import { assignableGoal, readGoalExecutionBlock } from "../goals/goal-execution-store.js";
import { saveWorkflowStep } from "./workflow-step-store.js";
import type { ExecutionConfig } from "./execution-config.js";
import { defaultEffortPolicy, selectInitialEffort } from "./effort-policy.js";
import { ensureRetryState } from "./retry-state-store.js";
import { retryLimitReason } from "./retry-policy.js";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { events, projects, providerGates, runs, steps, tasks } from "../../db/schema.js";
import type { AnalysisEvent, StopReason } from "./analysis.js";
import { requireTermination, settleStoppedCompletion, type QueueClaim, type RunCompletion } from "./run-task.js";
import { providerGateView, providerScope, readProviderGate, recordProviderOutcome, reserveProviderCheck } from "./provider-gate.js";
import { assertExecutionOwner } from "./execution-owner.js";
import { saveRunCompletion } from "./run-completion-store.js";

export const unresolvedRun = sql`${runs.status} = 'running' OR (${runs.status} IN ('interrupted', 'blocked', 'waiting_capacity') AND ${runs.terminationConfirmedAt} IS NULL)`;

export function createDrizzleRunStore(db: ReturnType<typeof openDatabase>["db"], ownerToken?: string, policies: Pick<ExecutionConfig, "automaticRecovery" | "capacityRecovery" | "effortPolicy" | "analysisWorkflow"> = {}) {
  const instanceId = ownerToken ?? randomUUID();
  type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

  function assertOwner(tx: Transaction) {
    assertExecutionOwner(tx, ownerToken);
  }

  function claim(model: string, selection: { taskId: string } | { workspaceKeys: string[] }): QueueClaim {
    return db.transaction((tx) => {
      assertOwner(tx);
      const held = tx.select({ id: runs.id, status: runs.status }).from(runs)
        .where(unresolvedRun)
        .orderBy(asc(runs.startedAt), asc(runs.id)).get();
      if (held) return { kind: "held", runId: held.id, reason: held.status };
      const gate = readProviderGate(tx);
      const probing = gate?.blocked === true;
      if (probing && (!gate.probeTaskId || gate.probeRunId || (gate.retryAt && gate.retryAt > new Date())
        || ("taskId" in selection && selection.taskId !== gate.probeTaskId))) {
        return { kind: "held", runId: gate.sourceRunId!, reason: `provider_${gate.reason}` };
      }
      if (probing && gate.reason === "capacity" && gate.capacityState &&
        (gate.capacityState.checks >= gate.capacityState.policy.maxChecks || (gate.capacityState.nextCheckAt && Date.parse(gate.capacityState.nextCheckAt) > Date.now()))) {
        return { kind: "held", runId: gate.sourceRunId!, reason: "provider_capacity" };
      }
      if ("workspaceKeys" in selection && selection.workspaceKeys.length === 0) {
        return probing ? { kind: "held", runId: gate.sourceRunId!, reason: "provider_check_unavailable" } : { kind: "idle" };
      }
      const selectedId = probing ? gate.probeTaskId! : "taskId" in selection ? selection.taskId : undefined;
      const task = tx.select({ id: tasks.id, projectId: tasks.projectId, kind: tasks.kind, goalId: tasks.goalId, goalVersion: tasks.goalVersion, instruction: tasks.instruction, status: tasks.status, cancelRequestedAt: tasks.cancelRequestedAt, workspaceKey: projects.workspaceKey })
        .from(tasks).innerJoin(projects, eq(tasks.projectId, projects.id))
        .where(selectedId ? eq(tasks.id, selectedId)
          : and(eq(tasks.status, "queued"), sql`${tasks.cancelRequestedAt} IS NULL`, assignableGoal, inArray(projects.workspaceKey, "workspaceKeys" in selection ? selection.workspaceKeys : [])))
        .orderBy(asc(tasks.createdAt), asc(tasks.id)).get();
      if (!task) {
        if ("taskId" in selection) throw new Error("Task not found");
        return { kind: "idle" };
      }
      if (probing && (task.status !== "queued" || ("workspaceKeys" in selection && !selection.workspaceKeys.includes(task.workspaceKey)))) {
        return { kind: "held", runId: gate.sourceRunId!, reason: "provider_check_unavailable" };
      }
      const goalBlock = readGoalExecutionBlock(tx, task);
      if (goalBlock) {
        if (probing) return { kind: "held", runId: gate.sourceRunId!, reason: goalBlock.toLowerCase() };
        throw new Error(goalBlock);
      }
      if (task.status !== "queued") throw new Error("Only queued tasks can be started");
      if (task.cancelRequestedAt) throw new Error("Cancelled tasks cannot be started");
      const id = randomUUID();
      const now = new Date();
      const attempt = (tx.select({ value: sql<number>`max(${runs.attempt})` }).from(runs).where(eq(runs.taskId, task.id)).get()?.value ?? 0) + 1;
      const retryState = ensureRetryState(tx, task.id, policies.automaticRecovery);
      if (retryState) {
        const reason = attempt > 1 ? retryLimitReason(retryState) : retryState.totalRunMs >= retryState.policy.maxTotalRunMs ? "task_time_limit" : null;
        if (reason) {
          tx.update(tasks).set({ status: "blocked", retryState: { ...retryState, reason, nextAttemptAt: null } }).where(eq(tasks.id, task.id)).run();
          return { kind: "idle" };
        }
        if (retryState.nextAttemptAt && Date.parse(retryState.nextAttemptAt) > now.getTime()) return { kind: "idle" };
        tx.update(tasks).set({ retryState: { ...retryState, retries: retryState.retries + (attempt > 1 ? 1 : 0), nextAttemptAt: null, reason: null } }).where(eq(tasks.id, task.id)).run();
      }
      tx.update(tasks).set({ status: "running" }).where(eq(tasks.id, task.id)).run();
      const effortPolicy = policies.effortPolicy ?? defaultEffortPolicy;
      const effortSelection = selectInitialEffort(task.instruction, effortPolicy);
      tx.insert(runs).values({ id, taskId: task.id, attempt, goalVersion: task.goalVersion, instanceId, status: "running", model, effort: effortSelection.effort, effortPolicy, workflowPolicy: policies.analysisWorkflow, startedAt: now, lastActivityAt: now,
        providerGateVersion: probing ? gate.version : null }).run();
      if (probing) tx.update(providerGates).set({ probeRunId: id, ...(gate.reason === "capacity" && gate.capacityState ? { capacityState: { ...gate.capacityState, checks: gate.capacityState.checks + 1, nextCheckAt: null, reason: "checking" } } : {}) }).where(eq(providerGates.scope, providerScope)).run();
      tx.insert(steps).values({ id: randomUUID(), runId: id, sequence: 1, status: "running", startedAt: now, effort: effortSelection.effort, effortReason: effortSelection.reason, effortPolicyVersion: effortSelection.policyVersion }).run();
      tx.insert(events).values({ id: randomUUID(), runId: id, sequence: 1, kind: "run.started", createdAt: now }).run();
      return { kind: "claimed", run: { id, taskId: task.id, instruction: task.instruction, effort: effortSelection.effort, effortPolicy, ...(policies.analysisWorkflow ? { workflow: policies.analysisWorkflow } : {}), ...(retryState ? { remainingRunMs: Math.max(1, retryState.policy.maxTotalRunMs - retryState.totalRunMs) } : {}), ...(probing ? { providerCheck: true } : {}) }, workspaceKey: task.workspaceKey };
    }, { behavior: "immediate" });
  }

  return {
    claim(taskId: string, model: string) {
      const result = claim(model, { taskId });
      if (result.kind !== "claimed") throw new Error("A previous run needs completion or recovery before starting another run");
      return result.run;
    },
    claimNext(model: string, workspaceKeys: string[]) {
      return claim(model, { workspaceKeys });
    },
    getProviderGate() { return providerGateView(db); },
    reserveProviderCheck(taskId: string, expectedVersion: number, now = new Date()) {
      db.transaction(tx => {
        assertOwner(tx);
        if (tx.select({ id: runs.id }).from(runs).where(unresolvedRun).get()) throw new Error("Execution termination must be confirmed first");
        const task = tx.select().from(tasks).where(eq(tasks.id, taskId)).get();
        if (!task || task.status !== "queued" || task.cancelRequestedAt) throw new Error("Only uncancelled queued tasks can confirm provider recovery");
        const goalBlock = readGoalExecutionBlock(tx, task);
        if (goalBlock) throw new Error(goalBlock);
        reserveProviderCheck(tx, taskId, expectedVersion, now);
      }, { behavior: "immediate" });
    },
    requestStop(runId: string, reason: StopReason): StopReason {
      return db.transaction((tx) => {
        assertOwner(tx);
        const run = tx.select().from(runs).where(and(eq(runs.id, runId), eq(runs.instanceId, instanceId), eq(runs.status, "running"))).get();
        if (!run) throw new Error("Cannot stop a run not owned by this executor");
        if (run.stopReason) return run.stopReason;
        const now = new Date();
        tx.update(runs).set({ stopReason: reason, stopRequestedAt: now }).where(eq(runs.id, runId)).run();
        if (reason === "user_cancel") tx.update(tasks).set({ cancelRequestedAt: now }).where(eq(tasks.id, run.taskId)).run();
        return reason;
      }, { behavior: "immediate" });
    },
    record(runId: string, event: AnalysisEvent) {
      db.transaction((tx) => {
        assertOwner(tx);
        const run = tx.select().from(runs).where(and(eq(runs.id, runId), eq(runs.instanceId, instanceId), eq(runs.status, "running"))).get();
        if (!run) throw new Error("Run is no longer active");
        if (event.execution) {
          if (run.execution) throw new Error("Execution identity is already assigned");
          tx.update(runs).set({ execution: event.execution }).where(eq(runs.id, runId)).run();
        }
        const now = new Date();
        tx.update(runs).set({ lastActivityAt: now }).where(eq(runs.id, runId)).run();
        if (event.step) saveWorkflowStep(tx, run, event.step, now);
        if (event.sessionId) tx.update(steps).set({ sessionId: event.sessionId }).where(and(eq(steps.runId, runId), eq(steps.status, "running"))).run();
        const last = tx.select({ sequence: sql<number>`max(${events.sequence})` }).from(events).where(eq(events.runId, runId)).get();
        const sequence = (last?.sequence ?? 0) + 1;
        if (sequence <= 1000) tx.insert(events).values({
          id: randomUUID(), runId, sequence, kind: event.kind.slice(0, 100), createdAt: now,
        }).run();
      }, { behavior: "immediate" });
    },
    finish(runId: string, completion: RunCompletion) {
      return db.transaction((tx) => {
        assertOwner(tx);
        const run = tx.select().from(runs).where(and(eq(runs.id, runId), eq(runs.instanceId, instanceId), eq(runs.status, "running"))).get();
        if (!run) throw new Error("Cannot finish a run not owned by this executor");
        if (run.workflowPolicy && completion.status === "succeeded") {
          const lastStep = tx.select().from(steps).where(eq(steps.runId, runId)).orderBy(desc(steps.sequence)).get();
          if (!lastStep?.assessment?.complete || lastStep.assessment.report !== completion.result) completion = { ...completion, status: "blocked", result: null, errorCode: "invalid_plan" };
        }
        if (run.providerGateVersion !== null) completion = requireTermination(completion);
        const task = tx.select({ cancelRequestedAt: tasks.cancelRequestedAt }).from(tasks).where(eq(tasks.id, run.taskId)).get()!;
        completion = settleStoppedCompletion(completion, run.stopReason, task.cancelRequestedAt !== null);
        const now = new Date();
        saveRunCompletion(tx, run, completion, now);
        recordProviderOutcome(tx, run, completion, now, policies.capacityRecovery);
        return completion;
      }, { behavior: "immediate" });
    },
    listByTask(taskId: string) {
      return db.select({ id: runs.id, taskId: runs.taskId, attempt: runs.attempt, goalVersion: runs.goalVersion, status: runs.status, model: runs.model, effort: runs.effort, startedAt: runs.startedAt, finishedAt: runs.finishedAt })
        .from(runs).where(eq(runs.taskId, taskId)).orderBy(desc(runs.attempt)).all();
    },
    findById(id: string) {
      const run = db.select().from(runs).where(eq(runs.id, id)).get();
      if (!run) return undefined;
      return {
        id: run.id, taskId: run.taskId, attempt: run.attempt, goalVersion: run.goalVersion, status: run.status, model: run.model, effort: run.effort,
        startedAt: run.startedAt, finishedAt: run.finishedAt, lastActivityAt: run.lastActivityAt,
        result: run.result, errorCode: run.errorCode,
        stopReason: run.stopReason, stopRequestedAt: run.stopRequestedAt, terminationConfirmedAt: run.terminationConfirmedAt, retryAt: run.retryAt,
        steps: db.select({ sequence: steps.sequence, status: steps.status, sessionId: steps.sessionId, effort: steps.effort, effortReason: steps.effortReason, effortPolicyVersion: steps.effortPolicyVersion, proposedEffort: steps.proposedEffort, purpose: steps.purpose, model: steps.model, assessment: steps.assessment, usage: steps.usage, startedAt: steps.startedAt, finishedAt: steps.finishedAt })
          .from(steps).where(eq(steps.runId, id)).orderBy(asc(steps.sequence)).all(),
        events: db.select({ sequence: events.sequence, kind: events.kind, createdAt: events.createdAt })
          .from(events).where(eq(events.runId, id)).orderBy(asc(events.sequence)).all(),
      };
    },
  };
}
