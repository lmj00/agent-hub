import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { parseResponse, runDetailsSchema } from "@agent-hub/contracts";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db/connection.js";
import { projects, runs, tasks } from "../src/db/schema.js";
import {
  hashPassword,
  type PasswordHash,
} from "../src/modules/auth/password.js";
import { loadAuthConfig } from "../src/modules/auth/auth-config.js";
import type { GoalVerification } from "../src/modules/goals/goal-verification.js";
import { createDrizzleGoalStore } from "../src/modules/goals/drizzle-goal-store.js";

// Read-side fixtures only. goal-verification.test.ts proves the actual journal
// and atomic completion; these rows exercise authenticated historical display.
const now = new Date("2026-01-01T00:00:00Z");
const password = "goal-verification-fixture-password";
const secret = "sk-fixtureSensitiveOutput12345678901234567890";
let passwordHash: PasswordHash;
let directory: string, runId: string, cookie: string;
let database: ReturnType<typeof openDatabase>, app: ReturnType<typeof buildApp>;
let verification: GoalVerification;
beforeAll(async () => {
  passwordHash = await hashPassword(password);
});
beforeEach(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-goal-proof-read-")));
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
      workspaceKey: "fixture",
      createdAt: now,
    })
    .run();
  const goal = createDrizzleGoalStore(database.db).register(projectId, "goal", {
    description: "Check the entire Goal",
    completionCriteria: "All criteria verified",
    kind: "finite",
    priority: 50,
    allowedPaths: ["src"],
    excludedPaths: [],
    checkIntervalMs: 60000,
    budget: { windowMs: 3600000, maxCalls: 20, maxRunMs: 1800000 },
  }).goal;
  database.db
    .insert(tasks)
    .values({
      id: taskId,
      projectId,
      goalId: goal.id,
      goalVersion: 1,
      kind: "planning",
      instruction: "Check the entire Goal",
      requestKey: taskId,
      status: "blocked",
      createdAt: now,
    })
    .run();
  database.db
    .insert(runs)
    .values({
      id: runId,
      taskId,
      goalVersion: 1,
      instanceId: "fixture",
      status: "blocked",
      model: "fixture",
      effort: "medium",
      startedAt: now,
      lastActivityAt: now,
      finishedAt: now,
      terminationConfirmedAt: now,
    })
    .run();
  const configuration = {
    image: "private-image-sentinel",
    command: ["private-command-sentinel", "/private/path-sentinel"],
    timeoutMs: 1000,
  };
  const execution = {
    kind: "docker" as const,
    containerId: "1".repeat(64),
    token: "private-token-sentinel",
    engineId: "private-engine-sentinel",
  };
  verification = {
    version: 1,
    sourceRevision: "a".repeat(40),
    inputDigest: "b".repeat(64),
    configuration,
    startedAt: now.toISOString(),
    test: {
      result: {
        inputDigest: "b".repeat(64),
        candidateDigest: "b".repeat(64),
        configurationDigest: "c".repeat(64),
        configuration,
        execution,
        imageId: `sha256:${"d".repeat(64)}`,
        status: "passed",
        exitCode: 0,
        oomKilled: false,
        elapsedMs: 15,
        output: `test passed ${secret}`,
      },
      recordedAt: now.toISOString(),
    },
    review: {
      execution,
      verificationDigest: "e".repeat(64),
      assessment: {
        report: `전체 기준 확인 ${secret}`,
        evidence: ["src/main.ts"],
        unresolved: [],
        complete: true,
        next: null,
      },
      recordedAt: now.toISOString(),
    },
  };
  save("proposed");
  app = buildApp({ databasePath, auth: loadAuthConfig(authPath) });
  const session = await app.inject("/auth/session");
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
  await app?.close();
  database.close();
  rmSync(directory, { recursive: true, force: true });
});
function save(status: "proposed" | "applied", reason?: string) {
  database.db
    .update(runs)
    .set({
      planResult: {
        proposal: "fixture plan",
        status,
        createdTaskIds: [],
        reason: reason ?? null,
        verification,
      },
    })
    .where(eq(runs.id, runId))
    .run();
}
const read = () =>
  app.inject({ method: "GET", url: `/runs/${runId}`, headers: { cookie } });

test("requires login, redacts test and review output, and excludes all private proof metadata", async () => {
  expect((await app.inject(`/runs/${runId}`)).statusCode).toBe(401);
  const response = await read();
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  const body = parseResponse(runDetailsSchema, response.json());
  expect(body.goalVerification).toMatchObject({
    phase: "verified",
    completionApplied: false,
    sourceRevision: "a".repeat(40),
    test: { status: "passed", elapsedMs: 15 },
    review: { assessment: { complete: true } },
  });
  for (const value of [
    secret,
    "private-",
    "/private/",
    "1".repeat(64),
    "configuration",
    "execution",
    "imageId",
  ])
    expect(JSON.stringify(body.goalVerification)).not.toContain(value);
  expect(body.goalVerification!.test!.output).toContain("[REDACTED]");
  expect(body.goalVerification!.review!.assessment.report).toContain(
    "[REDACTED]",
  );
  expect(database.db.select().from(runs).get()!.status).toBe("blocked");
});

test("only an applied completion record declares historical Goal completion and survives reopen", async () => {
  save("applied", "complete");
  const before = (await read()).json();
  expect(before.goalVerification.completionApplied).toBe(true);
  await app.close();
  database.close();
  database = openDatabase(join(directory, "hub.sqlite"));
  app = buildApp({
    databasePath: join(directory, "hub.sqlite"),
    auth: loadAuthConfig(join(directory, "auth.json")),
  });
  expect((await read()).json().goalVerification).toEqual(
    before.goalVerification,
  );
});

test("partial and rejected proof stays distinct from completed Goal state", async () => {
  const testResult = verification.test,
    review = verification.review;
  verification.test = null;
  verification.review = null;
  save("proposed");
  expect((await read()).json().goalVerification).toMatchObject({
    phase: "testing",
    completionApplied: false,
    test: null,
    review: null,
  });
  verification.test = testResult;
  save("proposed");
  expect((await read()).json().goalVerification).toMatchObject({
    phase: "reviewing",
    completionApplied: false,
    review: null,
  });
  verification.review = review;
  verification.review!.assessment = {
    ...review!.assessment,
    complete: false,
    unresolved: ["검증하지 않은 목표 기준"],
  };
  save("applied", "goal_incomplete");
  expect((await read()).json().goalVerification).toMatchObject({
    phase: "needs_changes",
    completionApplied: false,
    review: { assessment: { unresolved: ["검증하지 않은 목표 기준"] } },
  });
});

test("legacy runs have no proof and malformed completion history produces a generic error", async () => {
  database.db
    .update(runs)
    .set({ planResult: null })
    .where(eq(runs.id, runId))
    .run();
  expect((await read()).json().goalVerification).toBeNull();
  verification.test = null;
  save("applied", "complete");
  const response = await read();
  expect(response.statusCode).toBe(500);
  expect(response.json()).toEqual({
    error: "INTERNAL_ERROR",
    message: "Unable to query execution",
  });
  expect(response.body).not.toContain("private");
});
