import { randomUUID } from "node:crypto";
import { reserveNextBudgetCall } from "../budgets/budget-store.js";
import { and, asc, eq } from "drizzle-orm";
import type { Effort } from "@agent-hub/contracts";
import type { openDatabase } from "../../db/connection.js";
import { runs, steps, tasks } from "../../db/schema.js";
import { AnalysisError } from "./analysis.js";
import { defaultEffortPolicy } from "./effort-policy.js";
import { parseStepUpdate, selectNextEffort } from "./analysis-workflow.js";

type StepDb = Pick<
  ReturnType<typeof openDatabase>["db"],
  "select" | "update" | "insert"
>;

// The server recomputes every next choice from persisted reports and the Run's limits.
export function saveWorkflowStep(
  db: StepDb,
  run: typeof runs.$inferSelect,
  raw: unknown,
  now: Date,
) {
  if (
    !run.workflowPolicy ||
    db.select().from(tasks).where(eq(tasks.id, run.taskId)).get()
      ?.cancelRequestedAt
  )
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
      latest.assessment
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
  if (update.sequence > run.workflowPolicy.maxSteps)
    throw new AnalysisError("workflow_limit");
  if (update.sequence === 1) {
    if (history.length !== 1 || latest.purpose || latest.status !== "running")
      throw new AnalysisError("invalid_plan");
    db.update(steps)
      .set({ purpose: "초기 분석", model: run.model, startedAt: now })
      .where(eq(steps.id, latest.id))
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
  db.insert(steps)
    .values({
      id: randomUUID(),
      runId: run.id,
      sequence: update.sequence,
      status: "running",
      purpose: proposal.purpose,
      model: run.model,
      proposedEffort: proposal.effort,
      effort: selected.effort,
      effortReason: `${selected.reason} 제안 근거: ${proposal.reason}`,
      effortPolicyVersion: selected.policyVersion,
      startedAt: now,
    })
    .run();
  db.update(runs)
    .set({ effort: selected.effort })
    .where(and(eq(runs.id, run.id), eq(runs.status, "running")))
    .run();
}
