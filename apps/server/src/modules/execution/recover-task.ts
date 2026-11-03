import { recoveryActions, type RecoveryAction } from "@agent-hub/contracts";
export { recoveryActions, type RecoveryAction };
import type { AnalysisUsage, ExecutionIdentity, StopReason } from "./analysis.js";
import type { TaskStatus } from "../tasks/task-state.js";
import { settleStoppedCompletion, type RunCompletion } from "./run-task.js";

export type RecoveryInput = { taskId: string; runId: string | null; requestKey: string; action: RecoveryAction; providerGateVersion: number | null };
export type RecoveryRequest = RecoveryInput & {
  id: string; status: "pending" | "completed" | "rejected"; resultStatus: TaskStatus | null;
  errorCode: string | null; createdAt: Date; finishedAt: Date | null;
};
export class RecoveryError extends Error {
  constructor(public readonly code: string) { super(code); }
}

export type RecoveryStore = {
  request(input: RecoveryInput, activeRunId: string | null, canTrackTermination: boolean): { request: RecoveryRequest; created: boolean };
  findById(id: string): RecoveryRequest | undefined;
  nextPending(): RecoveryRequest | undefined;
  candidate(id: string): { request: RecoveryRequest; run: { execution: ExecutionIdentity | null; terminationConfirmedAt: Date | null } | null } | undefined;
  complete(id: string, terminationConfirmedAt: Date | null): { proofSaved: boolean };
};
export type ExecutionObserver = {
  confirm: (identity: ExecutionIdentity) => Promise<Date | null>;
  cleanup: (identity: ExecutionIdentity) => Promise<void>;
};

export function reconcileCompletion(
  run: { status: TaskStatus; stopReason: StopReason | null; result: string | null; errorCode: string | null; retryAt: Date | null },
  usage: AnalysisUsage | null,
  confirmedAt: Date | null,
  cancelled: boolean,
): RunCompletion {
  let completion: RunCompletion = {
    status: run.status === "running" || run.status === "queued" ? "interrupted" : run.status,
    result: run.result, errorCode: run.errorCode ?? "owner_lost", usage, retryAt: run.retryAt,
    terminationConfirmedAt: confirmedAt,
  };
  completion = settleStoppedCompletion(completion, run.stopReason, cancelled);
  if (!confirmedAt || completion.status !== "interrupted") return completion;
  if (run.stopReason === "unknown") return { ...completion, status: "blocked", errorCode: "stop_reason_unknown" };
  if (run.result && run.errorCode === "termination_unconfirmed") return { ...completion, status: "succeeded", errorCode: null };
  if (run.errorCode === "capacity" || run.errorCode === "budget_limit") return { ...completion, status: "waiting_capacity" };
  if (run.status === "running" || run.errorCode === "owner_lost") return { ...completion, status: "waiting_retry", errorCode: "owner_lost" };
  return { ...completion, status: "blocked" };
}

export function createRecoveryProcessor(store: RecoveryStore, observer: ExecutionObserver, cleanupRun?: (runId: string) => void) {
  return {
    next: () => store.nextPending(),
    async process(id: string) {
      const candidate = store.candidate(id);
      if (!candidate) return;
      let confirmedAt = candidate.run?.terminationConfirmedAt ?? null;
      if (candidate.run?.execution && !confirmedAt) {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          confirmedAt = await Promise.race([
            observer.confirm(candidate.run.execution).catch(() => null),
            new Promise<null>(resolve => { deadline = setTimeout(() => resolve(null), 8000); }),
          ]);
        } finally { clearTimeout(deadline); }
      }
      // DB 저장에 실패하면 종료된 컨테이너도 보존하여 재시작 뒤 다시 관측할 수 있게 합니다.
      const result = store.complete(id, confirmedAt);
      if (result.proofSaved && candidate.run?.execution) await observer.cleanup(candidate.run.execution);
      if (result.proofSaved && candidate.request.runId) cleanupRun?.(candidate.request.runId);
    },
  };
}
