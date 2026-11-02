import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import {
  events,
  projects,
  recoveryRequests,
  runs,
  tasks,
} from "../src/db/schema.js";
import { createAutomaticRecovery } from "../src/modules/execution/automatic-recovery.js";
import { createDrizzleRunStore } from "../src/modules/execution/drizzle-run-store.js";
import { createDrizzleRecoveryStore } from "../src/modules/execution/drizzle-recovery-store.js";
import { acquireExecutionOwner } from "../src/modules/execution/execution-owner.js";
import { createRecoveryProcessor } from "../src/modules/execution/recover-task.js";
import { classifyCodexError } from "../src/modules/execution/analysis.js";
import {
  defaultRetryPolicy,
  parseRetryPolicy,
  retryDelay,
  type RetryPolicy,
} from "../src/modules/execution/retry-policy.js";

let directory: string;
let database: ReturnType<typeof openDatabase>;
let owner: ReturnType<typeof acquireExecutionOwner>;
let store: ReturnType<typeof createDrizzleRunStore>;
let recovery: ReturnType<typeof createDrizzleRecoveryStore>;
let automatic: ReturnType<typeof createAutomaticRecovery>;
let taskId: string;
let policy: RetryPolicy;
function connect() {
  database = openDatabase(join(directory, "hub.sqlite"));
  owner = acquireExecutionOwner(database.db);
  store = createDrizzleRunStore(database.db, owner.token, policy);
  recovery = createDrizzleRecoveryStore(database.db, owner.token);
  automatic = createAutomaticRecovery({
    db: database.db,
    ownerToken: owner.token,
    policy,
    workspaceKeys: ["example"],
    recovery,
    random: () => 0,
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T00:00:00Z"));
  directory = mkdtempSync(join(tmpdir(), "hub-automatic-"));
  policy = { ...defaultRetryPolicy, initialDelayMs: 1000, maxDelayMs: 10000 };
  connect();
  const projectId = randomUUID();
  taskId = randomUUID();
  database.db
    .insert(projects)
    .values({
      id: projectId,
      name: "Example",
      workspaceKey: "example",
      createdAt: new Date(),
    })
    .run();
  database.db
    .insert(tasks)
    .values({
      id: taskId,
      projectId,
      instruction: "Analyze",
      requestKey: "one",
      createdAt: new Date(),
    })
    .run();
});
afterEach(() => {
  owner.release();
  database.close();
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});
const task = () =>
  database.db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
function failure(errorCode = "transient", proof = true) {
  const run = store.claim(taskId, "fixture");
  vi.setSystemTime(Date.now() + 100);
  store.finish(run.id, {
    status:
      errorCode === "capacity"
        ? "waiting_capacity"
        : errorCode === "authentication"
          ? "blocked"
          : "failed",
    errorCode,
    result: null,
    usage: null,
    terminationConfirmedAt: proof ? new Date() : null,
  });
  return run;
}
const due = () => vi.setSystemTime(new Date(task().retryState!.nextAttemptAt!));

test("policy rejects invalid limits and jitter cannot exceed the maximum delay", () => {
  expect(parseRetryPolicy({})).toEqual(defaultRetryPolicy);
  for (const value of [
    null,
    true,
    { maxRetries: -1 },
    { initialDelayMs: 999 },
    { maxDelayMs: 1000 },
    { jitterRatio: NaN },
    { unknown: true },
  ])
    expect(() => parseRetryPolicy(value)).toThrow();
  expect(retryDelay(policy, 0, 1)).toBe(1200);
  expect(retryDelay(policy, 99, 1)).toBe(10000);
  for (const message of [
    "network error",
    "ECONNRESET",
    "HTTP 503",
    "temporarily unavailable",
  ])
    expect(classifyCodexError(message).code).toBe("transient");
  expect(classifyCodexError("unrecognized failure").code).toBe(
    "provider_error",
  );
  expect(classifyCodexError("429 network quota").code).toBe("capacity");
});

test("one failed attempt schedules once, waits, and consumes a retry only at claim", () => {
  const first = failure();
  expect(automatic.tick()).toBe(true);
  expect(task()).toMatchObject({
    status: "waiting_retry",
    retryState: {
      retries: 0,
      consecutiveErrors: 1,
      totalRunMs: 100,
      nextAttemptAt: new Date(Date.now() + 1000).toISOString(),
    },
  });
  expect(automatic.tick()).toBe(false);
  expect(store.claimNext("fixture", ["example"]).kind).toBe("idle");
  expect(() =>
    recovery.request(
      {
        taskId,
        runId: first.id,
        requestKey: "early",
        action: "resume",
        providerGateVersion: null,
      },
      null,
      true,
    ),
  ).toThrow("RETRY_TOO_EARLY");
  due();
  expect(automatic.tick()).toBe(true);
  expect(task().retryState?.retries).toBe(0);
  const second = store.claim(taskId, "fixture");
  expect(task().retryState?.retries).toBe(1);
  expect(store.listByTask(taskId).map((run) => run.attempt)).toEqual([2, 1]);
  expect(second.id).not.toBe(first.id);
});

test("restart and a larger new configuration cannot reset the saved policy, counters or due time", () => {
  failure();
  automatic.tick();
  const saved = task().retryState;
  owner.release();
  database.close();
  policy = { ...policy, maxRetries: 20, initialDelayMs: 20000 };
  connect();
  expect(automatic.tick()).toBe(false);
  expect(task().retryState).toEqual(saved);
  due();
  automatic.tick();
  failure();
  automatic.tick();
  expect(task().retryState).toMatchObject({
    retries: 1,
    consecutiveErrors: 2,
    totalRunMs: 200,
    policy: { maxRetries: 3, initialDelayMs: 1000 },
    nextAttemptAt: new Date(Date.now() + 2000).toISOString(),
  });
});

test("repeated errors block further automatic and manual attempts without blocking another task", () => {
  for (let index = 0; index < 3; index++) {
    failure();
    automatic.tick();
    if (index < 2) {
      due();
      automatic.tick();
    }
  }
  expect(task()).toMatchObject({
    status: "blocked",
    retryState: {
      retries: 2,
      consecutiveErrors: 3,
      reason: "repeated_error_limit",
      nextAttemptAt: null,
    },
  });
  const runId = store.listByTask(taskId)[0]!.id;
  expect(() =>
    recovery.request(
      {
        taskId,
        runId,
        requestKey: "manual",
        action: "resume",
        providerGateVersion: null,
      },
      null,
      true,
    ),
  ).toThrow("RECOVERY_LIMIT_REACHED");
  const id = randomUUID();
  database.db
    .insert(tasks)
    .values({
      id,
      projectId: task().projectId,
      instruction: "other",
      requestKey: id,
      createdAt: new Date(),
    })
    .run();
  expect(store.claimNext("fixture", ["example"])).toMatchObject({
    kind: "claimed",
    run: { taskId: id },
  });
});

test("total retry count stops alternating errors even when the consecutive counter resets", () => {
  for (const error of [
    "transient",
    "server_shutdown",
    "transient",
    "owner_lost",
  ]) {
    failure(error);
    automatic.tick();
    if (task().retryState?.nextAttemptAt) {
      due();
      automatic.tick();
    }
  }
  expect(task()).toMatchObject({
    status: "blocked",
    retryState: { retries: 3, consecutiveErrors: 1, reason: "retry_limit" },
  });
});

test("cumulative time is counted once across reconciliation and limits the next execution", async () => {
  policy.maxTotalRunMs = 1000;
  const run = store.claim(taskId, "fixture");
  vi.setSystemTime(Date.now() + 700);
  store.finish(run.id, {
    status: "failed",
    errorCode: "transient",
    result: null,
    usage: null,
    terminationConfirmedAt: new Date(),
  });
  const receipt = recovery.request(
    {
      taskId,
      runId: run.id,
      action: "reconcile",
      requestKey: "check",
      providerGateVersion: null,
    },
    null,
    true,
  );
  const processor = createRecoveryProcessor(recovery, {
    confirm: async () => new Date(),
    cleanup: async () => {},
  });
  await processor.process(receipt.request.id);
  await processor.process(receipt.request.id);
  expect(task().retryState?.totalRunMs).toBe(700);
  automatic.tick();
  due();
  automatic.tick();
  const next = store.claim(taskId, "fixture");
  expect(next.remainingRunMs).toBe(300);
  vi.setSystemTime(Date.now() + 300);
  store.finish(next.id, {
    status: "failed",
    errorCode: "transient",
    result: null,
    usage: null,
    terminationConfirmedAt: new Date(),
  });
  automatic.tick();
  expect(task().retryState).toMatchObject({
    totalRunMs: 1000,
    reason: "task_time_limit",
    nextAttemptAt: null,
  });
});

test("automatic recovery reconciles the orphan before scheduling a replacement", async () => {
  const run = store.claim(taskId, "fixture");
  store.record(run.id, {
    kind: "execution.prepared",
    execution: {
      kind: "docker",
      containerId: "a".repeat(64),
      engineId: "fixture",
      token: randomUUID(),
    },
  });
  expect(automatic.tick()).toBe(true);
  const receipt = recovery.nextPending()!;
  expect(receipt.action).toBe("reconcile");
  expect(store.listByTask(taskId)).toHaveLength(1);
  vi.setSystemTime(Date.now() + 500);
  await createRecoveryProcessor(recovery, {
    confirm: async () => new Date(),
    cleanup: async () => {},
  }).process(receipt.id);
  expect(store.findById(run.id)).toMatchObject({
    status: "waiting_retry",
    errorCode: "owner_lost",
    terminationConfirmedAt: expect.any(Date),
  });
  automatic.tick();
  expect(task().retryState).toMatchObject({
    reason: "retry_scheduled",
    totalRunMs: 500,
  });
  due();
  automatic.tick();
  expect(store.claim(taskId, "fixture").id).not.toBe(run.id);
});

test("unconfirmed termination is observed once, stays held, and can recover after a later manual observation", async () => {
  const run = store.claim(taskId, "fixture");
  store.record(run.id, {
    kind: "execution.prepared",
    execution: {
      kind: "docker",
      containerId: "a".repeat(64),
      engineId: "fixture",
      token: randomUUID(),
    },
  });
  automatic.tick();
  await createRecoveryProcessor(recovery, {
    confirm: async () => null,
    cleanup: async () => {},
  }).process(recovery.nextPending()!.id);
  automatic.tick();
  expect(task().retryState?.reason).toBe("termination_unconfirmed");
  for (let count = 0; count < 10; count++) expect(automatic.tick()).toBe(false);
  expect(database.db.select().from(recoveryRequests).all()).toHaveLength(1);
  const manual = recovery.request(
    {
      taskId,
      runId: run.id,
      action: "reconcile",
      requestKey: "later",
      providerGateVersion: null,
    },
    null,
    true,
  );
  await createRecoveryProcessor(recovery, {
    confirm: async () => new Date(),
    cleanup: async () => {},
  }).process(manual.request.id);
  automatic.tick();
  expect(task().retryState?.reason).toBe("retry_scheduled");
});

test("cancellation during backoff clears the reservation and no restart requeues it", async () => {
  const run = failure();
  automatic.tick();
  const cancelled = recovery.request(
    {
      taskId,
      runId: run.id,
      action: "cancel",
      requestKey: "cancel",
      providerGateVersion: null,
    },
    null,
    true,
  );
  await createRecoveryProcessor(recovery, {
    confirm: async () => new Date(),
    cleanup: async () => {},
  }).process(cancelled.request.id);
  vi.setSystemTime(Date.now() + 100000);
  automatic.tick();
  expect(task()).toMatchObject({
    status: "cancelled",
    retryState: { nextAttemptAt: null, reason: "user_cancelled" },
  });
  expect(store.claimNext("fixture", ["example"]).kind).toBe("idle");
});

test.each([
  "timeout",
  "provider_error",
  "output_limit",
  "authentication",
  "capacity",
])("%s is not silently retried", (error) => {
  failure(error);
  automatic.tick();
  expect(task().retryState?.nextAttemptAt).toBeNull();
  vi.setSystemTime(Date.now() + 86400000);
  expect(automatic.tick()).toBe(false);
  expect(store.listByTask(taskId)).toHaveLength(1);
});

test("provider gate prevents a due retry from bypassing another project's account block", () => {
  const first = failure();
  automatic.tick();
  const id = randomUUID();
  database.db
    .insert(tasks)
    .values({
      id,
      projectId: task().projectId,
      instruction: "other",
      requestKey: id,
      createdAt: new Date(),
    })
    .run();
  const other = store.claim(id, "fixture");
  store.finish(other.id, {
    status: "blocked",
    errorCode: "authentication",
    result: null,
    usage: null,
    terminationConfirmedAt: new Date(),
  });
  due();
  automatic.tick();
  expect(automatic.tick()).toBe(false);
  expect(task().status).toBe("waiting_retry");
  expect(store.claimNext("fixture", ["example"])).toMatchObject({
    kind: "held",
    reason: "provider_authentication",
  });
  expect(store.listByTask(first.taskId)).toHaveLength(1);
});

test("failed decision storage rolls back the event, next time and counters", () => {
  failure();
  database.client.exec(
    "CREATE TRIGGER reject_retry BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
  );
  expect(() => automatic.tick()).toThrow("fixture");
  expect(task().retryState).toMatchObject({
    consecutiveErrors: 1,
    decisionRunId: null,
    nextAttemptAt: null,
  });
  expect(
    database.db
      .select()
      .from(events)
      .all()
      .some((row) => row.kind.startsWith("recovery.")),
  ).toBe(false);
  database.client.exec("DROP TRIGGER reject_retry");
  automatic.tick();
  expect(task().retryState?.consecutiveErrors).toBe(1);
});

test("adopting an older task preserves its past execution count and elapsed time", () => {
  store = createDrizzleRunStore(database.db, owner.token);
  failure();
  expect(task().retryState).toBeNull();
  automatic.tick();
  expect(task().retryState).toMatchObject({
    retries: 0,
    totalRunMs: 100,
    consecutiveErrors: 1,
  });
  expect(database.db.select().from(runs).get()?.accountedDurationMs).toBe(100);
});

test("manual resume arriving before the automatic decision still sees the newest error streak", () => {
  policy.maxConsecutiveErrors = 1;
  const run = failure();
  expect(task().retryState).toMatchObject({
    consecutiveErrors: 1,
    decisionRunId: null,
  });
  expect(() =>
    recovery.request(
      {
        taskId,
        runId: run.id,
        action: "resume",
        requestKey: "race",
        providerGateVersion: null,
      },
      null,
      true,
    ),
  ).toThrow("RECOVERY_LIMIT_REACHED");
  automatic.tick();
  expect(task().retryState?.reason).toBe("repeated_error_limit");
});
