import { randomUUID } from "node:crypto";
import { desc, eq, inArray, sql } from "drizzle-orm";
import type { BudgetWait } from "@agent-hub/contracts";
import type { openDatabase } from "../../db/connection.js";
import { budgetPeriods, budgetReservations, goals, projectBudgets } from "../../db/schema.js";
import { AnalysisError } from "../execution/analysis.js";
import { defaultProjectBudget, periodWait, validateBudget, type Period } from "./budget-policy.js";

export type BudgetDb = Pick<ReturnType<typeof openDatabase>["db"], "select" | "insert" | "update">;
type TaskReference = { projectId: string; goalId: string | null };

export function latestPeriod(db: Pick<BudgetDb, "select">, accountKey: string) {
  return db
    .select()
    .from(budgetPeriods)
    .where(eq(budgetPeriods.accountKey, accountKey))
    .orderBy(desc(budgetPeriods.startedAt))
    .get();
}

// Enabling or disabling enforcement is immediate; stored usage and period limits stay intact.
export function withCurrentBudgetMode(
  db: Pick<BudgetDb, "select">,
  period: typeof budgetPeriods.$inferSelect,
) {
  const policy = period.goalId
    ? db.select().from(goals).where(eq(goals.id, period.goalId)).get()?.definition.budget
    : db.select().from(projectBudgets).where(eq(projectBudgets.projectId, period.projectId)).get()
        ?.policy;
  return { ...period, policy: { ...period.policy, unlimited: policy?.unlimited === true } };
}

function periodsForTask(db: BudgetDb, task: TaskReference, now: Date, create: boolean): Period[] {
  let project = db
    .select()
    .from(projectBudgets)
    .where(eq(projectBudgets.projectId, task.projectId))
    .get();
  if (!project && create)
    project = db
      .insert(projectBudgets)
      .values({
        projectId: task.projectId,
        version: 1,
        policy: defaultProjectBudget,
        updatedAt: now,
      })
      .returning()
      .get();
  const goal = task.goalId
    ? db.select().from(goals).where(eq(goals.id, task.goalId)).get()
    : undefined;
  if (task.goalId && (!goal || goal.projectId !== task.projectId))
    throw new Error("GOAL_BINDING_INVALID");
  const accounts = [
    {
      accountKey: `project:${task.projectId}`,
      goalId: null as string | null,
      policy: project?.policy ?? defaultProjectBudget,
    },
    ...(goal
      ? [
          {
            accountKey: `goal:${goal.id}`,
            goalId: goal.id,
            policy: goal.definition.budget,
          },
        ]
      : []),
  ];
  return accounts.flatMap((account) => {
    const previous = latestPeriod(db, account.accountKey);
    if (previous && previous.endsAt > now) return [withCurrentBudgetMode(db, previous)];
    if (!create) return [];
    const policy = validateBudget(account.policy);
    return [
      db
        .insert(budgetPeriods)
        .values({
          id: randomUUID(),
          accountKey: account.accountKey,
          projectId: task.projectId,
          goalId: account.goalId,
          startedAt: now,
          endsAt: new Date(now.getTime() + policy.windowMs),
          policy,
        })
        .returning()
        .get()!,
    ];
  });
}

// Called inside the same immediate transaction as claim. Neither API reads nor edits reset a period.
export function prepareRunBudget(db: BudgetDb, task: TaskReference, now: Date) {
  const periods = periodsForTask(db, task, now, true);
  return {
    periods,
    wait: periodWait(periods, now),
    remainingRunMs: Math.max(
      0,
      Math.min(
        ...periods.map((period) =>
          period.policy.unlimited
            ? Infinity
            : Math.min(
                period.policy.maxRunMs - period.runMs,
                period.endsAt.getTime() - now.getTime(),
              ),
        ),
      ),
    ),
  };
}
export function readBudgetWait(db: BudgetDb, task: TaskReference, now: Date): BudgetWait | null {
  return periodWait(periodsForTask(db, task, now, false), now);
}
export function reserveRunBudget(
  db: BudgetDb,
  runId: string,
  periods: Period[],
  durationMs: number,
  now: Date,
) {
  db.insert(budgetReservations)
    .values({
      runId,
      projectPeriodId: periods.find((p) => !p.goalId)!.id,
      goalPeriodId: periods.find((p) => p.goalId)?.id ?? null,
      startedAt: now,
      reservedRunMs: durationMs,
    })
    .run();
  for (const period of periods)
    db.update(budgetPeriods)
      .set({
        calls: sql`${budgetPeriods.calls} + 1`,
        runMs: sql`${budgetPeriods.runMs} + ${durationMs}`,
      })
      .where(eq(budgetPeriods.id, period.id))
      .run();
}
function reservationPeriods(db: BudgetDb, reservation: typeof budgetReservations.$inferSelect) {
  return db
    .select()
    .from(budgetPeriods)
    .where(
      inArray(budgetPeriods.id, [
        reservation.projectPeriodId,
        ...(reservation.goalPeriodId ? [reservation.goalPeriodId] : []),
      ]),
    )
    .all()
    .map((period) => withCurrentBudgetMode(db, period));
}

// The preceding Step has already committed its report. Throwing here prevents the next acknowledgement.
export function reserveNextBudgetCall(db: BudgetDb, runId: string, now: Date) {
  const reservation = db
    .select()
    .from(budgetReservations)
    .where(eq(budgetReservations.runId, runId))
    .get();
  if (!reservation) return; // Runs created before budget accounting have no retroactive reservation.
  const periods = reservationPeriods(db, reservation);
  if (
    reservation.settledAt ||
    periods.some(
      (p) =>
        !p.policy.unlimited &&
        (now >= p.endsAt ||
          p.calls >= p.policy.maxCalls ||
          now.getTime() >=
            reservation.startedAt.getTime() +
              p.policy.maxRunMs -
              p.runMs +
              reservation.reservedRunMs),
    )
  )
    throw new AnalysisError("budget_limit");
  for (const period of periods)
    db.update(budgetPeriods)
      .set({ calls: sql`${budgetPeriods.calls} + 1` })
      .where(eq(budgetPeriods.id, period.id))
      .run();
}

// Only observed termination releases unused time. Repeated or later reconciliation cannot double-charge.
export function settleRunBudget(db: BudgetDb, runId: string, confirmedAt: Date | null) {
  if (!confirmedAt) return;
  const reservation = db
    .select()
    .from(budgetReservations)
    .where(eq(budgetReservations.runId, runId))
    .get();
  if (!reservation) return;
  const elapsed = Math.max(
    confirmedAt < reservation.startedAt
      ? reservation.reservedRunMs
      : confirmedAt.getTime() - reservation.startedAt.getTime(),
    reservation.settledRunMs ?? 0,
  );
  const delta = elapsed - (reservation.settledRunMs ?? reservation.reservedRunMs);
  for (const period of reservationPeriods(db, reservation))
    db.update(budgetPeriods)
      .set({ runMs: sql`${budgetPeriods.runMs} + ${delta}` })
      .where(eq(budgetPeriods.id, period.id))
      .run();
  db.update(budgetReservations)
    .set({ settledRunMs: elapsed, settledAt: confirmedAt })
    .where(eq(budgetReservations.runId, runId))
    .run();
}

export function runBudgetWait(db: BudgetDb, runId: string, now: Date): BudgetWait | null {
  const reservation = db
    .select()
    .from(budgetReservations)
    .where(eq(budgetReservations.runId, runId))
    .get();
  if (!reservation) return null;
  const periods = reservationPeriods(db, reservation);
  return (
    periodWait(periods, now) ?? {
      scope: reservation.goalPeriodId ? "goal" : "project",
      reason: "time_limit",
      retryAt: periods
        .reduce((latest, p) => (p.endsAt > latest ? p.endsAt : latest), periods[0]!.endsAt)
        .toISOString(),
    }
  );
}
