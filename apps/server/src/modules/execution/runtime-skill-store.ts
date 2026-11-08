import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { runs, steps, tasks } from "../../db/schema.js";
import { readGoalExecutionBlock } from "../goals/goal-execution-store.js";
import { AnalysisError } from "./analysis.js";
import {
  parseRuntimeSkillContext,
  runtimeSkillPolicyVersion,
  sameRuntimeSkill,
  type RuntimeSkillRole,
} from "./runtime-skills.js";
import type { RunCompletion } from "./run-task.js";

type Db = Pick<ReturnType<typeof openDatabase>["db"], "select" | "update">;

function expectedRole(task: typeof tasks.$inferSelect, sequence: number): RuntimeSkillRole {
  return task.kind === "planning"
    ? sequence === 1
      ? "planner"
      : "reviewer"
    : task.plannedWork
      ? sequence % 2 === 1
        ? "developer"
        : "reviewer"
      : "analyst";
}

// Called inside the owner's existing transaction. Only parent-created selected
// events and exact child load confirmations can reach this journal.
export function saveRuntimeSkillUpdate(
  db: Db,
  run: typeof runs.$inferSelect,
  raw: unknown,
  kind: string,
  now: Date,
) {
  const update = raw as {
    type?: unknown;
    sequence?: unknown;
    selection?: unknown;
  } | null;
  if (
    !update ||
    typeof update !== "object" ||
    Array.isArray(update) ||
    Object.keys(update).length !== 3 ||
    (update.type !== "selected" && update.type !== "loaded") ||
    kind !== `skill.${update.type}` ||
    run.runtimeSkillVersion !== runtimeSkillPolicyVersion ||
    run.stopReason
  )
    throw new AnalysisError("unsupported_settings");
  const context = parseRuntimeSkillContext({
    sequence: update.sequence,
    selection: update.selection,
  });
  const task = db.select().from(tasks).where(eq(tasks.id, run.taskId)).get();
  const step = db
    .select()
    .from(steps)
    .where(eq(steps.runId, run.id))
    .orderBy(desc(steps.sequence))
    .get();
  if (
    !task ||
    task.cancelRequestedAt ||
    readGoalExecutionBlock(db, task) ||
    !step ||
    step.status !== "running" ||
    step.sequence !== context.sequence ||
    expectedRole(task, step.sequence) !== context.selection.role ||
    step.runtimeSkillLoadedAt
  )
    throw new AnalysisError("unsupported_settings");
  if (update.type === "selected") {
    if (step.runtimeSkill) {
      if (!sameRuntimeSkill({ sequence: step.sequence, selection: step.runtimeSkill }, context))
        throw new AnalysisError("unsupported_settings");
      return; // The initial child-managed Step starts after the parent selected it.
    }
    db.update(steps)
      .set({ runtimeSkill: context.selection, runtimeSkillSelectedAt: now })
      .where(eq(steps.id, step.id))
      .run();
  } else {
    if (
      !step.runtimeSkill ||
      !step.runtimeSkillSelectedAt ||
      !sameRuntimeSkill({ sequence: step.sequence, selection: step.runtimeSkill }, context)
    )
      throw new AnalysisError("unsupported_settings");
    db.update(steps).set({ runtimeSkillLoadedAt: now }).where(eq(steps.id, step.id)).run();
  }
}

export function requireRuntimeSkillEvidence(
  db: Pick<Db, "select">,
  run: typeof runs.$inferSelect,
  completion: RunCompletion,
): RunCompletion {
  if (run.runtimeSkillVersion === null || completion.status !== "succeeded") return completion;
  const history = db.select().from(steps).where(eq(steps.runId, run.id)).all();
  if (
    run.runtimeSkillVersion !== runtimeSkillPolicyVersion ||
    !history.length ||
    history.some(
      (step) => !step.runtimeSkill || !step.runtimeSkillSelectedAt || !step.runtimeSkillLoadedAt,
    )
  )
    return {
      ...completion,
      status: "blocked",
      result: null,
      errorCode: "unsupported_settings",
    };
  return completion;
}

// For new adapters, no durable load ACK means no SDK call could start. Container
// recovery also requires an empty execution journal; direct SDK calls with an
// acknowledged load remain uncertain and never gain container termination proof.
export function runtimeSkillNotStarted(db: Pick<Db, "select">, run: typeof runs.$inferSelect) {
  return (
    run.runtimeSkillVersion === runtimeSkillPolicyVersion &&
    !db
      .select({ id: steps.id })
      .from(steps)
      .where(and(eq(steps.runId, run.id), isNotNull(steps.runtimeSkillLoadedAt)))
      .get()
  );
}
