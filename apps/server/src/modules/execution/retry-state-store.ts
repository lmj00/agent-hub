import { asc, eq } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { runs, tasks } from "../../db/schema.js";
import {
  initialRetryState,
  type RetryPolicy,
  type RetryState,
} from "./retry-policy.js";

type RetryDb = Pick<ReturnType<typeof openDatabase>["db"], "select" | "update">;

function errorStreak(history: { errorCode: string | null }[]) {
  const lastError = history.at(-1)?.errorCode ?? null;
  let consecutiveErrors = 0;
  if (lastError) {
    for (
      let index = history.length - 1;
      index >= 0 && history[index]!.errorCode === lastError;
      index--
    )
      consecutiveErrors++;
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
    .set({ retryState: { ...task.retryState, ...errorStreak(history) } })
    .where(eq(tasks.id, taskId))
    .run();
}

// 같은 완료를 여러 번 대조해도 이미 합산한 Run 시간을 다시 더하지 않습니다.
export function accountRunDuration(
  db: RetryDb,
  runId: string,
  end: Date | null,
) {
  if (!end) return;
  const run = db.select().from(runs).where(eq(runs.id, runId)).get()!;
  const task = db.select().from(tasks).where(eq(tasks.id, run.taskId)).get()!;
  if (!task.retryState) return;
  const duration = Math.max(
    run.accountedDurationMs,
    end.getTime() - run.startedAt.getTime(),
    0,
  );
  const delta = duration - run.accountedDurationMs;
  if (!delta) return;
  db.update(runs)
    .set({ accountedDurationMs: duration })
    .where(eq(runs.id, runId))
    .run();
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
  if (task.retryState || !policy) return task.retryState;
  const history = db
    .select()
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .orderBy(asc(runs.attempt))
    .all();
  const state = initialRetryState(policy);
  state.retries = Math.max(0, history.length - 1);
  Object.assign(state, errorStreak(history));
  for (const run of history) {
    const end = run.terminationConfirmedAt ?? run.finishedAt;
    const duration = Math.max(
      run.accountedDurationMs,
      end ? end.getTime() - run.startedAt.getTime() : 0,
      0,
    );
    state.totalRunMs += duration;
    db.update(runs)
      .set({ accountedDurationMs: duration })
      .where(eq(runs.id, run.id))
      .run();
  }
  db.update(tasks).set({ retryState: state }).where(eq(tasks.id, taskId)).run();
  return state;
}
