import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { GoalDefinition } from "@agent-hub/contracts";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db/connection.js";
import { projects, runs, tasks } from "../src/db/schema.js";
import { createDrizzleGoalStore } from "../src/modules/goals/drizzle-goal-store.js";
import { narrowsGoalScope } from "../src/modules/goals/goal-scope-policy.js";
import { createDrizzleRunStore } from "../src/modules/execution/drizzle-run-store.js";
import { createDrizzleRecoveryStore } from "../src/modules/execution/drizzle-recovery-store.js";
import { runTask, runClaimedTask } from "../src/modules/execution/run-task.js";

const definition: GoalDefinition = {
  description: "Example",
  completionCriteria: "Verified",
  kind: "finite",
  priority: 50,
  allowedPaths: ["src"],
  excludedPaths: ["src/private"],
  checkIntervalMs: 60000,
  budget: { windowMs: 3600000, maxCalls: 20, maxRunMs: 1800000 },
};
let directory: string, projectId: string, goalId: string, taskId: string;
let database: ReturnType<typeof openDatabase>,
  goals: ReturnType<typeof createDrizzleGoalStore>,
  store: ReturnType<typeof createDrizzleRunStore>;
const task = () => database.db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
const run = () => database.db.select().from(runs).where(eq(runs.taskId, taskId)).get()!;
const narrow = () =>
  goals.change(goalId, "narrow", 1, {
    definition: { ...definition, allowedPaths: ["src/main"] },
  });
const options = () => ({
  taskId,
  model: "fixture",
  workspace: directory,
  timeoutMs: 5000,
  signal: new AbortController().signal,
});
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "hub-scope-stop-"));
  database = openDatabase(join(directory, "hub.sqlite"));
  goals = createDrizzleGoalStore(database.db);
  store = createDrizzleRunStore(database.db);
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
  taskId = randomUUID();
  database.db
    .insert(tasks)
    .values({
      id: taskId,
      projectId,
      goalId,
      goalVersion: 1,
      instruction: "Analyze",
      requestKey: taskId,
      createdAt: new Date(),
    })
    .run();
});
afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

test.each([
  [["src"], [], ["src/main"], [], true],
  [["."], [], ["src"], [], true],
  [["src"], [], ["src"], ["src/private"], true],
  [["src/main"], [], ["src"], ["src/main/secret"], true],
  [["src"], ["src/private"], ["src"], ["src"], true],
  [["src", "tests"], [], ["src"], [], true],
  [["src/main"], [], ["src"], [], false],
  [["src"], [], ["."], [], false],
  [["src"], ["src/private"], ["src"], [], false],
  [["src"], [], ["src"], ["tests"], false],
  [["src"], ["src/private"], ["src"], ["src/private/secret"], false],
  [["src", "src/main"], [], ["src"], [], false],
  [["src", "tests"], ["tests"], ["src"], [], false],
] as const)(
  "compares effective path permissions: %j - %j -> %j - %j = %s",
  (allowed, excluded, nextAllowed, nextExcluded, expected) => {
    expect(
      narrowsGoalScope(
        { allowedPaths: [...allowed], excludedPaths: [...excluded] },
        { allowedPaths: [...nextAllowed], excludedPaths: [...nextExcluded] },
      ),
    ).toBe(expected);
  },
);

test.each([true, false])(
  "an independent HTTP update stops a quiet run without inventing user cancellation; proof=%s",
  async (proof) => {
    const app = buildApp({ databasePath: join(directory, "hub.sqlite") });
    const started = Promise.withResolvers<void>();
    let durableBeforeSignal = false;
    const pending = runTask(options(), store, {
      analyze(request) {
        request.signal.addEventListener("abort", () => {
          durableBeforeSignal =
            run().stopReason === "scope_changed" && goals.findById(goalId).version === 2;
        });
        started.resolve();
        return new Promise(() => {});
      },
      confirmTermination: async () => (proof ? new Date() : null),
    });
    try {
      await started.promise;
      const response = await app.inject({
        method: "PATCH",
        url: `/goals/${goalId}`,
        payload: {
          requestKey: "narrow",
          expectedVersion: 1,
          definition: { ...definition, allowedPaths: ["src/main"] },
        },
      });
      expect(response.statusCode).toBe(200);
      const outcome = await pending;
      expect(durableBeforeSignal).toBe(true);
      expect(outcome).toMatchObject({
        status: proof ? "cancelled" : "interrupted",
        errorCode: "scope_changed",
        result: null,
      });
      expect(task().cancelRequestedAt).toBeNull();
      expect(goals.findById(goalId)).toMatchObject({
        version: 2,
        status: "active",
      });
      expect(
        (await app.inject({ method: "GET", url: `/runs/${outcome.runId}` })).json(),
      ).toMatchObject({
        stopReason: "scope_changed",
        errorCode: "scope_changed",
      });
      if (!proof) {
        const recovery = createDrizzleRecoveryStore(database.db);
        const receipt = recovery.request(
          {
            taskId,
            runId: outcome.runId,
            requestKey: "reconcile",
            action: "reconcile",
            providerGateVersion: null,
          },
          null,
          true,
        ).request;
        recovery.complete(receipt.id, new Date());
        expect(run()).toMatchObject({
          status: "cancelled",
          errorCode: "scope_changed",
          terminationConfirmedAt: expect.any(Date),
        });
        expect(task().cancelRequestedAt).toBeNull();
      }
    } finally {
      await app.close();
    }
  },
);

test("a late successful result cannot override a scope stop recorded during termination confirmation", async () => {
  const outcome = await runTask(options(), store, {
    analyze: async () => ({ output: "Late report", usage: null }),
    confirmTermination: async () => {
      narrow();
      return new Date();
    },
  });
  expect(outcome).toMatchObject({
    status: "cancelled",
    result: null,
    errorCode: "scope_changed",
  });
  expect(run().goalVersion).toBe(1);
  expect(task().cancelRequestedAt).toBeNull();
});

test("a scope reduction between assignment and the first call prevents the model from starting", async () => {
  const claimed = store.claim(taskId, "fixture");
  narrow();
  const analyze = vi.fn(async () => ({ output: "Never run", usage: null }));
  const outcome = await runClaimedTask(claimed, options(), store, {
    analyze,
    confirmTermination: async () => new Date(),
  });
  expect(analyze).not.toHaveBeenCalled();
  expect(outcome).toMatchObject({
    status: "cancelled",
    errorCode: "scope_changed",
  });
});

test("a scope reduction also covers an interrupted run whose termination is still unknown", () => {
  const claimed = store.claim(taskId, "fixture");
  store.finish(claimed.id, {
    status: "interrupted",
    result: "Old result",
    errorCode: "termination_unconfirmed",
    usage: null,
  });
  narrow();
  expect(run().stopReason).toBe("scope_changed");
  const recovery = createDrizzleRecoveryStore(database.db);
  const request = recovery.request(
    {
      taskId,
      runId: claimed.id,
      requestKey: "reconcile",
      action: "reconcile",
      providerGateVersion: null,
    },
    null,
    true,
  ).request;
  recovery.complete(request.id, new Date());
  expect(run()).toMatchObject({
    status: "cancelled",
    result: null,
    errorCode: "scope_changed",
  });
});

test("goal definition, revision and stop intent roll back together if the stop write fails", () => {
  store.claim(taskId, "fixture");
  database.client.exec(
    "CREATE TRIGGER fail_scope_stop BEFORE UPDATE OF stop_reason ON runs BEGIN SELECT RAISE(ABORT, 'injected'); END",
  );
  expect(narrow).toThrow("injected");
  expect(goals.findById(goalId)).toMatchObject({ version: 1, definition });
  expect(goals.history(goalId)).toHaveLength(1);
  expect(run().stopReason).toBeNull();
  database.client.exec("DROP TRIGGER fail_scope_stop");
  narrow();
  narrow();
  expect(goals.history(goalId)).toHaveLength(2);
  expect(run().stopReason).toBe("scope_changed");
});

test.each(["pause", "description", "expand"])(
  "a %s change keeps the active run's original stop intent",
  (change) => {
    store.claim(taskId, "fixture");
    if (change === "pause") goals.change(goalId, "change", 1, { action: "pause" });
    else
      goals.change(goalId, "change", 1, {
        definition: {
          ...definition,
          ...(change === "expand" ? { allowedPaths: ["."] } : { description: "New description" }),
        },
      });
    expect(run().stopReason).toBeNull();
    expect(task().status).toBe("running");
  },
);

test("scope changes do not overwrite an earlier stop or affect another goal's execution", () => {
  const active = store.claim(taskId, "fixture");
  store.requestStop(active.id, "timeout");
  narrow();
  expect(run().stopReason).toBe("timeout");
  store.finish(active.id, {
    status: "interrupted",
    result: null,
    usage: null,
    errorCode: "timeout",
    terminationConfirmedAt: new Date(),
  });
  const other = goals.register(projectId, "other", definition).goal,
    otherId = randomUUID();
  database.db
    .insert(tasks)
    .values({
      id: otherId,
      projectId,
      goalId: other.id,
      goalVersion: 1,
      instruction: "Other",
      requestKey: otherId,
      createdAt: new Date(),
    })
    .run();
  const next = store.claim(otherId, "fixture");
  goals.change(goalId, "narrow-again", 2, {
    definition: { ...definition, allowedPaths: ["src/main/one"] },
  });
  expect(store.findById(next.id)?.stopReason).toBeNull();
});

test("failure to read durable stop intent prevents starting the model and records unknown, not a user cancellation", async () => {
  const analyze = vi.fn(async () => ({ output: "Never run", usage: null }));
  store.requestedStop = () => {
    throw new Error("Read failure");
  };
  const outcome = await runTask(options(), store, { analyze });
  expect(analyze).not.toHaveBeenCalled();
  expect(outcome).toMatchObject({
    status: "interrupted",
    errorCode: "stop_reason_unknown",
  });
  expect(run().stopReason).toBe("unknown");
  expect(task().cancelRequestedAt).toBeNull();
});
