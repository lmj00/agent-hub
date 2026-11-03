import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { CapacityState } from "@agent-hub/contracts";
import type { openDatabase } from "../../db/connection.js";
import {
  events,
  projects,
  providerGates,
  recoveryRequests,
  runs,
  tasks,
} from "../../db/schema.js";
import { readBudgetWait } from "../budgets/budget-store.js";
import {
  assignableGoal,
  readGoalExecutionBlock,
} from "../goals/goal-execution-store.js";
import { capacityCheckAt, type CapacityPolicy } from "./capacity-policy.js";
import {
  providerScope,
  reserveProviderCheck,
  type readProviderGate,
} from "./provider-gate.js";
import { ensureRetryState, readRetryBaseline } from "./retry-state-store.js";
import { retryLimitReason, type RetryPolicy } from "./retry-policy.js";

type Db = Pick<
  ReturnType<typeof openDatabase>["db"],
  "select" | "insert" | "update"
>;
type Gate = NonNullable<ReturnType<typeof readProviderGate>>;

// The caller holds the execution owner and an immediate transaction, and has
// ruled out active/unconfirmed runs. Account limits survive a target change.
export function replaceUnavailableGoalProbe(
  db: Db,
  gate: Gate,
  options: {
    workspaceKeys: string[];
    policy: CapacityPolicy;
    retryPolicy: RetryPolicy;
    random?: () => number;
  },
  now: Date,
): boolean | undefined {
  if (gate.probeRunId) return false;
  const source = gate.sourceRunId
    ? db.select().from(runs).where(eq(runs.id, gate.sourceRunId)).get()
    : undefined;
  const targetId = gate.probeTaskId ?? source?.taskId;
  const target = targetId
    ? db.select().from(tasks).where(eq(tasks.id, targetId)).get()
    : undefined;
  if (!target?.goalId || !readGoalExecutionBlock(db, target)) return undefined;
  // Even a completed-looking source needs termination evidence. No new model
  // call is used to discover whether the old one has really stopped.
  if (!source?.terminationConfirmedAt) return false;
  if (
    db
      .select({ id: recoveryRequests.id })
      .from(recoveryRequests)
      .where(
        and(
          eq(recoveryRequests.taskId, target.id),
          eq(recoveryRequests.status, "pending"),
        ),
      )
      .get()
  )
    return false;

  const state: CapacityState = gate.capacityState ?? {
    policy: { ...options.policy },
    checks: 0,
    decisionVersion: gate.version,
    nextCheckAt: capacityCheckAt(
      options.policy,
      0,
      now,
      gate.retryAt,
      (options.random ?? Math.random)(),
    ),
    reason: "waiting",
  };
  const limited = state.checks >= state.policy.maxChecks;
  const due =
    !limited &&
    !!state.nextCheckAt &&
    Date.parse(state.nextCheckAt) <= now.getTime() &&
    (!gate.retryAt || gate.retryAt <= now);
  let nextTaskId: string | null = null;
  if (due && options.workspaceKeys.length) {
    const candidates = db
      .select({ task: tasks })
      .from(tasks)
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .where(
        and(
          sql`${tasks.cancelRequestedAt} IS NULL AND ${tasks.plannedWork} IS NULL`,
          assignableGoal,
          sql`(${tasks.status} = 'queued' OR (${tasks.status} = 'waiting_capacity' AND ${tasks.budgetWait} IS NOT NULL AND json_extract(${tasks.budgetWait}, '$.retryAt') <= ${now.toISOString()}))`,
          inArray(projects.workspaceKey, options.workspaceKeys),
        ),
      )
      .orderBy(asc(tasks.createdAt), asc(tasks.id))
      .all();
    for (const { task } of candidates) {
      if (
        db
          .select({ id: recoveryRequests.id })
          .from(recoveryRequests)
          .where(
            and(
              eq(recoveryRequests.taskId, task.id),
              eq(recoveryRequests.status, "pending"),
            ),
          )
          .get()
      )
        continue;
      const last = db
        .select()
        .from(runs)
        .where(eq(runs.taskId, task.id))
        .orderBy(desc(runs.attempt))
        .get();
      if (last && (!last.terminationConfirmedAt || last.status === "succeeded"))
        continue;
      if (readBudgetWait(db, task, now)) continue;
      const retry = ensureRetryState(db, task.id, options.retryPolicy)!;
      if (
        (last || (readRetryBaseline(db, task.id)?.priorAttempts ?? 0) > 0
          ? retryLimitReason(retry)
          : retry.totalRunMs >= retry.policy.maxTotalRunMs) ||
        (retry.nextAttemptAt && Date.parse(retry.nextAttemptAt) > now.getTime())
      )
        continue;
      nextTaskId = task.id;
      db.update(tasks)
        .set({
          status: "queued",
          budgetWait: null,
          retryState: { ...retry, reason: "capacity_check_ready" },
        })
        .where(eq(tasks.id, task.id))
        .run();
      break;
    }
  }
  const version = gate.version + (gate.probeTaskId !== nextTaskId ? 1 : 0);
  const nextState: CapacityState = {
    ...state,
    decisionVersion: version,
    nextCheckAt: limited ? null : state.nextCheckAt,
    reason: limited
      ? "check_limit"
      : nextTaskId
        ? "ready"
        : due
          ? "task_unavailable"
          : "waiting",
  };
  if (
    gate.probeTaskId === nextTaskId &&
    JSON.stringify(gate.capacityState) === JSON.stringify(nextState)
  )
    return false;
  db.update(providerGates)
    .set({ version, probeTaskId: null, capacityState: nextState })
    .where(eq(providerGates.scope, providerScope))
    .run();
  if (nextTaskId) reserveProviderCheck(db, nextTaskId, version, now);
  const sequence =
    (db
      .select({ value: sql<number>`max(${events.sequence})` })
      .from(events)
      .where(eq(events.runId, source.id))
      .get()?.value ?? 0) + 1;
  db.insert(events)
    .values({
      id: randomUUID(),
      runId: source.id,
      sequence,
      kind: nextTaskId
        ? "capacity.check_reassigned"
        : `capacity.held.${nextState.reason}`,
      createdAt: now,
    })
    .run();
  return true;
}
