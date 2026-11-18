import { randomUUID } from "node:crypto";
import { reserveNextBudgetCall } from "../budgets/budget-store.js";
import { and, asc, eq } from "drizzle-orm";
import type { Effort } from "@agent-hub/contracts";
import type { openDatabase } from "../../db/connection.js";
import { runs, steps, tasks } from "../../db/schema.js";
import { AnalysisError } from "./analysis.js";
import { defaultEffortPolicy } from "./effort-policy.js";
import { parseStepUpdate, selectNextEffort } from "./analysis-workflow.js";
import { selectModel, sensitiveModelScope } from "./model-policy.js";

type StepDb = Pick<ReturnType<typeof openDatabase>["db"], "select" | "update" | "insert">;

// The server recomputes every next choice from persisted reports and the Run's limits.
export function saveWorkflowStep(
  db: StepDb,
  run: typeof runs.$inferSelect,
  raw: unknown,
  now: Date,
) {
  const task = db.select().from(tasks).where(eq(tasks.id, run.taskId)).get();
  if (!run.workflowPolicy || task?.cancelRequestedAt || run.stopReason)
    throw new AnalysisError("invalid_plan");
  const update = parseStepUpdate(raw);
  const history = db
    .select()
    .from(steps)
    .where(eq(steps.runId, run.id))
    .orderBy(asc(steps.sequence))
    .all();
  const latest = history.at(-1)!;
  if (update.type === "complete") {
    if (
      latest.sequence !== update.sequence ||
      latest.status !== "running" ||
      !latest.purpose ||
      latest.assessment ||
      (run.runtimeSkillVersion !== null && !latest.runtimeSkillLoadedAt)
    )
      throw new AnalysisError("invalid_plan");
    db.update(steps)
      .set({
        status: "succeeded",
        assessment: update.assessment,
        usage: update.usage,
        finishedAt: now,
      })
      .where(eq(steps.id, latest.id))
      .run();
    return;
  }
  if (update.sequence > run.workflowPolicy.maxSteps) throw new AnalysisError("workflow_limit");
  // A verified scope expansion may add sensitive paths after the Run was claimed.
  const modelPolicy =
    run.modelPolicy &&
    sensitiveModelScope(
      [
        task?.instruction,
        task?.plannedWork?.acceptanceCriteria,
        ...(task?.plannedWork?.paths ?? []),
      ].join("\n"),
    )
      ? { ...run.modelPolicy, minimumTier: "sol" as const }
      : run.modelPolicy;
  if (update.sequence === 1) {
    if (history.length !== 1 || latest.purpose || latest.status !== "running")
      throw new AnalysisError("invalid_plan");
    const selectedModel =
      modelPolicy?.minimumTier === "sol"
        ? selectModel(run.model, modelPolicy, task?.plannedWork?.model)
        : { model: run.model, reason: latest.modelReason };
    db.update(steps)
      .set({
        purpose: task?.plannedWork ? "개발" : "초기 분석",
        model: selectedModel.model,
        modelReason: selectedModel.reason,
        startedAt: now,
      })
      .where(eq(steps.id, latest.id))
      .run();
    db.update(runs)
      .set({ model: selectedModel.model, modelPolicy })
      .where(eq(runs.id, run.id))
      .run();
    return;
  }
  const proposal = latest.assessment?.next;
  if (
    latest.sequence + 1 !== update.sequence ||
    latest.status !== "succeeded" ||
    latest.assessment?.complete ||
    !proposal
  )
    throw new AnalysisError("invalid_plan");
  const changes = history
    .slice(1)
    .filter((step, index) => step.effort !== history[index]!.effort).length;
  const selected = selectNextEffort(
    proposal.effort,
    latest.effort as Effort,
    changes,
    run.effortPolicy ?? defaultEffortPolicy,
    run.workflowPolicy,
  );
  reserveNextBudgetCall(db, run.id, now);
  const modelSelection = selectModel(
    run.model,
    modelPolicy,
    proposal.model ? { tier: proposal.model, reason: proposal.reason } : null,
    task?.kind === "planning" || (run.developmentVersion !== null && update.sequence % 2 === 0),
  );
  db.insert(steps)
    .values({
      id: randomUUID(),
      runId: run.id,
      sequence: update.sequence,
      status: "running",
      purpose: proposal.purpose,
      model: modelSelection.model,
      modelReason: modelSelection.reason,
      proposedEffort: proposal.effort,
      effort: selected.effort,
      effortReason: `${selected.reason} 제안 근거: ${proposal.reason}`,
      effortPolicyVersion: selected.policyVersion,
      startedAt: now,
    })
    .run();
  db.update(runs)
    .set({ effort: selected.effort, modelPolicy })
    .where(and(eq(runs.id, run.id), eq(runs.status, "running")))
    .run();
}
