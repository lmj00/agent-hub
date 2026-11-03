import type { TaskKind } from "@agent-hub/contracts";

export type TaskGoalReference = {
  projectId: string;
  kind: TaskKind;
  goalId: string | null;
  goalVersion: number | null;
};
export type GoalExecutionBlock =
  | "GOAL_BINDING_INVALID"
  | "GOAL_PAUSED"
  | "GOAL_COMPLETED"
  | "GOAL_VERSION_CHANGED";
type GoalReference = {
  id: string;
  projectId: string;
  version: number;
  status: string;
};

// A goal's current status and version are checked at each execution boundary.
// Old work may be rebound only by an explicit scope check, never silently here.
export function goalExecutionBlock(
  task: TaskGoalReference,
  goal: GoalReference | undefined,
): GoalExecutionBlock | null {
  if (task.kind !== "planning" && task.kind !== "work")
    return "GOAL_BINDING_INVALID";
  if (task.goalId === null)
    return task.kind === "work" && task.goalVersion === null
      ? null
      : "GOAL_BINDING_INVALID";
  if (
    !goal ||
    goal.id !== task.goalId ||
    goal.projectId !== task.projectId ||
    !Number.isSafeInteger(task.goalVersion) ||
    task.goalVersion! < 1
  )
    return "GOAL_BINDING_INVALID";
  if (goal.status === "paused") return "GOAL_PAUSED";
  if (goal.status === "completed") return "GOAL_COMPLETED";
  if (goal.status !== "active") return "GOAL_BINDING_INVALID";
  return goal.version === task.goalVersion ? null : "GOAL_VERSION_CHANGED";
}
