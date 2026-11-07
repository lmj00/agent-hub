import { readExecutions } from "../src/modules/execution/execution-record-store.js";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { migrationsDirectory, openDatabase } from "../src/db/connection.js";
import { projects, runs, tasks } from "../src/db/schema.js";
import { createDrizzleRunStore } from "../src/modules/execution/drizzle-run-store.js";
import { runTask } from "../src/modules/execution/run-task.js";

let directory: string;
let database: ReturnType<typeof openDatabase>;
let taskId: string;
let store: ReturnType<typeof createDrizzleRunStore>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "hub-stop-"));
  database = openDatabase(join(directory, "hub.sqlite"));
  store = createDrizzleRunStore(database.db);
  const projectId = randomUUID();
  taskId = randomUUID();
  database.db
    .insert(projects)
    .values({ id: projectId, name: "Example", workspaceKey: "example", createdAt: new Date() })
    .run();
  database.db
    .insert(tasks)
    .values({
      id: taskId,
      projectId,
      instruction: "Analyze",
      requestKey: "first",
      createdAt: new Date(),
    })
    .run();
});
afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

test("unavailable termination evidence keeps even a completed report held", async () => {
  const cleanup = vi.fn();
  const outcome = await runTask(
    {
      taskId,
      model: "test",
      workspace: directory,
      timeoutMs: 1000,
      signal: new AbortController().signal,
    },
    store,
    {
      analyze: async () => ({ output: "Report", usage: null }),
      confirmTermination: async () => null,
      cleanup,
    },
  );
  expect(outcome).toMatchObject({
    status: "interrupted",
    errorCode: "termination_unconfirmed",
    result: "Report",
  });
  expect(cleanup).not.toHaveBeenCalled();
  expect(store.claimNext("test", ["example"])).toMatchObject({
    kind: "held",
    runId: outcome.runId,
  });
});

test("failed completion persistence preserves the execution identity and does not remove its container", async () => {
  database.client.exec(
    "CREATE TRIGGER reject_finish BEFORE UPDATE ON steps BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
  );
  const cleanup = vi.fn();
  const execution = {
    kind: "docker" as const,
    containerId: "a".repeat(64),
    token: randomUUID(),
    engineId: "fixture",
  };
  await expect(
    runTask(
      {
        taskId,
        model: "test",
        workspace: directory,
        timeoutMs: 1000,
        signal: new AbortController().signal,
      },
      store,
      {
        async analyze(_request, onEvent) {
          onEvent({ kind: "execution.prepared", execution });
          return { output: "Report", usage: null };
        },
        confirmTermination: async () => new Date(),
        cleanup,
      },
    ),
  ).rejects.toThrow("fixture");
  expect(database.db.select().from(runs).get()).toMatchObject({
    status: "running",
    terminationConfirmedAt: null,
  });
  expect(
    readExecutions(database.db, database.db.select().from(runs).get()!.id)[0]?.identity,
  ).toEqual(execution);
  expect(cleanup).not.toHaveBeenCalled();
});

test("execution identity is durable and cannot be replaced during a run", () => {
  const run = store.claim(taskId, "test");
  const execution = {
    kind: "docker" as const,
    containerId: "a".repeat(64),
    token: randomUUID(),
    engineId: "fixture",
  };
  store.record(run.id, { kind: "execution.prepared", execution });
  expect(() =>
    store.record(run.id, {
      kind: "execution.prepared",
      execution: { ...execution, token: randomUUID() },
    }),
  ).toThrow("already assigned");
  database.close();
  database = openDatabase(join(directory, "hub.sqlite"));
  expect(readExecutions(database.db, run.id)[0]?.identity).toEqual(execution);
});

test.each(["user_cancel", "server_shutdown"] as const)(
  "persists %s before signaling the executor and preserves it across restart",
  async (reason) => {
    const controller = new AbortController();
    let observedBeforeStop = false;
    const outcome = await runTask(
      { taskId, model: "test", workspace: directory, timeoutMs: 1000, signal: controller.signal },
      store,
      {
        analyze(request) {
          return new Promise((_resolve, reject) => {
            request.signal.addEventListener(
              "abort",
              () => {
                const run = database.db.select().from(runs).get()!;
                const task = database.db.select().from(tasks).get()!;
                observedBeforeStop =
                  run.stopReason === reason &&
                  run.stopRequestedAt instanceof Date &&
                  (reason === "user_cancel"
                    ? task.cancelRequestedAt instanceof Date
                    : task.cancelRequestedAt === null);
                reject(new Error("Stopped"));
              },
              { once: true },
            );
            controller.abort(reason);
          });
        },
      },
    );
    expect(observedBeforeStop).toBe(true);
    expect(outcome.status).toBe("interrupted");
    expect(outcome.errorCode).toBe(
      reason === "user_cancel" ? "cancel_requested" : "server_shutdown",
    );
    database.close();
    database = openDatabase(join(directory, "hub.sqlite"));
    store = createDrizzleRunStore(database.db);
    expect(store.findById(outcome.runId)).toMatchObject({
      stopReason: reason,
      stopRequestedAt: expect.any(Date),
      terminationConfirmedAt: null,
      finishedAt: null,
    });
  },
);

test("records timeout without inventing process termination or user cancellation", async () => {
  const outcome = await runTask(
    {
      taskId,
      model: "test",
      workspace: directory,
      timeoutMs: 5,
      signal: new AbortController().signal,
    },
    store,
    {
      analyze: () => new Promise(() => {}),
    },
  );
  expect(store.findById(outcome.runId)).toMatchObject({
    status: "interrupted",
    stopReason: "timeout",
    stopRequestedAt: expect.any(Date),
    terminationConfirmedAt: null,
  });
  expect(database.db.select().from(tasks).get()?.cancelRequestedAt).toBeNull();
});

test("the first durable stop reason wins and a stale owner cannot replace it", () => {
  const run = store.claim(taskId, "test");
  expect(store.requestStop(run.id, "user_cancel")).toBe("user_cancel");
  const before = store.findById(run.id);
  expect(store.requestStop(run.id, "timeout")).toBe("user_cancel");
  expect(store.findById(run.id)).toEqual(before);
  expect(() => createDrizzleRunStore(database.db).requestStop(run.id, "server_shutdown")).toThrow(
    "not owned",
  );
  expect(store.findById(run.id)).toEqual(before);
});

test("a failed stop write rolls back intent, still aborts, and keeps the active run held", async () => {
  database.client.exec(
    "CREATE TRIGGER reject_cancel BEFORE UPDATE OF cancel_requested_at ON tasks BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
  );
  const controller = new AbortController();
  let signaled = false;
  await expect(
    runTask(
      { taskId, model: "test", workspace: directory, timeoutMs: 1000, signal: controller.signal },
      store,
      {
        analyze(request) {
          request.signal.addEventListener("abort", () => {
            signaled = true;
          });
          controller.abort("user_cancel");
          return new Promise(() => {});
        },
      },
    ),
  ).rejects.toThrow("fixture");
  expect(signaled).toBe(true);
  const run = database.db.select().from(runs).get()!;
  expect(run).toMatchObject({
    status: "running",
    stopReason: null,
    stopRequestedAt: null,
    terminationConfirmedAt: null,
  });
  expect(database.db.select().from(tasks).get()).toMatchObject({
    status: "running",
    cancelRequestedAt: null,
  });
  expect(store.claimNext("test", ["example"])).toMatchObject({ kind: "held", runId: run.id });
});

test("upgrades old interrupted records without guessing a stop time or unlocking them", () => {
  database.close();
  rmSync(join(directory, "hub.sqlite"));
  const folder = join(directory, "old-migrations");
  cpSync(migrationsDirectory, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.slice(0, 4);
  writeFileSync(journalPath, JSON.stringify(journal));
  const legacy = openDatabase(join(directory, "hub.sqlite"), folder);
  try {
    legacy.client
      .prepare("INSERT INTO projects VALUES (?, ?, ?, ?)")
      .run("project", "Example", "example", 1000);
    legacy.client
      .prepare(
        "INSERT INTO tasks (id, project_id, instruction, request_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(taskId, "project", "Analyze", "first", "interrupted", 1000);
    legacy.client
      .prepare(
        "INSERT INTO runs (id, task_id, instance_id, status, model, effort, started_at, last_activity_at, error_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "old-run",
        taskId,
        "old-owner",
        "interrupted",
        "test",
        "medium",
        1000,
        2000,
        "cancel_requested",
      );
    legacy.client
      .prepare(
        "INSERT INTO steps (id, run_id, sequence, status, started_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("step", "old-run", 1, "interrupted", 1000);
    legacy.client
      .prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?)")
      .run("event", "old-run", 1, "run.interrupted", 2000);
  } finally {
    legacy.close();
  }
  database = openDatabase(join(directory, "hub.sqlite"));
  store = createDrizzleRunStore(database.db);
  expect(store.findById("old-run")).toMatchObject({
    status: "interrupted",
    stopReason: "unknown",
    stopRequestedAt: null,
    terminationConfirmedAt: null,
    steps: [{ sequence: 1, status: "interrupted" }],
    events: [{ kind: "run.interrupted" }],
  });
  expect(store.claimNext("test", ["example"])).toMatchObject({ kind: "held", runId: "old-run" });
  expect(database.client.pragma("foreign_key_check")).toEqual([]);
});
