import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { GoalDefinition, TaskKind } from "@agent-hub/contracts";
import { buildApp } from "../../src/app.js";
import { migrationsDirectory, openDatabase } from "../../src/db/connection.js";
import { goals, projects, providerGates, runs, tasks } from "../../src/db/schema.js";
import { createDrizzleGoalStore } from "../../src/modules/goals/drizzle-goal-store.js";
import { createDrizzleRunStore } from "../../src/modules/execution/drizzle-run-store.js";
import { createDrizzleRecoveryStore } from "../../src/modules/execution/drizzle-recovery-store.js";
import { createAutomaticRecovery } from "../../src/modules/execution/automatic-recovery.js";
import { createCapacityRecovery } from "../../src/modules/execution/capacity-recovery.js";
import { defaultRetryPolicy } from "../../src/modules/execution/retry-policy.js";
import { defaultCapacityPolicy } from "../../src/modules/execution/capacity-policy.js";
import { acquireExecutionOwner } from "../../src/modules/execution/execution-owner.js";

const definition: GoalDefinition = {
  description: "Improve an example",
  completionCriteria: "Verified changes",
  kind: "finite",
  priority: 50,
  allowedPaths: ["."],
  excludedPaths: [".git"],
  checkIntervalMs: 60000,
  budget: { windowMs: 3600000, maxCalls: 20, maxRunMs: 1800000 },
};
const retryPolicy = {
  ...defaultRetryPolicy,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  jitterRatio: 0,
};
const capacityPolicy = {
  ...defaultCapacityPolicy,
  initialDelayMs: 1000,
  maxDelayMs: 4000,
  jitterRatio: 0,
};
let directory: string,
  database: ReturnType<typeof openDatabase>,
  owner: ReturnType<typeof acquireExecutionOwner>,
  projectId: string,
  goalId: string;
let goalStore: ReturnType<typeof createDrizzleGoalStore>,
  store: ReturnType<typeof createDrizzleRunStore>,
  recovery: ReturnType<typeof createDrizzleRecoveryStore>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
  directory = mkdtempSync(join(tmpdir(), "hub-goal-execution-"));
  database = openDatabase(join(directory, "hub.sqlite"));
  owner = acquireExecutionOwner(database.db);
  store = createDrizzleRunStore(database.db, owner.token, {
    automaticRecovery: retryPolicy,
    capacityRecovery: capacityPolicy,
  });
  recovery = createDrizzleRecoveryStore(database.db, owner.token);
  goalStore = createDrizzleGoalStore(database.db);
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
  goalId = goalStore.register(projectId, "goal", definition).goal.id;
});
afterEach(() => {
  owner.release();
  database.close();
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});
function task(linked = true, kind: TaskKind = "work", project = projectId) {
  const id = randomUUID();
  database.db
    .insert(tasks)
    .values({
      id,
      projectId: project,
      instruction: "Read the example",
      requestKey: id,
      kind,
      goalId: linked ? goalId : null,
      goalVersion: linked ? 1 : null,
      createdAt: new Date(),
    })
    .run();
  vi.setSystemTime(Date.now() + 1);
  return id;
}
const taskRow = (id: string) => database.db.select().from(tasks).where(eq(tasks.id, id)).get()!;
const pause = () =>
  goalStore.change(goalId, randomUUID(), goalStore.findById(goalId).version, {
    action: "pause",
  });
function failure(taskId: string, code = "transient", proof = true) {
  const run = store.claim(taskId, "fixture");
  vi.setSystemTime(Date.now() + 100);
  store.finish(run.id, {
    status: code === "capacity" ? "waiting_capacity" : proof ? "failed" : "interrupted",
    errorCode: code,
    result: null,
    usage: null,
    terminationConfirmedAt: proof ? new Date() : null,
  });
  return run;
}
const automatic = () =>
  createAutomaticRecovery({
    db: database.db,
    ownerToken: owner.token,
    policy: retryPolicy,
    workspaceKeys: ["example"],
    recovery,
    random: () => 0,
  });

test("queue skips paused goals and starts eligible work without allocating a retry to the paused task", () => {
  const paused = task();
  pause();
  const next = task(false);
  expect(() => store.claim(paused, "fixture")).toThrow("GOAL_PAUSED");
  expect(store.claimNext("fixture", ["example"])).toMatchObject({
    kind: "claimed",
    run: { taskId: next },
  });
  expect(store.listByTask(paused)).toEqual([]);
  expect(taskRow(paused)).toMatchObject({ status: "queued", retryState: null });
});

test("current goal version is saved on the Run and changing the goal does not rewrite its execution history", () => {
  const id = task(),
    run = store.claim(id, "fixture");
  pause();
  store.finish(run.id, {
    status: "succeeded",
    result: "Recorded under version one",
    errorCode: null,
    usage: null,
    terminationConfirmedAt: new Date(),
  });
  expect(store.findById(run.id)).toMatchObject({
    goalVersion: 1,
    status: "succeeded",
  });
  expect(goalStore.findById(goalId)).toMatchObject({
    version: 2,
    status: "paused",
  });
  expect(taskRow(id).cancelRequestedAt).toBeNull();
});

test.each(["planning", "work"] as const)(
  "a resumed or edited goal cannot silently reuse the old %s binding",
  (kind) => {
    const id = task(true, kind);
    pause();
    goalStore.change(goalId, "resume", 2, { action: "resume" });
    expect(() => store.claim(id, "fixture")).toThrow("GOAL_VERSION_CHANGED");
    expect(store.claimNext("fixture", ["example"])).toEqual({ kind: "idle" });
    expect(taskRow(id)).toMatchObject({ goalVersion: 1, status: "queued" });
    expect(store.listByTask(id)).toEqual([]);
  },
);

test("a goal belonging to another project never authorizes an execution", () => {
  const other = randomUUID();
  database.db
    .insert(projects)
    .values({
      id: other,
      name: "Other",
      workspaceKey: "example",
      createdAt: new Date(),
    })
    .run();
  const id = task(true, "work", other);
  expect(() => store.claim(id, "fixture")).toThrow("GOAL_BINDING_INVALID");
  expect(store.claimNext("fixture", ["example"])).toEqual({ kind: "idle" });
});

test("completed goals and invalid stored task bindings cannot start work", () => {
  const id = task();
  database.db.update(goals).set({ status: "completed" }).where(eq(goals.id, goalId)).run();
  expect(() => store.claim(id, "fixture")).toThrow("GOAL_COMPLETED");
  expect(() =>
    database.client.prepare("UPDATE tasks SET goal_version = NULL WHERE id = ?").run(id),
  ).toThrow();
  expect(() =>
    database.client.prepare("UPDATE tasks SET goal_version = 0 WHERE id = ?").run(id),
  ).toThrow();
  expect(() =>
    database.client.prepare("UPDATE tasks SET kind = 'invalid' WHERE id = ?").run(id),
  ).toThrow();
  expect(() => task(false, "planning")).toThrow();
});

test("manual resume checks the goal both before acceptance and after termination observation", () => {
  const id = task(),
    run = failure(id, "transient", false);
  const request = recovery.request(
    {
      taskId: id,
      runId: run.id,
      requestKey: "resume",
      action: "resume",
      providerGateVersion: null,
    },
    null,
    true,
  ).request;
  pause();
  expect(recovery.complete(request.id, new Date())).toEqual({
    proofSaved: true,
  });
  expect(recovery.findById(request.id)).toMatchObject({
    status: "rejected",
    errorCode: "GOAL_PAUSED",
  });
  expect(store.findById(run.id)?.terminationConfirmedAt).not.toBeNull();
  expect(taskRow(id).status).not.toBe("queued");
  expect(() =>
    recovery.request(
      {
        taskId: id,
        runId: run.id,
        requestKey: "again",
        action: "resume",
        providerGateVersion: null,
      },
      null,
      true,
    ),
  ).toThrow("GOAL_PAUSED");
  const cancelled = recovery.request(
    {
      taskId: id,
      runId: run.id,
      requestKey: "cancel",
      action: "cancel",
      providerGateVersion: null,
    },
    null,
    true,
  ).request;
  recovery.complete(cancelled.id, new Date());
  expect(taskRow(id).status).toBe("cancelled");
});

test("automatic recovery still reconciles old execution while a goal is paused but cannot retry it", () => {
  const id = task(),
    run = failure(id, "transient", false);
  pause();
  expect(automatic().tick()).toBe(true);
  const request = recovery.nextPending()!;
  expect(request).toMatchObject({ taskId: id, action: "reconcile" });
  recovery.complete(request.id, new Date());
  expect(automatic().tick()).toBe(false);
  expect(store.findById(run.id)?.terminationConfirmedAt).not.toBeNull();
  expect(store.listByTask(id)).toHaveLength(1);
  expect(taskRow(id).retryState?.retries).toBe(0);
});

test("pausing during backoff cannot promote the task or consume another attempt", () => {
  const id = task();
  failure(id);
  expect(automatic().tick()).toBe(true);
  const due = taskRow(id).retryState!.nextAttemptAt!;
  pause();
  vi.setSystemTime(new Date(due));
  expect(automatic().tick()).toBe(false);
  expect(taskRow(id)).toMatchObject({
    status: "waiting_retry",
    retryState: { retries: 0, nextAttemptAt: due },
  });
});

test("capacity checks and already reserved probes cannot bypass a goal pause", () => {
  const id = task();
  failure(id, "capacity");
  const capacity = createCapacityRecovery({
    db: database.db,
    ownerToken: owner.token,
    policy: capacityPolicy,
    retryPolicy,
    workspaceKeys: ["example"],
    random: () => 0,
  });
  capacity.tick();
  const gate = store.getProviderGate();
  vi.setSystemTime(new Date(gate.capacityState!.nextCheckAt!));
  capacity.tick();
  expect(store.getProviderGate().probeTaskId).toBe(id);
  pause();
  expect(store.claimNext("fixture", ["example"])).toMatchObject({
    kind: "held",
    reason: "goal_paused",
  });
  expect(store.getProviderGate().capacityState!.checks).toBe(0);
  expect(store.listByTask(id)).toHaveLength(1);
  database.db.update(providerGates).set({ probeTaskId: null }).run();
  capacity.tick();
  expect(store.getProviderGate()).toMatchObject({
    probeTaskId: null,
    capacityState: { checks: 0, reason: "task_unavailable" },
  });
});

test("HTTP exposes goal linkage but cannot forge planning tasks or reuse an internal task key", async () => {
  const id = task(true, "planning"),
    app = buildApp({ databasePath: join(directory, "hub.sqlite") });
  try {
    expect((await app.inject({ method: "GET", url: `/tasks/${id}` })).json()).toMatchObject({
      kind: "planning",
      goalId,
      goalVersion: 1,
    });
    const body = { instruction: "Read the example", requestKey: id };
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/projects/${projectId}/tasks`,
          payload: body,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/projects/${projectId}/tasks`,
          payload: {
            ...body,
            requestKey: "forged",
            kind: "planning",
            goalId,
            goalVersion: 1,
          },
        })
      ).statusCode,
    ).toBe(400);
    const run = store.claim(id, "fixture");
    expect((await app.inject({ method: "GET", url: `/runs/${run.id}` })).json()).toMatchObject({
      goalVersion: 1,
    });
  } finally {
    await app.close();
  }
});

test("migration preserves existing tasks, runs and recovery references without replacing the task table", () => {
  const folder = join(directory, "old-migrations");
  cpSync(migrationsDirectory, folder, { recursive: true });
  const file = join(folder, "meta/_journal.json"),
    journal = JSON.parse(readFileSync(file, "utf8"));
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 16);
  writeFileSync(file, JSON.stringify(journal));
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
      requestKey: "key",
      kind: "work",
      goalId: null,
      goalVersion: null,
    });
    expect(upgraded.db.select().from(runs).get()).toMatchObject({
      id: "r",
      taskId: "t",
      goalVersion: null,
    });
    expect(upgraded.client.prepare("SELECT task_id,run_id FROM recovery_requests").get()).toEqual({
      task_id: "t",
      run_id: "r",
    });
    expect(upgraded.client.pragma("foreign_key_check")).toEqual([]);
    expect(upgraded.client.pragma("foreign_keys", { simple: true })).toBe(1);
  } finally {
    upgraded.close();
  }
});
