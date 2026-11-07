import type { AnalysisWorkflowPolicy } from "./analysis-workflow.js";
import type { EffortPolicy } from "./effort-policy.js";
import type { Effort } from "@agent-hub/contracts";
import { AnalysisError, redactOutput, signalStopReason, type AnalysisEvent, type AnalysisExecutor, type AnalysisUsage, type StopReason } from "./analysis.js";
import type { TaskStatus } from "../tasks/task-state.js";
import type { ProviderGateView } from "./provider-gate.js";
import type { GoalScope } from "../goals/prepared-workspace.js";
import type { PlanningContext } from "../goals/goal-plan-policy.js";

export type ClaimedRun = { id: string; taskId: string; instruction: string; effort?: Effort; effortPolicy?: EffortPolicy; workflow?: AnalysisWorkflowPolicy; providerCheck?: boolean; remainingRunMs?: number; budgetDeadlineAt?: number; budgetRunMs?: number; scope?: GoalScope; planning?: PlanningContext; runtimeSkillVersion?: number };
export type RunCompletion = {
  status: Exclude<TaskStatus, "queued" | "running">;
  result: string | null;
  errorCode: string | null;
  usage: AnalysisUsage | null;
  terminationConfirmedAt?: Date | null;
  retryAt?: Date | null;
};

export function requireTermination(completion: RunCompletion): RunCompletion {
  return completion.terminationConfirmedAt ? completion : {
    ...completion, status: "interrupted", errorCode: completion.errorCode ?? "termination_unconfirmed",
  };
}

export function settleStoppedCompletion(completion: RunCompletion, reason: StopReason | null, cancelled: boolean): RunCompletion {
  if (cancelled || reason === "user_cancel") {
    return { ...completion, status: completion.terminationConfirmedAt ? "cancelled" : "interrupted", errorCode: "cancel_requested" };
  }
  if (reason === "scope_changed") return { ...completion, status: completion.terminationConfirmedAt ? "cancelled" : "interrupted", result: null, errorCode: "scope_changed" };
  if (completion.status === "interrupted" && completion.terminationConfirmedAt) {
    if (reason === "timeout") return { ...completion, status: "failed", errorCode: "timeout" };
    if (reason === "budget_limit") return { ...completion, status: "waiting_capacity", errorCode: "budget_limit" };
    if (reason === "server_shutdown") return { ...completion, status: "waiting_retry", errorCode: "server_shutdown" };
  }
  return completion;
}
export type RunStore = {
  claim(taskId: string, model: string, runtimeSkillVersion?: number): ClaimedRun;
  record(runId: string, event: AnalysisEvent): void;
  requestStop(runId: string, reason: StopReason): StopReason;
  requestedStop?(runId: string): StopReason | null;
  finish(runId: string, completion: RunCompletion): RunCompletion;
};

export type QueueClaim =
  | { kind: "claimed"; run: ClaimedRun; workspaceKey: string }
  | { kind: "held"; runId: string; reason: string }
  | { kind: "idle"; reason?: string };
export type QueueStore = RunStore & {
  claimNext(model: string, workspaceKeys: string[], runtimeSkillVersion?: number): QueueClaim;
};

export type RunSummary = {
  id: string; taskId: string; attempt: number; status: TaskStatus; model: string; effort: string;
  startedAt: Date; finishedAt: Date | null; goalVersion?: number | null;
};
export type RunDetails = RunSummary & {
  planningEvidence?: import("@agent-hub/contracts").PlanningEvidence | null;
  developmentEvidence?: import("@agent-hub/contracts").DevelopmentEvidence | null;
  goalVerification?: import("@agent-hub/contracts").GoalVerificationEvidence | null;
  runtimeSkillVersion?: number | null;
  lastActivityAt: Date; result: string | null; errorCode: string | null;
  stopReason: StopReason | null; stopRequestedAt: Date | null; terminationConfirmedAt: Date | null;
  retryAt: Date | null;
  steps: { sequence: number; status: TaskStatus; sessionId: string | null; effort: Effort | null; effortReason: string | null; effortPolicyVersion: number | null; proposedEffort: string | null; purpose: string | null; model: string | null; assessment: import("@agent-hub/contracts").AnalysisAssessment | null; runtimeSkill?: import("@agent-hub/contracts").RuntimeSkillEvidence | null; usage: AnalysisUsage | null; startedAt: Date; finishedAt: Date | null }[];
  events: { sequence: number; kind: string; createdAt: Date }[];
};
export type RunQueries = {
  listByTask(taskId: string): RunSummary[];
  findById(id: string): RunDetails | undefined;
  getProviderGate(): ProviderGateView;
};

export async function runTask(
  options: { taskId: string; model: string; workspace: string; timeoutMs: number; signal: AbortSignal },
  store: RunStore,
  executor: AnalysisExecutor,
) {
  options.signal.throwIfAborted();
  const run = executor.runtimeSkillVersion === undefined ? store.claim(options.taskId, options.model)
    : store.claim(options.taskId, options.model, executor.runtimeSkillVersion);
  return runClaimedTask(run, options, store, executor);
}

export async function runClaimedTask(
  run: ClaimedRun,
  options: { model: string; workspace: string; timeoutMs: number; signal: AbortSignal },
  store: RunStore,
  executor: AnalysisExecutor,
) {
  const controller = new AbortController();
  let acceptingEvents = true;
  let stopReason: StopReason | null = null;
  let stopWriteError: unknown;
  let stopWriteFailed = false;
  const { promise: interrupted, resolve: stopWaiting } = Promise.withResolvers<null>();
  const requestAbort = (reason: StopReason) => {
    if (controller.signal.aborted) return;
    acceptingEvents = false;
    stopReason = reason;
    try {
      // 요청을 먼저 보존합니다. 저장 실패 시에도 실행 중단은 요청하되 보류 기록을 해제하지 않습니다.
      stopReason = store.requestStop(run.id, reason);
    } catch (error) { stopWriteFailed = true; stopWriteError = error; }
    stopWaiting(null);
    controller.abort(stopReason);
  };
  const abort = () => requestAbort(signalStopReason(options.signal));
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();
  const observeStop = () => {
    if (controller.signal.aborted) return;
    try {
      const reason = store.requestedStop?.(run.id);
      if (reason) requestAbort(reason);
    } catch { requestAbort("unknown"); }
  };
  // Also observes durable requests from another API process while a CLI Run or
  // a quiet model call emits no events. A failed read stops rather than assuming
  // the old permissions still apply.
  const stopObserver = store.requestedStop ? setInterval(observeStop, 500) : undefined;
  const regularLimit = Math.min(options.timeoutMs, run.remainingRunMs ?? options.timeoutMs);
  const budgetLimit = run.budgetDeadlineAt === undefined ? Infinity : Math.max(0, Math.min(run.budgetDeadlineAt - Date.now(), run.budgetRunMs ?? Infinity));
  const timer = setTimeout(() => {
    requestAbort(budgetLimit < regularLimit ? "budget_limit" : "timeout");
  }, Math.min(regularLimit, budgetLimit));
  if (budgetLimit <= 0) requestAbort("budget_limit");
  let completion: RunCompletion;
  try {
    observeStop();
    controller.signal.throwIfAborted();
    // 중단 신호에 응답하지 않는 실행도 기다림을 끝냅니다. Promise.race는 뒤늦은 실패도 처리합니다.
    const result = await Promise.race([
      executor.analyze({
        ...(run.runtimeSkillVersion !== undefined ? { runtimeSkillVersion: run.runtimeSkillVersion, stepSequence: 1 } : {}),
        instruction: run.instruction, workspace: options.workspace, model: options.model, signal: controller.signal, runId: run.id, effort: run.effort ?? "medium", ...(run.effortPolicy ? { effortPolicy: run.effortPolicy } : {}), ...(run.workflow ? { workflow: run.workflow } : {}), ...(run.scope ? { scope: run.scope } : {}), ...(run.planning ? { planning: run.planning } : {}),
      }, (event) => {
        observeStop();
        if (acceptingEvents && !controller.signal.aborted) store.record(run.id, event);
      }),
      interrupted,
    ]);
    if (result === null || controller.signal.aborted) throw new Error("Execution interrupted");
    if (!result.output.trim() || Buffer.byteLength(result.output) > 65536) throw new AnalysisError("output_limit");
    completion = { status: "succeeded", result: redactOutput(result.output), errorCode: null, usage: result.usage };
  } catch (error) {
    if (controller.signal.aborted) {
      // 중단 사유를 먼저 보존하고, 컨테이너 실행의 실제 종료는 아래에서 따로 관측합니다.
      const errorCode = stopReason === "timeout" ? "timeout" : stopReason === "budget_limit" ? "budget_limit" : stopReason === "server_shutdown" ? "server_shutdown" : stopReason === "scope_changed" ? "scope_changed" : stopReason === "unknown" ? "stop_reason_unknown" : "cancel_requested";
      completion = { status: "interrupted", result: null, errorCode, usage: null };
    } else {
      const code = error instanceof AnalysisError ? error.code : "execution_error";
      const status = !(error instanceof AnalysisError) || error.completionUncertain ? "interrupted"
        : ["authentication", "unsupported_settings", "invalid_plan", "invalid_change", "workflow_limit", "analysis_incomplete", "input_unavailable", "input_changed", "goal_changed"].includes(code) ? "blocked"
        : code === "capacity" || code === "budget_limit" ? "waiting_capacity" : "failed";
      completion = { status, result: null, errorCode: code, usage: null, retryAt: error instanceof AnalysisError ? error.retryAt : null };
    }
  } finally {
    acceptingEvents = false;
    clearTimeout(timer);
    clearInterval(stopObserver);
    options.signal.removeEventListener("abort", abort);
  }
  if (executor.confirmTermination) {
    // 외부 관측은 DB 트랜잭션 밖에서 제한 시간 안에 수행합니다.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      completion.terminationConfirmedAt = await Promise.race([
        executor.confirmTermination(run.id).catch(() => null),
        new Promise<null>(resolve => { deadline = setTimeout(() => resolve(null), 8000); }),
      ]);
    } finally { clearTimeout(deadline); }
  }
  if (executor.confirmTermination || run.providerCheck) completion = requireTermination(completion);
  if (stopWriteFailed) throw stopWriteError;
  const saved = store.finish(run.id, completion);
  if (saved.terminationConfirmedAt) await executor.cleanup?.(run.id);
  return { runId: run.id, ...saved };
}
