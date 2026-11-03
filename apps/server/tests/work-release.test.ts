import { randomUUID } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  parseResponse,
  taskSchema,
  taskReleaseSchema,
  type GoalDefinition,
} from "@agent-hub/contracts";
import { buildApp } from "../src/app.js";
import { openDatabase, migrationsDirectory } from "../src/db/connection.js";
import {
  projects,
  tasks,
  runs,
  taskReleases,
  recoveryRequests,
  goalRevisions,
  planningCycles,
  providerGates,
  budgetPeriods,
} from "../src/db/schema.js";
import { createDrizzleGoalStore } from "../src/modules/goals/drizzle-goal-store.js";
import { createWorkReleaseStore } from "../src/modules/goals/work-release-store.js";
import { createPlanningStore } from "../src/modules/goals/planning-store.js";
import { readPlanningWork } from "../src/modules/goals/planning-work-state.js";
import { createDrizzleRunStore } from "../src/modules/execution/drizzle-run-store.js";
import {
  accountRunDuration,
  ensureRetryState,
  refreshRetryErrorStreak,
} from "../src/modules/execution/retry-state-store.js";
import {
  initialRetryState,
  defaultRetryPolicy,
} from "../src/modules/execution/retry-policy.js";

const definition: GoalDefinition = {
  description: "Improve example",
  completionCriteria: "Tests verify behavior",
  kind: "finite",
  priority: 50,
  allowedPaths: ["src", "tests"],
  excludedPaths: ["src/private"],
  checkIntervalMs: 60000,
  budget: { windowMs: 3600000, maxCalls: 20, maxRunMs: 1800000 },
};
let directory: string, projectId: string, goalId: string;
let database: ReturnType<typeof openDatabase>;
let goals: ReturnType<typeof createDrizzleGoalStore>;
const path = () => join(directory, "hub.sqlite");
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "hub-work-release-"));
  database = openDatabase(path());
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
const row = (id: string) =>
  database.db.select().from(tasks).where(eq(tasks.id, id)).get()!;
function work(overrides: Partial<typeof tasks.$inferInsert> = {}) {
  const id = randomUUID();
  database.db
    .insert(tasks)
    .values({
      id,
      projectId,
      goalId,
      goalVersion: 1,
      instruction: "Improve example code",
      requestKey: id,
      status: "cancelled",
      cancelRequestedAt: new Date(),
      createdAt: new Date(),
      retryState: initialRetryState(defaultRetryPolicy),
      plannedWork: {
        planningTaskId: randomUUID(),
        problemKey: "fixture",
        sourceRevision: "a".repeat(40),
        sourceDigest: "b".repeat(64),
        title: "Improve",
        paths: ["src/main.ts"],
        acceptanceCriteria: "Tests pass",
        evidence: ["Example code"],
      },
      ...overrides,
    })
    .run();
  return id;
}
function recordedRun(
  taskId: string,
  overrides: Partial<typeof runs.$inferInsert> = {},
) {
  const id = randomUUID(),
    start = new Date(Date.now() - 1000),
    end = new Date();
  database.db
    .insert(runs)
    .values({
      id,
      taskId,
      instanceId: "fixture",
      attempt: 1,
      goalVersion: row(taskId).goalVersion,
      status: "cancelled",
      model: "fixture",
      effort: "medium",
      startedAt: start,
      lastActivityAt: end,
      finishedAt: end,
      terminationConfirmedAt: end,
      errorCode: "transient",
      ...overrides,
    })
    .run();
  return id;
}
const command = () => ({
  requestKey: randomUUID(),
  expectedGoalVersion: goals.findById(goalId).version,
});
const release = (id: string, input = command()) =>
  createWorkReleaseStore(database.db).release(id, input);
const reject = (id: string, code: string) => {
  const before = goals.findById(goalId),
    count = database.db.select().from(tasks).all().length;
  expect(() => release(id)).toThrow(code);
  expect(goals.findById(goalId)).toEqual(before);
  expect(database.db.select().from(tasks).all()).toHaveLength(count);
  expect(database.db.select().from(taskReleases).all()).toEqual([]);
};

test("creates one linked successor, preserves cancellation and policy, and remains pending a development executor", async () => {
  const source = work(),
    before = row(source),
    input = command();
  const app = buildApp({ databasePath: path() });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/tasks/${source}/release`,
      payload: input,
    });
    expect(response.statusCode).toBe(201);
    const accepted = parseResponse(taskReleaseSchema, response.json());
    expect(response.headers.location).toBe(`/tasks/${accepted.newTaskId}`);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(row(source)).toEqual(before);
    expect(row(accepted.newTaskId)).toMatchObject({
      status: "queued",
      cancelRequestedAt: null,
      goalVersion: 2,
      plannedWork: before.plannedWork,
      retryState: before.retryState,
    });
    expect(goals.findById(goalId)).toMatchObject({ version: 2, definition });
    const old = parseResponse(
      taskSchema,
      (await app.inject(`/tasks/${source}`)).json(),
    );
    const next = parseResponse(
      taskSchema,
      (await app.inject(`/tasks/${accepted.newTaskId}`)).json(),
    );
    expect(old).toMatchObject({
      nextTaskId: next.id,
      previousTaskId: null,
      planningTaskId: before.plannedWork!.planningTaskId,
    });
    expect(next).toMatchObject({ previousTaskId: source, nextTaskId: null });
    const listed = (await app.inject(`/projects/${projectId}/tasks`)).json()
      .tasks;
    expect(listed).toEqual(expect.arrayContaining([old, next]));
    expect(
      createDrizzleRunStore(database.db).claimNext("fixture", ["example"]),
    ).toEqual({ kind: "idle", reason: "development_pending" });
    expect(() =>
      createDrizzleRunStore(database.db).claim(next.id, "fixture"),
    ).toThrow("DEVELOPMENT_EXECUTOR_UNAVAILABLE");
  } finally {
    await app.close();
  }
});

test("replays the original receipt after goal edits and reopening, and rejects altered or second requests", () => {
  const source = work(),
    input = command(),
    original = release(source, input);
  goals.change(goalId, "edit", 2, {
    definition: { ...definition, description: "Changed later" },
  });
  database.close();
  database = openDatabase(path());
  goals = createDrizzleGoalStore(database.db);
  expect(release(source, input)).toEqual({ ...original, created: false });
  expect(() => release(source, { ...input, expectedGoalVersion: 3 })).toThrow(
    "REQUEST_KEY_CONFLICT",
  );
  expect(() => release(source)).toThrow("TASK_ALREADY_RELEASED");
  expect(database.db.select().from(taskReleases).all()).toHaveLength(1);
  expect(goals.findById(goalId).version).toBe(3);
});

test("serializes duplicate HTTP requests across independent connections", async () => {
  const source = work(),
    payload = command(),
    apps = [
      buildApp({ databasePath: path() }),
      buildApp({ databasePath: path() }),
    ];
  try {
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        apps[i % 2]!.inject({
          method: "POST",
          url: `/tasks/${source}/release`,
          payload,
        }),
      ),
    );
    expect(responses.map((r) => r.statusCode).sort()).toEqual([
      200, 200, 200, 200, 200, 200, 200, 201,
    ]);
    expect(new Set(responses.map((r) => r.json().newTaskId)).size).toBe(1);
    expect(database.db.select().from(tasks).all()).toHaveLength(2);
    expect(goals.findById(goalId).version).toBe(2);
  } finally {
    await Promise.all(apps.map((app) => app.close()));
  }
});

test.each(["tasks", "goal_revisions", "task_releases"])(
  "rolls back the whole release if %s cannot be saved",
  (table) => {
    const source = work({ retryState: null }),
      before = row(source),
      priorGoal = goals.findById(goalId);
    recordedRun(source);
    database.client.exec(
      `CREATE TRIGGER fail_release BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected release failure'); END`,
    );
    expect(() => release(source)).toThrow();
    expect(row(source)).toEqual(before);
    expect(goals.findById(goalId)).toEqual(priorGoal);
    expect(database.db.select().from(tasks).all()).toHaveLength(1);
    expect(database.db.select().from(taskReleases).all()).toEqual([]);
    database.client.exec("DROP TRIGGER fail_release");
    expect(release(source).created).toBe(true);
  },
);

test.each([
  "queued",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "waiting_retry",
] as const)("does not release a %s task", (status) =>
  reject(work({ status }), "TASK_NOT_RELEASABLE"),
);
test("does not release a planning task or a manual task lacking provenance", () => {
  reject(work({ kind: "planning" }), "TASK_NOT_RELEASABLE");
  reject(work({ plannedWork: null }), "TASK_NOT_RELEASABLE");
});
test.each(["paused", "completed"] as const)(
  "does not release work for a %s goal",
  (status) => {
    const source = work();
    database.client
      .prepare("UPDATE goals SET status = ? WHERE id = ?")
      .run(status, goalId);
    reject(source, status === "paused" ? "GOAL_PAUSED" : "GOAL_COMPLETED");
  },
);
test("requires the expected goal version and the original project binding", () => {
  const source = work();
  expect(() =>
    release(source, { ...command(), expectedGoalVersion: 20 }),
  ).toThrow("GOAL_VERSION_CHANGED");
  const other = randomUUID();
  database.db
    .insert(projects)
    .values({
      id: other,
      name: "Other",
      workspaceKey: "other",
      createdAt: new Date(),
    })
    .run();
  database.db
    .update(tasks)
    .set({ projectId: other })
    .where(eq(tasks.id, source))
    .run();
  reject(source, "GOAL_BINDING_INVALID");
});
test.each(["outside", "private", "missing-history", "new-child-exclusion"])(
  "rejects %s scope without changing history",
  (scenario) => {
    const source = work(),
      planned = row(source).plannedWork!;
    if (scenario === "outside")
      goals.change(goalId, "scope", 1, {
        definition: { ...definition, allowedPaths: ["tests"] },
      });
    if (scenario === "private")
      database.db
        .update(tasks)
        .set({ plannedWork: { ...planned, paths: ["src/.env"] } })
        .where(eq(tasks.id, source))
        .run();
    if (scenario === "missing-history")
      database.db
        .delete(goalRevisions)
        .where(eq(goalRevisions.goalId, goalId))
        .run();
    if (scenario === "new-child-exclusion") {
      database.db
        .update(tasks)
        .set({ plannedWork: { ...planned, paths: ["src"] } })
        .where(eq(tasks.id, source))
        .run();
      goals.change(goalId, "scope", 1, {
        definition: {
          ...definition,
          excludedPaths: ["src/private", "src/new-child"],
        },
      });
    }
    reject(source, "TASK_SCOPE_CHANGED");
  },
);
test("requires proof for every prior run and rejects pending recovery", () => {
  const source = work(),
    first = recordedRun(source, { terminationConfirmedAt: null });
  recordedRun(source, { attempt: 2 });
  reject(source, "TERMINATION_UNCONFIRMED");
  database.db
    .update(runs)
    .set({ terminationConfirmedAt: new Date() })
    .where(eq(runs.id, first))
    .run();
  database.db
    .insert(recoveryRequests)
    .values({
      id: randomUUID(),
      taskId: source,
      runId: first,
      requestKey: "pending",
      action: "reconcile",
      status: "pending",
      createdAt: new Date(),
    })
    .run();
  reject(source, "RECOVERY_IN_PROGRESS");
});
test.each(["retries", "consecutiveErrors", "totalRunMs"] as const)(
  "does not reset exhausted %s by creating another task",
  (field) => {
    const state = initialRetryState(defaultRetryPolicy);
    state[field] =
      field === "retries"
        ? state.policy.maxRetries
        : field === "consecutiveErrors"
          ? state.policy.maxConsecutiveErrors
          : state.policy.maxTotalRunMs;
    const source = work({ retryState: state });
    recordedRun(source);
    reject(source, "RECOVERY_LIMIT_REACHED");
  },
);
test("carries legacy history through repeated cancellation and reconstructs inherited counters without double accounting", () => {
  const source = work({ retryState: null });
  const start = new Date(Date.now() - 2000),
    end = new Date(start.getTime() + 1000);
  recordedRun(source, {
    startedAt: start,
    finishedAt: end,
    terminationConfirmedAt: end,
  });
  const first = release(source).release.newTaskId;
  expect(row(first).retryState).toMatchObject({
    retries: 0,
    totalRunMs: 1000,
    consecutiveErrors: 1,
    lastError: "transient",
  });
  database.db
    .update(tasks)
    .set({ status: "cancelled", cancelRequestedAt: new Date() })
    .where(eq(tasks.id, first))
    .run();
  const next = release(first).release.newTaskId;
  expect(
    database.db
      .select()
      .from(taskReleases)
      .where(eq(taskReleases.newTaskId, next))
      .get()!.priorAttempts,
  ).toBe(1);
  // Exercise shared retry accounting in isolation. Real released planned work
  // stays blocked until a development executor exists, asserted above.
  database.db
    .update(tasks)
    .set({ plannedWork: null })
    .where(eq(tasks.id, next))
    .run();
  const claim = createDrizzleRunStore(database.db).claim(next, "fixture");
  expect(row(next).retryState).toMatchObject({ retries: 1, totalRunMs: 1000 });
  const current = database.db
    .select()
    .from(runs)
    .where(eq(runs.id, claim.id))
    .get()!;
  const finish = new Date(current.startedAt.getTime() + 500);
  database.db
    .update(runs)
    .set({
      status: "failed",
      errorCode: "transient",
      finishedAt: finish,
      terminationConfirmedAt: finish,
    })
    .where(eq(runs.id, claim.id))
    .run();
  accountRunDuration(database.db, claim.id, finish);
  accountRunDuration(database.db, claim.id, finish);
  refreshRetryErrorStreak(database.db, next);
  expect(row(next).retryState).toMatchObject({
    retries: 1,
    totalRunMs: 1500,
    consecutiveErrors: 2,
    lastError: "transient",
  });
  database.db
    .update(tasks)
    .set({ retryState: null })
    .where(eq(tasks.id, next))
    .run();
  expect(ensureRetryState(database.db, next)).toMatchObject({
    retries: 1,
    totalRunMs: 1500,
    consecutiveErrors: 2,
    reason: null,
    decisionRunId: null,
  });
  database.db
    .update(runs)
    .set({ status: "succeeded", errorCode: null })
    .where(eq(runs.id, claim.id))
    .run();
  refreshRetryErrorStreak(database.db, next);
  expect(row(next).retryState).toMatchObject({
    consecutiveErrors: 0,
    lastError: null,
  });
});
test("allows an unstarted task with zero retries, but never a second execution with that policy", () => {
  const source = work({
    retryState: initialRetryState({ ...defaultRetryPolicy, maxRetries: 0 }),
  });
  const next = release(source).release.newTaskId;
  database.db
    .update(tasks)
    .set({ plannedWork: null })
    .where(eq(tasks.id, next))
    .run();
  const claimed = createDrizzleRunStore(database.db).claim(next, "fixture");
  expect(row(next).retryState!.retries).toBe(0);
  database.db
    .update(runs)
    .set({
      status: "cancelled",
      terminationConfirmedAt: new Date(),
      finishedAt: new Date(),
    })
    .where(eq(runs.id, claimed.id))
    .run();
  database.db
    .update(tasks)
    .set({
      plannedWork: row(source).plannedWork,
      status: "cancelled",
      cancelRequestedAt: new Date(),
    })
    .where(eq(tasks.id, next))
    .run();
  expect(() => release(next)).toThrow("RECOVERY_LIMIT_REACHED");
});
test("keeps the saved retry policy and future delay even if the server policy changes", () => {
  const state = {
    ...initialRetryState({ ...defaultRetryPolicy, maxRetries: 1 }),
    nextAttemptAt: new Date(Date.now() + 60000).toISOString(),
    reason: "user_cancelled",
  };
  const source = work({ retryState: state });
  recordedRun(source);
  const next = createWorkReleaseStore(database.db, {
    ...defaultRetryPolicy,
    maxRetries: 20,
  }).release(source, command()).release.newTaskId;
  expect(row(next).retryState).toEqual({ ...state, reason: null });
  database.db
    .update(tasks)
    .set({ plannedWork: null })
    .where(eq(tasks.id, next))
    .run();
  expect(
    createDrizzleRunStore(database.db).claimNext("fixture", ["example"]),
  ).toEqual({ kind: "idle" });
  expect(database.db.select().from(runs).all()).toHaveLength(1);
});
test("moves suppression to the successor and only retires a proved old planning reservation", () => {
  const source = work();
  expect(
    readPlanningWork(database.db, goalId).suppressed.map((t) => t.taskId),
  ).toEqual([source]);
  const planner = createPlanningStore(database.db);
  const planned = planner.reserveNext(["example"]);
  expect(planned).toBeTruthy();
  const next = release(source).release.newTaskId;
  expect(readPlanningWork(database.db, goalId)).toMatchObject({
    unresolved: true,
    suppressed: [],
  });
  database.db
    .update(tasks)
    .set({ status: "succeeded" })
    .where(eq(tasks.id, next))
    .run();
  expect(readPlanningWork(database.db, goalId)).toMatchObject({
    unresolved: false,
    suppressed: [],
  });
  expect(planner.reserveNext(["example"])).toBeTruthy();
  expect(
    database.db
      .select()
      .from(planningCycles)
      .all()
      .filter((c) => c.status === "reserved"),
  ).toHaveLength(1);
  database.db
    .update(tasks)
    .set({ status: "cancelled", cancelRequestedAt: new Date() })
    .where(eq(tasks.id, next))
    .run();
  expect(
    readPlanningWork(database.db, goalId).suppressed.map((t) => t.taskId),
  ).toEqual([next]);
});
test("does not retire an old planning run until its termination is confirmed", () => {
  const source = work(),
    planner = createPlanningStore(database.db);
  const old = planner.reserveNext(["example"])!;
  const oldRun = recordedRun(old.taskId, {
    status: "blocked",
    terminationConfirmedAt: null,
  });
  const next = release(source).release.newTaskId;
  database.db
    .update(tasks)
    .set({ status: "succeeded" })
    .where(eq(tasks.id, next))
    .run();
  expect(planner.reserveNext(["example"])).toBeNull();
  expect(
    database.db
      .select()
      .from(planningCycles)
      .where(eq(planningCycles.taskId, old.taskId))
      .get()!.status,
  ).toBe("reserved");
  database.db
    .update(runs)
    .set({ terminationConfirmedAt: new Date() })
    .where(eq(runs.id, oldRun))
    .run();
  expect(planner.reserveNext(["example"])!.taskId).not.toBe(old.taskId);
  expect(row(old.taskId).status).toBe("cancelled");
});

test("preserves account blocking and the project and goal period budgets", () => {
  const source = work(),
    runId = recordedRun(source),
    now = new Date();
  database.db
    .insert(providerGates)
    .values({
      scope: "codex:chatgpt",
      version: 2,
      blocked: true,
      reason: "capacity",
      blockedAt: now,
      sourceRunId: runId,
    })
    .run();
  for (const scope of ["project", "goal"]) {
    database.db
      .insert(budgetPeriods)
      .values({
        id: randomUUID(),
        accountKey: `${scope}:${scope === "project" ? projectId : goalId}`,
        projectId,
        goalId: scope === "goal" ? goalId : null,
        startedAt: now,
        endsAt: new Date(now.getTime() + 3600000),
        policy: definition.budget,
        calls: 20,
        runMs: 1800000,
      })
      .run();
  }
  const before = {
    gate: database.db.select().from(providerGates).all(),
    budgets: database.db.select().from(budgetPeriods).all(),
  };
  const next = release(source).release.newTaskId;
  expect(row(next).status).toBe("queued");
  expect({
    gate: database.db.select().from(providerGates).all(),
    budgets: database.db.select().from(budgetPeriods).all(),
  }).toEqual(before);
});

test("validates release input and does not accept caller supplied limits or task contents", async () => {
  const source = work(),
    app = buildApp({ databasePath: path() });
  try {
    for (const payload of [
      {},
      { ...command(), expectedGoalVersion: 0 },
      { ...command(), retryState: initialRetryState(defaultRetryPolicy) },
      { ...command(), instruction: "Different" },
    ]) {
      const result = await app.inject({
        method: "POST",
        url: `/tasks/${source}/release`,
        payload,
      });
      expect(result.statusCode).toBe(400);
      expect(result.json().error).toBe("INVALID_REQUEST");
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/tasks/${source}/release`,
          payload: "text",
        })
      ).statusCode,
    ).toBe(415);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/tasks/${randomUUID()}/release`,
          payload: command(),
        })
      ).statusCode,
    ).toBe(404);
    expect(database.db.select().from(taskReleases).all()).toEqual([]);
  } finally {
    await app.close();
  }
});
test("upgrades the pre-release database without changing tasks, runs or recovery receipts", () => {
  database.close();
  const folder = join(directory, "old-migrations");
  cpSync(migrationsDirectory, folder, { recursive: true });
  const journalPath = join(folder, "meta/_journal.json"),
    journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter(
    (entry: { idx: number }) => entry.idx < 21,
  );
  writeFileSync(journalPath, JSON.stringify(journal));
  const oldPath = join(directory, "old.sqlite"),
    old = openDatabase(oldPath, folder);
  old.db
    .insert(projects)
    .values({
      id: projectId,
      name: "Old",
      workspaceKey: "example",
      createdAt: new Date(),
    })
    .run();
  const id = randomUUID(),
    runId = randomUUID();
  old.db
    .insert(tasks)
    .values({
      id,
      projectId,
      instruction: "Old work",
      requestKey: "old",
      status: "cancelled",
      createdAt: new Date(),
    })
    .run();
  old.client
    .prepare(
      "INSERT INTO runs(id,task_id,instance_id,status,model,effort,started_at,last_activity_at,termination_confirmed_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run(
      runId,
      id,
      "old",
      "cancelled",
      "fixture",
      "medium",
      Date.now(),
      Date.now(),
      Date.now(),
    );
  old.db
    .insert(recoveryRequests)
    .values({
      id: randomUUID(),
      taskId: id,
      runId,
      requestKey: "old",
      action: "cancel",
      status: "completed",
      createdAt: new Date(),
    })
    .run();
  const before = [
    old.db.select().from(tasks).all(),
    (old.client.prepare("SELECT * FROM runs").all() as Record<string, unknown>[]).map(({ execution, ...row }) => {
      expect(execution).toBeNull();
      return row;
    }),
    old.db.select().from(recoveryRequests).all(),
  ];
  old.close();
  database = openDatabase(oldPath);
  expect([
    database.db.select().from(tasks).all(),
    database.client.prepare("SELECT * FROM runs").all(),
    database.db.select().from(recoveryRequests).all(),
  ]).toMatchObject(before);
  expect(database.client.prepare("SELECT count(*) AS count FROM run_executions").get()).toEqual({ count: 0 });
  expect(database.db.select().from(taskReleases).all()).toEqual([]);
  expect(() => database.checkReady()).not.toThrow();
  database.client.exec("DROP TABLE task_releases");
  expect(() => database.checkReady()).toThrow();
});
