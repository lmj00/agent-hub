import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { GoalDefinition } from "@agent-hub/contracts";
import { openDatabase } from "../src/db/connection.js";
import {
  budgetPeriods,
  projects,
  providerGates,
  recoveryRequests,
  runs,
  tasks,
} from "../src/db/schema.js";
import { createCapacityRecovery } from "../src/modules/execution/capacity-recovery.js";
import { defaultCapacityPolicy } from "../src/modules/execution/capacity-policy.js";
import { defaultRetryPolicy, initialRetryState } from "../src/modules/execution/retry-policy.js";
import { createDrizzleRunStore } from "../src/modules/execution/drizzle-run-store.js";
import { acquireExecutionOwner } from "../src/modules/execution/execution-owner.js";
import { createDrizzleGoalStore } from "../src/modules/goals/drizzle-goal-store.js";

const policy = {
  ...defaultCapacityPolicy,
  initialDelayMs: 1000,
  maxDelayMs: 4000,
  jitterRatio: 0,
};
const definition: GoalDefinition = {
  description: "Example",
  completionCriteria: "Verified",
  kind: "finite",
  priority: 50,
  allowedPaths: ["src"],
  excludedPaths: [],
  checkIntervalMs: 60000,
  budget: { windowMs: 3600000, maxCalls: 20, maxRunMs: 1800000 },
};
let directory: string, projectId: string, sourceGoal: string, sourceTask: string, sourceRun: string;
let database: ReturnType<typeof openDatabase>, owner: ReturnType<typeof acquireExecutionOwner>;
let store: ReturnType<typeof createDrizzleRunStore>,
  goals: ReturnType<typeof createDrizzleGoalStore>;
let capacity: ReturnType<typeof createCapacityRecovery>;
const gate = () => store.getProviderGate();
const row = (id: string) => database.db.select().from(tasks).where(eq(tasks.id, id)).get()!;
function candidate() {
  const goal = goals.register(projectId, randomUUID(), definition).goal;
  const id = randomUUID();
  database.db
    .insert(tasks)
    .values({
      id,
      projectId,
      goalId: goal.id,
      goalVersion: goal.version,
      instruction: "Different work",
      requestKey: id,
      createdAt: new Date(),
    })
    .run();
  return { taskId: id, goalId: goal.id };
}
function pause(id = sourceGoal) {
  return goals.change(id, randomUUID(), 1, { action: "pause" });
}
function due() {
  vi.setSystemTime(new Date(gate().capacityState!.nextCheckAt!));
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
  directory = mkdtempSync(join(tmpdir(), "hub-probe-fallback-"));
  database = openDatabase(join(directory, "hub.sqlite"));
  owner = acquireExecutionOwner(database.db);
  store = createDrizzleRunStore(database.db, owner.token, {
    automaticRecovery: defaultRetryPolicy,
    capacityRecovery: policy,
  });
  goals = createDrizzleGoalStore(database.db);
  capacity = createCapacityRecovery({
    db: database.db,
    ownerToken: owner.token,
    policy,
    retryPolicy: defaultRetryPolicy,
    workspaceKeys: ["example"],
    random: () => 0,
  });
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
  const initial = candidate();
  sourceTask = initial.taskId;
  sourceGoal = initial.goalId;
  sourceRun = store.claim(sourceTask, "fixture").id;
  store.finish(sourceRun, {
    status: "waiting_capacity",
    errorCode: "capacity",
    result: null,
    usage: null,
    retryAt: new Date(Date.now() + 10000),
    terminationConfirmedAt: new Date(),
  });
});
afterEach(() => {
  owner.release();
  database.close();
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

test.each(["pause", "edit"])(
  "a %s of the source goal permits another task only at the saved account time",
  (change) => {
    const next = candidate(),
      original = row(sourceTask),
      before = gate();
    if (change === "pause") pause();
    else
      goals.change(sourceGoal, "edit", 1, {
        definition: { ...definition, description: "Changed goal" },
      });
    expect(capacity.tick()).toBe(false);
    expect(gate()).toMatchObject({
      blocked: true,
      sourceRunId: sourceRun,
      retryAt: before.retryAt,
      probeTaskId: null,
      capacityState: {
        checks: 0,
        nextCheckAt: before.capacityState!.nextCheckAt,
      },
    });
    expect(capacity.tick()).toBe(false);
    expect(row(sourceTask)).toEqual(original);
    due();
    expect(capacity.tick()).toBe(true);
    expect(gate()).toMatchObject({
      blocked: true,
      probeTaskId: next.taskId,
      probeRunId: null,
      capacityState: {
        checks: 0,
        nextCheckAt: before.capacityState!.nextCheckAt,
        reason: "ready",
      },
    });
    expect(database.db.select().from(runs).all()).toHaveLength(1);
    const claimed = store.claimNext("fixture", ["example"]);
    expect(claimed).toMatchObject({
      kind: "claimed",
      run: { taskId: next.taskId, providerCheck: true },
    });
    expect(gate().capacityState?.checks).toBe(1);
    if (claimed.kind !== "claimed") throw new Error("Expected probe");
    store.finish(claimed.run.id, {
      status: "succeeded",
      result: "Recovered",
      errorCode: null,
      usage: null,
      terminationConfirmedAt: new Date(),
    });
    expect(gate().blocked).toBe(false);
    expect(row(sourceTask)).toEqual(original);
  },
);

test("replaces an unstarted reservation atomically and another SQLite connection cannot replace it again", () => {
  const next = candidate();
  capacity.tick();
  due();
  capacity.tick();
  expect(gate().probeTaskId).toBe(sourceTask);
  const original = gate();
  pause();
  expect(capacity.tick()).toBe(true);
  expect(gate()).toMatchObject({
    version: original.version + 1,
    probeTaskId: next.taskId,
    capacityState: {
      checks: 0,
      nextCheckAt: original.capacityState!.nextCheckAt,
    },
  });
  const second = openDatabase(join(directory, "hub.sqlite"));
  try {
    const scheduler = createCapacityRecovery({
      db: second.db,
      ownerToken: owner.token,
      policy,
      retryPolicy: defaultRetryPolicy,
      workspaceKeys: ["example"],
    });
    expect(scheduler.tick()).toBe(false);
    expect(gate().probeTaskId).toBe(next.taskId);
    expect(() => store.reserveProviderCheck(next.taskId, original.version)).toThrow("GATE_CHANGED");
  } finally {
    second.close();
  }
});

test("clears a stale unstarted reservation when no replacement exists and notices later eligible work", () => {
  capacity.tick();
  due();
  capacity.tick();
  pause();
  expect(capacity.tick()).toBe(true);
  expect(gate()).toMatchObject({
    probeTaskId: null,
    capacityState: { checks: 0, reason: "task_unavailable" },
  });
  expect(capacity.tick()).toBe(false);
  const next = candidate();
  expect(capacity.tick()).toBe(true);
  expect(gate().probeTaskId).toBe(next.taskId);
});

test("a selected replacement that becomes stale is replaced without resetting the shared check count", () => {
  const first = candidate();
  pause();
  due();
  capacity.tick();
  expect(gate().probeTaskId).toBe(first.taskId);
  const saved = gate();
  pause(first.goalId);
  const second = candidate();
  capacity.tick();
  expect(gate()).toMatchObject({
    probeTaskId: second.taskId,
    sourceRunId: sourceRun,
    capacityState: {
      checks: saved.capacityState!.checks,
      nextCheckAt: saved.capacityState!.nextCheckAt,
    },
  });
});

test("an active or unconfirmed probe cannot be reassigned after its goal changes", () => {
  candidate();
  capacity.tick();
  due();
  capacity.tick();
  const probe = store.claim(sourceTask, "fixture");
  pause();
  const running = gate();
  expect(capacity.tick()).toBe(false);
  expect(gate()).toEqual(running);
  store.finish(probe.id, {
    status: "succeeded",
    result: "Unconfirmed",
    usage: null,
    errorCode: null,
  });
  expect(capacity.tick()).toBe(false);
  expect(gate()).toEqual(running);
});

test.each([
  "cancelled",
  "paused",
  "stale",
  "retry-limit",
  "retry-count",
  "retry-time",
  "termination-unconfirmed",
  "budget",
  "pending-recovery",
  "development",
  "workspace",
])("does not move the account probe onto a %s candidate", (kind) => {
  const next = candidate();
  if (kind === "cancelled")
    database.db
      .update(tasks)
      .set({ cancelRequestedAt: new Date() })
      .where(eq(tasks.id, next.taskId))
      .run();
  if (kind === "paused") pause(next.goalId);
  if (kind === "stale")
    goals.change(next.goalId, "edit", 1, {
      definition: { ...definition, description: "New" },
    });
  if (kind === "retry-count" || kind === "termination-unconfirmed")
    database.db
      .insert(runs)
      .values({
        id: randomUUID(),
        taskId: next.taskId,
        goalVersion: 1,
        attempt: 1,
        instanceId: "fixture",
        status: "failed",
        model: "fixture",
        effort: "medium",
        startedAt: new Date(),
        lastActivityAt: new Date(),
        finishedAt: new Date(),
        terminationConfirmedAt: kind === "retry-count" ? new Date() : null,
        errorCode: "transient",
      })
      .run();
  if (kind === "retry-limit" || kind === "retry-count" || kind === "retry-time") {
    const retry = initialRetryState(defaultRetryPolicy);
    if (kind === "retry-limit") retry.totalRunMs = retry.policy.maxTotalRunMs;
    else if (kind === "retry-count") retry.retries = retry.policy.maxRetries;
    else retry.nextAttemptAt = new Date(Date.now() + 30000).toISOString();
    database.db.update(tasks).set({ retryState: retry }).where(eq(tasks.id, next.taskId)).run();
  }
  if (kind === "budget")
    database.db
      .insert(budgetPeriods)
      .values({
        id: randomUUID(),
        accountKey: `goal:${next.goalId}`,
        projectId,
        goalId: next.goalId,
        startedAt: new Date(),
        endsAt: new Date(Date.now() + 3600000),
        policy: definition.budget,
        calls: definition.budget.maxCalls,
      })
      .run();
  if (kind === "pending-recovery")
    database.db
      .insert(recoveryRequests)
      .values({
        id: randomUUID(),
        taskId: next.taskId,
        requestKey: "pending",
        action: "cancel",
        status: "pending",
        createdAt: new Date(),
      })
      .run();
  if (kind === "development")
    database.db
      .update(tasks)
      .set({
        plannedWork: {
          planningTaskId: "fixture",
          problemKey: "fixture",
          sourceRevision: "fixture",
          sourceDigest: "fixture",
          title: "Development",
          paths: ["src/main.ts"],
          acceptanceCriteria: "Verified",
          evidence: ["fixture"],
        },
      })
      .where(eq(tasks.id, next.taskId))
      .run();
  if (kind === "workspace")
    database.db
      .update(projects)
      .set({ workspaceKey: "unconfigured" })
      .where(eq(projects.id, projectId))
      .run();
  const before = row(next.taskId);
  pause();
  due();
  capacity.tick();
  expect(gate()).toMatchObject({
    probeTaskId: null,
    capacityState: { checks: 0, reason: "task_unavailable" },
  });
  expect(database.db.select().from(runs).all()).toHaveLength(
    kind === "retry-count" || kind === "termination-unconfirmed" ? 2 : 1,
  );
  expect(row(next.taskId)).toEqual(before);
});

test("account exhaustion and authentication still stop all replacement probes", () => {
  candidate();
  pause();
  due();
  const state = gate().capacityState!;
  database.db
    .update(providerGates)
    .set({ capacityState: { ...state, checks: state.policy.maxChecks } })
    .run();
  capacity.tick();
  expect(gate()).toMatchObject({
    probeTaskId: null,
    capacityState: { checks: state.policy.maxChecks, reason: "check_limit" },
  });
  database.db.update(providerGates).set({ reason: "authentication" }).run();
  const auth = gate();
  expect(capacity.tick()).toBe(false);
  expect(gate()).toEqual(auth);
});

test("a failed replacement write rolls back the target and reservation together", () => {
  const next = candidate();
  capacity.tick();
  due();
  capacity.tick();
  pause();
  const saved = gate(),
    taskBefore = row(next.taskId);
  database.client.exec(
    "CREATE TRIGGER reject_replacement BEFORE INSERT ON events WHEN NEW.kind = 'capacity.check_reassigned' BEGIN SELECT RAISE(ABORT, 'injected'); END",
  );
  expect(() => capacity.tick()).toThrow("injected");
  expect(gate()).toEqual(saved);
  expect(row(next.taskId)).toEqual(taskBefore);
  database.client.exec("DROP TRIGGER reject_replacement");
  expect(capacity.tick()).toBe(true);
  expect(gate().probeTaskId).toBe(next.taskId);
});

test("replacement state survives restart and a new local policy without spending a check", () => {
  const next = candidate();
  pause();
  due();
  capacity.tick();
  const saved = gate();
  owner.release();
  database.close();
  database = openDatabase(join(directory, "hub.sqlite"));
  owner = acquireExecutionOwner(database.db);
  store = createDrizzleRunStore(database.db, owner.token, {
    automaticRecovery: defaultRetryPolicy,
    capacityRecovery: policy,
  });
  const restarted = createCapacityRecovery({
    db: database.db,
    ownerToken: owner.token,
    policy: { ...policy, maxChecks: 20 },
    retryPolicy: defaultRetryPolicy,
    workspaceKeys: ["example"],
  });
  expect(restarted.tick()).toBe(false);
  expect(gate()).toEqual(saved);
  store.claim(next.taskId, "fixture");
  expect(gate().capacityState).toMatchObject({
    checks: 1,
    policy: { maxChecks: 3 },
  });
});
