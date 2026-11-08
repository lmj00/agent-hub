import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Goal, ReleaseTask, TaskRelease } from "@agent-hub/contracts";
import type { openDatabase } from "../../db/connection.js";
import {
  goalRevisions,
  goals,
  recoveryRequests,
  runs,
  taskReleases,
  tasks,
} from "../../db/schema.js";
import {
  defaultRetryPolicy,
  retryLimitReason,
  type RetryPolicy,
} from "../execution/retry-policy.js";
import { ensureRetryState, readRetryBaseline } from "../execution/retry-state-store.js";
import { allowedGoalPath, privateInputPath } from "../workspace/prepared-workspace.js";
import { narrowsGoalScope } from "./goal-scope-policy.js";
import { revalidateGoalWork } from "./revalidate-goal-work.js";

export class WorkReleaseError extends Error {
  constructor(
    public readonly code:
      | "TASK_NOT_FOUND"
      | "TASK_NOT_RELEASABLE"
      | "TASK_ALREADY_RELEASED"
      | "REQUEST_KEY_CONFLICT"
      | "GOAL_BINDING_INVALID"
      | "GOAL_PAUSED"
      | "GOAL_COMPLETED"
      | "GOAL_VERSION_CHANGED"
      | "TASK_SCOPE_CHANGED"
      | "TERMINATION_UNCONFIRMED"
      | "RECOVERY_IN_PROGRESS"
      | "RECOVERY_LIMIT_REACHED",
  ) {
    super(code);
  }
}
const receipt = (row: typeof taskReleases.$inferSelect): TaskRelease => ({
  sourceTaskId: row.sourceTaskId,
  newTaskId: row.newTaskId,
  goalId: row.goalId,
  goalVersion: row.goalVersion,
  createdAt: row.createdAt.toISOString(),
});

export function createWorkReleaseStore(
  db: ReturnType<typeof openDatabase>["db"],
  policy: RetryPolicy = defaultRetryPolicy,
) {
  return {
    release(sourceTaskId: string, input: ReleaseTask) {
      const commandHash = createHash("sha256")
        .update(JSON.stringify([sourceTaskId, input.expectedGoalVersion]))
        .digest("hex");
      return db.transaction(
        (tx) => {
          const existing = tx
            .select()
            .from(taskReleases)
            .where(eq(taskReleases.sourceTaskId, sourceTaskId))
            .get();
          if (existing) {
            if (existing.requestKey !== input.requestKey)
              throw new WorkReleaseError("TASK_ALREADY_RELEASED");
            if (existing.commandHash !== commandHash)
              throw new WorkReleaseError("REQUEST_KEY_CONFLICT");
            return { release: receipt(existing), created: false };
          }
          const source = tx.select().from(tasks).where(eq(tasks.id, sourceTaskId)).get();
          if (!source) throw new WorkReleaseError("TASK_NOT_FOUND");
          if (
            source.status !== "cancelled" ||
            source.kind !== "work" ||
            !source.plannedWork ||
            !source.goalId ||
            !source.goalVersion
          )
            throw new WorkReleaseError("TASK_NOT_RELEASABLE");
          const goal = tx.select().from(goals).where(eq(goals.id, source.goalId)).get();
          if (!goal || goal.projectId !== source.projectId)
            throw new WorkReleaseError("GOAL_BINDING_INVALID");
          if (goal.version !== input.expectedGoalVersion)
            throw new WorkReleaseError("GOAL_VERSION_CHANGED");
          if (goal.status === "paused") throw new WorkReleaseError("GOAL_PAUSED");
          if (goal.status === "completed") throw new WorkReleaseError("GOAL_COMPLETED");
          const history = tx.select().from(runs).where(eq(runs.taskId, sourceTaskId)).all();
          if (history.some((run) => run.status === "running" || !run.terminationConfirmedAt))
            throw new WorkReleaseError("TERMINATION_UNCONFIRMED");
          if (
            tx
              .select({ id: recoveryRequests.id })
              .from(recoveryRequests)
              .where(
                and(
                  eq(recoveryRequests.taskId, sourceTaskId),
                  eq(recoveryRequests.status, "pending"),
                ),
              )
              .get()
          )
            throw new WorkReleaseError("RECOVERY_IN_PROGRESS");
          const priorGoal = tx
            .select()
            .from(goalRevisions)
            .where(
              and(eq(goalRevisions.goalId, goal.id), eq(goalRevisions.version, source.goalVersion)),
            )
            .get()?.snapshot;
          const paths = source.plannedWork.paths;
          if (
            !priorGoal ||
            priorGoal.projectId !== source.projectId ||
            !Array.isArray(paths) ||
            !paths.length ||
            paths.length > 20 ||
            paths.some(
              (path) =>
                typeof path !== "string" ||
                !allowedGoalPath(path, priorGoal.definition) ||
                !allowedGoalPath(path, goal.definition) ||
                privateInputPath(path),
            ) ||
            narrowsGoalScope(
              {
                allowedPaths: paths,
                excludedPaths: priorGoal.definition.excludedPaths,
              },
              goal.definition,
            )
          )
            throw new WorkReleaseError("TASK_SCOPE_CHANGED");
          const priorAttempts =
            (readRetryBaseline(tx, sourceTaskId)?.priorAttempts ?? 0) + history.length;
          const priorRetryState = ensureRetryState(tx, sourceTaskId, policy)!;
          if (
            priorAttempts
              ? retryLimitReason(priorRetryState)
              : priorRetryState.totalRunMs >= priorRetryState.policy.maxTotalRunMs
          )
            throw new WorkReleaseError("RECOVERY_LIMIT_REACHED");
          const now = new Date(),
            newTaskId = randomUUID(),
            version = goal.version + 1;
          const snapshot: Goal = {
            id: goal.id,
            projectId: goal.projectId,
            definition: goal.definition,
            status: "active",
            version,
            nextCheckAt: null,
            createdAt: goal.createdAt.toISOString(),
            updatedAt: now.toISOString(),
          };
          tx.update(goals)
            .set({ version, nextCheckAt: null, updatedAt: now })
            .where(eq(goals.id, goal.id))
            .run();
          tx.insert(goalRevisions)
            .values({
              goalId: goal.id,
              version,
              requestKey: `release-work:${sourceTaskId}:${input.requestKey}`,
              commandHash,
              snapshot,
            })
            .run();
          tx.insert(tasks)
            .values({
              id: newTaskId,
              projectId: source.projectId,
              kind: "work",
              goalId: goal.id,
              goalVersion: version,
              instruction: source.instruction,
              plannedWork: source.plannedWork,
              requestKey: `released:${sourceTaskId}`,
              status: "queued",
              createdAt: now,
              retryState: {
                ...priorRetryState,
                reason: null,
                decisionRunId: null,
              },
              goalReview: {
                fromVersion: source.goalVersion,
                toVersion: version,
                decision: "retained",
                paths: [...paths],
                checkedAt: now.toISOString(),
              },
            })
            .run();
          const record = tx
            .insert(taskReleases)
            .values({
              sourceTaskId,
              newTaskId,
              goalId: goal.id,
              goalVersion: version,
              requestKey: input.requestKey,
              commandHash,
              priorAttempts,
              priorRetryState,
              createdAt: now,
            })
            .returning()
            .get();
          revalidateGoalWork(tx, goal.id, now);
          return { release: receipt(record), created: true };
        },
        { behavior: "immediate" },
      );
    },
  };
}
