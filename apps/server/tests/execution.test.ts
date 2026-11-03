import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { migrationsDirectory, openDatabase } from "../src/db/connection.js";
import { events, projects, runs, steps, tasks } from "../src/db/schema.js";
import { AnalysisError, type AnalysisEvent, type AnalysisExecutor, type AnalysisResult } from "../src/modules/execution/analysis.js";
import { createDrizzleRunStore } from "../src/modules/execution/drizzle-run-store.js";
import { runTask } from "../src/modules/execution/run-task.js";

let directory: string;
let databasePath: string;
let database: ReturnType<typeof openDatabase>;
let store: ReturnType<typeof createDrizzleRunStore>;
let taskId: string;
let otherTaskId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "agent-hub-execution-"));
  databasePath = join(directory, "hub.sqlite");
  database = openDatabase(databasePath);
  store = createDrizzleRunStore(database.db);
  const projectId = randomUUID();
  taskId = randomUUID(); otherTaskId = randomUUID();
  database.db.insert(projects).values({ id: projectId, name: "Example", workspaceKey: "example", createdAt: new Date() }).run();
  database.db.insert(tasks).values([
    { id: taskId, projectId, instruction: "Analyze", requestKey: "first", createdAt: new Date() },
    { id: otherTaskId, projectId, instruction: "Analyze again", requestKey: "second", createdAt: new Date() },
  ]).run();
});

afterEach(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });

function execute(executor: AnalysisExecutor, timeoutMs = 1000) {
  return runTask({ taskId, model: "test-model", workspace: directory, timeoutMs, signal: new AbortController().signal }, store, executor);
}

const succeeds: AnalysisExecutor = {
  async analyze(_request, onEvent) {
    onEvent({ kind: "thread.started", sessionId: "test-session" });
    onEvent({ kind: "item.completed:command_execution" });
    return { output: "Result with sk-secret_fixture_token and Bearer fixture-token", usage: { inputTokens: 20, cachedInputTokens: 5, outputTokens: 10 } };
  },
};

test("persists task, run, step, bounded metadata and redacted result across reopening", async () => {
  const result = await execute(succeeds);
  expect(result.status).toBe("succeeded");
  const run = store.findById(result.runId)!;
  expect(run.result).toBe("Result with [REDACTED] and Bearer [REDACTED]");
  expect(run.steps).toHaveLength(1);
  expect(run.steps[0]).toMatchObject({ status: "succeeded", sessionId: "test-session", usage: { inputTokens: 20, cachedInputTokens: 5, outputTokens: 10 } });
  expect(run.events.map(event => event.sequence)).toEqual([1, 2, 3, 4]);
  expect(run.events.at(-1)?.kind).toBe("run.succeeded");
  database.close();
  database = openDatabase(databasePath);
  store = createDrizzleRunStore(database.db);
  expect(store.findById(result.runId)).toEqual(run);
  expect(database.client.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId)).toEqual({ status: "succeeded" });
  expect(database.client.pragma("foreign_key_check")).toEqual([]);
});

test("claims one run atomically across database connections and rejects a second active run", () => {
  const first = store.claim(taskId, "test-model");
  const second = openDatabase(databasePath);
  try {
    expect(() => createDrizzleRunStore(second.db).claim(otherTaskId, "test-model")).toThrow("previous run");
    expect(second.client.prepare("SELECT status FROM tasks WHERE id = ?").get(otherTaskId)).toEqual({ status: "queued" });
    expect(second.db.select().from(runs).all()).toHaveLength(1);
    expect(second.db.select().from(steps).all()).toHaveLength(1);
    expect(() => second.db.insert(runs).values({
      id: randomUUID(), taskId: otherTaskId, instanceId: "other", status: "running", model: "test", effort: "medium", startedAt: new Date(), lastActivityAt: new Date(),
    }).run()).toThrow();
    expect(() => createDrizzleRunStore(second.db).finish(first.id, { status: "succeeded", result: "stale", errorCode: null, usage: null })).toThrow("not owned");
  } finally { second.close(); }
});

test("a crash record is preserved and blocks new claims after reopening", () => {
  const run = store.claim(taskId, "test-model");
  database.close();
  database = openDatabase(databasePath);
  store = createDrizzleRunStore(database.db);
  expect(store.findById(run.id)?.status).toBe("running");
  expect(() => store.claim(otherTaskId, "test-model")).toThrow("previous run");
});

test("rolls back task and run changes when step creation fails", () => {
  database.client.exec("CREATE TRIGGER reject_step BEFORE INSERT ON steps BEGIN SELECT RAISE(ABORT, 'fixture'); END;");
  expect(() => store.claim(taskId, "test-model")).toThrow();
  expect(database.client.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId)).toEqual({ status: "queued" });
  expect(database.db.select().from(runs).all()).toEqual([]);
  expect(database.db.select().from(events).all()).toEqual([]);
});

test("rolls back completion as a unit when saving the step result fails", () => {
  const run = store.claim(taskId, "test-model");
  database.client.exec("CREATE TRIGGER reject_finish BEFORE UPDATE ON steps BEGIN SELECT RAISE(ABORT, 'fixture'); END;");
  expect(() => store.finish(run.id, { status: "succeeded", result: "Result", errorCode: null, usage: null })).toThrow();
  expect(store.findById(run.id)).toMatchObject({ status: "running", result: null, finishedAt: null });
  expect(database.client.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId)).toEqual({ status: "running" });
});

test.each([
  ["authentication", "blocked"], ["capacity", "waiting_capacity"], ["unsupported_settings", "blocked"],
] as const)("persists %s and prevents bypass by starting another task", async (code, status) => {
  const result = await execute({ async analyze() { throw new AnalysisError(code); } });
  expect(result.status).toBe(status);
  expect(store.findById(result.runId)?.errorCode).toBe(code);
  expect(() => store.claim(otherTaskId, "test-model")).toThrow("previous run");
});

test("leaves timeout as interrupted until child-process termination can be verified", async () => {
  const result = await execute({ analyze(request) {
    return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  } }, 10);
  expect(result).toMatchObject({ status: "interrupted", errorCode: "timeout" });
  expect(store.findById(result.runId)?.finishedAt).toBeNull();
  expect(() => store.claim(otherTaskId, "test-model")).toThrow("previous run");
});

test.each(["resolve", "reject"] as const)("bounds an unresponsive executor and ignores late events and %s", async settlement => {
  vi.useFakeTimers();
  const analysis = Promise.withResolvers<AnalysisResult>();
  let emit!: (event: AnalysisEvent) => void;
  const pending = execute({ analyze(request, onEvent) {
    emit = onEvent;
    // 중단 신호는 무시하며, 신호를 받는 순간에도 이벤트를 보냅니다.
    request.signal.addEventListener("abort", () => emit({ kind: "late.abort" }));
    return analysis.promise;
  } }, 10);
  try {
    await vi.advanceTimersByTimeAsync(10);
    expect(store.listByTask(taskId)[0]?.status).toBe("interrupted");
    const result = await pending;
    expect(result).toMatchObject({ status: "interrupted", errorCode: "timeout", result: null });
    const saved = store.findById(result.runId);
    expect(saved?.finishedAt).toBeNull();
    expect(saved?.events.map(event => event.kind)).toEqual(["run.started", "run.interrupted"]);
    expect(() => store.claim(otherTaskId, "test")).toThrow("previous run");
    database.close();
    expect(() => emit({ kind: "late.event", sessionId: "late-session" })).not.toThrow();
    if (settlement === "resolve") analysis.resolve({ output: "late success", usage: null });
    else analysis.reject(new Error("late failure"));
    await Promise.resolve();
    await Promise.resolve();
    database = openDatabase(databasePath);
    store = createDrizzleRunStore(database.db);
    expect(store.findById(result.runId)).toEqual(saved);
  } finally {
    analysis.resolve({ output: "cleanup", usage: null });
    await pending;
    vi.useRealTimers();
  }
});

test("does not mark a result successful when cancellation arrives before return", async () => {
  const controller = new AbortController();
  const result = await runTask({ taskId, model: "test", workspace: directory, timeoutMs: 1000, signal: controller.signal }, store, {
    async analyze() { controller.abort(); return { output: "too late", usage: null }; },
  });
  expect(result).toMatchObject({ status: "interrupted", errorCode: "cancel_requested", result: null });
});

test("limits saved output and records only capped progress events plus final status", async () => {
  const result = await execute({ async analyze(_request, onEvent) {
    for (let index = 0; index < 1010; index++) onEvent({ kind: "activity" });
    return { output: "a".repeat(65537), usage: null };
  } });
  expect(result).toMatchObject({ status: "failed", errorCode: "output_limit", result: null });
  expect(store.findById(result.runId)?.events).toHaveLength(1001);
});

test("exposes execution records through read-only APIs without internal ownership fields", async () => {
  const result = await execute(succeeds);
  const app = buildApp({ databasePath });
  try {
    const response = await app.inject({ method: "GET", url: `/runs/${result.runId}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: result.runId, status: "succeeded", result: expect.stringContaining("[REDACTED]") });
    expect(response.json()).toMatchObject({ stopReason: null, stopRequestedAt: null, terminationConfirmedAt: null });
    expect(response.json()).not.toHaveProperty("instanceId");
    expect(response.json()).not.toHaveProperty("slot");
    expect(response.headers["cache-control"]).toBe("no-store");
    const list = await app.inject({ method: "GET", url: `/tasks/${taskId}/runs` });
    expect(list.json().runs).toHaveLength(1);
    expect(list.json().runs[0]).not.toHaveProperty("result");
    expect((await app.inject({ method: "GET", url: `/tasks/${otherTaskId}/runs` })).json()).toEqual({ runs: [] });
    expect((await app.inject({ method: "GET", url: `/runs/${randomUUID()}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/tasks/${randomUUID()}/runs` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/runs/invalid" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/tasks/${taskId}` })).json().status).toBe("succeeded");
  } finally { await app.close(); }
});

test("upgrades a queued-task database without losing its deduplication key", () => {
  database.close();
  rmSync(databasePath, { force: true });
  const folder = join(directory, "legacy-migrations");
  cpSync(migrationsDirectory, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.slice(0, 2);
  writeFileSync(journalPath, JSON.stringify(journal));
  const legacy = openDatabase(databasePath, folder);
  const project = { id: randomUUID(), name: "Legacy", workspaceKey: "legacy", createdAt: new Date() };
  const task = { id: taskId, projectId: project.id, instruction: "Legacy task", requestKey: "old-key", status: "queued" as const, createdAt: new Date() };
  legacy.db.insert(projects).values(project).run();
  // 구버전 테이블에는 현재 스키마에 추가된 필드가 없으므로 당시의 저장 형식을 사용합니다.
  legacy.client.prepare("INSERT INTO tasks (id, project_id, instruction, request_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(task.id, task.projectId, task.instruction, task.requestKey, task.status, task.createdAt.getTime());
  legacy.close();
  database = openDatabase(databasePath);
  store = createDrizzleRunStore(database.db);
  expect(database.db.select().from(tasks).all()).toEqual([{ ...task, kind: "work", goalId: null, goalVersion: null, cancelRequestedAt: null, retryState: null }]);
  const run = store.claim(taskId, "test-model");
  expect(store.findById(run.id)?.status).toBe("running");
  expect(database.client.pragma("foreign_key_check")).toEqual([]);
});
