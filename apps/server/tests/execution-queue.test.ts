import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db/connection.js";
import { executionOwner, goals, projects, runs, tasks } from "../src/db/schema.js";
import { AnalysisError, type AnalysisExecutor } from "../src/modules/execution/analysis.js";
import { createDrizzleRunStore } from "../src/modules/execution/drizzle-run-store.js";
import { createExecutionQueue } from "../src/modules/execution/execution-queue.js";
import { loadExecutionConfig } from "../src/modules/execution/execution-config.js";
import { acquireExecutionOwner } from "../src/modules/execution/execution-owner.js";
import type { QueueDiagnostic } from "../src/modules/execution/execution-diagnostics.js";

let directory: string;
let databasePath: string;
let database: ReturnType<typeof openDatabase>;
let config: ReturnType<typeof loadExecutionConfig>;
let projectId: string;
const cleanup: (() => void | Promise<unknown>)[] = [];

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-queue-")));
  databasePath = join(directory, "hub.sqlite");
  database = openDatabase(databasePath);
  mkdirSync(join(directory, "auth"));
  mkdirSync(join(directory, "workspace"));
  writeFileSync(join(directory, "auth", "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
  const file = join(directory, "execution.json");
  writeFileSync(
    file,
    JSON.stringify({
      model: "test-model",
      codexHome: "auth",
      workspaces: { example: "workspace" },
    }),
  );
  config = loadExecutionConfig(file);
  projectId = randomUUID();
  database.db
    .insert(projects)
    .values({ id: projectId, name: "Example", workspaceKey: "example", createdAt: new Date() })
    .run();
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

function task(instruction: string, createdAt = new Date(), project = projectId, id = randomUUID()) {
  database.db
    .insert(tasks)
    .values({ id, projectId: project, instruction, requestKey: randomUUID(), createdAt })
    .run();
  return id;
}
function taskStatus(id: string) {
  return database.db.select().from(tasks).where(eq(tasks.id, id)).get()?.status;
}
function queue(executor: AnalysisExecutor, validate = () => {}) {
  const result = createExecutionQueue({
    config,
    executor,
    store: createDrizzleRunStore(database.db),
    validate,
    reportDiagnostic: () => {},
    pollIntervalMs: 5,
  });
  cleanup.push(() => result.stop());
  return result;
}
const success: AnalysisExecutor = {
  async analyze() {
    return { output: "Analysis", usage: null };
  },
};

test("selects configured queued tasks by creation time and ID, skipping unconfigured projects", () => {
  const otherProject = randomUUID();
  database.db
    .insert(projects)
    .values({
      id: otherProject,
      name: "Unconfigured",
      workspaceKey: "missing",
      createdAt: new Date(0),
    })
    .run();
  const skipped = task("skip", new Date(0), otherProject);
  const later = task("later", new Date(2));
  const second = task("second", new Date(1), projectId, "00000000-0000-4000-8000-000000000002");
  const first = task("first", new Date(1), projectId, "00000000-0000-4000-8000-000000000001");
  const store = createDrizzleRunStore(database.db);
  for (const id of [first, second, later]) {
    const claim = store.claimNext("test", ["example"]);
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") throw new Error("Expected claim");
    expect(claim.run.taskId).toBe(id);
    store.finish(claim.run.id, {
      status: "succeeded",
      result: "Done",
      errorCode: null,
      usage: null,
    });
  }
  expect(store.claimNext("test", ["example"])).toEqual({ kind: "idle" });
  expect(taskStatus(skipped)).toBe("queued");
});

test("queue selection and run creation roll back together and a second connection cannot claim", () => {
  const first = task("first", new Date(1));
  task("second", new Date(2));
  const store = createDrizzleRunStore(database.db);
  database.client.exec(
    "CREATE TRIGGER reject_step BEFORE INSERT ON steps BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
  );
  expect(() => store.claimNext("test", ["example"])).toThrow();
  expect(taskStatus(first)).toBe("queued");
  expect(database.db.select().from(runs).all()).toEqual([]);
  database.client.exec("DROP TRIGGER reject_step");
  expect(store.claimNext("test", ["example"]).kind).toBe("claimed");
  const other = openDatabase(databasePath);
  try {
    expect(createDrizzleRunStore(other.db).claimNext("test", ["example"]).kind).toBe("held");
  } finally {
    other.close();
  }
});

test("starts only once and awaits one analysis before starting the next", async () => {
  const first = task("first", new Date(1));
  const second = task("second", new Date(2));
  let finish!: () => void;
  const analyze = vi
    .fn<AnalysisExecutor["analyze"]>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ output: "First", usage: null });
        }),
    )
    .mockImplementation(success.analyze);
  const execution = queue({ analyze });
  execution.start();
  execution.start();
  expect(analyze).toHaveBeenCalledTimes(1);
  expect(execution.getStatus()).toMatchObject({ state: "running", taskId: first });
  expect(taskStatus(second)).toBe("queued");
  finish();
  await vi.waitFor(() => expect(taskStatus(second)).toBe("succeeded"));
  expect(analyze).toHaveBeenCalledTimes(2);
  expect(execution.getStatus().state).toBe("idle");
});

test.each(["authentication", "capacity", "unsupported_settings"] as const)(
  "%s holds the next task without repeated AI calls",
  async (code) => {
    task("first", new Date(1));
    const second = task("second", new Date(2));
    const analyze = vi.fn<AnalysisExecutor["analyze"]>(async () => {
      throw new AnalysisError(code);
    });
    const execution = queue({ analyze });
    execution.start();
    await vi.waitFor(() => expect(execution.getStatus().state).toBe("held"));
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(taskStatus(second)).toBe("queued");
  },
);

test("a completed failure permits the next distinct task without retrying the failed task", async () => {
  const first = task("first", new Date(1));
  const second = task("second", new Date(2));
  const analyze = vi
    .fn<AnalysisExecutor["analyze"]>()
    .mockRejectedValueOnce(new AnalysisError("provider_error"))
    .mockImplementation(success.analyze);
  const execution = queue({ analyze });
  execution.start();
  await vi.waitFor(() => expect(taskStatus(second)).toBe("succeeded"));
  expect(taskStatus(first)).toBe("failed");
  expect(analyze).toHaveBeenCalledTimes(2);
});

test("configuration is rechecked before claims and an invalid environment creates no runs", async () => {
  const id = task("first");
  let valid = false;
  const analyze = vi.fn(success.analyze);
  const execution = queue({ analyze }, () => {
    if (!valid) throw new Error("private config path");
  });
  execution.start();
  expect(execution.getStatus()).toMatchObject({ state: "error", reason: "configuration_invalid" });
  expect(JSON.stringify(execution.getStatus())).not.toContain("private config path");
  expect(taskStatus(id)).toBe("queued");
  expect(database.db.select().from(runs).all()).toEqual([]);
  valid = true;
  await vi.waitFor(() => expect(taskStatus(id)).toBe("succeeded"));
  expect(analyze).toHaveBeenCalledTimes(1);
});

test("timeout holds the queue and stopping leaves later tasks queued", async () => {
  const first = task("first", new Date(1));
  const second = task("second", new Date(2));
  config.timeoutMs = 10;
  const execution = queue({
    analyze(request) {
      return new Promise((_resolve, reject) =>
        request.signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      );
    },
  });
  execution.start();
  await vi.waitFor(() => expect(execution.getStatus().state).toBe("held"));
  expect(taskStatus(first)).toBe("interrupted");
  expect(taskStatus(second)).toBe("queued");
  await execution.stop();
  expect(execution.getStatus().state).toBe("stopped");
});

test("ownership replacement cannot release an unresolved run or accept a stale result", () => {
  const first = task("first", new Date(1));
  task("second", new Date(2));
  const owner = acquireExecutionOwner(database.db, {
    hostname: "fixture",
    pid: 100,
    mayExist: () => false,
  });
  const store = createDrizzleRunStore(database.db, owner.token);
  const run = store.claim(first, "test");
  const replacement = acquireExecutionOwner(database.db, {
    hostname: "fixture",
    pid: 200,
    mayExist: () => false,
  });
  expect(
    createDrizzleRunStore(database.db, replacement.token).claimNext("test", ["example"]),
  ).toMatchObject({ kind: "held", runId: run.id });
  expect(() =>
    store.finish(run.id, { status: "succeeded", result: "late", errorCode: null, usage: null }),
  ).toThrow("ownership");
  expect(() => createDrizzleRunStore(database.db).claimNext("test", ["example"])).toThrow(
    "ownership",
  );
  replacement.release();
});

test("a normal API server leaves execution disabled", async () => {
  const id = task("pending");
  const app = buildApp({ databasePath });
  cleanup.push(() => app.close());
  const response = await app.inject({ url: "/execution" });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    state: "disabled",
    runId: null,
    taskId: null,
    reason: null,
    lastCheckedAt: null,
    automaticRecoveryEnabled: false,
    capacityRecoveryEnabled: false,
  });
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(taskStatus(id)).toBe("queued");
});

test("listening starts the queue, duplicate servers are refused, and shutdown preserves interruption before closing DB", async () => {
  const first = task("first", new Date(1));
  const second = task("second", new Date(2));
  const analyze = vi.fn<AnalysisExecutor["analyze"]>(
    (request) =>
      new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("stopped")), {
          once: true,
        });
      }),
  );
  const execution = { config, executor: { analyze }, pollIntervalMs: 5 };
  const app = buildApp({ databasePath, execution });
  cleanup.push(() => app.close());
  await app.ready();
  expect(analyze).not.toHaveBeenCalled();
  await app.listen({ host: "127.0.0.1", port: 0 });
  await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
  expect((await app.inject({ url: "/execution" })).json()).toMatchObject({
    state: "running",
    taskId: first,
  });
  const duplicate = buildApp({ databasePath, execution });
  await expect(duplicate.ready()).rejects.toThrow("already owns");
  await duplicate.close();
  expect(database.db.select().from(executionOwner).all()).toHaveLength(1);
  await app.close();
  expect(taskStatus(first)).toBe("interrupted");
  expect(taskStatus(second)).toBe("queued");
  expect(database.db.select().from(executionOwner).all()).toHaveLength(0);
  const resumed = buildApp({ databasePath, execution });
  cleanup.push(() => resumed.close());
  await resumed.listen({ host: "127.0.0.1", port: 0 });
  await vi.waitFor(async () =>
    expect((await resumed.inject({ url: "/execution" })).json()).toMatchObject({
      state: "held",
      reason: "interrupted",
    }),
  );
  expect(analyze).toHaveBeenCalledTimes(1);
});

test("cannot start AI when HTTP listening fails and does not retain execution ownership", async () => {
  const server = buildApp({ databasePath });
  cleanup.push(() => server.close());
  const address = await server.listen({ host: "127.0.0.1", port: 0 });
  task("pending");
  const analyze = vi.fn(success.analyze);
  const app = buildApp({ databasePath, execution: { config, executor: { analyze } } });
  await expect(
    app.listen({ host: "127.0.0.1", port: Number(new URL(address).port) }),
  ).rejects.toThrow();
  await app.close();
  expect(analyze).not.toHaveBeenCalled();
  expect(database.db.select().from(executionOwner).all()).toHaveLength(0);
});

test("queue detects newly added project overrides before claiming a later task", async () => {
  const app = buildApp({
    databasePath,
    execution: { config, executor: success, pollIntervalMs: 5 },
  });
  cleanup.push(() => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  mkdirSync(join(directory, "workspace", ".codex"));
  writeFileSync(join(directory, "workspace", ".codex", "config.toml"), "");
  const id = task("pending");
  await vi.waitFor(async () =>
    expect((await app.inject({ url: "/execution" })).json()).toMatchObject({
      state: "error",
      reason: "configuration_invalid",
    }),
  );
  expect(taskStatus(id)).toBe("queued");
  expect(database.db.select().from(runs).all()).toEqual([]);
});

test("closing the server persists interruption without waiting for an executor that ignores cancellation", async () => {
  const first = task("first", new Date(1));
  const second = task("second", new Date(2));
  const analysis = Promise.withResolvers<{ output: string; usage: null }>();
  const analyze = vi.fn(() => analysis.promise);
  const app = buildApp({
    databasePath,
    execution: { config, executor: { analyze }, pollIntervalMs: 5 },
  });
  cleanup.push(() => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
  const closing = app.close();
  try {
    await vi.waitFor(() => expect(taskStatus(first)).toBe("interrupted"));
    await closing;
    expect(taskStatus(second)).toBe("queued");
    expect(database.db.select().from(executionOwner).all()).toHaveLength(0);
  } finally {
    analysis.resolve({ output: "late success", usage: null });
    await closing;
  }
  expect(taskStatus(first)).toBe("interrupted");
});

test("records a sanitized cause for a completion write failure without claiming it recovered on a later read", async () => {
  const id = task("first");
  database.client.exec(
    "CREATE TRIGGER reject_finish BEFORE UPDATE ON steps BEGIN SELECT RAISE(ABORT, 'secret_value'); END;",
  );
  const report = vi.fn<(diagnostic: QueueDiagnostic) => void>();
  const execution = createExecutionQueue({
    config,
    store: createDrizzleRunStore(database.db),
    executor: success,
    validate: () => {},
    reportDiagnostic: report,
    pollIntervalMs: 5,
  });
  cleanup.push(() => execution.stop());
  execution.start();
  await vi.waitFor(() => expect(execution.getStatus().state).toBe("held"));
  expect(report).toHaveBeenCalledTimes(1);
  expect(report.mock.calls[0]?.[0]).toMatchObject({
    event: "execution_queue.error",
    phase: "execution",
    code: "SQLITE_CONSTRAINT",
    taskId: id,
    occurrences: 1,
  });
  expect(JSON.stringify(report.mock.calls)).not.toContain("secret_value");
  expect(taskStatus(id)).toBe("running");
});

test("writes diagnostic records to the server logger without exposing configuration content", async () => {
  const lines: string[] = [];
  const app = buildApp({
    databasePath,
    logger: {
      stream: {
        write(line: string) {
          lines.push(line);
        },
      },
    },
    execution: { config, executor: success, pollIntervalMs: 5 },
  });
  cleanup.push(() => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  writeFileSync(join(directory, "auth", "auth.json"), '{"secret_value":');
  await vi.waitFor(() =>
    expect(lines.some((line) => line.includes('"event":"execution_queue.error"'))).toBe(true),
  );
  const failures = lines
    .map((line) => JSON.parse(line))
    .filter((line) => line.event === "execution_queue.error");
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({ phase: "validation", code: "INVALID_JSON", occurrences: 1 });
  expect(JSON.stringify(failures)).not.toContain("secret_value");
  expect(JSON.stringify(failures)).not.toContain(directory);
  writeFileSync(join(directory, "auth", "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
  await vi.waitFor(() =>
    expect(lines.some((line) => line.includes('"event":"execution_queue.recovered"'))).toBe(true),
  );
  expect((await app.inject({ url: "/execution" })).json().state).toBe("idle");
});

const autonomousGoal = {
  description: "Keep the example healthy",
  completionCriteria: "No verified defects remain",
  kind: "continuous" as const,
  priority: 50,
  allowedPaths: ["main.mjs"],
  excludedPaths: [],
  checkIntervalMs: 60000,
  budget: { windowMs: 3600000, maxCalls: 20, maxRunMs: 1800000 },
};
function preparePlanningSource() {
  const source = config.workspaces.get("example")!;
  writeFileSync(join(source, "main.mjs"), "export const answer = 42;\n");
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
        env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
        stdio: "ignore",
      },
    );
  git("init", "--quiet", "--template=");
  git("add", "--all");
  git("commit", "--quiet", "-m", "fixture");
  config.containerImage = "fixture:local";
  config.verification = new Map([
    ["example", { image: "fixture:local", command: ["node", "main.mjs"], timeoutMs: 10000 }],
  ]);
}
function waitingPlanner() {
  return {
    analyze: vi.fn<AnalysisExecutor["analyze"]>(async (request) => {
      expect(request.responseMode).toBe("goal-plan");
      const input = JSON.parse(request.instruction.split("\n").at(-1)!);
      return {
        output: JSON.stringify({
          version: 1,
          goalVersion: input.goalVersion,
          inputDigest: input.inputDigest,
          outcome: "wait",
          summary: "No new work",
          evidence: ["main.mjs returns 42"],
          tasks: [],
        }),
        usage: null,
      };
    }),
    confirmTermination: async () => new Date(),
  };
}
async function checkedAgain(app: ReturnType<typeof buildApp>) {
  const previous = (await app.inject({ url: "/execution" })).json().lastCheckedAt;
  await vi.waitFor(async () => {
    const current = (await app.inject({ url: "/execution" })).json().lastCheckedAt;
    expect(current).not.toBeNull();
    expect(current).not.toBe(previous);
  });
}

test("goal registration starts planning, waits without repeated calls and resumes a due check after server restart", async () => {
  preparePlanningSource();
  const executor = waitingPlanner();
  const execution = { config, executor, pollIntervalMs: 5 };
  const app = buildApp({ databasePath, execution });
  cleanup.push(() => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const response = await app.inject({
    method: "POST",
    url: `/projects/${projectId}/goals`,
    payload: { requestKey: "automatic-goal", definition: autonomousGoal },
  });
  expect(response.statusCode).toBe(201);
  await vi.waitFor(
    () =>
      expect(
        database.db
          .select()
          .from(tasks)
          .all()
          .map((item) => item.status),
      ).toEqual(["succeeded"]),
    { timeout: 10000 },
  );
  const id = response.json().id;
  expect(
    database.db.select().from(goals).where(eq(goals.id, id)).get()!.nextCheckAt!.getTime(),
  ).toBeGreaterThan(Date.now());
  await checkedAgain(app);
  expect(executor.analyze).toHaveBeenCalledTimes(1);
  await app.close();
  const restarted = buildApp({ databasePath, execution });
  cleanup.push(() => restarted.close());
  await restarted.listen({ host: "127.0.0.1", port: 0 });
  await checkedAgain(restarted);
  expect(executor.analyze).toHaveBeenCalledTimes(1);
  expect(database.db.select().from(tasks).all()).toHaveLength(1);
  database.db
    .update(goals)
    .set({ nextCheckAt: new Date(0) })
    .where(eq(goals.id, id))
    .run();
  await vi.waitFor(
    () =>
      expect(
        database.db
          .select()
          .from(tasks)
          .all()
          .map((item) => item.status),
      ).toEqual(["succeeded", "succeeded"]),
    { timeout: 10000 },
  );
  expect(executor.analyze).toHaveBeenCalledTimes(2);
});

test.each(["image", "verification", "termination"])(
  "goal registration without development %s does not reserve automatic planning",
  async (missing) => {
    preparePlanningSource();
    if (missing === "image") {
      delete config.containerImage;
      delete config.verification;
    }
    if (missing === "verification") delete config.verification;
    const executor = waitingPlanner();
    const app = buildApp({
      databasePath,
      execution: {
        config,
        executor: missing === "termination" ? { analyze: executor.analyze } : executor,
        pollIntervalMs: 5,
      },
    });
    cleanup.push(() => app.close());
    await app.listen({ host: "127.0.0.1", port: 0 });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/projects/${projectId}/goals`,
          payload: { requestKey: "no-development", definition: autonomousGoal },
        })
      ).statusCode,
    ).toBe(201);
    await checkedAgain(app);
    expect(database.db.select().from(tasks).all()).toEqual([]);
    expect(executor.analyze).not.toHaveBeenCalled();
  },
);

test("planning storage failures prevent claims and report recovery in the planning phase", async () => {
  const id = task("queued work");
  let healthy = false;
  const reportDiagnostic = vi.fn();
  const analyze = vi.fn(success.analyze);
  const execution = createExecutionQueue({
    config,
    executor: { analyze },
    store: createDrizzleRunStore(database.db),
    validate() {},
    reportDiagnostic,
    pollIntervalMs: 5,
    planning: {
      tick() {
        if (!healthy)
          throw Object.assign(new Error("private storage detail"), { code: "SQLITE_BUSY" });
      },
    },
  });
  cleanup.push(() => execution.stop());
  execution.start();
  expect(execution.getStatus()).toMatchObject({ state: "error", reason: "storage_error" });
  expect(reportDiagnostic.mock.calls[0]?.[0]).toMatchObject({
    phase: "planning",
    code: "SQLITE_BUSY",
  });
  expect(analyze).not.toHaveBeenCalled();
  healthy = true;
  await vi.waitFor(() => expect(taskStatus(id)).toBe("succeeded"));
  expect(
    reportDiagnostic.mock.calls.some(
      ([event]) => event.event === "execution_queue.recovered" && event.phase === "planning",
    ),
  ).toBe(true);
});
