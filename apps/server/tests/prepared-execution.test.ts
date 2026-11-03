import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { GoalDefinition } from "@agent-hub/contracts";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db/connection.js";
import { projects, runs, tasks } from "../src/db/schema.js";
import { createDrizzleGoalStore } from "../src/modules/goals/drizzle-goal-store.js";
import {
  cleanupConfirmedInputs,
  cleanupPreparedRun,
  createPreparedExecutor,
} from "../src/modules/goals/prepared-executor.js";
import { preparedInputRoot } from "../src/modules/goals/prepared-workspace.js";
import { createDrizzleRunStore } from "../src/modules/execution/drizzle-run-store.js";
import { createDrizzleRecoveryStore } from "../src/modules/execution/drizzle-recovery-store.js";
import { createRecoveryProcessor } from "../src/modules/execution/recover-task.js";
import { acquireExecutionOwner } from "../src/modules/execution/execution-owner.js";
import { loadExecutionConfig } from "../src/modules/execution/execution-config.js";
import type { AnalysisExecutor } from "../src/modules/execution/analysis.js";
import { runTask } from "../src/modules/execution/run-task.js";

const definition: GoalDefinition = {
  description: "Inspect source",
  completionCriteria: "Verified",
  kind: "finite",
  priority: 50,
  allowedPaths: ["main.ts"],
  excludedPaths: [],
  checkIntervalMs: 60000,
  budget: { windowMs: 3600000, maxCalls: 20, maxRunMs: 1800000 },
};
let directory: string,
  source: string,
  root: string,
  taskId: string,
  goalId: string;
let database: ReturnType<typeof openDatabase>,
  owner: ReturnType<typeof acquireExecutionOwner>,
  store: ReturnType<typeof createDrizzleRunStore>,
  goals: ReturnType<typeof createDrizzleGoalStore>;
beforeEach(() => {
  directory = realpathSync(
    mkdtempSync(join(tmpdir(), "hub-prepared-execution-")),
  );
  source = join(directory, "source");
  mkdirSync(source);
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      {
        cwd: source,
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        stdio: "ignore",
      },
    );
  git("init", "--quiet", "--template=");
  writeFileSync(join(source, "main.ts"), "export const answer = 42;\n");
  writeFileSync(join(source, "outside.txt"), "outside scope");
  git("add", "--all");
  git("commit", "--quiet", "-m", "fixture");
  database = openDatabase(join(directory, "hub.sqlite"));
  root = preparedInputRoot(join(directory, "hub.sqlite"));
  owner = acquireExecutionOwner(database.db);
  store = createDrizzleRunStore(database.db, owner.token);
  goals = createDrizzleGoalStore(database.db);
  const projectId = randomUUID();
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
      instruction: "Inspect",
      requestKey: taskId,
      goalId,
      goalVersion: 1,
      createdAt: new Date(),
    })
    .run();
});
afterEach(() => {
  owner.release();
  database.close();
  rmSync(directory, { recursive: true, force: true });
});
const row = () => database.db.select().from(runs).get()!;
const pause = () => goals.change(goalId, randomUUID(), 1, { action: "pause" });
const base = (
  analyze: AnalysisExecutor["analyze"] = async () => ({
    output: "Verified source",
    usage: null,
  }),
): AnalysisExecutor => ({
  analyze: vi.fn(analyze),
  confirmTermination: async () => new Date(),
});
const run = (
  executor: AnalysisExecutor,
  signal = new AbortController().signal,
) =>
  runTask(
    { taskId, model: "fixture", workspace: source, timeoutMs: 5000, signal },
    store,
    createPreparedExecutor(executor, root),
  );

test("persists preparation intent before copying and ready metadata before invoking AI, then cleans up after proof", async () => {
  const record = store.record,
    events: string[] = [];
  store.record = (id, event) => {
    record(id, event);
    events.push(event.kind);
    if (event.kind === "input.preparing") {
      expect(row().preparedInput?.phase).toBe("preparing");
      expect(existsSync(event.preparedInput!.directory)).toBe(false);
    }
  };
  const executor = base(async (request) => {
    const input = row().preparedInput!;
    expect(input.phase).toBe("ready");
    expect(input.scope).toMatchObject({
      goalId,
      goalVersion: 1,
      allowedPaths: ["main.ts"],
    });
    expect(request.scope).toBeUndefined();
    expect(request.workspace).toBe(input.directory);
    expect(request.workspace).not.toBe(source);
    expect(readFileSync(join(request.workspace, "main.ts"), "utf8")).toContain(
      "42",
    );
    expect(existsSync(join(request.workspace, "outside.txt"))).toBe(false);
    return { output: "Verified source", usage: null };
  });
  expect(await run(executor)).toMatchObject({
    status: "succeeded",
    terminationConfirmedAt: expect.any(Date),
  });
  expect(events).toEqual(["input.preparing", "input.ready"]);
  expect(existsSync(row().preparedInput!.directory)).toBe(false);
  expect(existsSync(join(source, "main.ts"))).toBe(true);
});

test.each(["preparing", "ready"])(
  "a failed %s write cannot authorize an AI call",
  async (phase) => {
    database.client.exec(
      `CREATE TRIGGER fail_prepared BEFORE UPDATE OF prepared_input ON runs WHEN json_extract(NEW.prepared_input,'$.phase') = '${phase}' BEGIN SELECT RAISE(ABORT,'injected failure'); END`,
    );
    const executor = base();
    expect(await run(executor)).toMatchObject({
      status: "blocked",
      errorCode: "input_unavailable",
      result: null,
      terminationConfirmedAt: expect.any(Date),
    });
    expect(executor.analyze).not.toHaveBeenCalled();
    if (row().preparedInput)
      expect(existsSync(row().preparedInput!.directory)).toBe(false);
  },
);

test.each(["preparing", "ready"])(
  "a goal changed during %s cannot start AI using stale permissions",
  async (phase) => {
    const record = store.record;
    store.record = (id, event) => {
      if (event.kind === `input.${phase}`) pause();
      record(id, event);
    };
    const executor = base();
    expect(await run(executor)).toMatchObject({
      status: "blocked",
      errorCode: "goal_changed",
      result: null,
    });
    expect(executor.analyze).not.toHaveBeenCalled();
  },
);

test("a changed source invalidates the result without altering source files", async () => {
  const executor = base(async () => {
    writeFileSync(join(source, "main.ts"), "user change");
    return { output: "Old result", usage: null };
  });
  expect(await run(executor)).toMatchObject({
    status: "blocked",
    errorCode: "input_changed",
    result: null,
  });
  expect(readFileSync(join(source, "main.ts"), "utf8")).toBe("user change");
  expect(existsSync(row().preparedInput!.directory)).toBe(false);
});

test("a goal changed during AI invalidates its success at the completion transaction", async () => {
  const executor = base(async () => {
    pause();
    return { output: "Old goal result", usage: null };
  });
  expect(await run(executor)).toMatchObject({
    status: "blocked",
    errorCode: "goal_changed",
    result: null,
  });
  expect(row().goalVersion).toBe(1);
});

test("cancellation during preparation prevents AI and keeps the user cancellation reason", async () => {
  const controller = new AbortController(),
    record = store.record;
  store.record = (id, event) => {
    record(id, event);
    if (event.kind === "input.preparing") controller.abort("user_cancel");
  };
  const executor = base();
  expect(await run(executor, controller.signal)).toMatchObject({
    status: "cancelled",
    errorCode: "cancel_requested",
    terminationConfirmedAt: expect.any(Date),
  });
  expect(executor.analyze).not.toHaveBeenCalled();
  expect(existsSync(row().preparedInput!.directory)).toBe(false);
});

test.each([false, true])(
  "unconfirmed execution retains input until durable recovery proof; goal changed=%s",
  async (changed) => {
    const executor = { ...base(), confirmTermination: async () => null };
    const result = await run(executor);
    expect(result).toMatchObject({
      status: "interrupted",
      terminationConfirmedAt: null,
    });
    const input = row().preparedInput!;
    cleanupPreparedRun(database.db, root, result.runId);
    cleanupConfirmedInputs(database.db, root);
    expect(existsSync(input.directory)).toBe(true);
    if (changed) pause();
    const recovery = createDrizzleRecoveryStore(database.db, owner.token);
    const request = recovery.request(
      {
        taskId,
        runId: result.runId,
        action: "reconcile",
        requestKey: "recover",
        providerGateVersion: null,
      },
      null,
      true,
    ).request;
    // Simulate an observer's proof; no actual model process is used in this test.
    recovery.complete(request.id, new Date());
    expect(row()).toMatchObject({
      status: changed ? "blocked" : "succeeded",
      errorCode: changed ? "goal_changed" : null,
    });
    // Startup retries cleanup if a parent stopped after proof was saved.
    cleanupConfirmedInputs(database.db, root);
    expect(existsSync(input.directory)).toBe(false);
    cleanupConfirmedInputs(database.db, root);
  },
);

test("recovery cleanup runs only after the store persisted its proof", async () => {
  const executor = { ...base(), confirmTermination: async () => null };
  const result = await run(executor),
    input = row().preparedInput!;
  const identity = {
    kind: "docker" as const,
    engineId: "fixture",
    containerId: "a".repeat(64),
    token: "fixture",
  };
  database.db
    .update(runs)
    .set({ execution: identity })
    .where(eq(runs.id, result.runId))
    .run();
  const recovery = createDrizzleRecoveryStore(database.db, owner.token);
  const request = recovery.request(
    {
      taskId,
      runId: result.runId,
      action: "reconcile",
      requestKey: "recover",
      providerGateVersion: null,
    },
    null,
    true,
  ).request;
  const cleanup = vi.fn(async () => {
    expect(row().terminationConfirmedAt).toBeInstanceOf(Date);
    expect(existsSync(input.directory)).toBe(true);
  });
  const processor = createRecoveryProcessor(
    recovery,
    { confirm: async () => new Date(), cleanup },
    (id) => cleanupPreparedRun(database.db, root, id),
  );
  await processor.process(request.id);
  expect(cleanup).toHaveBeenCalledOnce();
  expect(existsSync(input.directory)).toBe(false);
});

test("wrapping the direct SDK cannot invent process termination tracking", async () => {
  const executor = createPreparedExecutor(
    { analyze: async () => ({ output: "done", usage: null }) },
    root,
  );
  expect(executor.confirmTermination).toBeUndefined();
});

test("termination waits for preparation to settle before confirming that no AI was started", async () => {
  const controller = new AbortController(),
    executor = base(),
    wrapped = createPreparedExecutor(executor, root),
    id = randomUUID();
  let release!: () => void, reached!: () => void;
  const barrier = new Promise<void>((resolve) => {
      release = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
  const result = wrapped
    .analyze(
      {
        runId: id,
        workspace: source,
        model: "fixture",
        instruction: "Inspect",
        signal: controller.signal,
        scope: {
          goalId,
          goalVersion: 1,
          allowedPaths: ["main.ts"],
          excludedPaths: [],
        },
      },
      async () => {
        reached();
        await barrier;
      },
    )
    .catch((error) => error);
  await ready;
  controller.abort();
  let confirmed = false;
  const proof = wrapped.confirmTermination!(id).then((value) => {
    confirmed = true;
    return value;
  });
  await Promise.resolve();
  expect(confirmed).toBe(false);
  release();
  await result;
  expect(await proof).toBeInstanceOf(Date);
  expect(executor.analyze).not.toHaveBeenCalled();
  await wrapped.cleanup!(id);
});

test("a source removed before preparation is a proved pre-AI failure, not an unresolved execution", async () => {
  rmSync(source, { recursive: true });
  const executor = base();
  expect(await run(executor)).toMatchObject({
    status: "blocked",
    errorCode: "input_unavailable",
    terminationConfirmedAt: expect.any(Date),
  });
  expect(row().preparedInput).toBeNull();
  expect(executor.analyze).not.toHaveBeenCalled();
});

test("a termination observer arriving during preparation rechecks whether AI has since started", async () => {
  let release!: () => void, reached!: () => void;
  const barrier = new Promise<void>((resolve) => {
      release = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      reached = resolve;
    });
  const executor = { ...base(), confirmTermination: vi.fn(async () => null) },
    wrapped = createPreparedExecutor(executor, root),
    id = randomUUID();
  const result = wrapped.analyze(
    {
      runId: id,
      workspace: source,
      model: "fixture",
      instruction: "Inspect",
      signal: new AbortController().signal,
      scope: {
        goalId,
        goalVersion: 1,
        allowedPaths: ["main.ts"],
        excludedPaths: [],
      },
    },
    async (event) => {
      if (event.kind === "input.ready") {
        reached();
        await barrier;
      }
    },
  );
  await ready;
  const proof = wrapped.confirmTermination!(id);
  release();
  await result;
  expect(await proof).toBeNull();
  expect(executor.confirmTermination).toHaveBeenCalledWith(id);
  await wrapped.cleanup!(id);
});

test("the automatic server queue supplies the same scoped input and omits private metadata from HTTP", async () => {
  const home = join(directory, "home");
  mkdirSync(home);
  writeFileSync(
    join(home, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt" }),
  );
  const path = join(directory, "execution.json");
  writeFileSync(
    path,
    JSON.stringify({
      model: "fixture",
      codexHome: home,
      workspaces: { example: source },
    }),
  );
  owner.release();
  const executor = base(async (request) => {
    expect(request.workspace).not.toBe(source);
    expect(existsSync(join(request.workspace, "outside.txt"))).toBe(false);
    return { output: "scoped queue", usage: null };
  });
  const app = buildApp({
    databasePath: join(directory, "hub.sqlite"),
    execution: {
      config: loadExecutionConfig(path),
      executor,
      pollIntervalMs: 5,
    },
  });
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    await vi.waitFor(() =>
      expect(database.db.select().from(tasks).get()?.status).toBe("succeeded"),
    );
    const response = await app.inject({
      method: "GET",
      url: `/runs/${row().id}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty("preparedInput");
    expect(response.body).not.toContain(directory);
    expect(executor.analyze).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});
