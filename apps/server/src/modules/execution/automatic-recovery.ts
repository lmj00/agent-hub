import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import {
  events,
  projects,
  recoveryRequests,
  runs,
  tasks,
} from "../../db/schema.js";
import { assertExecutionOwner } from "./execution-owner.js";
import { unresolvedRun } from "./drizzle-run-store.js";
import { readProviderGate } from "./provider-gate.js";
import { ensureRetryState } from "./retry-state-store.js";
import {
  retryDelay,
  retryableError,
  retryLimitReason,
  type RetryPolicy,
  type RetryState,
} from "./retry-policy.js";
import type { RecoveryInput, RecoveryStore } from "./recover-task.js";

type Db = ReturnType<typeof openDatabase>["db"];

export function createAutomaticRecovery(options: {
  db: Db;
  ownerToken: string;
  policy: RetryPolicy;
  workspaceKeys: string[];
  recovery: RecoveryStore;
  now?: () => Date;
  random?: () => number;
}) {
  return {
    tick(): boolean {
      const now = (options.now ?? (() => new Date()))();
      const result = options.db.transaction(
        (tx) => {
          assertExecutionOwner(tx, options.ownerToken);
          if (!options.workspaceKeys.length) return false;
          const candidates = tx
            .select({ task: tasks })
            .from(tasks)
            .innerJoin(projects, eq(tasks.projectId, projects.id))
            .where(
              and(
                inArray(projects.workspaceKey, options.workspaceKeys),
                inArray(tasks.status, [
                  "running",
                  "interrupted",
                  "waiting_retry",
                  "waiting_capacity",
                  "failed",
                  "blocked",
                ]),
              ),
            )
            .orderBy(asc(tasks.createdAt), asc(tasks.id))
            .all();
          for (const { task } of candidates) {
            const run = tx
              .select()
              .from(runs)
              .where(eq(runs.taskId, task.id))
              .orderBy(desc(runs.attempt))
              .get();
            if (!run) continue;
            if (
              tx
                .select({ id: recoveryRequests.id })
                .from(recoveryRequests)
                .where(
                  and(
                    eq(recoveryRequests.taskId, task.id),
                    eq(recoveryRequests.status, "pending"),
                  ),
                )
                .get()
            )
              continue;
            let state = ensureRetryState(tx, task.id, options.policy)!;
            const save = (
              next: RetryState,
              status = task.status,
              kind?: string,
            ) => {
              tx.update(tasks)
                .set({ status, retryState: next })
                .where(eq(tasks.id, task.id))
                .run();
              if (kind) {
                const sequence =
                  (tx
                    .select({ value: sql<number>`max(${events.sequence})` })
                    .from(events)
                    .where(eq(events.runId, run.id))
                    .get()?.value ?? 0) + 1;
                tx.insert(events)
                  .values({
                    id: randomUUID(),
                    runId: run.id,
                    sequence,
                    kind,
                    createdAt: now,
                  })
                  .run();
              }
            };
            // 서버가 현재 실행 중이면 이 함수는 호출되지 않습니다. 새 소유자만 옛 실행을 대조합니다.
            if (!run.terminationConfirmedAt) {
              const action = task.cancelRequestedAt ? "cancel" : "reconcile";
              const requestKey = `auto-${action}-${run.id}`;
              const previous = tx
                .select()
                .from(recoveryRequests)
                .where(
                  and(
                    eq(recoveryRequests.taskId, task.id),
                    eq(recoveryRequests.requestKey, requestKey),
                  ),
                )
                .get();
              if (!previous)
                return {
                  taskId: task.id,
                  runId: run.id,
                  action,
                  requestKey,
                  providerGateVersion: null,
                } satisfies RecoveryInput;
              if (
                state.decisionRunId !== run.id ||
                state.reason !== "termination_unconfirmed"
              ) {
                save(
                  {
                    ...state,
                    decisionRunId: run.id,
                    nextAttemptAt: null,
                    reason: "termination_unconfirmed",
                  },
                  task.status,
                  "recovery.held.termination_unconfirmed",
                );
                return true;
              }
              continue;
            }
            if (task.cancelRequestedAt) {
              if (state.reason !== "user_cancelled") {
                save(
                  {
                    ...state,
                    decisionRunId: run.id,
                    nextAttemptAt: null,
                    reason: "user_cancelled",
                  },
                  "cancelled",
                );
                return true;
              }
              continue;
            }
            if (
              state.decisionRunId !== run.id ||
              state.reason === "termination_unconfirmed"
            ) {
              state = { ...state, decisionRunId: run.id };
              const limit = retryLimitReason(state);
              if (
                !retryableError(run.errorCode) ||
                run.stopReason === "unknown" ||
                run.stopReason === "timeout"
              ) {
                const reason =
                  run.errorCode === "capacity"
                    ? "capacity_manual_check"
                    : run.errorCode === "authentication"
                      ? "authentication_required"
                      : run.errorCode === "unsupported_settings"
                        ? "configuration_required"
                        : "not_retryable";
                save(
                  { ...state, reason, nextAttemptAt: null },
                  task.status,
                  `recovery.held.${reason}`,
                );
                return true;
              }
              if (limit) {
                save(
                  { ...state, reason: limit, nextAttemptAt: null },
                  "blocked",
                  `recovery.held.${limit}`,
                );
                return true;
              }
              const nextAttemptAt = new Date(
                now.getTime() +
                  retryDelay(
                    state.policy,
                    state.retries,
                    (options.random ?? Math.random)(),
                  ),
              ).toISOString();
              save(
                { ...state, nextAttemptAt, reason: "retry_scheduled" },
                "waiting_retry",
                "recovery.retry_scheduled",
              );
              return true;
            }
            if (
              !state.nextAttemptAt ||
              Date.parse(state.nextAttemptAt) > now.getTime()
            )
              continue;
            if (
              readProviderGate(tx)?.blocked ||
              tx.select({ id: runs.id }).from(runs).where(unresolvedRun).get()
            )
              continue;
            const limit = retryLimitReason(state);
            if (limit)
              save(
                { ...state, nextAttemptAt: null, reason: limit },
                "blocked",
                `recovery.held.${limit}`,
              );
            else
              save(
                { ...state, reason: "retry_ready" },
                "queued",
                "recovery.retry_ready",
              );
            return true;
          }
          return false;
        },
        { behavior: "immediate" },
      );
      if (typeof result === "object") {
        // 접수도 기존 중복·최신 Run·취소 규칙을 재사용합니다. 저장 실패 시 다음 순회에서 다시 확인합니다.
        options.recovery.request(result, null, true);
        return true;
      }
      return result;
    },
  };
}
