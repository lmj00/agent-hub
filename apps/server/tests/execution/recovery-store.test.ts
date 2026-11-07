import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openDatabase } from "../../src/db/connection.js";
import { projects, tasks } from "../../src/db/schema.js";
import { createDrizzleRunStore } from "../../src/modules/execution/drizzle-run-store.js";
import { createDrizzleRecoveryStore } from "../../src/modules/execution/drizzle-recovery-store.js";
import { acquireExecutionOwner } from "../../src/modules/execution/execution-owner.js";
import {
  createRecoveryProcessor,
  type RecoveryInput,
} from "../../src/modules/execution/recover-task.js";

let directory: string;
let path: string;
let database: ReturnType<typeof openDatabase>;
let runs: ReturnType<typeof createDrizzleRunStore>;
let recovery: ReturnType<typeof createDrizzleRecoveryStore>;
let projectId: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "hub-recovery-"));
  path = join(directory, "hub.sqlite");
  database = openDatabase(path);
  runs = createDrizzleRunStore(database.db);
  recovery = createDrizzleRecoveryStore(database.db);
  projectId = randomUUID();
  database.db
    .insert(projects)
    .values({ id: projectId, name: "Example", workspaceKey: "example", createdAt: new Date() })
    .run();
});
afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

function task() {
  const id = randomUUID();
  database.db
    .insert(tasks)
    .values({ id, projectId, instruction: "Analyze", requestKey: id, createdAt: new Date() })
    .run();
  return id;
}
function interrupted(confirmed = false) {
  const run = runs.claim(task(), "fixture");
  runs.record(run.id, {
    kind: "execution.prepared",
    execution: {
      kind: "docker",
      containerId: "a".repeat(64),
      engineId: "fixture",
      token: randomUUID(),
    },
  });
  runs.requestStop(run.id, "server_shutdown");
  runs.finish(run.id, {
    status: "interrupted",
    result: null,
    errorCode: "server_shutdown",
    usage: null,
    terminationConfirmedAt: confirmed ? new Date() : null,
  });
  return run;
}
function input(
  run: { id: string; taskId: string },
  overrides: Partial<RecoveryInput> = {},
): RecoveryInput {
  return {
    taskId: run.taskId,
    runId: run.id,
    action: "resume",
    requestKey: randomUUID(),
    providerGateVersion: null,
    ...overrides,
  };
}
function processor(
  confirm = vi.fn(async () => new Date() as Date | null),
  cleanup = vi.fn(async () => {}),
) {
  return { service: createRecoveryProcessor(recovery, { confirm, cleanup }), confirm, cleanup };
}

test("one durable request queues one new attempt and replays the same receipt after restart", async () => {
  const run = interrupted(true);
  const request = input(run);
  const accepted = recovery.request(request, null, true);
  expect(recovery.request(request, null, true)).toEqual({ ...accepted, created: false });
  expect(() => recovery.request({ ...request, action: "cancel" }, null, true)).toThrow(
    "REQUEST_KEY_CONFLICT",
  );
  const observed = processor();
  await observed.service.process(accepted.request.id);
  expect(observed.confirm).not.toHaveBeenCalled();
  expect(recovery.findById(accepted.request.id)).toMatchObject({
    status: "completed",
    resultStatus: "queued",
  });
  const second = runs.claim(run.taskId, "fixture");
  expect(runs.listByTask(run.taskId).map((row) => [row.id, row.attempt, row.status])).toEqual([
    [second.id, 2, "running"],
    [run.id, 1, "waiting_retry"],
  ]);
  database.close();
  database = openDatabase(path);
  recovery = createDrizzleRecoveryStore(database.db);
  expect(recovery.request(request, null, true)).toMatchObject({
    created: false,
    request: { id: accepted.request.id, status: "completed" },
  });
  expect(() => recovery.request(input(run), null, true)).toThrow("STALE_RUN");
});

test("unavailable termination evidence keeps the slot held and does not remove the container", async () => {
  const run = interrupted();
  const accepted = recovery.request(input(run), null, true);
  const observed = processor(vi.fn(async () => null));
  await observed.service.process(accepted.request.id);
  expect(recovery.findById(accepted.request.id)).toMatchObject({
    status: "rejected",
    errorCode: "TERMINATION_UNCONFIRMED",
  });
  expect(runs.findById(run.id)).toMatchObject({
    status: "interrupted",
    terminationConfirmedAt: null,
  });
  expect(runs.claimNext("fixture", ["example"])).toMatchObject({ kind: "held", runId: run.id });
  expect(observed.cleanup).not.toHaveBeenCalled();
});

test("a legacy run with no execution identity cannot gain proof from a resume request", async () => {
  const run = runs.claim(task(), "fixture");
  runs.finish(run.id, {
    status: "interrupted",
    result: null,
    errorCode: "server_shutdown",
    usage: null,
  });
  const accepted = recovery.request(input(run), null, true);
  const observed = processor();
  await observed.service.process(accepted.request.id);
  expect(observed.confirm).not.toHaveBeenCalled();
  expect(recovery.findById(accepted.request.id)?.errorCode).toBe("TERMINATION_UNCONFIRMED");
  expect(runs.claimNext("fixture", ["example"]).kind).toBe("held");
});

test("a slow observer is bounded and its late answer cannot silently resume the task", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const run = interrupted();
    const accepted = recovery.request(input(run), null, true);
    const observation = Promise.withResolvers<Date | null>();
    const cleanup = vi.fn(async () => {});
    const service = createRecoveryProcessor(recovery, {
      confirm: () => observation.promise,
      cleanup,
    });
    const processing = service.process(accepted.request.id);
    await vi.advanceTimersByTimeAsync(8000);
    await processing;
    expect(recovery.findById(accepted.request.id)?.errorCode).toBe("TERMINATION_UNCONFIRMED");
    observation.resolve(new Date());
    await Promise.resolve();
    expect(runs.findById(run.id)).toMatchObject({
      status: "interrupted",
      terminationConfirmedAt: null,
    });
    expect(cleanup).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test("a cancellation arriving during observation supersedes resume and cannot be undone by its late result", async () => {
  const run = interrupted();
  const resume = recovery.request(input(run), null, true);
  const observed = Promise.withResolvers<Date | null>();
  const confirm = vi.fn(() => observed.promise);
  const cleanup = vi.fn(async () => {});
  const service = createRecoveryProcessor(recovery, { confirm, cleanup });
  const processing = service.process(resume.request.id);
  const cancel = recovery.request(input(run, { action: "cancel" }), null, true);
  expect(database.db.select().from(tasks).get()?.cancelRequestedAt).toBeInstanceOf(Date);
  observed.resolve(new Date());
  await processing;
  expect(recovery.findById(resume.request.id)).toMatchObject({
    status: "rejected",
    errorCode: "TASK_CANCELLED",
  });
  expect(cleanup).not.toHaveBeenCalled();
  await service.process(cancel.request.id);
  expect(recovery.findById(cancel.request.id)).toMatchObject({
    status: "completed",
    resultStatus: "cancelled",
  });
  expect(runs.findById(run.id)).toMatchObject({
    status: "cancelled",
    stopReason: "server_shutdown",
  });
  expect(runs.claimNext("fixture", ["example"]).kind).toBe("idle");
  expect(() => recovery.request(input(run), null, true)).toThrow("TASK_CANCELLED");
});

test("a failed recovery transaction keeps its pending request and observation resource for retry", async () => {
  const run = interrupted();
  const accepted = recovery.request(input(run), null, true);
  const observed = processor();
  database.client.exec(
    "CREATE TRIGGER reject_recovery BEFORE UPDATE ON recovery_requests WHEN NEW.status != 'pending' BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
  );
  await expect(observed.service.process(accepted.request.id)).rejects.toThrow("fixture");
  expect(runs.findById(run.id)).toMatchObject({
    status: "interrupted",
    terminationConfirmedAt: null,
  });
  expect(recovery.findById(accepted.request.id)?.status).toBe("pending");
  expect(observed.cleanup).not.toHaveBeenCalled();
  database.client.exec("DROP TRIGGER reject_recovery");
  await observed.service.process(accepted.request.id);
  expect(recovery.findById(accepted.request.id)).toMatchObject({
    status: "completed",
    resultStatus: "queued",
  });
  expect(observed.cleanup).toHaveBeenCalledOnce();
});

test("a new owner processes the saved request while the old owner cannot even observe it", async () => {
  const run = interrupted();
  const old = acquireExecutionOwner(database.db, {
    hostname: "fixture",
    pid: 101,
    mayExist: () => false,
  });
  recovery = createDrizzleRecoveryStore(database.db, old.token);
  const accepted = recovery.request(input(run), null, true);
  const oldProcessor = processor();
  database.close();
  database = openDatabase(path);
  const owner = acquireExecutionOwner(database.db, {
    hostname: "fixture",
    pid: 102,
    mayExist: () => false,
  });
  const staleStore = createDrizzleRecoveryStore(database.db, old.token);
  const confirm = vi.fn(async () => new Date());
  await expect(
    createRecoveryProcessor(staleStore, { confirm, cleanup: async () => {} }).process(
      accepted.request.id,
    ),
  ).rejects.toThrow("ownership");
  expect(confirm).not.toHaveBeenCalled();
  recovery = createDrizzleRecoveryStore(database.db, owner.token);
  expect(recovery.nextPending()?.id).toBe(accepted.request.id);
  await processor().service.process(accepted.request.id);
  expect(recovery.findById(accepted.request.id)?.resultStatus).toBe("queued");
  expect(oldProcessor.confirm).not.toHaveBeenCalled();
  owner.release();
});

test.each([
  ["timeout", "failed"],
  ["server_shutdown", "waiting_retry"],
  ["unknown", "blocked"],
  [null, "waiting_retry"],
] as const)(
  "reconciliation settles a lost run with reason %s as %s without automatically queuing it",
  async (reason, status) => {
    const run = runs.claim(task(), "fixture");
    runs.record(run.id, {
      kind: "execution.prepared",
      execution: {
        kind: "docker",
        containerId: "a".repeat(64),
        engineId: "fixture",
        token: randomUUID(),
      },
    });
    if (reason) runs.requestStop(run.id, reason);
    const accepted = recovery.request(input(run, { action: "reconcile" }), null, true);
    await processor().service.process(accepted.request.id);
    expect(runs.findById(run.id)).toMatchObject({
      status,
      finishedAt: expect.any(Date),
      terminationConfirmedAt: expect.any(Date),
    });
    expect(recovery.findById(accepted.request.id)).toMatchObject({
      status: "completed",
      resultStatus: status,
    });
    expect(runs.claimNext("fixture", ["example"]).kind).toBe("idle");
    if (reason === "unknown") {
      const resume = recovery.request(input(run), null, true);
      await processor().service.process(resume.request.id);
      expect(recovery.findById(resume.request.id)?.errorCode).toBe("UNKNOWN_STOP_REASON");
    }
  },
);

test("an already saved result is finalized without executing a replacement", async () => {
  const run = runs.claim(task(), "fixture");
  runs.finish(run.id, {
    status: "interrupted",
    result: "Report",
    errorCode: "termination_unconfirmed",
    usage: null,
  });
  const request = recovery.request(input(run), null, true);
  recovery.complete(request.request.id, new Date());
  expect(runs.findById(run.id)).toMatchObject({
    status: "succeeded",
    result: "Report",
    errorCode: null,
  });
  expect(recovery.findById(request.request.id)?.resultStatus).toBe("succeeded");
  expect(runs.listByTask(run.taskId)).toHaveLength(1);
});

function block(retryAt: Date | null = null) {
  const run = runs.claim(task(), "fixture");
  runs.finish(run.id, {
    status: "waiting_capacity",
    errorCode: "capacity",
    result: null,
    usage: null,
    retryAt,
    terminationConfirmedAt: new Date(),
  });
  return run;
}

test("provider recovery checks time and version, reserves one attempt, and requires its success to unblock", async () => {
  const run = block(new Date(Date.now() + 60000));
  expect(() => recovery.request(input(run), null, true)).toThrow("GATE_CHANGED");
  expect(() => recovery.request(input(run, { providerGateVersion: 1 }), null, true)).toThrow(
    "RETRY_TOO_EARLY",
  );
  database.client.exec("UPDATE provider_gates SET retry_at = 0");
  const accepted = recovery.request(input(run, { providerGateVersion: 1 }), null, true);
  await processor().service.process(accepted.request.id);
  expect(runs.getProviderGate()).toMatchObject({
    blocked: true,
    probeTaskId: run.taskId,
    probeRunId: null,
  });
  const other = task();
  expect(() =>
    recovery.request(
      { taskId: other, runId: null, requestKey: "check", action: "resume", providerGateVersion: 1 },
      null,
      true,
    ),
  ).toThrow("PROVIDER_CHECK_RESERVED");
  const claim = runs.claimNext("fixture", ["example"]);
  expect(claim).toMatchObject({
    kind: "claimed",
    run: { taskId: run.taskId, providerCheck: true },
  });
  if (claim.kind !== "claimed") throw new Error("Expected confirmation");
  runs.finish(claim.run.id, {
    status: "succeeded",
    result: "Report",
    errorCode: null,
    usage: null,
    terminationConfirmedAt: new Date(),
  });
  expect(runs.getProviderGate()).toMatchObject({ blocked: false, version: 2 });
  expect(runs.claimNext("fixture", ["example"])).toMatchObject({
    kind: "claimed",
    run: { taskId: other },
  });
});

test("cancelling an unstarted provider check clears its reservation but retains account blocking", async () => {
  block();
  const id = task();
  const request: RecoveryInput = {
    taskId: id,
    runId: null,
    action: "resume",
    requestKey: "check",
    providerGateVersion: 1,
  };
  const accepted = recovery.request(request, null, true);
  await processor().service.process(accepted.request.id);
  expect(runs.getProviderGate().probeTaskId).toBe(id);
  const cancel = recovery.request(
    { ...request, action: "cancel", requestKey: "cancel" },
    null,
    true,
  );
  expect(cancel.request).toMatchObject({ status: "completed", resultStatus: "cancelled" });
  expect(runs.getProviderGate()).toMatchObject({
    blocked: true,
    version: 2,
    probeTaskId: null,
    probeRunId: null,
  });
  expect(runs.claimNext("fixture", ["example"]).kind).toBe("held");
});

test("gate changes during observation reject the stale resume after saving termination proof", async () => {
  const run = block();
  const accepted = recovery.request(input(run, { providerGateVersion: 1 }), null, true);
  database.client.exec("UPDATE provider_gates SET version = 2, reason = 'authentication'");
  await processor().service.process(accepted.request.id);
  expect(recovery.findById(accepted.request.id)).toMatchObject({
    status: "rejected",
    errorCode: "GATE_CHANGED",
  });
  expect(runs.getProviderGate()).toMatchObject({
    version: 2,
    reason: "authentication",
    probeTaskId: null,
  });
});

test("an orphaned probe is reconciled but cannot reuse its obsolete gate version", async () => {
  block();
  const id = task();
  runs.reserveProviderCheck(id, 1);
  const probe = runs.claim(id, "fixture");
  runs.record(probe.id, {
    kind: "execution.prepared",
    execution: {
      kind: "docker",
      containerId: "b".repeat(64),
      engineId: "fixture",
      token: randomUUID(),
    },
  });
  const accepted = recovery.request(input(probe, { providerGateVersion: 1 }), null, true);
  await processor().service.process(accepted.request.id);
  expect(recovery.findById(accepted.request.id)).toMatchObject({
    status: "rejected",
    errorCode: "GATE_CHANGED",
  });
  expect(runs.getProviderGate()).toMatchObject({
    blocked: true,
    version: 2,
    probeTaskId: null,
    probeRunId: null,
  });
  expect(runs.findById(probe.id)).toMatchObject({
    status: "waiting_retry",
    terminationConfirmedAt: expect.any(Date),
  });
});

test("active runs and executors without termination tracking cannot be resumed", () => {
  const run = interrupted(true);
  expect(() => recovery.request(input(run), null, false)).toThrow("TERMINATION_TRACKING_REQUIRED");
  expect(() => recovery.request(input(run), run.id, true)).toThrow("RUN_ACTIVE");
  expect(recovery.nextPending()).toBeUndefined();
});
