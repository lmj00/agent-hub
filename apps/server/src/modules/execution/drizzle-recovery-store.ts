import { retryLimitReason } from "./retry-policy.js";
import { accountRunDuration } from "./retry-state-store.js";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { providerGates, recoveryRequests, runs, steps, tasks } from "../../db/schema.js";
import { assertExecutionOwner } from "./execution-owner.js";
import { unresolvedRun } from "./drizzle-run-store.js";
import { ProviderGateError, providerScope, readProviderGate, recordProviderOutcome, reserveProviderCheck } from "./provider-gate.js";
import { reconcileCompletion, RecoveryError, type RecoveryStore } from "./recover-task.js";
import { saveRunCompletion } from "./run-completion-store.js";

type Db = ReturnType<typeof openDatabase>["db"];
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

function latestRun(db: Pick<Db, "select">, taskId: string) {
  return db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(desc(runs.attempt)).get();
}

function cancelPendingProbe(tx: Transaction, taskId: string) {
  const gate = readProviderGate(tx);
  if (gate?.blocked && gate.probeTaskId === taskId && !gate.probeRunId) {
    tx.update(providerGates).set({ version: gate.version + 1, probeTaskId: null }).where(eq(providerGates.scope, providerScope)).run();
  }
}

export function createDrizzleRecoveryStore(db: Db, ownerToken?: string): RecoveryStore {
  return {
    request(input, activeRunId, canTrackTermination) {
      return db.transaction(tx => {
        assertExecutionOwner(tx, ownerToken);
        const existing = tx.select().from(recoveryRequests).where(and(eq(recoveryRequests.taskId, input.taskId), eq(recoveryRequests.requestKey, input.requestKey))).get();
        if (existing) {
          if (existing.action !== input.action || existing.runId !== input.runId || existing.providerGateVersion !== input.providerGateVersion) throw new RecoveryError("REQUEST_KEY_CONFLICT");
          return { request: existing, created: false };
        }
        const task = tx.select().from(tasks).where(eq(tasks.id, input.taskId)).get();
        if (!task) throw new RecoveryError("TASK_NOT_FOUND");
        const run = latestRun(tx, task.id);
        if ((run?.id ?? null) !== input.runId) throw new RecoveryError("STALE_RUN");
        if (task.status === "succeeded") throw new RecoveryError("TASK_ALREADY_COMPLETED");
        if (input.action !== "cancel" && (task.cancelRequestedAt || task.status === "cancelled")) throw new RecoveryError("TASK_CANCELLED");
        if (input.action !== "cancel" && run && run.id === activeRunId) throw new RecoveryError("RUN_ACTIVE");
        if (input.action === "reconcile" && !run) throw new RecoveryError("NO_RUN");
        if (input.action === "resume") {
          if (task.retryState && retryLimitReason(task.retryState)) throw new RecoveryError("RECOVERY_LIMIT_REACHED");
          if (task.retryState?.nextAttemptAt && Date.parse(task.retryState.nextAttemptAt) > Date.now()) throw new RecoveryError("RETRY_TOO_EARLY");
          if (!canTrackTermination) throw new RecoveryError("TERMINATION_TRACKING_REQUIRED");
          const gate = readProviderGate(tx);
          if ((gate?.blocked && input.providerGateVersion === null)
            || (input.providerGateVersion !== null && input.providerGateVersion !== (gate?.version ?? 0))) throw new RecoveryError("GATE_CHANGED");
          if (gate?.blocked && gate.retryAt && gate.retryAt > new Date()) throw new RecoveryError("RETRY_TOO_EARLY");
          if (gate?.blocked && gate.reason === "capacity" && gate.capacityState) {
            if (gate.capacityState.checks >= gate.capacityState.policy.maxChecks) throw new RecoveryError("RECOVERY_LIMIT_REACHED");
            if (gate.capacityState.nextCheckAt && Date.parse(gate.capacityState.nextCheckAt) > Date.now()) throw new RecoveryError("RETRY_TOO_EARLY");
          }
          if (gate?.probeTaskId && gate.probeRunId !== run?.id) throw new RecoveryError("PROVIDER_CHECK_RESERVED");
          if (task.status === "queued" && !gate?.blocked) throw new RecoveryError("TASK_ALREADY_QUEUED");
        }
        const pending = tx.select().from(recoveryRequests).where(and(eq(recoveryRequests.taskId, task.id), eq(recoveryRequests.status, "pending"))).get();
        const now = new Date();
        if (pending) {
          if (input.action !== "cancel" || pending.action === "cancel") throw new RecoveryError("RECOVERY_IN_PROGRESS");
          // 취소 의도는 관측 중인 재개 요청보다 우선합니다. 옛 처리자는 pending을 다시 대조합니다.
          tx.update(recoveryRequests).set({ status: "rejected", errorCode: "TASK_CANCELLED", finishedAt: now }).where(eq(recoveryRequests.id, pending.id)).run();
        }
        if (input.action === "cancel") {
          tx.update(tasks).set({ cancelRequestedAt: task.cancelRequestedAt ?? now }).where(eq(tasks.id, task.id)).run();
          if (run?.status === "running" && !run.stopReason) {
            tx.update(runs).set({ stopReason: "user_cancel", stopRequestedAt: now }).where(eq(runs.id, run.id)).run();
          }
          cancelPendingProbe(tx, task.id);
        }
        const immediateCancel = input.action === "cancel" && !run;
        if (immediateCancel) tx.update(tasks).set({ status: "cancelled" }).where(eq(tasks.id, task.id)).run();
        const created = tx.insert(recoveryRequests).values({
          ...input, id: randomUUID(), status: immediateCancel ? "completed" : "pending",
          resultStatus: immediateCancel ? "cancelled" : null, createdAt: now, finishedAt: immediateCancel ? now : null,
        }).returning().get()!;
        return { request: created, created: true };
      }, { behavior: "immediate" });
    },
    findById(id) { return db.select().from(recoveryRequests).where(eq(recoveryRequests.id, id)).get(); },
    nextPending() {
      return db.select().from(recoveryRequests).where(eq(recoveryRequests.status, "pending")).orderBy(asc(recoveryRequests.createdAt), asc(recoveryRequests.id)).get();
    },
    candidate(id) {
      return db.transaction(tx => {
        assertExecutionOwner(tx, ownerToken);
        const request = tx.select().from(recoveryRequests).where(eq(recoveryRequests.id, id)).get();
        if (!request || request.status !== "pending") return undefined;
        const run = latestRun(tx, request.taskId);
        return { request, run: run?.id === request.runId ? run : null };
      });
    },
    complete(id, confirmedAt) {
      return db.transaction(tx => {
        assertExecutionOwner(tx, ownerToken);
        const request = tx.select().from(recoveryRequests).where(eq(recoveryRequests.id, id)).get();
        if (!request || request.status !== "pending") return { proofSaved: false };
        const task = tx.select().from(tasks).where(eq(tasks.id, request.taskId)).get()!;
        const run = latestRun(tx, task.id);
        const now = new Date();
        let proofSaved = false;
        let finalStatus = task.status;
        const finish = (errorCode: string | null) => {
          tx.update(recoveryRequests).set({ status: errorCode ? "rejected" : "completed", errorCode, resultStatus: finalStatus, finishedAt: now })
            .where(eq(recoveryRequests.id, id)).run();
          return { proofSaved };
        };
        if ((run?.id ?? null) !== request.runId) return finish("STALE_RUN");
        if (request.action !== "cancel" && (task.cancelRequestedAt || task.status === "cancelled")) return finish("TASK_CANCELLED");
        if (run) {
          const proof = run.terminationConfirmedAt ?? confirmedAt;
          if (run.status === "running" || run.status === "interrupted") {
            const usage = tx.select({ usage: steps.usage }).from(steps).where(eq(steps.runId, run.id)).orderBy(asc(steps.sequence)).get()?.usage ?? null;
            const completion = reconcileCompletion(run, usage, proof, task.cancelRequestedAt !== null);
            saveRunCompletion(tx, run, completion, now);
            finalStatus = completion.status;
            // 종료가 확인된 옛 확인 실행만 예약을 정리합니다. 일반 과거 오류를 새 차단으로 기록하지 않습니다.
            const gate = readProviderGate(tx);
            if (proof && gate?.probeRunId === run.id && gate.version === run.providerGateVersion) recordProviderOutcome(tx, run, completion, now);
          } else if (proof && !run.terminationConfirmedAt) {
            tx.update(runs).set({ terminationConfirmedAt: proof }).where(eq(runs.id, run.id)).run();
          }
          accountRunDuration(tx, run.id, proof ?? run.finishedAt);
          proofSaved = proof !== null;
          if (!proof) return finish("TERMINATION_UNCONFIRMED");
        }
        if (request.action === "cancel") {
          if (finalStatus === "succeeded") return finish("TASK_ALREADY_COMPLETED");
          tx.update(tasks).set({ status: "cancelled", ...(task.retryState ? { retryState: { ...tx.select({ state: tasks.retryState }).from(tasks).where(eq(tasks.id, task.id)).get()!.state!, nextAttemptAt: null, reason: "user_cancelled" } } : {}) }).where(eq(tasks.id, task.id)).run();
          cancelPendingProbe(tx, task.id);
          finalStatus = "cancelled";
          return finish(null);
        }
        if (request.action === "reconcile" || finalStatus === "succeeded") return finish(null);
        if (finalStatus === "cancelled") return finish("TASK_CANCELLED");
        const retryState = tx.select({ state: tasks.retryState }).from(tasks).where(eq(tasks.id, task.id)).get()?.state;
        if (retryState && retryLimitReason(retryState)) return finish("RECOVERY_LIMIT_REACHED");
        if (retryState?.nextAttemptAt && Date.parse(retryState.nextAttemptAt) > now.getTime()) return finish("RETRY_TOO_EARLY");
        if (run?.stopReason === "unknown") return finish("UNKNOWN_STOP_REASON");
        if (tx.select({ id: runs.id }).from(runs).where(unresolvedRun).get()) return finish("UNRESOLVED_RUN");
        const gate = readProviderGate(tx);
        if ((gate?.blocked && request.providerGateVersion === null)
          || (request.providerGateVersion !== null && request.providerGateVersion !== (gate?.version ?? 0))) return finish("GATE_CHANGED");
        if (finalStatus === "queued" && !gate?.blocked) return finish("TASK_ALREADY_QUEUED");
        if (gate?.blocked) {
          try { reserveProviderCheck(tx, task.id, request.providerGateVersion!, now); }
          catch (error) { if (error instanceof ProviderGateError) return finish(error.code); throw error; }
        }
        tx.update(tasks).set({ status: "queued" }).where(eq(tasks.id, task.id)).run();
        finalStatus = "queued";
        return finish(null);
      }, { behavior: "immediate" });
    },
  };
}
