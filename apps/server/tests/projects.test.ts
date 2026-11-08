import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db/connection.js";
import { projects } from "../src/db/schema.js";

let directory: string;
let databasePath: string;
let app: ReturnType<typeof buildApp>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "agent-hub-projects-"));
  databasePath = join(directory, "hub.sqlite");
  app = buildApp({ databasePath });
});

afterEach(async () => {
  try {
    await app.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const input = { name: "언어 공부 앱", workspaceKey: "language-app" };

test("returns an empty project list before registration", async () => {
  const response = await app.inject({ method: "GET", url: "/projects" });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ projects: [] });
  expect(response.headers["cache-control"]).toBe("no-store");
});

test("registers a project, trims its name, and preserves the API result after reopening the app", async () => {
  const before = Date.now();
  const created = await app.inject({
    method: "POST",
    url: "/projects",
    payload: { ...input, name: `  ${input.name}  ` },
  });
  const after = Date.now();
  expect(created.statusCode).toBe(201);
  const project = created.json();
  expect(project).toEqual({ ...input, id: expect.any(String), createdAt: expect.any(String) });
  expect(project.id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(Date.parse(project.createdAt)).toBeGreaterThanOrEqual(before);
  expect(Date.parse(project.createdAt)).toBeLessThanOrEqual(after);
  expect(created.headers.location).toBe(`/projects/${project.id}`);

  await app.close();
  app = buildApp({ databasePath });

  const detail = await app.inject({ method: "GET", url: created.headers.location! });
  expect(detail.statusCode).toBe(200);
  expect(detail.json()).toEqual(project);
  const list = await app.inject({ method: "GET", url: "/projects" });
  expect(list.json()).toEqual({ projects: [project] });
});

test("lists newest projects first and orders equal timestamps by id", async () => {
  const database = openDatabase(databasePath);
  const firstId = "00000000-0000-4000-8000-000000000001";
  const secondId = "00000000-0000-4000-8000-000000000002";
  const newestId = "00000000-0000-4000-8000-000000000003";
  try {
    database.db
      .insert(projects)
      .values([
        { ...input, id: secondId, createdAt: new Date("2026-01-01T00:00:00Z") },
        { ...input, id: firstId, createdAt: new Date("2026-01-01T00:00:00Z") },
        { ...input, id: newestId, createdAt: new Date("2026-01-02T00:00:00Z") },
      ])
      .run();
  } finally {
    database.close();
  }

  const response = await app.inject({ method: "GET", url: "/projects" });
  expect(response.statusCode).toBe(200);
  expect(response.json().projects.map((project: { id: string }) => project.id)).toEqual([
    newestId,
    firstId,
    secondId,
  ]);
});

test.each([
  ["missing name", { workspaceKey: input.workspaceKey }],
  ["missing workspace key", { name: input.name }],
  ["blank name", { ...input, name: " \t\n　" }],
  ["numeric name", { ...input, name: 123 }],
  ["null name", { ...input, name: null }],
  ["array name", { ...input, name: ["name"] }],
  ["long name", { ...input, name: "a".repeat(101) }],
  ["blank workspace key", { ...input, workspaceKey: "" }],
  ["numeric workspace key", { ...input, workspaceKey: 123 }],
  ["path as workspace key", { ...input, workspaceKey: "../private" }],
  ["newline in workspace key", { ...input, workspaceKey: "app\n" }],
  ["long workspace key", { ...input, workspaceKey: "a".repeat(101) }],
  ["client-provided id", { ...input, id: randomUUID() }],
  ["unknown field", { ...input, workspceKey: "typo" }],
])("rejects %s without writing a project", async (_description, payload) => {
  const response = await app.inject({ method: "POST", url: "/projects", payload });
  expect(response.statusCode).toBe(400);
  expect(response.json().error).toBe("INVALID_REQUEST");
  const list = await app.inject({ method: "GET", url: "/projects" });
  expect(list.json()).toEqual({ projects: [] });
});

test("accepts the documented input limits and treats each POST as a new registration", async () => {
  const payload = { name: "가".repeat(100), workspaceKey: `A0._-${"a".repeat(95)}` };
  const first = await app.inject({ method: "POST", url: "/projects", payload });
  const second = await app.inject({ method: "POST", url: "/projects", payload });
  expect(first.statusCode).toBe(201);
  expect(second.statusCode).toBe(201);
  expect(first.json()).toMatchObject(payload);
  expect(second.json().id).not.toBe(first.json().id);
  const list = await app.inject({ method: "GET", url: "/projects" });
  expect(list.json().projects).toHaveLength(2);
});

test("distinguishes malformed project ids from missing projects", async () => {
  const malformed = await app.inject({ method: "GET", url: "/projects/not-a-uuid" });
  expect(malformed.statusCode).toBe(400);
  const missing = await app.inject({ method: "GET", url: `/projects/${randomUUID()}` });
  expect(missing.statusCode).toBe(404);
  expect(missing.json()).toEqual({ error: "PROJECT_NOT_FOUND", message: "Project not found" });
});

test("rejects malformed JSON and non-JSON request bodies", async () => {
  const malformed = await app.inject({
    method: "POST",
    url: "/projects",
    headers: { "content-type": "application/json" },
    payload: '{"name":',
  });
  expect(malformed.statusCode).toBe(400);
  const text = await app.inject({
    method: "POST",
    url: "/projects",
    headers: { "content-type": "text/plain" },
    payload: JSON.stringify(input),
  });
  expect(text.statusCode).toBe(415);
  const list = await app.inject({ method: "GET", url: "/projects" });
  expect(list.json()).toEqual({ projects: [] });
});

test("returns generic errors on database failure while liveness remains available", async () => {
  await app.ready();
  const database = openDatabase(databasePath);
  try {
    database.client.exec("DROP TABLE projects");
  } finally {
    database.close();
  }

  const responses = [
    await app.inject({ method: "GET", url: "/projects" }),
    await app.inject({ method: "GET", url: `/projects/${randomUUID()}` }),
    await app.inject({ method: "POST", url: "/projects", payload: input }),
  ];
  for (const response of responses) {
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: "INTERNAL_ERROR",
      message: "Unable to process project request",
    });
  }
  expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(503);
});
