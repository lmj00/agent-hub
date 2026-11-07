import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { migrationsDirectory, openDatabase } from "../../src/db/connection.js";
import { projects, runExecutions, tasks } from "../../src/db/schema.js";
import { maxRunExecutions, type ExecutionIdentity } from "../../src/modules/execution/analysis.js";
import { createDrizzleRunStore } from "../../src/modules/execution/drizzle-run-store.js";
import { createDrizzleRecoveryStore } from "../../src/modules/execution/drizzle-recovery-store.js";
import { readExecutions } from "../../src/modules/execution/execution-record-store.js";
import { createRecoveryProcessor } from "../../src/modules/execution/recover-task.js";

let directory: string;
let database: ReturnType<typeof openDatabase>;
let store: ReturnType<typeof createDrizzleRunStore>;
let run: ReturnType<typeof store.claim>;
const identity = (): ExecutionIdentity => ({
  kind: "docker",
  containerId: randomUUID().replaceAll("-", "").repeat(2),
  token: randomUUID(),
  engineId: "fixture",
});
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "hub-execution-records-"));
  database = openDatabase(join(directory, "hub.sqlite"));
  database.db
    .insert(projects)
    .values({
      id: "project",
      name: "Fixture",
      workspaceKey: "fixture",
      createdAt: new Date(),
    })
    .run();
  database.db
    .insert(tasks)
    .values({
      id: "task",
      projectId: "project",
      instruction: "Inspect",
      requestKey: "task",
      createdAt: new Date(),
    })
    .run();
  store = createDrizzleRunStore(database.db);
  run = store.claim("task", "fixture");
});
afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});
const prepare = (execution: ExecutionIdentity) =>
  store.record(run.id, { kind: "execution.prepared", execution });
const terminate = (execution: ExecutionIdentity, confirmedAt = new Date()) =>
  store.record(run.id, {
    kind: "execution.terminated",
    executionTermination: { identity: execution, confirmedAt },
  });
const request = (recovery: ReturnType<typeof createDrizzleRecoveryStore>) =>
  recovery.request(
    {
      taskId: run.taskId,
      runId: run.id,
      requestKey: randomUUID(),
      action: "reconcile",
      providerGateVersion: null,
    },
    null,
    true,
  ).request;

test("a later phase requires saved proof and preserves earlier identities across reopen", () => {
  const first = identity(),
    second = identity();
  prepare(first);
  expect(() => prepare(second)).toThrow("termination is unconfirmed");
  terminate(first);
  prepare(second);
  expect(() => prepare(first)).toThrow("already assigned");
  database.close();
  database = openDatabase(join(directory, "hub.sqlite"));
  expect(readExecutions(database.db, run.id)).toMatchObject([
    { sequence: 1, identity: first, terminationConfirmedAt: expect.any(Date) },
    { sequence: 2, identity: second, terminationConfirmedAt: null },
  ]);
});

test("wrong, future or forged phase proof cannot release the next phase", () => {
  const first = identity();
  prepare(first);
  for (const forged of [{ ...first, token: "wrong" }, { ...first, engineId: "wrong" }, identity()])
    expect(() => terminate(forged)).toThrow("Invalid execution termination");
  expect(() => terminate(first, new Date(Date.now() + 60000))).toThrow(
    "Invalid execution termination",
  );
  expect(() => terminate(first, new Date(0))).toThrow("Invalid execution termination");
  expect(() => terminate(first, new Date(NaN))).toThrow("Invalid execution termination");
  expect(readExecutions(database.db, run.id)[0]?.terminationConfirmedAt).toBeNull();
  const proof = new Date();
  terminate(first, proof);
  terminate(first);
  expect(readExecutions(database.db, run.id)[0]?.terminationConfirmedAt).toEqual(proof);
});

test("a failed phase-proof write rolls back and keeps the next phase blocked", () => {
  const first = identity();
  prepare(first);
  database.client.exec(
    "CREATE TRIGGER reject_phase_proof BEFORE UPDATE ON run_executions BEGIN SELECT RAISE(ABORT, 'proof failed'); END",
  );
  expect(() => terminate(first)).toThrow("proof failed");
  expect(() => prepare(identity())).toThrow("termination is unconfirmed");
  expect(readExecutions(database.db, run.id)[0]?.terminationConfirmedAt).toBeNull();
});

test("Run completion and the final phase proof commit or roll back together", () => {
  const first = identity(),
    second = identity();
  prepare(first);
  terminate(first);
  prepare(second);
  const prior = readExecutions(database.db, run.id)[0]!.terminationConfirmedAt;
  database.client.exec(
    "CREATE TRIGGER reject_run_finish BEFORE UPDATE OF status ON tasks BEGIN SELECT RAISE(ABORT, 'finish failed'); END",
  );
  const complete = () =>
    store.finish(run.id, {
      status: "succeeded",
      result: "Report",
      errorCode: null,
      usage: null,
      terminationConfirmedAt: new Date(),
    });
  expect(complete).toThrow("finish failed");
  expect(readExecutions(database.db, run.id).map((row) => row.terminationConfirmedAt)).toEqual([
    prior,
    null,
  ]);
  expect(store.findById(run.id)?.status).toBe("running");
  database.client.exec("DROP TRIGGER reject_run_finish");
  complete();
  expect(readExecutions(database.db, run.id).map((row) => row.terminationConfirmedAt)).toEqual([
    prior,
    expect.any(Date),
  ]);
});

test("recovery observes only the unfinished phase and cleans every recorded container after saving", async () => {
  const first = identity(),
    second = identity();
  prepare(first);
  terminate(first);
  prepare(second);
  store.requestStop(run.id, "server_shutdown");
  database.close();
  database = openDatabase(join(directory, "hub.sqlite"));
  const recovery = createDrizzleRecoveryStore(database.db);
  const confirm = vi.fn(async () => new Date());
  const cleanup = vi.fn(async () => {
    expect(readExecutions(database.db, run.id).every((row) => row.terminationConfirmedAt)).toBe(
      true,
    );
  });
  const receipt = request(recovery);
  await createRecoveryProcessor(recovery, { confirm, cleanup }).process(receipt.id);
  expect(confirm.mock.calls).toEqual([[second]]);
  expect(cleanup.mock.calls).toEqual([[first], [second]]);
  expect(recovery.findById(receipt.id)).toMatchObject({
    status: "completed",
    resultStatus: "waiting_retry",
  });
});

test("a missing final container remains held even with earlier saved proof", async () => {
  const first = identity();
  prepare(first);
  terminate(first);
  prepare(identity());
  const recovery = createDrizzleRecoveryStore(database.db),
    receipt = request(recovery);
  const cleanup = vi.fn(async () => {});
  await createRecoveryProcessor(recovery, {
    confirm: async () => null,
    cleanup,
  }).process(receipt.id);
  expect(recovery.findById(receipt.id)?.errorCode).toBe("TERMINATION_UNCONFIRMED");
  expect(store.claimNext("fixture", ["fixture"]).kind).toBe("held");
  expect(cleanup).not.toHaveBeenCalled();
});

test("a phase added after recovery observation invalidates the aggregate proof", () => {
  const first = identity();
  prepare(first);
  terminate(first);
  const recovery = createDrizzleRecoveryStore(database.db),
    receipt = request(recovery);
  const observed = recovery.candidate(receipt.id)!.run!.executions;
  prepare(identity());
  expect(recovery.complete(receipt.id, new Date(), false, observed)).toEqual({
    proofSaved: false,
  });
  expect(recovery.findById(receipt.id)?.errorCode).toBe("TERMINATION_UNCONFIRMED");
  expect(store.findById(run.id)?.terminationConfirmedAt).toBeNull();
});

test("a durable stop prevents further phase allocation and the database rejects concurrent unconfirmed phases", () => {
  const first = identity();
  prepare(first);
  expect(() =>
    database.db
      .insert(runExecutions)
      .values({
        runId: run.id,
        sequence: 2,
        containerId: "b".repeat(64),
        token: "token",
        engineId: "fixture",
        createdAt: new Date(),
      })
      .run(),
  ).toThrow();
  terminate(first);
  store.requestStop(run.id, "user_cancel");
  expect(() => prepare(identity())).toThrow("Execution cannot start");
});

test("a Run cannot allocate an unbounded sequence of stopped containers", () => {
  for (let sequence = 0; sequence < maxRunExecutions; sequence++) {
    const next = identity();
    prepare(next);
    terminate(next);
  }
  expect(() => prepare(identity())).toThrow("Execution resource limit");
  expect(readExecutions(database.db, run.id)).toHaveLength(maxRunExecutions);
});

test("migration preserves old identities and proofs without inventing termination", () => {
  database.close();
  rmSync(join(directory, "hub.sqlite"));
  const folder = join(directory, "old-migrations");
  cpSync(migrationsDirectory, folder, { recursive: true });
  const journal = JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8"));
  journal.entries = journal.entries.slice(0, 23);
  writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify(journal));
  const legacy = openDatabase(join(directory, "hub.sqlite"), folder);
  const first = identity(),
    second = identity();
  try {
    legacy.client
      .prepare("INSERT INTO projects VALUES ('project', 'Fixture', 'fixture', 1000)")
      .run();
    for (const [id, execution, proof] of [
      ["old-running", first, null],
      ["old-done", second, 2000],
    ] as const) {
      legacy.client
        .prepare(
          "INSERT INTO tasks (id, project_id, instruction, request_key, status, created_at) VALUES (?, 'project', 'Inspect', ?, ?, 1000)",
        )
        .run(id, id, proof ? "succeeded" : "interrupted");
      legacy.client
        .prepare(
          "INSERT INTO runs (id, task_id, instance_id, status, model, effort, started_at, last_activity_at, execution, termination_confirmed_at) VALUES (?, ?, 'old-owner', ?, 'fixture', 'medium', 1000, 1000, ?, ?)",
        )
        .run(id, id, proof ? "succeeded" : "interrupted", JSON.stringify(execution), proof);
    }
  } finally {
    legacy.close();
  }
  database = openDatabase(join(directory, "hub.sqlite"));
  expect(readExecutions(database.db, "old-running")).toEqual([
    {
      sequence: 1,
      identity: first,
      createdAt: new Date(1000),
      terminationConfirmedAt: null,
    },
  ]);
  expect(readExecutions(database.db, "old-done")[0]).toMatchObject({
    identity: second,
    terminationConfirmedAt: new Date(2000),
  });
  expect(database.client.pragma("foreign_key_check")).toEqual([]);
  expect(database.client.pragma("table_info(runs)")).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "execution" })]),
  );
  database.close();
  database = openDatabase(join(directory, "hub.sqlite"));
  expect(database.db.select().from(runExecutions).all()).toHaveLength(2);
});
