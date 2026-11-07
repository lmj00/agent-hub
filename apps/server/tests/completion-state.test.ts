import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { migrationsDirectory, openDatabase } from "../src/db/connection.js";
import { projects, tasks } from "../src/db/schema.js";
import { createDrizzleRunStore } from "../src/modules/execution/drizzle-run-store.js";
import { runTask } from "../src/modules/execution/run-task.js";

let directory: string;
let path: string;
let database: ReturnType<typeof openDatabase>;
let store: ReturnType<typeof createDrizzleRunStore>;
let taskId: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "hub-completion-"));
  path = join(directory, "hub.sqlite");
  database = openDatabase(path);
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

test.each([
  ["user_cancel", "cancelled"],
  ["server_shutdown", "waiting_retry"],
  ["timeout", "failed"],
] as const)("settles a confirmed %s as %s", async (reason, status) => {
  const controller = new AbortController();
  const outcome = await runTask(
    { taskId, model: "fixture", workspace: directory, timeoutMs: 5, signal: controller.signal },
    store,
    {
      analyze() {
        if (reason !== "timeout") controller.abort(reason);
        return new Promise(() => {});
      },
      confirmTermination: async () => new Date(),
    },
  );
  expect(outcome.status).toBe(status);
  expect(store.findById(outcome.runId)).toMatchObject({
    status,
    stopReason: reason,
    finishedAt: expect.any(Date),
    terminationConfirmedAt: expect.any(Date),
    steps: [{ status, finishedAt: expect.any(Date) }],
  });
  expect(database.db.select().from(tasks).get()?.status).toBe(status);
  expect(store.claimNext("fixture", ["example"]).kind).toBe("idle");
});

test("a durable cancellation still prevents assignment if the task is accidentally requeued", () => {
  const run = store.claim(taskId, "fixture");
  store.requestStop(run.id, "user_cancel");
  store.finish(run.id, {
    status: "interrupted",
    result: null,
    errorCode: "cancel_requested",
    usage: null,
    terminationConfirmedAt: new Date(),
  });
  database.client.prepare("UPDATE tasks SET status = 'queued' WHERE id = ?").run(taskId);
  expect(store.claimNext("fixture", ["example"]).kind).toBe("idle");
  expect(() => store.claim(taskId, "fixture")).toThrow("Cancelled");
});

test("attempt numbers preserve order even when the clock moves backward", () => {
  const first = store.claim(taskId, "fixture");
  store.finish(first.id, {
    status: "failed",
    result: null,
    errorCode: "provider_error",
    usage: null,
    terminationConfirmedAt: new Date(),
  });
  // 다음 단위의 재개 처리가 만드는 대기 상태를 준비합니다.
  database.client.prepare("UPDATE tasks SET status = 'queued' WHERE id = ?").run(taskId);
  const second = store.claim(taskId, "fixture");
  database.client.prepare("UPDATE runs SET started_at = 0 WHERE id = ?").run(second.id);
  expect(store.listByTask(taskId).map((run) => [run.id, run.attempt])).toEqual([
    [second.id, 2],
    [first.id, 1],
  ]);
});

function legacyDatabase() {
  database.close();
  rmSync(path);
  const folder = join(directory, "legacy");
  cpSync(migrationsDirectory, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.slice(0, 7);
  writeFileSync(journalPath, JSON.stringify(journal));
  const old = openDatabase(path, folder);
  try {
    old.client.exec(`
      INSERT INTO projects VALUES ('project', 'Example', 'example', 1000);
      INSERT INTO tasks (id, project_id, instruction, request_key, status, cancel_requested_at, created_at)
        VALUES ('task', 'project', 'Analyze', 'first', 'running', 1500, 1000);
      INSERT INTO runs (id, task_id, instance_id, status, model, effort, started_at, last_activity_at, termination_confirmed_at)
        VALUES ('first', 'task', 'owner', 'waiting_capacity', 'fixture', 'medium', 1000, 1000, 1000),
               ('second', 'task', 'owner', 'running', 'fixture', 'medium', 1000, 1000, NULL);
      INSERT INTO steps (id, run_id, sequence, status, started_at) VALUES ('step', 'second', 1, 'running', 1000);
      INSERT INTO events VALUES ('event', 'second', 1, 'run.started', 1000);
      INSERT INTO provider_gates (scope, version, blocked, reason, blocked_at, source_run_id, probe_task_id, probe_run_id)
        VALUES ('openai:chatgpt', 3, 1, 'capacity', 1000, 'first', 'task', 'second');
    `);
  } finally {
    old.close();
  }
  return folder;
}

test("rebuilds the task constraint while preserving referenced run, step, event and gate history", () => {
  legacyDatabase();
  database = openDatabase(path);
  store = createDrizzleRunStore(database.db);
  expect(store.listByTask("task").map((run) => [run.id, run.attempt])).toEqual([
    ["second", 2],
    ["first", 1],
  ]);
  expect(store.findById("second")).toMatchObject({
    status: "running",
    steps: [{ status: "running" }],
    events: [{ kind: "run.started" }],
  });
  expect(store.getProviderGate()).toMatchObject({
    sourceRunId: "first",
    probeTaskId: "task",
    probeRunId: "second",
    version: 3,
  });
  expect(database.db.select().from(tasks).get()?.cancelRequestedAt).toEqual(new Date(1500));
  expect(database.client.pragma("foreign_keys", { simple: true })).toBe(1);
  expect(database.client.pragma("defer_foreign_keys", { simple: true })).toBe(0);
  expect(database.client.pragma("foreign_key_check")).toEqual([]);
  expect(() =>
    database.client.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = 'task'").run(),
  ).not.toThrow();
});

test("a failed final foreign-key check rolls back the parent replacement and migration journal", () => {
  legacyDatabase();
  const badFolder = join(directory, "bad");
  cpSync(migrationsDirectory, badFolder, { recursive: true });
  const migration = join(badFolder, "0007_completion_states.sql");
  writeFileSync(
    migration,
    readFileSync(migration, "utf8").replace("FROM `tasks`;", "FROM `tasks` WHERE 0;"),
  );
  expect(() => openDatabase(path, badFolder)).toThrow("INSERT INTO migration_fk_guard");
  const client = new Database(path);
  try {
    expect(client.prepare("SELECT id, status FROM tasks").all()).toEqual([
      { id: "task", status: "running" },
    ]);
    expect(client.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get()).toEqual({
      count: 7,
    });
    expect(
      client.prepare("SELECT name FROM pragma_table_info('runs') WHERE name = 'attempt'").all(),
    ).toEqual([]);
    expect(client.prepare("SELECT probe_run_id FROM provider_gates").get()).toEqual({
      probe_run_id: "second",
    });
    expect(client.pragma("foreign_key_check")).toEqual([]);
  } finally {
    client.close();
  }
});
