import { randomUUID } from "node:crypto";
import { asc, desc, eq, sql } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { events, runs, tasks, taskReleases } from "../../db/schema.js";
import {
  initialRetryState,
  retryLimitKeys,
  type RetryPolicy,
  type RetryState,
} from "./retry-policy.js";

type RetryDb = Pick<ReturnType<typeof openDatabase>["db"], "select" | "insert" | "update">;

export function readRetryBaseline(db: Pick<RetryDb, "select">, taskId: string) {
  return db.select().from(taskReleases).where(eq(taskReleases.newTaskId, taskId)).get();
}

function errorStreak(
  history: { errorCode: string | null }[],
  baseline?: Pick<RetryState, "lastError" | "consecutiveErrors">,
) {
  let lastError = baseline?.lastError ?? null,
    consecutiveErrors = baseline?.consecutiveErrors ?? 0;
  for (const run of history) {
    consecutiveErrors = run.errorCode
      ? run.errorCode === lastError
        ? consecutiveErrors + 1
        : 1
      : 0;
    lastError = run.errorCode;
  }
  return { lastError, consecutiveErrors };
}

// 완료 저장 시 바로 갱신하여 자동 루프보다 먼저 온 수동 재개도 같은 제한을 봅니다.
export function refreshRetryErrorStreak(db: RetryDb, taskId: string) {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
  if (!task.retryState) return;
  const history = db
    .select({ errorCode: runs.errorCode })
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .orderBy(asc(runs.attempt))
    .all();
  db.update(tasks)
    .set({
      retryState: {
        ...task.retryState,
        ...errorStreak(history, readRetryBaseline(db, taskId)?.priorRetryState),
      },
    })
    .where(eq(tasks.id, taskId))
    .run();
}

// 같은 완료를 여러 번 대조해도 이미 합산한 Run 시간을 다시 더하지 않습니다.
export function accountRunDuration(db: RetryDb, runId: string, end: Date | null) {
  if (!end) return;
  const run = db.select().from(runs).where(eq(runs.id, runId)).get()!;
  const task = db.select().from(tasks).where(eq(tasks.id, run.taskId)).get()!;
  if (!task.retryState) return;
  const duration = Math.max(run.accountedDurationMs, end.getTime() - run.startedAt.getTime(), 0);
  const delta = duration - run.accountedDurationMs;
  if (!delta) return;
  db.update(runs).set({ accountedDurationMs: duration }).where(eq(runs.id, runId)).run();
  db.update(tasks)
    .set({
      retryState: {
        ...task.retryState,
        totalRunMs: task.retryState.totalRunMs + delta,
      },
    })
    .where(eq(tasks.id, task.id))
    .run();
}

export function ensureRetryState(
  db: RetryDb,
  taskId: string,
  policy?: RetryPolicy,
): RetryState | null {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
  if (task.retryState) {
    const state = removeConfiguredLimits(task.retryState, policy);
    if (state !== task.retryState) {
      db.update(tasks).set({ retryState: state }).where(eq(tasks.id, taskId)).run();
      const run = db
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.taskId, taskId))
        .orderBy(desc(runs.attempt))
        .get();
      if (run) {
        const sequence =
          (db
            .select({ value: sql<number>`max(${events.sequence})` })
            .from(events)
            .where(eq(events.runId, run.id))
            .get()?.value ?? 0) + 1;
        db.insert(events)
          .values({
            id: randomUUID(),
            runId: run.id,
            sequence,
            kind: "recovery.limits_removed",
            createdAt: new Date(),
          })
          .run();
      }
    }
    return state;
  }
  const baseline = readRetryBaseline(db, taskId);
  if (!policy && !baseline) return null;
  const history = db
    .select()
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .orderBy(asc(runs.attempt))
    .all();
  const state = removeConfiguredLimits(
    baseline ? structuredClone(baseline.priorRetryState) : initialRetryState(policy!),
    policy,
  );
  if (baseline) {
    state.reason = null;
    state.decisionRunId = null;
  }
  state.retries += baseline?.priorAttempts ? history.length : Math.max(0, history.length - 1);
  Object.assign(state, errorStreak(history, baseline?.priorRetryState));
  for (const run of history) {
    const end = run.terminationConfirmedAt ?? run.finishedAt;
    const duration = Math.max(
      run.accountedDurationMs,
      end ? end.getTime() - run.startedAt.getTime() : 0,
      0,
    );
    state.totalRunMs += duration;
    db.update(runs).set({ accountedDurationMs: duration }).where(eq(runs.id, run.id)).run();
  }
  db.update(tasks).set({ retryState: state }).where(eq(tasks.id, taskId)).run();
  return state;
}

// Explicit null removes a stored cap. Finite config edits still do not reset a
// task's policy, counters, backoff or past decisions.
function removeConfiguredLimits(state: RetryState, policy?: RetryPolicy): RetryState {
  const removed = retryLimitKeys.filter(
    (key) => policy?.[key] === null && state.policy[key] !== null,
  );
  if (!removed.length) return state;
  const next = { ...state, policy: { ...state.policy } };
  for (const key of removed) next.policy[key] = null;
  if (
    state.reason &&
    ["task_time_limit", "retry_limit", "repeated_error_limit"].includes(state.reason)
  ) {
    next.decisionRunId = null;
    next.reason = null;
  }
  return next;
}
