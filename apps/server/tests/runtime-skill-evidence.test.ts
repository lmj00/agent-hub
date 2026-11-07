import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { parseResponse, runDetailsSchema, runtimeSkillRoles } from "@agent-hub/contracts";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db/connection.js";
import { projects, runs, steps, tasks } from "../src/db/schema.js";
import { hashPassword, type PasswordHash } from "../src/modules/auth/password.js";
import { loadAuthConfig } from "../src/modules/auth/auth-config.js";
import { loadRuntimeSkill } from "../src/modules/execution/runtime-skills.js";

// Read-side fixtures, not proof of a model invocation. Runtime handshake and
// journal suites cover the writes that establish these records.
const selectedAt = new Date("2026-01-01T00:00:00.000Z");
const loadedAt = new Date("2026-01-01T00:00:01.000Z");
const password = "runtime-skill-fixture-password";
let passwordHash: PasswordHash;
let directory: string, runId: string, cookie: string;
let database: ReturnType<typeof openDatabase>, app: ReturnType<typeof buildApp>;
beforeAll(async () => {
  passwordHash = await hashPassword(password);
});
beforeEach(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-skill-read-")));
  const databasePath = join(directory, "hub.sqlite"),
    authPath = join(directory, "auth.json");
  writeFileSync(
    authPath,
    JSON.stringify({
      version: 1,
      origin: "http://localhost",
      sessionSecret: randomBytes(32).toString("hex"),
      password: passwordHash,
    }),
    { mode: 0o600 },
  );
  database = openDatabase(databasePath);
  const projectId = randomUUID(),
    taskId = randomUUID();
  runId = randomUUID();
  database.db
    .insert(projects)
    .values({
      id: projectId,
      name: "Fixture",
      workspaceKey: "example",
      createdAt: selectedAt,
    })
    .run();
  database.db
    .insert(tasks)
    .values({
      id: taskId,
      projectId,
      instruction: "Inspect saved skills",
      requestKey: taskId,
      status: "blocked",
      createdAt: selectedAt,
    })
    .run();
  database.db
    .insert(runs)
    .values({
      id: runId,
      taskId,
      instanceId: "fixture",
      status: "blocked",
      model: "fixture",
      effort: "medium",
      runtimeSkillVersion: 1,
      startedAt: selectedAt,
      lastActivityAt: loadedAt,
      finishedAt: loadedAt,
      terminationConfirmedAt: loadedAt,
      errorCode: "unsupported_settings",
    })
    .run();
  app = buildApp({ databasePath, auth: loadAuthConfig(authPath) });
  const session = await app.inject({ method: "GET", url: "/auth/session" });
  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    headers: {
      cookie: String(session.headers["set-cookie"]).split(";")[0]!,
      "x-csrf-token": session.json().csrfToken,
    },
    payload: { password },
  });
  expect(login.statusCode).toBe(200);
  cookie = String(login.headers["set-cookie"]).split(";")[0]!;
});
afterEach(async () => {
  await app.close();
  database.close();
  rmSync(directory, { recursive: true, force: true });
});
function addStep(sequence: number, record: Partial<typeof steps.$inferInsert> = {}) {
  database.db
    .insert(steps)
    .values({
      id: randomUUID(),
      runId,
      sequence,
      status: "blocked",
      startedAt: selectedAt,
      finishedAt: loadedAt,
      ...record,
    })
    .run();
}
async function read() {
  const response = await app.inject({
    method: "GET",
    url: `/runs/${runId}`,
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  return parseResponse(runDetailsSchema, response.json());
}

test("requires login and projects all four saved roles without private journal fields", async () => {
  for (const [index, role] of runtimeSkillRoles.entries()) {
    const selection = loadRuntimeSkill(role).selection;
    addStep(index + 1, {
      runtimeSkill: {
        ...selection,
        privatePath: "/private/sentinel",
        instructions: "private-instructions-sentinel",
      } as typeof selection,
      runtimeSkillSelectedAt: selectedAt,
      runtimeSkillLoadedAt: loadedAt,
    });
  }
  expect((await app.inject({ method: "GET", url: `/runs/${runId}` })).statusCode).toBe(401);
  const result = await read();
  expect(result.runtimeSkillVersion).toBe(1);
  expect(result.steps.map((step) => step.runtimeSkill)).toEqual(
    runtimeSkillRoles.map((role) => ({
      ...loadRuntimeSkill(role).selection,
      selectedAt: selectedAt.toISOString(),
      loadedAt: loadedAt.toISOString(),
    })),
  );
  expect(JSON.stringify(result)).not.toContain("sentinel");
  expect(JSON.stringify(result)).not.toContain("runtimeSkillSelectedAt");
  expect(result.status).toBe("blocked"); // Load evidence alone cannot imply success.
});

test("distinguishes absent, selected and loaded records and preserves them after reopening SQLite", async () => {
  addStep(1);
  const selection = loadRuntimeSkill("analyst").selection;
  addStep(2, { runtimeSkill: selection, runtimeSkillSelectedAt: selectedAt });
  let result = await read();
  expect(result.steps[0]!.runtimeSkill).toBeNull();
  expect(result.steps[1]!.runtimeSkill).toEqual({
    ...selection,
    selectedAt: selectedAt.toISOString(),
    loadedAt: null,
  });
  database.db
    .update(steps)
    .set({ runtimeSkillLoadedAt: loadedAt })
    .where(eq(steps.sequence, 2))
    .run();
  await app.close();
  database.close();
  const databasePath = join(directory, "hub.sqlite");
  database = openDatabase(databasePath);
  app = buildApp({
    databasePath,
    auth: loadAuthConfig(join(directory, "auth.json")),
  });
  result = await read();
  expect(result.steps[1]!.runtimeSkill?.loadedAt).toBe(loadedAt.toISOString());
});

test("legacy runs retain null policy and missing evidence instead of receiving today's profile", async () => {
  database.db.update(runs).set({ runtimeSkillVersion: null }).where(eq(runs.id, runId)).run();
  addStep(1);
  const result = await read();
  expect(result.runtimeSkillVersion).toBeNull();
  expect(result.steps[0]!.runtimeSkill).toBeNull();
});

test("reads historical descriptors without comparing them to today's installed bundle", async () => {
  const historical = {
    ...loadRuntimeSkill("planner").selection,
    upstreamVersion: "1.0.0",
    upstreamCommit: "a".repeat(40),
    digest: "b".repeat(64),
    bundleDigest: "c".repeat(64),
    bytes: 100,
  };
  addStep(1, {
    runtimeSkill: historical,
    runtimeSkillSelectedAt: selectedAt,
    runtimeSkillLoadedAt: loadedAt,
  });
  expect((await read()).steps[0]!.runtimeSkill).toEqual({
    ...historical,
    selectedAt: selectedAt.toISOString(),
    loadedAt: loadedAt.toISOString(),
  });
});

test("malformed saved metadata fails safely instead of exposing raw fields or inventing load evidence", async () => {
  addStep(1, {
    runtimeSkill: {
      ...loadRuntimeSkill("developer").selection,
      id: "/private/sentinel",
    },
    runtimeSkillSelectedAt: selectedAt,
    runtimeSkillLoadedAt: loadedAt,
  });
  const response = await app.inject({
    method: "GET",
    url: `/runs/${runId}`,
    headers: { cookie },
  });
  expect(response.statusCode).toBe(500);
  expect(response.json()).toEqual({
    error: "INTERNAL_ERROR",
    message: "Unable to query execution",
  });
});
