import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import { taskSchema, parseResponse, type GoalDefinition } from "@agent-hub/contracts";
import { buildApp } from "../../src/app.js";
import { migrationsDirectory, openDatabase } from "../../src/db/connection.js";
import { projects, tasks, runs } from "../../src/db/schema.js";
import { createDrizzleGoalStore } from "../../src/modules/goals/drizzle-goal-store.js";
import { createDrizzleRunStore } from "../../src/modules/execution/drizzle-run-store.js";
import { createPlanningStore } from "../../src/modules/goals/planning-store.js";
import { defaultRetryPolicy, initialRetryState } from "../../src/modules/execution/retry-policy.js";

const definition: GoalDefinition = {
  description: "Improve the example",
  completionCriteria: "Tests verify the change",
  kind: "finite",
  priority: 50,
  allowedPaths: ["src", "tests"],
  excludedPaths: ["src/private"],
  checkIntervalMs: 60000,
  budget: { windowMs: 3600000, maxCalls: 20, maxRunMs: 1800000 },
};
let directory: string, projectId: string, goalId: string;
let database: ReturnType<typeof openDatabase>, goals: ReturnType<typeof createDrizzleGoalStore>;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "hub-goal-revalidation-"));
  database = openDatabase(join(directory, "hub.sqlite"));
  goals = createDrizzleGoalStore(database.db);
  projectId = randomUUID();
  database.db
    .insert(projects)
    .values({
      id: projectId,
      name: "Example",
      workspaceKey: "example",
      createdAt: new Date(),
    })
    .run();
  goalId = goals.register(projectId, "goal", definition).goal.id;
});
afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});
function work(paths = ["src/main.ts"]) {
  const id = randomUUID();
  database.db
    .insert(tasks)
    .values({
      id,
      projectId,
      goalId,
      goalVersion: 1,
      instruction: "Improve existing behavior",
      requestKey: id,
      createdAt: new Date(),
      plannedWork: {
        planningTaskId: randomUUID(),
        problemKey: "fixture",
        sourceRevision: "a".repeat(40),
        sourceDigest: "b".repeat(64),
        title: "Improve",
        paths,
        acceptanceCriteria: "Tests pass",
        evidence: ["Existing behavior"],
      },
    })
    .run();
  return id;
}
const row = (id: string) => database.db.select().from(tasks).where(eq(tasks.id, id)).get()!;
const change = (next = definition) =>
  goals.change(goalId, randomUUID(), goals.findById(goalId).version, {
    definition: next,
  });
function recordedRun(taskId: string, confirmed = true, status: "failed" | "running" = "failed") {
  const id = randomUUID();
  database.db
    .insert(runs)
    .values({
      id,
      taskId,
      attempt: 1,
      goalVersion: 1,
      instanceId: "fixture",
      status,
      model: "fixture",
      effort: "medium",
      startedAt: new Date(),
      lastActivityAt: new Date(),
      finishedAt: confirmed ? new Date() : null,
      terminationConfirmedAt: confirmed ? new Date() : null,
      errorCode: "transient",
    })
    .run();
  return id;
}

test("pause preserves work; resume records a scope check while keeping the task and its instructions", () => {
  const id = work(),
    before = row(id);
  goals.change(goalId, "pause", 1, { action: "pause" });
  expect(row(id)).toEqual(before);
  goals.change(goalId, "resume", 2, { action: "resume" });
  expect(row(id)).toMatchObject({
    id,
    goalVersion: 3,
    status: "queued",
    plannedWork: before.plannedWork,
    instruction: before.instruction,
    goalReview: {
      fromVersion: 1,
      toVersion: 3,
      decision: "retained",
      paths: ["src/main.ts"],
    },
  });
  const reviewed = row(id);
  goals.change(goalId, "resume", 2, { action: "resume" });
  expect(row(id)).toEqual(reviewed);
  expect(createDrizzleRunStore(database.db).claimNext("fixture", ["example"])).toEqual({
    kind: "idle",
    reason: "development_pending",
  });
});

test.each([
  ["description edit", { ...definition, description: "Updated goal" }],
  ["permission expansion", { ...definition, allowedPaths: ["."] }],
  [
    "unrelated exclusion",
    {
      ...definition,
      excludedPaths: [...definition.excludedPaths, "tests/private"],
    },
  ],
] as const)("%s retains eligible work", (_name, next) => {
  const id = work();
  change({
    ...next,
    allowedPaths: [...next.allowedPaths],
    excludedPaths: [...next.excludedPaths],
  });
  expect(row(id)).toMatchObject({
    goalVersion: 2,
    status: "queued",
    goalReview: { decision: "retained" },
  });
});

test.each([
  [["src/main.ts"], { ...definition, allowedPaths: ["tests"] }],
  [["src/main.ts"], { ...definition, excludedPaths: ["src/main.ts"] }],
  [["src"], { ...definition, excludedPaths: ["src/private", "src/new-private"] }],
  [["src/new/future.ts"], { ...definition, allowedPaths: ["src/main.ts"] }],
] as const)(
  "removes work outside the new scope, including not-yet-created paths: %j",
  (paths, next) => {
    const id = work([...paths]);
    change({
      ...next,
      allowedPaths: [...next.allowedPaths],
      excludedPaths: [...next.excludedPaths],
    });
    expect(row(id)).toMatchObject({
      goalVersion: 1,
      status: "cancelled",
      cancelRequestedAt: null,
      goalReview: {
        fromVersion: 1,
        toVersion: 2,
        decision: "excluded",
        paths: [...paths],
      },
    });
    change(definition);
    expect(row(id)).toMatchObject({
      status: "cancelled",
      goalVersion: 1,
      goalReview: { toVersion: 2 },
    });
  },
);

test("an existing child exclusion does not invalidate a broader task when permissions are unchanged", () => {
  const id = work(["src"]);
  change();
  expect(row(id)).toMatchObject({
    goalVersion: 2,
    status: "queued",
    goalReview: { decision: "retained" },
  });
});

test.each(["failed", "blocked", "waiting_retry", "waiting_capacity"] as const)(
  "rechecking %s work preserves failure, retry counters, budget wait and old Run version",
  (status) => {
    const id = work(),
      runId = recordedRun(id);
    const retryState = {
      ...initialRetryState(defaultRetryPolicy),
      retries: 3,
      totalRunMs: 45000,
      consecutiveErrors: 3,
      reason: "retry_limit",
    };
    const budgetWait = {
      scope: "goal" as const,
      scopeId: goalId,
      reason: "call_limit" as const,
      retryAt: new Date(Date.now() + 60000).toISOString(),
    };
    database.db.update(tasks).set({ status, retryState, budgetWait }).where(eq(tasks.id, id)).run();
    change();
    expect(row(id)).toMatchObject({
      status,
      retryState,
      budgetWait,
      goalVersion: 2,
    });
    expect(database.db.select().from(runs).where(eq(runs.id, runId)).get()).toMatchObject({
      goalVersion: 1,
      status: "failed",
      errorCode: "transient",
    });
    expect(database.db.select().from(tasks).all()).toHaveLength(1);
  },
);

test.each(["cancelled", "succeeded", "running"] as const)("does not rewrite %s work", (status) => {
  const id = work();
  database.db.update(tasks).set({ status }).where(eq(tasks.id, id)).run();
  const before = row(id);
  change();
  expect(row(id)).toEqual(before);
});

test("a stored user cancellation prevents rebinding even before the task status changes", () => {
  const id = work();
  database.db.update(tasks).set({ cancelRequestedAt: new Date() }).where(eq(tasks.id, id)).run();
  const before = row(id);
  change();
  expect(row(id)).toEqual(before);
});

test("termination proof is required, then a later queue pass rechecks without another goal edit", () => {
  const id = work(),
    runId = recordedRun(id, false);
  database.db.update(tasks).set({ status: "blocked" }).where(eq(tasks.id, id)).run();
  change();
  expect(row(id).goalVersion).toBe(1);
  database.db
    .update(runs)
    .set({ terminationConfirmedAt: new Date() })
    .where(eq(runs.id, runId))
    .run();
  expect(createDrizzleRunStore(database.db).claimNext("fixture", ["example"])).toEqual({
    kind: "idle",
  });
  expect(row(id)).toMatchObject({
    goalVersion: 2,
    status: "blocked",
    goalReview: { decision: "retained" },
  });
});

test("pending recovery holds the binding until observation completes; planning also performs the deferred check", () => {
  const id = work(),
    runId = recordedRun(id);
  database.client
    .prepare(
      "INSERT INTO recovery_requests (id,task_id,run_id,request_key,action,status,created_at) VALUES ('request',?,?, 'request','reconcile','pending',?)",
    )
    .run(id, runId, Date.now());
  change();
  expect(row(id).goalVersion).toBe(1);
  database.client.exec("UPDATE recovery_requests SET status = 'completed' WHERE id = 'request'");
  expect(createPlanningStore(database.db).reserveNext(["example"])).toBeNull();
  expect(row(id)).toMatchObject({
    goalVersion: 2,
    goalReview: { decision: "retained" },
  });
});

test("legacy scope without planned paths, private paths and missing goal history remain held", () => {
  const legacy = work(),
    privateTask = work(["src/.env"]),
    unknown = work();
  database.db.update(tasks).set({ plannedWork: null }).where(eq(tasks.id, legacy)).run();
  database.db.update(tasks).set({ goalVersion: 2 }).where(eq(tasks.id, unknown)).run();
  change();
  database.client.exec("DELETE FROM goal_revisions WHERE version = 2");
  change();
  for (const id of [legacy, privateTask, unknown]) expect(row(id).goalReview).toBeNull();
});

test("a task linked to another project cannot inherit the goal's authority", () => {
  const id = work(),
    other = randomUUID();
  database.db
    .insert(projects)
    .values({
      id: other,
      name: "Other",
      workspaceKey: "other",
      createdAt: new Date(),
    })
    .run();
  database.db.update(tasks).set({ projectId: other }).where(eq(tasks.id, id)).run();
  change();
  expect(row(id)).toMatchObject({ goalVersion: 1, goalReview: null });
});

test("a failed task review rolls back the goal revision and all earlier task changes", () => {
  const first = work(),
    second = work(["tests/main.ts"]);
  database.client.exec(
    "CREATE TRIGGER fail_goal_review BEFORE UPDATE OF goal_review ON tasks WHEN NEW.goal_review IS NOT NULL AND (SELECT count(*) FROM tasks WHERE goal_review IS NOT NULL) = 1 BEGIN SELECT RAISE(ABORT, 'injected'); END",
  );
  expect(() => change()).toThrow("injected");
  expect(goals.findById(goalId).version).toBe(1);
  expect(goals.history(goalId)).toHaveLength(1);
  for (const id of [first, second])
    expect(row(id)).toMatchObject({ goalVersion: 1, goalReview: null });
});

test("HTTP returns the server's latest review, preserves it across restart, and rejects caller supplied proof", async () => {
  const id = work();
  change({ ...definition, allowedPaths: ["tests"] });
  const app = buildApp({ databasePath: join(directory, "hub.sqlite") });
  try {
    const response = await app.inject({ method: "GET", url: `/tasks/${id}` });
    expect(response.statusCode).toBe(200);
    expect(parseResponse(taskSchema, response.json())).toMatchObject({
      status: "cancelled",
      goalReview: { decision: "excluded", fromVersion: 1, toVersion: 2 },
    });
    const forged = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/tasks`,
      payload: {
        instruction: "Forge",
        requestKey: "forge",
        goalReview: response.json().goalReview,
      },
    });
    expect(forged.statusCode).toBe(400);
  } finally {
    await app.close();
  }
});

test("migration adds an empty review while preserving existing task, run and recovery references", () => {
  const folder = join(directory, "prior-migrations");
  cpSync(migrationsDirectory, folder, { recursive: true });
  const journalFile = join(folder, "meta/_journal.json"),
    journal = JSON.parse(readFileSync(journalFile, "utf8"));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 20);
  writeFileSync(journalFile, JSON.stringify(journal));
  const path = join(directory, "old.sqlite"),
    old = openDatabase(path, folder);
  old.client.exec(
    "INSERT INTO projects VALUES ('p','Existing','example',1); INSERT INTO tasks (id,project_id,instruction,request_key,created_at) VALUES ('t','p','Keep','key',1); INSERT INTO runs (id,task_id,instance_id,status,model,effort,started_at,last_activity_at) VALUES ('r','t','i','failed','fixture','medium',1,1); INSERT INTO recovery_requests (id,task_id,run_id,request_key,action,status,created_at) VALUES ('q','t','r','recover','reconcile','completed',1)",
  );
  old.close();
  const upgraded = openDatabase(path);
  try {
    expect(upgraded.db.select().from(tasks).get()).toMatchObject({
      id: "t",
      instruction: "Keep",
      goalReview: null,
    });
    expect(upgraded.client.prepare("SELECT task_id,run_id FROM recovery_requests").get()).toEqual({
      task_id: "t",
      run_id: "r",
    });
    expect(upgraded.client.pragma("foreign_key_check")).toEqual([]);
  } finally {
    upgraded.close();
  }
});
