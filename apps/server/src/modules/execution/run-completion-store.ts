import { accountRunDuration, refreshRetryErrorStreak } from "./retry-state-store.js";
import { settleRunBudget, runBudgetWait } from "../budgets/budget-store.js";
import { randomUUID } from "node:crypto";
import { and, count, eq, ne, sql } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { events, runs, steps, tasks } from "../../db/schema.js";
import type { RunCompletion } from "./run-task.js";
import { confirmExecutions } from "./execution-record-store.js";

type CompletionDb = Pick<ReturnType<typeof openDatabase>["db"], "select" | "update" | "insert">;

// 호출자가 소유권·대상 Run을 검사한 같은 트랜잭션 안에서 사용합니다.
export function saveRunCompletion(
  db: CompletionDb,
  run: { id: string; taskId: string },
  completion: RunCompletion,
  now: Date,
  source: "executor" | "recovery" = "executor",
) {
  const finishedAt = completion.status === "interrupted" ? null : now;
  confirmExecutions(db, run.id, completion.terminationConfirmedAt);
  settleRunBudget(db, run.id, completion.terminationConfirmedAt ?? null);
  const budgetWait =
    completion.errorCode === "budget_limit" ? runBudgetWait(db, run.id, now) : null;
  db.update(tasks)
    .set({ status: completion.status, budgetWait })
    .where(eq(tasks.id, run.taskId))
    .run();
  db.update(runs)
    .set({
      status: completion.status,
      result: completion.result,
      errorCode: completion.errorCode,
      finishedAt,
      lastActivityAt: now,
      terminationConfirmedAt: completion.terminationConfirmedAt ?? null,
      retryAt: completion.retryAt ?? null,
    })
    .where(eq(runs.id, run.id))
    .run();
  accountRunDuration(db, run.id, completion.terminationConfirmedAt ?? finishedAt);
  refreshRetryErrorStreak(db, run.taskId);
  // A Run total cannot be attributed to unfinished workflow steps. Recovery has
  // no new provider usage; keep each previously recorded value, including null.
  const singleStep =
    source === "executor" &&
    db.select({ total: count() }).from(steps).where(eq(steps.runId, run.id)).get()!.total === 1;
  db.update(steps)
    .set({
      status: completion.status,
      ...(singleStep ? { usage: completion.usage } : {}),
      finishedAt,
    })
    .where(and(eq(steps.runId, run.id), ne(steps.status, "succeeded")))
    .run();
  const last = db
    .select({ sequence: sql<number>`max(${events.sequence})` })
    .from(events)
    .where(eq(events.runId, run.id))
    .get();
  db.insert(events)
    .values({
      id: randomUUID(),
      runId: run.id,
      sequence: (last?.sequence ?? 0) + 1,
      kind: `run.${completion.status}`,
      createdAt: now,
    })
    .run();
}
