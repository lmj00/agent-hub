import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openDatabase } from "../../src/db/connection.js";
import { projects, providerGates, tasks } from "../../src/db/schema.js";
import { createCapacityRecovery } from "../../src/modules/execution/capacity-recovery.js";
import {
  defaultCapacityPolicy,
  parseCapacityPolicy,
} from "../../src/modules/execution/capacity-policy.js";
import { defaultRetryPolicy } from "../../src/modules/execution/retry-policy.js";
import { createAutomaticRecovery } from "../../src/modules/execution/automatic-recovery.js";
import { createDrizzleRunStore } from "../../src/modules/execution/drizzle-run-store.js";
import { createDrizzleRecoveryStore } from "../../src/modules/execution/drizzle-recovery-store.js";
import { acquireExecutionOwner } from "../../src/modules/execution/execution-owner.js";
import { createRecoveryProcessor } from "../../src/modules/execution/recover-task.js";

let directory: string;
let database: ReturnType<typeof openDatabase>;
let owner: ReturnType<typeof acquireExecutionOwner>;
let store: ReturnType<typeof createDrizzleRunStore>;
let recovery: ReturnType<typeof createDrizzleRecoveryStore>;
let capacity: ReturnType<typeof createCapacityRecovery>;
let automatic: ReturnType<typeof createAutomaticRecovery>;
let projectId: string;
let taskId: string;
const retryPolicy = {
  ...defaultRetryPolicy,
  maxRetries: 20,
  maxConsecutiveErrors: 20,
};
const policy = {
  ...defaultCapacityPolicy,
  initialDelayMs: 1000,
  maxDelayMs: 4000,
  jitterRatio: 0,
};
function connect(config = policy) {
  database = openDatabase(join(directory, "hub.sqlite"));
  owner = acquireExecutionOwner(database.db);
  store = createDrizzleRunStore(database.db, owner.token, {
    automaticRecovery: retryPolicy,
    capacityRecovery: config,
  });
  recovery = createDrizzleRecoveryStore(database.db, owner.token);
  capacity = createCapacityRecovery({
    db: database.db,
    ownerToken: owner.token,
    policy: config,
    retryPolicy,
    workspaceKeys: ["example"],
    random: () => 0,
  });
  automatic = createAutomaticRecovery({
    db: database.db,
    ownerToken: owner.token,
    policy: retryPolicy,
    workspaceKeys: ["example"],
    recovery,
    random: () => 0,
  });
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
  directory = mkdtempSync(join(tmpdir(), "hub-capacity-"));
  connect();
  projectId = randomUUID();
  database.db
    .insert(projects)
    .values({
      id: projectId,
      name: "Example",
      workspaceKey: "example",
      createdAt: new Date(),
    })
    .run();
  taskId = newTask();
});
afterEach(() => {
  owner.release();
  database.close();
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});
function newTask() {
  const id = randomUUID();
  database.db
    .insert(tasks)
    .values({
      id,
      projectId,
      instruction: "Analyze",
      requestKey: id,
      createdAt: new Date(),
    })
    .run();
  return id;
}
const task = () => database.db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
const gate = () => store.getProviderGate();
function blocked(retryAt: Date | null = null) {
  const run = store.claim(taskId, "fixture");
  store.finish(run.id, {
    status: "waiting_capacity",
    errorCode: "capacity",
    result: null,
    usage: null,
    retryAt,
    terminationConfirmedAt: new Date(),
  });
  return run;
}
function dueProbe() {
  capacity.tick();
  vi.setSystemTime(new Date(gate().capacityState!.nextCheckAt!));
  expect(capacity.tick()).toBe(true);
  expect(gate().capacityState?.reason).toBe("ready");
  return store.claim(taskId, "fixture");
}

test("capacity policy is bounded and rejects unsupported or malformed settings", () => {
  expect(parseCapacityPolicy({})).toEqual(defaultCapacityPolicy);
  for (const value of [
    true,
    null,
    { maxChecks: 0 },
    { initialDelayMs: 999 },
    { maxDelayMs: 1000 },
    { jitterRatio: 1 },
    { arbitrary: 1 },
  ])
    expect(() => parseCapacityPolicy(value)).toThrow();
});

test("known retry evidence is preserved separately and enforced before any manual or automatic decision", () => {
  const retryAt = new Date(Date.now() + 10000);
  blocked(retryAt);
  expect(gate()).toMatchObject({
    retryAt,
    capacityState: { checks: 0, nextCheckAt: retryAt.toISOString() },
  });
  expect(() => store.reserveProviderCheck(newTask(), gate().version)).toThrow("RETRY_TOO_EARLY");
  capacity.tick();
  expect(capacity.tick()).toBe(false);
  vi.setSystemTime(retryAt);
  expect(capacity.tick()).toBe(true);
  expect(gate()).toMatchObject({
    blocked: true,
    probeTaskId: taskId,
    probeRunId: null,
    capacityState: { checks: 0 },
  });
  expect(capacity.tick()).toBe(false);
  const probe = store.claim(taskId, "fixture");
  expect(gate()).toMatchObject({
    probeRunId: probe.id,
    capacityState: { checks: 1, nextCheckAt: null, reason: "checking" },
  });
});

test("missing provider time remains null while the internal schedule survives restart and a new policy", () => {
  blocked();
  capacity.tick();
  const saved = gate();
  expect(saved.retryAt).toBeNull();
  expect(saved.capacityState?.nextCheckAt).toBe(new Date(Date.now() + 1000).toISOString());
  owner.release();
  database.close();
  connect({ ...policy, maxChecks: 20, initialDelayMs: 3000 });
  expect(gate()).toEqual(saved);
  expect(capacity.tick()).toBe(false);
  vi.setSystemTime(new Date(saved.capacityState!.nextCheckAt!));
  capacity.tick();
  store.claim(taskId, "fixture");
  expect(gate().capacityState).toMatchObject({
    checks: 1,
    policy: { maxChecks: 3, initialDelayMs: 1000 },
  });
});

test("a failed check increases the persisted delay atomically before the scheduler sees it", () => {
  blocked();
  const probe = dueProbe();
  store.finish(probe.id, {
    status: "waiting_capacity",
    errorCode: "capacity",
    result: null,
    usage: null,
    terminationConfirmedAt: new Date(),
  });
  expect(gate().capacityState).toMatchObject({
    checks: 1,
    nextCheckAt: new Date(Date.now() + 2000).toISOString(),
  });
  expect(() => store.reserveProviderCheck(newTask(), gate().version)).toThrow("RETRY_TOO_EARLY");
  capacity.tick();
  expect(task().retryState?.nextAttemptAt).toBe(gate().capacityState?.nextCheckAt);
});

test("successful response and confirmed termination clear the gate and permit ordinary work", () => {
  blocked();
  const other = newTask();
  const probe = dueProbe();
  store.finish(probe.id, {
    status: "succeeded",
    errorCode: null,
    result: "Recovered",
    usage: null,
    terminationConfirmedAt: new Date(),
  });
  expect(gate()).toMatchObject({ blocked: false, capacityState: null });
  expect(capacity.tick()).toBe(false);
  expect(store.claimNext("fixture", ["example"])).toMatchObject({
    kind: "claimed",
    run: { taskId: other },
  });
});

test("the account check limit cannot be bypassed with a different task or a restart", () => {
  blocked();
  for (let index = 0; index < 3; index++) {
    const probe = dueProbe();
    store.finish(probe.id, {
      status: "waiting_capacity",
      errorCode: "capacity",
      result: null,
      usage: null,
      terminationConfirmedAt: new Date(),
    });
  }
  capacity.tick();
  expect(gate().capacityState).toMatchObject({
    checks: 3,
    nextCheckAt: null,
    reason: "check_limit",
  });
  expect(task()).toMatchObject({
    status: "blocked",
    retryState: { reason: "capacity_check_limit", nextAttemptAt: null },
  });
  expect(() => store.reserveProviderCheck(newTask(), gate().version)).toThrow(
    "RECOVERY_LIMIT_REACHED",
  );
  owner.release();
  database.close();
  connect({ ...policy, maxChecks: 20 });
  expect(capacity.tick()).toBe(false);
  expect(gate().capacityState?.checks).toBe(3);
});

test("a Task limit stops automatic checks even if the account budget remains", () => {
  blocked();
  const current = task().retryState!;
  database.db
    .update(tasks)
    .set({
      retryState: { ...current, totalRunMs: current.policy.maxTotalRunMs },
    })
    .where(eq(tasks.id, taskId))
    .run();
  capacity.tick();
  expect(gate().capacityState).toMatchObject({
    checks: 0,
    reason: "task_limit",
  });
  expect(task()).toMatchObject({
    status: "blocked",
    retryState: { reason: "task_time_limit" },
  });
  expect(capacity.tick()).toBe(false);
});

test("cancelling the source task never revives it or consumes a capacity check", async () => {
  const run = blocked();
  capacity.tick();
  const receipt = recovery.request(
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
  }).process(receipt.request.id);
  capacity.tick();
  expect(gate().capacityState).toMatchObject({
    checks: 0,
    reason: "task_unavailable",
  });
  expect(task().status).toBe("cancelled");
  expect(() => store.reserveProviderCheck(newTask(), gate().version)).toThrow("RETRY_TOO_EARLY");
});

test("an interrupted successful probe keeps its reservation until later termination proof clears it", async () => {
  blocked();
  const probe = dueProbe();
  store.record(probe.id, {
    kind: "execution.prepared",
    execution: {
      kind: "docker",
      containerId: "a".repeat(64),
      engineId: "fixture",
      token: randomUUID(),
    },
  });
  const version = gate().version;
  store.finish(probe.id, {
    status: "succeeded",
    errorCode: null,
    result: "Recovered",
    usage: null,
  });
  expect(gate()).toMatchObject({
    blocked: true,
    version,
    probeRunId: probe.id,
    capacityState: { checks: 1 },
  });
  expect(capacity.tick()).toBe(false);
  automatic.tick();
  await createRecoveryProcessor(recovery, {
    confirm: async () => new Date(),
    cleanup: async () => {},
  }).process(recovery.nextPending()!.id);
  expect(gate()).toMatchObject({
    blocked: false,
    capacityState: null,
    probeRunId: null,
  });
  expect(task().status).toBe("succeeded");
  expect(store.listByTask(taskId)).toHaveLength(2);
});

test("a non-capacity probe failure keeps account limits and cannot immediately retry", () => {
  blocked();
  const probe = dueProbe();
  store.finish(probe.id, {
    status: "failed",
    errorCode: "transient",
    result: null,
    usage: null,
    terminationConfirmedAt: new Date(),
  });
  expect(gate()).toMatchObject({
    reason: "capacity",
    capacityState: {
      checks: 1,
      nextCheckAt: new Date(Date.now() + 2000).toISOString(),
    },
  });
  expect(() => store.reserveProviderCheck(newTask(), gate().version)).toThrow("RETRY_TOO_EARLY");
  automatic.tick();
  capacity.tick();
  expect(task().status).toBe("waiting_capacity");
});

test("authentication blocks stop the automatic checker without erasing already consumed checks", () => {
  blocked();
  const probe = dueProbe();
  store.finish(probe.id, {
    status: "blocked",
    errorCode: "authentication",
    result: null,
    usage: null,
    terminationConfirmedAt: new Date(),
  });
  expect(capacity.tick()).toBe(false);
  expect(gate()).toMatchObject({
    reason: "authentication",
    capacityState: { checks: 1 },
  });
});

test("a newer gate cannot be cleared by an old successful probe", () => {
  blocked();
  const probe = dueProbe();
  database.client.exec(
    "UPDATE provider_gates SET version = version + 1, reason = 'authentication', probe_run_id = NULL, probe_task_id = NULL",
  );
  const newer = gate();
  store.finish(probe.id, {
    status: "succeeded",
    result: "Old",
    errorCode: null,
    usage: null,
    terminationConfirmedAt: new Date(),
  });
  expect(gate()).toEqual(newer);
});

test("a reservation storage failure rolls back both the gate and the queued task", () => {
  blocked();
  capacity.tick();
  vi.setSystemTime(new Date(gate().capacityState!.nextCheckAt!));
  database.client.exec(
    "CREATE TRIGGER reject_probe BEFORE UPDATE ON provider_gates WHEN NEW.probe_task_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
  );
  expect(() => capacity.tick()).toThrow("fixture");
  expect(task().status).toBe("waiting_capacity");
  expect(gate().probeTaskId).toBeNull();
  expect(gate().capacityState?.checks).toBe(0);
  database.client.exec("DROP TRIGGER reject_probe");
  expect(capacity.tick()).toBe(true);
});

test("legacy capacity blocks adopt a bounded policy without changing provider retry evidence", () => {
  store = createDrizzleRunStore(database.db, owner.token, { automaticRecovery: retryPolicy });
  blocked();
  expect(gate().capacityState).toBeNull();
  expect(capacity.tick()).toBe(true);
  expect(gate()).toMatchObject({
    retryAt: null,
    capacityState: { checks: 0, policy },
  });
});
