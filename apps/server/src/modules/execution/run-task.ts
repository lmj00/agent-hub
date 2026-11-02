import { AnalysisError, redactOutput, signalStopReason, type AnalysisEvent, type AnalysisExecutor, type AnalysisUsage, type StopReason } from "./analysis.js";
import type { TaskStatus } from "../tasks/task-state.js";

export type ClaimedRun = { id: string; taskId: string; instruction: string };
export type RunCompletion = {
  status: Exclude<TaskStatus, "queued" | "running">;
  result: string | null;
  errorCode: string | null;
  usage: AnalysisUsage | null;
  terminationConfirmedAt?: Date | null;
};
export type RunStore = {
  claim(taskId: string, model: string): ClaimedRun;
  record(runId: string, event: AnalysisEvent): void;
  requestStop(runId: string, reason: StopReason): StopReason;
  finish(runId: string, completion: RunCompletion): void;
};

export type QueueClaim =
  | { kind: "claimed"; run: ClaimedRun; workspaceKey: string }
  | { kind: "held"; runId: string; reason: string }
  | { kind: "idle" };
export type QueueStore = RunStore & {
  claimNext(model: string, workspaceKeys: string[]): QueueClaim;
};

export type RunSummary = {
  id: string; taskId: string; status: TaskStatus; model: string; effort: string;
  startedAt: Date; finishedAt: Date | null;
};
export type RunDetails = RunSummary & {
  lastActivityAt: Date; result: string | null; errorCode: string | null;
  stopReason: StopReason | null; stopRequestedAt: Date | null; terminationConfirmedAt: Date | null;
  steps: { sequence: number; status: TaskStatus; sessionId: string | null; usage: AnalysisUsage | null; startedAt: Date; finishedAt: Date | null }[];
  events: { sequence: number; kind: string; createdAt: Date }[];
};
export type RunQueries = {
  listByTask(taskId: string): RunSummary[];
  findById(id: string): RunDetails | undefined;
};

export async function runTask(
  options: { taskId: string; model: string; workspace: string; timeoutMs: number; signal: AbortSignal },
  store: RunStore,
  executor: AnalysisExecutor,
) {
  options.signal.throwIfAborted();
  const run = store.claim(options.taskId, options.model);
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
  const timer = setTimeout(() => {
    requestAbort("timeout");
  }, options.timeoutMs);
  let completion: RunCompletion;
  try {
    controller.signal.throwIfAborted();
    // 중단 신호에 응답하지 않는 실행도 기다림을 끝냅니다. Promise.race는 뒤늦은 실패도 처리합니다.
    const result = await Promise.race([
      executor.analyze({
        instruction: run.instruction, workspace: options.workspace, model: options.model, signal: controller.signal, runId: run.id,
      }, (event) => {
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
      const errorCode = stopReason === "timeout" ? "timeout" : stopReason === "server_shutdown" ? "server_shutdown" : "cancel_requested";
      completion = { status: "interrupted", result: null, errorCode, usage: null };
    } else {
      const code = error instanceof AnalysisError ? error.code : "execution_error";
      const status = !(error instanceof AnalysisError) || error.completionUncertain ? "interrupted"
        : code === "authentication" || code === "unsupported_settings" ? "blocked"
        : code === "capacity" ? "waiting_capacity" : "failed";
      completion = { status, result: null, errorCode: code, usage: null };
    }
  } finally {
    acceptingEvents = false;
    clearTimeout(timer);
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
    if (!completion.terminationConfirmedAt) {
      completion.status = "interrupted";
      completion.errorCode ??= "termination_unconfirmed";
    }
  }
  if (stopWriteFailed) throw stopWriteError;
  store.finish(run.id, completion);
  if (completion.terminationConfirmedAt) await executor.cleanup?.(run.id);
  return { runId: run.id, ...completion };
}
