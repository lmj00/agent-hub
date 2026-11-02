import { setTimeout as delay } from "node:timers/promises";
import type { AnalysisExecutor } from "./analysis.js";
import type { ExecutionConfig } from "./execution-config.js";
import { runClaimedTask, type QueueStore } from "./run-task.js";
import { createQueueDiagnostics, type QueueDiagnostic, type QueueDiagnosticContext } from "./execution-diagnostics.js";

export type QueueStatus = {
  state: "disabled" | "idle" | "running" | "held" | "error" | "stopping" | "stopped";
  runId: string | null;
  taskId: string | null;
  reason: string | null;
  lastCheckedAt: string | null;
};

export function createExecutionQueue(options: {
  store: QueueStore;
  executor: AnalysisExecutor;
  config: ExecutionConfig;
  validate: () => void;
  reportDiagnostic: (diagnostic: QueueDiagnostic) => void;
  pollIntervalMs?: number;
}) {
  const controller = new AbortController();
  let started = false;
  let loop = Promise.resolve();
  let status: QueueStatus = { state: "idle", runId: null, taskId: null, reason: null, lastCheckedAt: null };
  const diagnostics = createQueueDiagnostics(options.reportDiagnostic);

  async function poll() {
    while (!controller.signal.aborted) {
      status.lastCheckedAt = new Date().toISOString();
      let phase: QueueDiagnosticContext["phase"] = "validation";
      let runId: string | null = null;
      let taskId: string | null = null;
      try {
        options.validate();
        diagnostics.recovered("validation");
        phase = "claim";
        const claim = options.store.claimNext(options.config.model, [...options.config.workspaces.keys()]);
        diagnostics.recovered("claim");
        if (claim.kind === "claimed") {
          phase = "execution";
          runId = claim.run.id;
          taskId = claim.run.taskId;
          status = { ...status, state: "running", runId: claim.run.id, taskId: claim.run.taskId, reason: null };
          await runClaimedTask(claim.run, {
            model: options.config.model,
            workspace: options.config.workspaces.get(claim.workspaceKey)!,
            timeoutMs: options.config.timeoutMs,
            signal: controller.signal,
          }, options.store, options.executor);
          diagnostics.recovered("execution");
          // 다음 순회에서 최종 상태와 보류 여부를 DB에서 확인합니다.
          if (!controller.signal.aborted) continue;
        } else if (claim.kind === "held") {
          status = { ...status, state: "held", runId: claim.runId, taskId: null, reason: claim.reason };
        } else {
          status = { ...status, state: "idle", runId: null, taskId: null, reason: null };
        }
      } catch (error) {
        // 설정·저장 오류는 호출 없이 다시 확인하며, API에서 조치가 필요한 상태를 보여줍니다.
        const reason = phase === "validation" ? "configuration_invalid" : "storage_error";
        status = { ...status, state: "error", runId, taskId, reason };
        diagnostics.failure(error, { phase, reason, runId, taskId });
      }
      if (!controller.signal.aborted) {
        try { await delay(options.pollIntervalMs ?? 1000, undefined, { signal: controller.signal }); }
        catch (error) { if (!controller.signal.aborted) throw error; }
      }
    }
    status = { ...status, state: "stopped" };
  }

  return {
    start() {
      if (started || controller.signal.aborted) return;
      started = true;
      loop = poll();
    },
    getStatus(): QueueStatus { return { ...status }; },
    async stop() {
      if (!controller.signal.aborted) {
        status = { ...status, state: "stopping" };
        controller.abort();
      }
      await loop;
      status = { ...status, state: "stopped" };
    },
  };
}
