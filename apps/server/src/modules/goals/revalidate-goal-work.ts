import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import {
  goalRevisions,
  goals,
  recoveryRequests,
  runs,
  tasks,
} from "../../db/schema.js";
import { allowedGoalPath, privateInputPath } from "./prepared-workspace.js";
import { narrowsGoalScope } from "./goal-scope-policy.js";

type Db = Pick<ReturnType<typeof openDatabase>["db"], "select" | "update">;

// The caller holds an immediate transaction. Rechecking permissions never grants
// a retry, clears a failure, releases a user cancellation or rewrites a past Run.
export function revalidateGoalWork(db: Db, goalId?: string, now = new Date()) {
  const candidates = db
    .select({ task: tasks, goal: goals })
    .from(tasks)
    .innerJoin(
      goals,
      and(eq(goals.id, tasks.goalId), eq(goals.projectId, tasks.projectId)),
    )
    .where(
      and(
        eq(goals.status, "active"),
        eq(tasks.kind, "work"),
        sql`${tasks.goalVersion} < ${goals.version}`,
        isNull(tasks.cancelRequestedAt),
        sql`${tasks.plannedWork} IS NOT NULL`,
        ne(tasks.status, "running"),
        ne(tasks.status, "succeeded"),
        ne(tasks.status, "cancelled"),
        goalId ? eq(goals.id, goalId) : undefined,
      ),
    )
    .all();
  for (const { task, goal } of candidates) {
    if (
      db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.taskId, task.id),
            sql`(${runs.status} = 'running' OR ${runs.terminationConfirmedAt} IS NULL)`,
          ),
        )
        .get()
    )
      continue;
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
    const previous = db
      .select()
      .from(goalRevisions)
      .where(
        and(
          eq(goalRevisions.goalId, goal.id),
          eq(goalRevisions.version, task.goalVersion!),
        ),
      )
      .get()?.snapshot;
    const paths = task.plannedWork?.paths;
    // Legacy/manual tasks or broken provenance stay held; do not guess their scope.
    if (
      !previous ||
      previous.projectId !== task.projectId ||
      !Array.isArray(paths) ||
      !paths.length ||
      paths.length > 20 ||
      paths.some(
        (path) =>
          typeof path !== "string" ||
          !allowedGoalPath(path, previous.definition) ||
          privateInputPath(path),
      )
    )
      continue;
    const retained =
      paths.every((path) => allowedGoalPath(path, goal.definition)) &&
      !narrowsGoalScope(
        {
          allowedPaths: paths,
          excludedPaths: previous.definition.excludedPaths,
        },
        goal.definition,
      );
    db.update(tasks)
      .set({
        ...(retained
          ? { goalVersion: goal.version }
          : { status: "cancelled" as const, budgetWait: null }),
        goalReview: {
          fromVersion: task.goalVersion!,
          toVersion: goal.version,
          decision: retained ? "retained" : "excluded",
          paths: [...paths],
          checkedAt: now.toISOString(),
        },
      })
      .where(eq(tasks.id, task.id))
      .run();
  }
}
