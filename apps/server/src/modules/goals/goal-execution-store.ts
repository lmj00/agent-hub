import { eq, sql } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { goals, tasks } from "../../db/schema.js";
import {
  goalExecutionBlock,
  type TaskGoalReference,
} from "./goal-execution-policy.js";

// Keep paused/stale goals out of queue selection so they cannot starve other work.
export const assignableGoal = sql`(
  (${tasks.goalId} IS NULL AND ${tasks.goalVersion} IS NULL AND ${tasks.kind} = 'work')
  OR EXISTS (
    SELECT 1 FROM ${goals} WHERE ${goals.id} = ${tasks.goalId}
      AND ${goals.projectId} = ${tasks.projectId}
      AND ${goals.status} = 'active' AND ${goals.version} = ${tasks.goalVersion}
      AND ${tasks.kind} IN ('planning', 'work')
  )
)`;

export function readGoalExecutionBlock(
  db: Pick<ReturnType<typeof openDatabase>["db"], "select">,
  task: TaskGoalReference,
) {
  const goal =
    task.goalId === null
      ? undefined
      : db.select().from(goals).where(eq(goals.id, task.goalId)).get();
  return goalExecutionBlock(task, goal);
}
