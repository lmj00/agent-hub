import { eq } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { goals, planningCycles, runs, tasks } from "../../db/schema.js";
import { AnalysisError, redactOutput } from "../execution/analysis.js";
import { readGoalExecutionBlock } from "./goal-execution-store.js";
import type { GoalScope, PreparedInput } from "./prepared-workspace.js";

type Db = Pick<ReturnType<typeof openDatabase>["db"], "select" | "update">;
type Run = typeof runs.$inferSelect;

export function readGoalScope(
  db: Db,
  goalId: string | null,
): GoalScope | undefined {
  if (!goalId) return undefined;
  const goal = db.select().from(goals).where(eq(goals.id, goalId)).get();
  if (!goal) throw new AnalysisError("goal_changed");
  return {
    goalId,
    goalVersion: goal.version,
    allowedPaths: goal.definition.allowedPaths,
    excludedPaths: goal.definition.excludedPaths,
  };
}

export function preparedGoalChanged(db: Db, run: Run) {
  const input = run.preparedInput;
  if (!input) return false;
  const task = db.select().from(tasks).where(eq(tasks.id, run.taskId)).get();
  return (
    !task ||
    !!readGoalExecutionBlock(db, task) ||
    task.goalVersion !== run.goalVersion ||
    task.goalId !== input.scope.goalId ||
    JSON.stringify(readGoalScope(db, task.goalId)) !==
      JSON.stringify(input.scope)
  );
}

export function savePreparedInput(
  db: Db,
  run: Run,
  input: PreparedInput,
  kind: string,
) {
  const task = db.select().from(tasks).where(eq(tasks.id, run.taskId)).get();
  if (
    !task ||
    task.cancelRequestedAt ||
    run.stopReason ||
    readGoalExecutionBlock(db, task) ||
    run.goalVersion !== input.scope.goalVersion ||
    task.goalId !== input.scope.goalId ||
    JSON.stringify(readGoalScope(db, task.goalId)) !==
      JSON.stringify(input.scope)
  )
    throw new AnalysisError("goal_changed");
  if (
    input.runId !== run.id ||
    run.execution ||
    kind !== `input.${input.phase}`
  )
    throw new AnalysisError("input_unavailable");
  if (input.phase === "preparing") {
    if (
      run.preparedInput ||
      input.revision ||
      input.digest ||
      input.files.length
    )
      throw new AnalysisError("input_unavailable");
  } else {
    const prior = run.preparedInput;
    if (
      !prior ||
      prior.phase !== "preparing" ||
      !input.revision ||
      !input.digest ||
      prior.id !== input.id ||
      prior.directory !== input.directory ||
      prior.source !== input.source ||
      JSON.stringify(prior.scope) !== JSON.stringify(input.scope)
    )
      throw new AnalysisError("input_unavailable");
  }
  db.update(runs)
    .set({ preparedInput: input })
    .where(eq(runs.id, run.id))
    .run();
}

export function savePlanningProposal(db: Db, run: Run, proposal: string, kind: string) {
  const cycle = db.select().from(planningCycles).where(eq(planningCycles.taskId, run.taskId)).get();
  if (!cycle || cycle.status !== "reserved" || run.planResult || run.preparedInput?.phase !== "ready" || kind !== "planning.proposed"
    || typeof proposal !== "string" || !proposal.trim() || Buffer.byteLength(proposal) > 65536) throw new AnalysisError("invalid_plan");
  db.update(runs).set({ planResult: { status: "proposed", proposal: redactOutput(proposal), createdTaskIds: [], reason: null } }).where(eq(runs.id, run.id)).run();
}
