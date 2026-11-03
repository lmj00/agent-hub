import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Goal, GoalDefinition } from "@agent-hub/contracts";
import type { openDatabase } from "../../db/connection.js";
import { goalRevisions, goals, projects, runs, tasks } from "../../db/schema.js";
import { GoalError, normalizeGoalDefinition } from "./goal-policy.js";
import { narrowsGoalScope } from "./goal-scope-policy.js";
import { revalidateGoalWork } from "./revalidate-goal-work.js";

function view(row: typeof goals.$inferSelect): Goal {
  return {
    id: row.id,
    projectId: row.projectId,
    definition: row.definition,
    status: row.status,
    version: row.version,
    nextCheckAt: row.nextCheckAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function createDrizzleGoalStore(
  db: ReturnType<typeof openDatabase>["db"],
) {
  function requireProject(projectId: string) {
    if (
      !db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId))
        .get()
    )
      throw new GoalError("PROJECT_NOT_FOUND");
  }
  return {
    register(projectId: string, requestKey: string, input: GoalDefinition) {
      const definition = normalizeGoalDefinition(input),
        hash = fingerprint({ action: "create", definition });
      return db.transaction(
        (tx) => {
          requireProject(projectId);
          const existing = tx
            .select()
            .from(goals)
            .where(
              and(
                eq(goals.projectId, projectId),
                eq(goals.requestKey, requestKey),
              ),
            )
            .get();
          if (existing) {
            const first = tx
              .select()
              .from(goalRevisions)
              .where(
                and(
                  eq(goalRevisions.goalId, existing.id),
                  eq(goalRevisions.version, 1),
                ),
              )
              .get()!;
            if (first.commandHash !== hash)
              throw new GoalError("REQUEST_KEY_CONFLICT");
            return { goal: first.snapshot, created: false };
          }
          const now = new Date();
          const row = tx
            .insert(goals)
            .values({
              id: randomUUID(),
              projectId,
              requestKey,
              definition,
              status: "active",
              version: 1,
              createdAt: now,
              updatedAt: now,
            })
            .returning()
            .get();
          const goal = view(row);
          tx.insert(goalRevisions)
            .values({
              goalId: goal.id,
              version: 1,
              requestKey,
              commandHash: hash,
              snapshot: goal,
            })
            .run();
          return { goal, created: true };
        },
        { behavior: "immediate" },
      );
    },
    change(
      id: string,
      requestKey: string,
      expectedVersion: number,
      change: { definition: GoalDefinition } | { action: "pause" | "resume" },
    ) {
      const normalized =
        "definition" in change
          ? { definition: normalizeGoalDefinition(change.definition) }
          : change;
      const hash = fingerprint({ expectedVersion, ...normalized });
      return db.transaction(
        (tx) => {
          const row = tx.select().from(goals).where(eq(goals.id, id)).get();
          if (!row) throw new GoalError("GOAL_NOT_FOUND");
          const previous = tx
            .select()
            .from(goalRevisions)
            .where(
              and(
                eq(goalRevisions.goalId, id),
                eq(goalRevisions.requestKey, requestKey),
              ),
            )
            .get();
          if (previous) {
            if (previous.commandHash !== hash)
              throw new GoalError("REQUEST_KEY_CONFLICT");
            return previous.snapshot;
          }
          if (row.version !== expectedVersion)
            throw new GoalError("GOAL_VERSION_CHANGED");
          if (row.status === "completed") throw new GoalError("GOAL_COMPLETED");
          const definition =
            "definition" in normalized ? normalized.definition : row.definition;
          const status =
            "action" in normalized
              ? normalized.action === "pause"
                ? "paused"
                : "active"
              : row.status;
          const updated = tx
            .update(goals)
            .set({
              definition,
              status,
              version: row.version + 1,
              updatedAt: new Date(),
              nextCheckAt: null,
            })
            .where(and(eq(goals.id, id), eq(goals.version, expectedVersion)))
            .returning()
            .get();
          if (!updated) throw new GoalError("GOAL_VERSION_CHANGED");
          const goal = view(updated);
          tx.insert(goalRevisions)
            .values({
              goalId: id,
              version: goal.version,
              requestKey,
              commandHash: hash,
              snapshot: goal,
            })
            .run();
          if (narrowsGoalScope(row.definition, definition)) {
            const active = tx.select({ id: runs.id }).from(runs).innerJoin(tasks, eq(runs.taskId, tasks.id))
              .where(and(eq(tasks.goalId, id), isNull(runs.stopReason), or(eq(runs.status, "running"), and(inArray(runs.status, ["interrupted", "blocked", "waiting_capacity"]), isNull(runs.terminationConfirmedAt))))).all();
            for (const run of active) tx.update(runs).set({ stopReason: "scope_changed", stopRequestedAt: updated.updatedAt }).where(eq(runs.id, run.id)).run();
          }
          revalidateGoalWork(tx, id, updated.updatedAt);
          return goal;
        },
        { behavior: "immediate" },
      );
    },
    listByProject(projectId: string) {
      requireProject(projectId);
      return db
        .select()
        .from(goals)
        .where(eq(goals.projectId, projectId))
        .orderBy(desc(goals.createdAt), asc(goals.id))
        .all()
        .map(view);
    },
    findById(id: string) {
      const row = db.select().from(goals).where(eq(goals.id, id)).get();
      if (!row) throw new GoalError("GOAL_NOT_FOUND");
      return view(row);
    },
    history(id: string) {
      if (
        !db.select({ id: goals.id }).from(goals).where(eq(goals.id, id)).get()
      )
        throw new GoalError("GOAL_NOT_FOUND");
      return db
        .select()
        .from(goalRevisions)
        .where(eq(goalRevisions.goalId, id))
        .orderBy(desc(goalRevisions.version))
        .all()
        .map((row) => row.snapshot);
    },
  };
}
