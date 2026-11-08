import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { goalSchema, parseResponse, type GoalDefinition } from "@agent-hub/contracts";
import { buildApp } from "../../src/app.js";
import { migrationsDirectory, openDatabase } from "../../src/db/connection.js";

const definition: GoalDefinition = {
  description: "학습 흐름 완성",
  completionCriteria: "사용자가 단어를 복습하고 결과를 저장할 수 있다",
  kind: "finite",
  priority: 50,
  allowedPaths: ["src", "tests"],
  excludedPaths: ["src/private"],
  checkIntervalMs: 900000,
  budget: { windowMs: 3600000, maxCalls: 20, maxRunMs: 1800000 },
};
let directory: string, databasePath: string, app: ReturnType<typeof buildApp>, projectId: string;
const url = () => `/projects/${projectId}/goals`;
const register = (requestKey = "first") =>
  app.inject({
    method: "POST",
    url: url(),
    payload: { requestKey, definition },
  });
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "hub-goals-"));
  databasePath = join(directory, "hub.sqlite");
  app = buildApp({ databasePath });
  projectId = (
    await app.inject({
      method: "POST",
      url: "/projects",
      payload: { name: "Learning", workspaceKey: "example" },
    })
  ).json().id;
});
afterEach(async () => {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
});

test("stores a versioned goal and preserves its original response and history across restart", async () => {
  const created = await register();
  expect(created.statusCode).toBe(201);
  const goal = parseResponse(goalSchema, created.json());
  expect(goal).toMatchObject({
    definition,
    status: "active",
    version: 1,
    nextCheckAt: null,
  });
  expect(created.headers.location).toBe(`/goals/${goal.id}`);
  expect(created.headers["cache-control"]).toBe("no-store");
  await app.close();
  app = buildApp({ databasePath });
  expect((await app.inject({ method: "GET", url: `/goals/${goal.id}` })).json()).toEqual(goal);
  expect((await app.inject({ method: "GET", url: url() })).json()).toEqual({
    goals: [goal],
  });
  expect((await app.inject({ method: "GET", url: `/goals/${goal.id}/revisions` })).json()).toEqual({
    revisions: [goal],
  });
  expect((await register()).json()).toEqual(goal);
  const db = openDatabase(databasePath);
  try {
    expect(db.client.prepare("SELECT * FROM tasks").all()).toEqual([]);
  } finally {
    db.close();
  }
});

test("duplicate registration is atomic across connections and keys belong to each project", async () => {
  const other = buildApp({ databasePath });
  try {
    const responses = await Promise.all(
      [app, other, app, other].map((server) =>
        server.inject({
          method: "POST",
          url: url(),
          payload: { requestKey: "burst", definition },
        }),
      ),
    );
    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(new Set(responses.map((r) => r.json().id)).size).toBe(1);
    const project = (
      await app.inject({
        method: "POST",
        url: "/projects",
        payload: { name: "Other", workspaceKey: "other" },
      })
    ).json();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/projects/${project.id}/goals`,
          payload: { requestKey: "burst", definition },
        })
      ).statusCode,
    ).toBe(201);
    expect((await app.inject({ method: "GET", url: url() })).json().goals).toHaveLength(1);
  } finally {
    await other.close();
  }
});

test("editing, pausing and resuming preserve every prior definition and do not touch manual tasks", async () => {
  const goal = (await register()).json();
  const task = (
    await app.inject({
      method: "POST",
      url: `/projects/${projectId}/tasks`,
      payload: { instruction: "Manual analysis", requestKey: "manual" },
    })
  ).json();
  const edited = await app.inject({
    method: "PATCH",
    url: `/goals/${goal.id}`,
    payload: {
      expectedVersion: 1,
      requestKey: "edit",
      definition: { ...definition, description: "새 목표", kind: "continuous" },
    },
  });
  expect(edited.statusCode).toBe(200);
  expect(edited.json()).toMatchObject({
    version: 2,
    definition: { description: "새 목표", kind: "continuous" },
  });
  const paused = await app.inject({
    method: "POST",
    url: `/goals/${goal.id}/control`,
    payload: { expectedVersion: 2, requestKey: "pause", action: "pause" },
  });
  expect(paused.json()).toMatchObject({ status: "paused", version: 3 });
  const resumed = await app.inject({
    method: "POST",
    url: `/goals/${goal.id}/control`,
    payload: { expectedVersion: 3, requestKey: "resume", action: "resume" },
  });
  expect(resumed.json()).toMatchObject({ status: "active", version: 4 });
  const revisions = (await app.inject({ method: "GET", url: `/goals/${goal.id}/revisions` })).json()
    .revisions;
  expect(revisions.map((r: { version: number }) => r.version)).toEqual([4, 3, 2, 1]);
  expect(revisions[3]).toEqual(goal);
  expect((await app.inject({ method: "GET", url: `/tasks/${task.id}` })).json()).toEqual(task);
});

test("replayed updates return the saved response and cannot undo later changes", async () => {
  const goal = (await register()).json();
  const payload = {
    expectedVersion: 1,
    requestKey: "edit",
    definition: { ...definition, priority: 80 },
  };
  const first = (await app.inject({ method: "PATCH", url: `/goals/${goal.id}`, payload })).json();
  await app.inject({
    method: "POST",
    url: `/goals/${goal.id}/control`,
    payload: { expectedVersion: 2, requestKey: "pause", action: "pause" },
  });
  expect((await app.inject({ method: "PATCH", url: `/goals/${goal.id}`, payload })).json()).toEqual(
    first,
  );
  expect((await register()).json()).toEqual(goal);
  expect((await app.inject({ method: "GET", url: `/goals/${goal.id}` })).json()).toMatchObject({
    version: 3,
    status: "paused",
    definition: { priority: 80 },
  });
});

test("stale versions and changed payloads under a reused key never overwrite the goal", async () => {
  const goal = (await register()).json();
  await app.inject({
    method: "POST",
    url: `/goals/${goal.id}/control`,
    payload: { expectedVersion: 1, requestKey: "pause", action: "pause" },
  });
  const stale = await app.inject({
    method: "PATCH",
    url: `/goals/${goal.id}`,
    payload: { expectedVersion: 1, requestKey: "stale", definition },
  });
  expect(stale.statusCode).toBe(409);
  expect(stale.json().error).toBe("GOAL_VERSION_CHANGED");
  const conflict = await app.inject({
    method: "POST",
    url: `/goals/${goal.id}/control`,
    payload: { expectedVersion: 1, requestKey: "pause", action: "resume" },
  });
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json().error).toBe("REQUEST_KEY_CONFLICT");
  expect(
    (
      await app.inject({
        method: "POST",
        url: url(),
        payload: {
          requestKey: "first",
          definition: { ...definition, priority: 90 },
        },
      })
    ).statusCode,
  ).toBe(409);
  expect((await app.inject({ method: "GET", url: `/goals/${goal.id}` })).json()).toMatchObject({
    version: 2,
    status: "paused",
  });
});

test("two connections editing the same version save exactly one new revision", async () => {
  const goal = (await register()).json();
  const other = buildApp({ databasePath });
  try {
    const responses = await Promise.all(
      [app, other].map((server, index) =>
        server.inject({
          method: "PATCH",
          url: `/goals/${goal.id}`,
          payload: {
            expectedVersion: 1,
            requestKey: `editor-${index}`,
            definition: { ...definition, priority: 60 + index },
          },
        }),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const revisions = (
      await app.inject({ method: "GET", url: `/goals/${goal.id}/revisions` })
    ).json().revisions;
    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toEqual(responses.find((response) => response.statusCode === 200)!.json());
  } finally {
    await other.close();
  }
});

test.each([
  { description: " \n " },
  { priority: 101 },
  { kind: "anything" },
  { status: "completed" },
  { allowedPaths: ["../other"] },
  { allowedPaths: ["/private"] },
  { allowedPaths: ["C:\\secret"] },
  { allowedPaths: ["src/../private"] },
  { allowedPaths: ["src", " src "] },
  { allowedPaths: ["src/private"] },
  { excludedPaths: ["."] },
  { budget: { windowMs: 600000, maxCalls: 1, maxRunMs: 600001 } },
  { checkIntervalMs: 10 },
])("rejects invalid scope, definition or budget %j before saving", async (invalid) => {
  const response = await app.inject({
    method: "POST",
    url: url(),
    payload: {
      requestKey: "invalid",
      definition: { ...definition, ...invalid },
    },
  });
  expect(response.statusCode).toBe(400);
  expect((await app.inject({ method: "GET", url: url() })).json()).toEqual({
    goals: [],
  });
});

test("missing resources, malformed ids and forged completion are rejected", async () => {
  expect((await app.inject({ method: "GET", url: `/goals/${randomUUID()}` })).statusCode).toBe(404);
  expect((await app.inject({ method: "GET", url: "/goals/invalid" })).statusCode).toBe(400);
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/projects/${randomUUID()}/goals`,
        payload: { requestKey: "missing", definition },
      })
    ).statusCode,
  ).toBe(404);
  const goal = (await register()).json();
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/goals/${goal.id}/control`,
        payload: {
          requestKey: "complete",
          expectedVersion: 1,
          action: "complete",
        },
      })
    ).statusCode,
  ).toBe(400);
});

test("revision storage failure rolls back both new goals and modifications", async () => {
  const db = openDatabase(databasePath);
  try {
    db.client.exec(
      "CREATE TRIGGER fail_revision BEFORE INSERT ON goal_revisions BEGIN SELECT RAISE(ABORT, 'private-storage-fixture'); END",
    );
    const failed = await register();
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toContain("private-storage");
    expect(db.client.prepare("SELECT * FROM goals").all()).toHaveLength(0);
    db.client.exec("DROP TRIGGER fail_revision");
    const goal = (await register()).json();
    db.client.exec(
      "CREATE TRIGGER fail_revision BEFORE INSERT ON goal_revisions BEGIN SELECT RAISE(ABORT, 'private-storage-fixture'); END",
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/goals/${goal.id}/control`,
          payload: { expectedVersion: 1, requestKey: "pause", action: "pause" },
        })
      ).statusCode,
    ).toBe(500);
    expect((await app.inject({ method: "GET", url: `/goals/${goal.id}` })).json()).toEqual(goal);
  } finally {
    db.close();
  }
});

test("upgrading a pre-goal database preserves task data and adds both goal tables", () => {
  const folder = join(directory, "old-migrations");
  cpSync(migrationsDirectory, folder, { recursive: true });
  const journalPath = join(folder, "meta/_journal.json"),
    journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 15);
  writeFileSync(journalPath, JSON.stringify(journal));
  const path = join(directory, "old.sqlite"),
    old = openDatabase(path, folder);
  old.client
    .prepare(
      "INSERT INTO projects (id,name,workspace_key,created_at) VALUES ('p','Existing','existing',1)",
    )
    .run();
  old.client
    .prepare(
      "INSERT INTO tasks (id,project_id,instruction,request_key,created_at) VALUES ('t','p','Preserved','k',1)",
    )
    .run();
  old.close();
  const upgraded = openDatabase(path);
  try {
    expect(upgraded.client.prepare("SELECT instruction FROM tasks").get()).toEqual({
      instruction: "Preserved",
    });
    expect(upgraded.client.prepare("SELECT * FROM goals").all()).toEqual([]);
    expect(upgraded.client.prepare("SELECT * FROM goal_revisions").all()).toEqual([]);
    expect(() => upgraded.checkReady()).not.toThrow();
  } finally {
    upgraded.close();
  }
});
