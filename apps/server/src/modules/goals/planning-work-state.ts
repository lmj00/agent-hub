import { and, asc, eq } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { recoveryRequests, runs, taskReleases, tasks } from "../../db/schema.js";
import { allowedGoalPath, privateInputPath } from "./prepared-workspace.js";

type Db = Pick<ReturnType<typeof openDatabase>["db"], "select">;
export type SuppressedWork = {
  taskId: string;
  status: "failed" | "blocked" | "cancelled";
  paths: string[];
  acceptanceCriteria: string;
};

const canonical = (path: string) => path.normalize("NFC").toLowerCase();
export function overlappingWorkPaths(first: string[], second: string[]) {
  return first.some((path) =>
    second.some((other) => {
      const a = canonical(path),
        b = canonical(other);
      return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    }),
  );
}

// Read every unfinished work item, independently of the bounded prompt history.
// Terminal problems suppress their own paths; active/unknown work still holds
// planning until its result and termination can be trusted.
export function readPlanningWork(db: Db, goalId: string) {
  const previous = db
    .select()
    .from(tasks)
    .where(and(eq(tasks.goalId, goalId), eq(tasks.kind, "work")))
    .orderBy(asc(tasks.createdAt), asc(tasks.id))
    .all();
  const suppressed: SuppressedWork[] = [];
  let unresolved = false;
  for (const task of previous) {
    if (task.status === "succeeded" && !task.cancelRequestedAt) continue;
    const history = db
      .select()
      .from(runs)
      .where(eq(runs.taskId, task.id))
      .all();
    const pending = db
      .select({ id: recoveryRequests.id })
      .from(recoveryRequests)
      .where(
        and(
          eq(recoveryRequests.taskId, task.id),
          eq(recoveryRequests.status, "pending"),
        ),
      )
      .get();
    if (
      pending ||
      history.some(
        (run) => run.status === "running" || !run.terminationConfirmedAt,
      )
    ) {
      unresolved = true;
      continue;
    }
    if (task.status === "cancelled" && db.select({ id: taskReleases.newTaskId }).from(taskReleases).where(eq(taskReleases.sourceTaskId, task.id)).get()) continue;
    // Scope exclusion before any attempt consumes no task retry budget. The
    // current Goal can be planned afresh without reviving the old Task.
    if (
      task.status === "cancelled" &&
      !task.cancelRequestedAt &&
      task.goalReview?.decision === "excluded" &&
      !history.length
    )
      continue;
    const work = task.plannedWork;
    if (
      !work ||
      !Array.isArray(work.paths) ||
      !work.paths.length ||
      work.paths.length > 20 ||
      work.paths.some(
        (path) =>
          typeof path !== "string" ||
          !allowedGoalPath(path, { allowedPaths: ["."], excludedPaths: [] }) ||
          privateInputPath(path),
      ) ||
      typeof work.acceptanceCriteria !== "string" ||
      !["failed", "blocked", "cancelled"].includes(task.status)
    ) {
      unresolved = true;
      continue;
    }
    suppressed.push({
      taskId: task.id,
      status: task.status as SuppressedWork["status"],
      paths: work.paths,
      acceptanceCriteria: work.acceptanceCriteria,
    });
  }
  return { previous, unresolved, suppressed };
}
