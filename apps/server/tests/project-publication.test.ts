import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db/connection.js";
import { projects, projectPublications, tasks, runs } from "../src/db/schema.js";
import { hashPassword, type PasswordHash } from "../src/modules/auth/password.js";

let directory: string;
let app: ReturnType<typeof buildApp>;
let database: ReturnType<typeof openDatabase>;
let password: PasswordHash;
let headers: { cookie: string; "x-csrf-token": string };
const privateId = randomUUID();
const publicId = randomUUID();
beforeAll(async () => {
  password = await hashPassword("publication-fixture-password");
});
beforeEach(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-publication-")));
  const databasePath = join(directory, "hub.sqlite");
  database = openDatabase(databasePath);
  database.db
    .insert(projects)
    .values([
      {
        id: privateId,
        name: "private-name-secret",
        workspaceKey: "private-workspace-secret",
        createdAt: new Date(),
      },
      {
        id: publicId,
        name: "internal-public-name-secret",
        workspaceKey: "public-workspace-secret",
        createdAt: new Date(),
      },
    ])
    .run();
  app = buildApp({
    databasePath,
    auth: {
      sourcePath: join(directory, "auth.json"),
      origin: "http://localhost",
      password,
      sessionSecret: randomBytes(32).toString("hex"),
    },
  });
  const anonymous = await app.inject("/auth/session");
  const cookie = anonymous.cookies.map((value) => `${value.name}=${value.value}`).join("; ");
  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    headers: { cookie, "x-csrf-token": anonymous.json().csrfToken },
    payload: { password: "publication-fixture-password" },
  });
  expect(login.statusCode).toBe(200);
  headers = {
    cookie: login.cookies.map((value) => `${value.name}=${value.value}`).join("; "),
    "x-csrf-token": login.json().csrfToken,
  };
});
afterEach(async () => {
  await app.close();
  database.close();
  rmSync(directory, { recursive: true, force: true });
});
const publish = (listed = true) =>
  app.inject({
    method: "PUT",
    url: `/projects/${publicId}/publication`,
    headers,
    payload: { listed, name: "방문자용 프로젝트" },
  });

test("all projects start private; only explicitly named public summaries leave the server, with revocation and persistence", async () => {
  expect((await app.inject("/public/projects")).json()).toEqual({
    projects: [],
    privateCount: 2,
    nextOffset: null,
  });
  expect((await publish()).statusCode).toBe(200);
  const taskId = randomUUID();
  database.db
    .insert(tasks)
    .values({
      id: taskId,
      projectId: publicId,
      instruction: "instruction-secret",
      requestKey: "fixture",
      status: "running",
      createdAt: new Date(),
    })
    .run();
  let response = await app.inject("/public/projects");
  expect(response.json()).toEqual({
    projects: [{ id: publicId, name: "방문자용 프로젝트", state: "running" }],
    privateCount: 1,
    nextOffset: null,
  });
  expect(response.headers["cache-control"]).toBe("no-store");
  for (const secret of [
    privateId,
    "private-name-secret",
    "internal-public-name-secret",
    "workspace-secret",
    "instruction-secret",
  ])
    expect(response.body).not.toContain(secret);
  database.db
    .insert(runs)
    .values({
      id: randomUUID(),
      taskId,
      instanceId: "fixture",
      status: "blocked",
      model: "fixture",
      effort: "medium",
      startedAt: new Date(),
      lastActivityAt: new Date(),
    })
    .run();
  expect((await app.inject("/public/projects")).json().projects[0].state).toBe("attention");
  // Open the same database again to prove visibility is stored, not process-local.
  const reopened = openDatabase(join(directory, "hub.sqlite"));
  expect(reopened.db.select().from(projectPublications).all()).toHaveLength(1);
  reopened.close();
  expect((await publish(false)).statusCode).toBe(200);
  response = await app.inject("/public/projects");
  expect(response.json()).toEqual({ projects: [], privateCount: 2, nextOffset: null });
});

test("visitors cannot read owner data or mutate publication, even with an anonymous CSRF token", async () => {
  const anonymous = await app.inject("/auth/session");
  const anonymousHeaders = {
    cookie: anonymous.cookies.map((value) => `${value.name}=${value.value}`).join("; "),
    "x-csrf-token": anonymous.json().csrfToken,
  };
  for (const url of [
    "/projects",
    "/projects/overview",
    `/projects/${privateId}/publication`,
    `/projects/${privateId}/goals`,
    `/projects/${privateId}/tasks`,
    "/execution",
  ])
    expect((await app.inject(url)).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: `/projects/${publicId}/publication`,
        headers: anonymousHeaders,
        payload: { listed: true, name: "not allowed" },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: `/projects/${publicId}/publication`,
        headers: { cookie: headers.cookie },
        payload: { listed: true, name: "not allowed" },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (await app.inject({ url: "/public/projects", headers: { origin: "https://other.example" } }))
      .statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/public/projects",
        headers: anonymousHeaders,
        payload: {},
      })
    ).statusCode,
  ).toBeGreaterThanOrEqual(400);
  expect((await app.inject("/public/projects")).json().projects).toEqual([]);
});

test("public reads are bounded and validated; private count is not tied to the page", async () => {
  for (let n = 0; n < 25; n++) {
    const id = randomUUID();
    database.db
      .insert(projects)
      .values({ id, name: `internal-${n}`, workspaceKey: "secret", createdAt: new Date() })
      .run();
    database.db
      .insert(projectPublications)
      .values({ projectId: id, name: `public-${n}`, listed: true })
      .run();
  }
  const first = (await app.inject("/public/projects")).json();
  expect(first.projects).toHaveLength(24);
  expect(first.nextOffset).toBe(24);
  const second = (await app.inject("/public/projects?offset=24")).json();
  expect(second.projects).toHaveLength(1);
  expect(second.privateCount).toBe(2);
  expect(second.nextOffset).toBeNull();
  expect(new Set([...first.projects, ...second.projects].map((project) => project.id)).size).toBe(
    25,
  );
  for (const offset of ["-1", "0.5", "1000001", "oops"])
    expect((await app.inject(`/public/projects?offset=${offset}`)).statusCode).toBe(400);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: `/projects/${publicId}/publication`,
        headers,
        payload: { listed: true, name: "   " },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: `/projects/${randomUUID()}/publication`,
        headers,
        payload: { listed: true, name: "Missing" },
      })
    ).statusCode,
  ).toBe(404);
});

test("readiness detects unavailable publication storage and public errors do not reveal database details", async () => {
  database.client.exec("DROP TABLE project_publications");
  expect(() => database.checkReady()).toThrow();
  const response = await app.inject("/public/projects");
  expect(response.statusCode).toBe(500);
  expect(response.json()).toEqual({
    error: "INTERNAL_ERROR",
    message: "Unable to read publication",
  });
  expect(response.body).not.toContain("project_publications");
});
