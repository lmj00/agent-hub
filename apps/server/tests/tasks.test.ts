import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db/connection.js";
import { tasks } from "../src/db/schema.js";

let directory: string;
let databasePath: string;
let app: ReturnType<typeof buildApp>;
let projectId: string;

const input = { instruction: "프로젝트 구조를 분석해줘", requestKey: "request-1" };
const taskUrl = () => `/projects/${projectId}/tasks`;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "agent-hub-tasks-"));
  databasePath = join(directory, "hub.sqlite");
  app = buildApp({ databasePath });
  const response = await app.inject({
    method: "POST", url: "/projects", payload: { name: "Example project", workspaceKey: "example" },
  });
  projectId = response.json().id;
});

afterEach(async () => {
  try { await app.close(); }
  finally { rmSync(directory, { recursive: true, force: true }); }
});

test("registers a queued task and preserves detail, list and request key after reopening", async () => {
  const empty = await app.inject({ method: "GET", url: taskUrl() });
  expect(empty.json()).toEqual({ tasks: [] });
  const before = Date.now();
  const created = await app.inject({ method: "POST", url: taskUrl(), payload: input });
  const after = Date.now();
  expect(created.statusCode).toBe(201);
  const task = created.json();
  expect(task).toEqual({ ...input, kind: "work", goalId: null, goalVersion: null, goalReview: null, budgetWait: null, id: expect.any(String), projectId, status: "queued", retryState: null, createdAt: expect.any(String) });
  expect(Date.parse(task.createdAt)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(task.createdAt)).toBeLessThanOrEqual(after);
  expect(created.headers.location).toBe(`/tasks/${task.id}`);
  expect(created.headers["cache-control"]).toBe("no-store");

  await app.close();
  app = buildApp({ databasePath });
  const detail = await app.inject({ method: "GET", url: `/tasks/${task.id}` });
  expect(detail.statusCode).toBe(200);
  expect(detail.json()).toEqual(task);
  const retry = await app.inject({ method: "POST", url: taskUrl(), payload: input });
  expect(retry.statusCode).toBe(200);
  expect(retry.json()).toEqual(task);
  const list = await app.inject({ method: "GET", url: taskUrl() });
  expect(list.json()).toEqual({ tasks: [task] });
});

test("keeps one task for a burst of identical registrations", async () => {
  const responses = await Promise.all(Array.from({ length: 10 }, () => app.inject({
    method: "POST", url: taskUrl(), payload: input,
  })));
  expect(responses.filter(response => response.statusCode === 201)).toHaveLength(1);
  expect(responses.filter(response => response.statusCode === 200)).toHaveLength(9);
  expect(new Set(responses.map(response => response.json().id)).size).toBe(1);
  const list = await app.inject({ method: "GET", url: taskUrl() });
  expect(list.json().tasks).toHaveLength(1);
});

test("rejects a changed instruction for the same key without changing the saved task", async () => {
  const created = await app.inject({ method: "POST", url: taskUrl(), payload: input });
  const conflict = await app.inject({ method: "POST", url: taskUrl(), payload: { ...input, instruction: "Different task" } });
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json().error).toBe("REQUEST_KEY_CONFLICT");
  const list = await app.inject({ method: "GET", url: taskUrl() });
  expect(list.json()).toEqual({ tasks: [created.json()] });
});

test("scopes request keys and lists to each project and permits a new key for the same instruction", async () => {
  const other = await app.inject({ method: "POST", url: "/projects", payload: { name: "Other", workspaceKey: "other" } });
  const otherUrl = `/projects/${other.json().id}/tasks`;
  const first = await app.inject({ method: "POST", url: taskUrl(), payload: input });
  const second = await app.inject({ method: "POST", url: otherUrl, payload: { ...input, instruction: "Other instruction" } });
  const third = await app.inject({ method: "POST", url: taskUrl(), payload: { ...input, requestKey: "request-2" } });
  expect([first.statusCode, second.statusCode, third.statusCode]).toEqual([201, 201, 201]);
  const list = await app.inject({ method: "GET", url: taskUrl() });
  expect(list.json().tasks).toHaveLength(2);
  expect(list.json().tasks.every((task: { projectId: string }) => task.projectId === projectId)).toBe(true);
  const otherList = await app.inject({ method: "GET", url: otherUrl });
  expect(otherList.json()).toEqual({ tasks: [second.json()] });
});

test("orders tasks by newest creation time and then by id", async () => {
  const database = openDatabase(databasePath);
  const first = "00000000-0000-4000-8000-000000000001";
  const second = "00000000-0000-4000-8000-000000000002";
  const newest = "00000000-0000-4000-8000-000000000003";
  try {
    database.db.insert(tasks).values([
      { ...input, projectId, id: second, requestKey: "b", createdAt: new Date("2026-01-01T00:00:00Z") },
      { ...input, projectId, id: first, requestKey: "a", createdAt: new Date("2026-01-01T00:00:00Z") },
      { ...input, projectId, id: newest, requestKey: "c", createdAt: new Date("2026-01-02T00:00:00Z") },
    ]).run();
  } finally { database.close(); }
  const list = await app.inject({ method: "GET", url: taskUrl() });
  expect(list.json().tasks.map((task: { id: string }) => task.id)).toEqual([newest, first, second]);
});

test.each([
  ["missing instruction", { requestKey: input.requestKey }],
  ["missing request key", { instruction: input.instruction }],
  ["blank instruction", { ...input, instruction: " \t\n　" }],
  ["numeric instruction", { ...input, instruction: 123 }],
  ["oversized instruction", { ...input, instruction: "a".repeat(10001) }],
  ["blank request key", { ...input, requestKey: "" }],
  ["numeric request key", { ...input, requestKey: 123 }],
  ["invalid request key", { ...input, requestKey: "request\n" }],
  ["oversized request key", { ...input, requestKey: "a".repeat(101) }],
  ["client-selected status", { ...input, status: "running" }],
])("rejects %s without storing a task", async (_name, payload) => {
  const response = await app.inject({ method: "POST", url: taskUrl(), payload });
  expect(response.statusCode).toBe(400);
  const list = await app.inject({ method: "GET", url: taskUrl() });
  expect(list.json()).toEqual({ tasks: [] });
});

test("accepts boundary lengths and preserves internal newlines in the instruction", async () => {
  const instruction = `a\n${"b".repeat(9998)}`;
  const response = await app.inject({ method: "POST", url: taskUrl(), payload: { instruction, requestKey: "x".repeat(100) } });
  expect(response.statusCode).toBe(201);
  expect(response.json().instruction).toBe(instruction);
});

test("returns 404 for missing projects and tasks and 400 for malformed ids", async () => {
  const missingUrl = `/projects/${randomUUID()}/tasks`;
  const create = await app.inject({ method: "POST", url: missingUrl, payload: input });
  const list = await app.inject({ method: "GET", url: missingUrl });
  expect(create.statusCode).toBe(404);
  expect(create.json().error).toBe("PROJECT_NOT_FOUND");
  expect(list.statusCode).toBe(404);
  const missing = await app.inject({ method: "GET", url: `/tasks/${randomUUID()}` });
  expect(missing.statusCode).toBe(404);
  expect(missing.json().error).toBe("TASK_NOT_FOUND");
  expect((await app.inject({ method: "GET", url: "/tasks/not-a-uuid" })).statusCode).toBe(400);
  expect((await app.inject({ method: "POST", url: "/projects/invalid/tasks", payload: input })).statusCode).toBe(400);
});

test("rejects malformed JSON and non-JSON requests", async () => {
  const malformed = await app.inject({
    method: "POST", url: taskUrl(), headers: { "content-type": "application/json" }, payload: '{"instruction":',
  });
  const text = await app.inject({
    method: "POST", url: taskUrl(), headers: { "content-type": "text/plain" }, payload: JSON.stringify(input),
  });
  expect(malformed.statusCode).toBe(400);
  expect(text.statusCode).toBe(415);
  expect((await app.inject({ method: "GET", url: taskUrl() })).json()).toEqual({ tasks: [] });
});

test("reports missing task storage in readiness without exposing SQL in API errors", async () => {
  const database = openDatabase(databasePath);
  try { database.client.exec("DROP TABLE tasks"); }
  finally { database.close(); }

  const responses = [
    await app.inject({ method: "POST", url: taskUrl(), payload: input }),
    await app.inject({ method: "GET", url: taskUrl() }),
    await app.inject({ method: "GET", url: `/tasks/${randomUUID()}` }),
  ];
  for (const response of responses) {
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "INTERNAL_ERROR", message: "Unable to process task request" });
  }
  expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(503);
  expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
});
