import { AnalysisError, redactOutput, type AnalysisEvent, type AnalysisExecutor, type AnalysisUsage } from "./analysis.js";
import type { TaskStatus } from "../tasks/task-state.js";

export type ClaimedRun = { id: string; taskId: string; instruction: string };
export type RunCompletion = {
  status: Exclude<TaskStatus, "queued" | "running">;
  result: string | null;
  errorCode: string | null;
  usage: AnalysisUsage | null;
};
export type RunStore = {
  claim(taskId: string, model: string): ClaimedRun;
  record(runId: string, event: AnalysisEvent): void;
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
  const { promise: interrupted, resolve: stopWaiting } = Promise.withResolvers<null>();
  const abort = () => {
    acceptingEvents = false;
    stopWaiting(null);
    controller.abort();
  };
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) { timedOut = true; abort(); }
  }, options.timeoutMs);
  let completion: RunCompletion;
  try {
    controller.signal.throwIfAborted();
    // 중단 신호에 응답하지 않는 실행도 기다림을 끝냅니다. Promise.race는 뒤늦은 실패도 처리합니다.
    const result = await Promise.race([
      executor.analyze({
        instruction: run.instruction, workspace: options.workspace, model: options.model, signal: controller.signal,
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
      // SDK는 자식 명령 전체의 종료를 보장하는 API가 없어 후속 실행을 보류합니다.
      completion = { status: "interrupted", result: null, errorCode: timedOut ? "timeout" : "cancel_requested", usage: null };
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
  store.finish(run.id, completion);
  return { runId: run.id, ...completion };
}
