import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { migrationsDirectory, openDatabase } from "../src/db/connection.js";
import { projects, providerGates, runs, tasks } from "../src/db/schema.js";
import { AnalysisError } from "../src/modules/execution/analysis.js";
import { createDrizzleRunStore } from "../src/modules/execution/drizzle-run-store.js";
import { runTask } from "../src/modules/execution/run-task.js";

let directory: string;
let databasePath: string;
let database: ReturnType<typeof openDatabase>;
let store: ReturnType<typeof createDrizzleRunStore>;
let projectId: string;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
  directory = mkdtempSync(join(tmpdir(), "hub-gate-"));
  databasePath = join(directory, "hub.sqlite");
  database = openDatabase(databasePath); store = createDrizzleRunStore(database.db);
  projectId = randomUUID();
  database.db.insert(projects).values({ id: projectId, name: "Example", workspaceKey: "example", createdAt: new Date() }).run();
});
afterEach(() => { database.close(); rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); });

function task(project = projectId) {
  const id = randomUUID();
  database.db.insert(tasks).values({ id, projectId: project, instruction: "Analyze", requestKey: id, createdAt: new Date() }).run();
  return id;
}
function block(retryAt: Date | null = null, confirmed = true, errorCode = "capacity") {
  const run = store.claim(task(), "fixture");
  store.finish(run.id, {
    status: errorCode === "capacity" ? "waiting_capacity" : "blocked", errorCode, result: null, usage: null,
    retryAt, terminationConfirmedAt: confirmed ? new Date() : null,
  });
  return run;
}
function probe(taskId: string) {
  store.reserveProviderCheck(taskId, store.getProviderGate().version);
  const claim = store.claimNext("fixture", ["example"]);
  expect(claim.kind).toBe("claimed");
  if (claim.kind !== "claimed") throw new Error("Expected probe claim");
  return claim.run;
}

test("persists provider retry evidence and blocks a different project after restart", async () => {
  const retryAt = new Date(Date.now() + 60000);
  const id = task();
  const outcome = await runTask({ taskId: id, model: "fixture", workspace: directory, timeoutMs: 1000, signal: new AbortController().signal }, store, {
    analyze: async () => { throw new AnalysisError("capacity", false, retryAt); },
    confirmTermination: async () => new Date(),
  });
  const otherProject = randomUUID();
  database.db.insert(projects).values({ id: otherProject, name: "Other", workspaceKey: "other", createdAt: new Date() }).run();
  const otherTask = task(otherProject);
  database.close(); database = openDatabase(databasePath); store = createDrizzleRunStore(database.db);
  expect(store.getProviderGate()).toMatchObject({ blocked: true, reason: "capacity", retryAt, sourceRunId: outcome.runId });
  expect(store.findById(outcome.runId)?.retryAt).toEqual(retryAt);
  expect(store.claimNext("different-model", ["other"])).toMatchObject({ kind: "held", reason: "provider_capacity" });
  expect(() => store.claim(otherTask, "different-model")).toThrow("previous run");
});

test("time passing does not unlock the provider; only one explicitly reserved successful run does", () => {
  const retryAt = new Date(Date.now() + 60000);
  const original = block(retryAt);
  const checkTask = task(); const nextTask = task();
  expect(() => store.reserveProviderCheck(checkTask, 1)).toThrow("RETRY_TOO_EARLY");
  vi.setSystemTime(retryAt);
  expect(store.claimNext("fixture", ["example"]).kind).toBe("held");
  store.reserveProviderCheck(checkTask, 1);
  const other = openDatabase(databasePath);
  try { expect(() => createDrizzleRunStore(other.db).reserveProviderCheck(nextTask, 1)).toThrow("PROVIDER_CHECK_RESERVED"); }
  finally { other.close(); }
  expect(() => store.claim(nextTask, "fixture")).toThrow("previous run");
  const run = store.claim(checkTask, "fixture");
  expect(store.getProviderGate()).toMatchObject({ blocked: true, probeTaskId: checkTask, probeRunId: run.id });
  store.finish(run.id, { status: "succeeded", result: "Report", errorCode: null, usage: null, terminationConfirmedAt: new Date() });
  expect(store.getProviderGate()).toMatchObject({ blocked: false, version: 2, reason: null, retryAt: null, probeTaskId: null, probeRunId: null });
  expect(store.findById(original.id)?.status).toBe("waiting_capacity");
  expect(store.claimNext("fixture", ["example"])).toMatchObject({ kind: "claimed", run: { taskId: nextTask } });
});

test("a successful response without termination proof cannot clear the gate", () => {
  block(); const run = probe(task());
  store.finish(run.id, { status: "succeeded", result: "Report", errorCode: null, usage: null });
  expect(store.getProviderGate()).toMatchObject({ blocked: true, version: 1, probeTaskId: run.taskId, probeRunId: run.id });
  expect(store.findById(run.id)).toMatchObject({ status: "interrupted", errorCode: "termination_unconfirmed" });
  expect(() => store.reserveProviderCheck(task(), 2)).toThrow("termination");
  expect(store.claimNext("fixture", ["example"]).kind).toBe("held");
});

test("a failed confirmation replaces its retry evidence and never schedules another automatically", () => {
  block(); const run = probe(task());
  const retryAt = new Date(Date.now() + 90000);
  store.finish(run.id, { status: "waiting_capacity", result: null, errorCode: "capacity", usage: null, retryAt, terminationConfirmedAt: new Date() });
  expect(store.getProviderGate()).toMatchObject({ blocked: true, version: 2, reason: "capacity", retryAt, probeTaskId: null, probeRunId: null });
  vi.setSystemTime(new Date(retryAt.getTime() + 1));
  expect(store.claimNext("fixture", ["example"]).kind).toBe("held");
});

test("an interrupted confirmation preserves authentication blocking", () => {
  block(null, true, "authentication"); const run = probe(task());
  store.finish(run.id, { status: "interrupted", result: null, errorCode: "server_shutdown", usage: null, terminationConfirmedAt: new Date() });
  expect(store.getProviderGate()).toMatchObject({ blocked: true, reason: "authentication", version: 2, probeTaskId: null, probeRunId: null });
});

test("a stale confirmation cannot clear or replace a newer block", () => {
  block(); const run = probe(task());
  database.client.prepare("UPDATE provider_gates SET version = version + 1, reason = 'authentication', probe_task_id = NULL, probe_run_id = NULL").run();
  const newer = store.getProviderGate();
  store.finish(run.id, { status: "succeeded", result: "Old result", errorCode: null, usage: null, terminationConfirmedAt: new Date() });
  expect(store.getProviderGate()).toEqual(newer);
});

test("gate persistence and run completion roll back together", () => {
  const run = store.claim(task(), "fixture");
  database.client.exec("CREATE TRIGGER reject_gate BEFORE INSERT ON provider_gates BEGIN SELECT RAISE(ABORT, 'fixture'); END;");
  expect(() => store.finish(run.id, { status: "waiting_capacity", result: null, errorCode: "capacity", usage: null, terminationConfirmedAt: new Date() })).toThrow("fixture");
  expect(store.findById(run.id)).toMatchObject({ status: "running", terminationConfirmedAt: null, steps: [{ status: "running" }] });
  expect(database.db.select().from(providerGates).all()).toEqual([]);
  expect(database.db.select().from(tasks).get()?.status).toBe("running");
});

test("unconfirmed execution and cancelled tasks cannot be used to bypass the gate", () => {
  block(null, false); const checkTask = task();
  expect(() => store.reserveProviderCheck(checkTask, 1)).toThrow("termination");
  database.client.prepare("UPDATE runs SET termination_confirmed_at = ?").run(Date.now());
  database.client.prepare("UPDATE tasks SET cancel_requested_at = ? WHERE id = ?").run(Date.now(), checkTask);
  expect(() => store.reserveProviderCheck(checkTask, 1)).toThrow("uncancelled");
});

test("a reserved confirmation remains held when its workspace is unavailable", () => {
  block(); const checkTask = task();
  store.reserveProviderCheck(checkTask, 1);
  expect(store.claimNext("fixture", ["other"])).toMatchObject({ kind: "held", reason: "provider_check_unavailable" });
  expect(store.claimNext("fixture", [])).toMatchObject({ kind: "held", reason: "provider_check_unavailable" });
  expect(database.db.select().from(runs).all()).toHaveLength(1);
  expect(store.claimNext("fixture", ["example"])).toMatchObject({ kind: "claimed", run: { taskId: checkTask } });
});

test("the API exposes the blocking reason and time without account or container identity", async () => {
  const retryAt = new Date(Date.now() + 60000); const run = block(retryAt);
  const app = buildApp({ databasePath });
  try {
    const response = await app.inject({ method: "GET", url: "/execution/provider-gate" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({ blocked: true, reason: "capacity", retryAt: retryAt.toISOString(), sourceRunId: run.id });
    expect(response.json()).not.toHaveProperty("scope");
    const details = await app.inject({ method: "GET", url: `/runs/${run.id}` });
    expect(details.json().retryAt).toBe(retryAt.toISOString());
  } finally { await app.close(); }
});

test("upgrades a completed legacy capacity error without silently opening its provider", () => {
  database.close(); rmSync(databasePath);
  const folder = join(directory, "old-migrations"); cpSync(migrationsDirectory, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")); journal.entries = journal.entries.slice(0, 6);
  writeFileSync(journalPath, JSON.stringify(journal));
  const old = openDatabase(databasePath, folder);
  try {
    old.client.prepare("INSERT INTO projects VALUES (?, ?, ?, ?)").run("project", "Example", "example", 1000);
    old.client.prepare("INSERT INTO tasks (id, project_id, instruction, request_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("task", "project", "Analyze", "first", "waiting_capacity", 1000);
    old.client.prepare("INSERT INTO runs (id, task_id, instance_id, status, model, effort, started_at, last_activity_at, finished_at, error_code, termination_confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("legacy", "task", "owner", "waiting_capacity", "fixture", "medium", 1000, 2000, 2000, "capacity", 2000);
  } finally { old.close(); }
  database = openDatabase(databasePath); store = createDrizzleRunStore(database.db);
  expect(store.getProviderGate()).toMatchObject({ blocked: true, reason: "capacity", retryAt: null, sourceRunId: "legacy" });
  expect(store.claimNext("fixture", ["example"])).toMatchObject({ kind: "held", reason: "provider_capacity" });
  expect(store.findById("legacy")).toMatchObject({ status: "waiting_capacity", terminationConfirmedAt: new Date(2000) });
  expect(database.client.pragma("foreign_key_check")).toEqual([]);
});
