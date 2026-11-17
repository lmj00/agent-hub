import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { parseResponse, projectUsageSchema } from "@agent-hub/contracts";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db/connection.js";
import { projects, runs, steps, tasks } from "../src/db/schema.js";

let directory: string;
let database: ReturnType<typeof openDatabase>;
let app: ReturnType<typeof buildApp>;
let projectId: string;
const now = new Date();
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "hub-usage-"));
  const databasePath = join(directory, "hub.sqlite");
  database = openDatabase(databasePath);
  app = buildApp({ databasePath });
  projectId = randomUUID();
  database.db
    .insert(projects)
    .values({ id: projectId, name: "Usage", workspaceKey: "usage", createdAt: now })
    .run();
  await app.ready();
});
afterEach(async () => {
  await app.close();
  database.close();
  rmSync(directory, { recursive: true, force: true });
});
function task(id = projectId) {
  const taskId = randomUUID();
  database.db
    .insert(tasks)
    .values({ id: taskId, projectId: id, requestKey: taskId, instruction: "Work", createdAt: now })
    .run();
  return taskId;
}
function run(taskId: string, attempt = 1, pending = false) {
  const id = randomUUID();
  database.db
    .insert(runs)
    .values({
      id,
      taskId,
      attempt,
      instanceId: "fixture",
      model: "gpt-6.1-sol",
      effort: "medium",
      status: pending ? "running" : "succeeded",
      startedAt: now,
      lastActivityAt: now,
      terminationConfirmedAt: pending ? null : now,
    })
    .run();
  return id;
}
function step(
  runId: string,
  sequence: number,
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | null,
  model: string | null = null,
) {
  database.db
    .insert(steps)
    .values({
      id: randomUUID(),
      runId,
      sequence,
      status: usage ? "succeeded" : "running",
      usage,
      model,
      startedAt: now,
    })
    .run();
}
async function view(id = projectId) {
  const response = await app.inject({ method: "GET", url: `/projects/${id}/usage` });
  expect(response.statusCode).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  return parseResponse(projectUsageSchema, response.json());
}
test("counts cached input once, retries and each step once, without leaking another project", async () => {
  const taskId = task();
  const first = run(taskId);
  step(first, 1, { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100 });
  step(first, 2, { inputTokens: 500, cachedInputTokens: 0, outputTokens: 50 });
  step(run(taskId, 2), 1, { inputTokens: 100, cachedInputTokens: 100, outputTokens: 10 });
  const other = randomUUID();
  database.db
    .insert(projects)
    .values({ id: other, name: "Private", workspaceKey: "private", createdAt: now })
    .run();
  step(run(task(other)), 1, { inputTokens: 999999, cachedInputTokens: 0, outputTokens: 999999 });
  const usage = await view();
  expect(usage).toMatchObject({
    inputTokens: 1600,
    cachedInputTokens: 300,
    outputTokens: 160,
    reportedSteps: 3,
    unreportedSteps: 0,
    pendingSteps: 0,
    unpricedSteps: 0,
  });
  expect(usage.referenceCostUsd).toBeCloseTo(0.00423, 10);
  expect(await view()).toEqual(usage);
});
test("preserves unknown cost, distinguishes missing from pending, and honors the step model", async () => {
  const completed = run(task());
  step(completed, 1, { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 }, "unknown-model");
  step(completed, 2, null);
  step(run(task(), 1, true), 1, null);
  const usage = await view();
  expect(usage).toMatchObject({
    referenceCostUsd: null,
    unpricedSteps: 1,
    reportedSteps: 1,
    unreportedSteps: 1,
    pendingSteps: 1,
    inputTokens: 100,
  });
  expect(usage.models.find((row) => row.model === "unknown-model")?.referenceCostUsd).toBeNull();
  step(
    completed,
    3,
    { inputTokens: 100, cachedInputTokens: 100, outputTokens: 0 },
    "gpt-6.1-terra",
  );
  expect((await view()).referenceCostUsd).toBeCloseTo(0.000005, 10);
  expect((await view()).unpricedSteps).toBe(1);
});
test("empty project is distinct from a missing project and rejects invalid ids", async () => {
  expect(await view()).toMatchObject({
    models: [],
    reportedSteps: 0,
    inputTokens: 0,
    referenceCostUsd: null,
  });
  expect((await app.inject(`/projects/${randomUUID()}/usage`)).statusCode).toBe(404);
  expect((await app.inject("/projects/not-an-id/usage")).statusCode).toBe(400);
});

test("historical recovery copies without an assessment are not counted as reported workflow tokens", async () => {
  const { eq } = await import("drizzle-orm");
  const id = run(task());
  database.db
    .update(runs)
    .set({ workflowPolicy: { version: 1, maxSteps: 3, maxEffortChanges: 1 } })
    .where(eq(runs.id, id))
    .run();
  const usage = { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10 };
  step(id, 1, usage);
  database.db
    .update(steps)
    .set({
      assessment: {
        report: "Continue",
        evidence: [],
        unresolved: ["More work"],
        complete: false,
        next: { purpose: "Continue", effort: "medium", reason: "More work" },
      },
    })
    .where(eq(steps.runId, id))
    .run();
  step(id, 2, usage);
  expect(await view()).toMatchObject({
    inputTokens: 100,
    outputTokens: 10,
    reportedSteps: 1,
    unreportedSteps: 1,
    pendingSteps: 0,
  });
});
