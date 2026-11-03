import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  parseResponse,
  runDetailsSchema,
  type GoalDefinition,
} from "@agent-hub/contracts";
import { buildApp } from "../src/app.js";
import { migrationsDirectory, openDatabase } from "../src/db/connection.js";
import {
  executionOwner,
  projects,
  runs,
  serviceTargets,
  tasks,
} from "../src/db/schema.js";
import { createDrizzleGoalStore } from "../src/modules/goals/drizzle-goal-store.js";
import {
  createPlanningStore,
  readPlanningContext,
} from "../src/modules/goals/planning-store.js";
import {
  buildPlanningInput,
  planningInstruction,
} from "../src/modules/goals/goal-plan-policy.js";
import { createPreparedExecutor } from "../src/modules/goals/prepared-executor.js";
import {
  preparedInputRoot,
  type PreparedInput,
} from "../src/modules/goals/prepared-workspace.js";
import { createDrizzleRunStore } from "../src/modules/execution/drizzle-run-store.js";
import { runTask } from "../src/modules/execution/run-task.js";
import { loadExecutionConfig } from "../src/modules/execution/execution-config.js";
import {
  createDrizzleServiceStore,
  type ObserverStatus,
} from "../src/modules/services/drizzle-service-store.js";
import {
  loadServiceConfig,
  type ServiceTargetConfig,
} from "../src/modules/services/service-config.js";
import type { ObservationResult } from "../src/modules/services/observe-service.js";
import type {
  AnalysisExecutor,
  AnalysisRequest,
} from "../src/modules/execution/analysis.js";

const definition: GoalDefinition = {
  description: "Improve example using evidence",
  completionCriteria: "Tests verify changes",
  kind: "continuous",
  priority: 50,
  allowedPaths: ["src"],
  excludedPaths: [],
  checkIntervalMs: 60000,
  budget: { windowMs: 3600000, maxCalls: 20, maxRunMs: 1800000 },
};
let directory: string,
  source: string,
  projectId: string,
  goalId: string,
  planId: string;
let database: ReturnType<typeof openDatabase>,
  services: ReturnType<typeof createDrizzleServiceStore>;
let target: ServiceTargetConfig, observer: ObserverStatus;
const path = () => join(directory, "hub.sqlite");
const closes: (() => Promise<unknown>)[] = [];
beforeEach(() => {
  directory = realpathSync(
    mkdtempSync(join(tmpdir(), "hub-planning-evidence-")),
  );
  source = join(directory, "source");
  mkdirSync(source);
  mkdirSync(join(source, "src"));
  writeFileSync(join(source, "src/main.ts"), "export const answer = 41;\n");
  for (const args of [
    ["init", "--quiet", "--template="],
    ["add", "--all"],
    ["commit", "--quiet", "-m", "fixture"],
  ])
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
  database = openDatabase(path());
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
  goalId = createDrizzleGoalStore(database.db).register(
    projectId,
    "goal",
    definition,
  ).goal.id;
  planId = createPlanningStore(database.db).reserveNext(["example"])!.taskId;
  target = {
    key: "service",
    projectId,
    name: "Example service",
    url: "http://127.0.0.1:4321/private-status",
    bearerToken: "fixture-token",
    fingerprint: "fixture-fingerprint",
    intervalMs: 1000,
    timeoutMs: 1000,
    staleAfterMs: 10000,
    allowWaiting: true,
    activityTimeoutMs: null,
  };
  services = createDrizzleServiceStore(database.db);
  services.configure([target]);
  observer = {
    enabledKeys: new Set([target.key]),
    errors: new Set(),
    nextChecks: new Map(),
  };
});
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  database.close();
  rmSync(directory, { recursive: true, force: true });
});
const context = (now = new Date()) =>
  readPlanningContext(database.db, planId, observer, now)!;
const stored = () =>
  database.db.select().from(runs).where(eq(runs.taskId, planId)).get()!;
function good(now = new Date()): ObservationResult {
  return {
    receivedAt: now,
    success: true,
    errorCode: null,
    snapshot: {
      observedAt: now.toISOString(),
      processState: "running",
      activityState: "waiting",
      lastSuccessAt: null,
      nextExpectedAt: null,
      errorCount: 0,
      summary: "Waiting for data",
    },
  };
}
function prepared(): PreparedInput {
  return {
    id: randomUUID(),
    runId: randomUUID(),
    source,
    directory: join(directory, "prepared"),
    scope: {
      goalId,
      goalVersion: 1,
      allowedPaths: definition.allowedPaths,
      excludedPaths: [],
    },
    phase: "ready",
    revision: "a".repeat(40),
    digest: "b".repeat(64),
    files: [{ path: "src/main.ts", blob: "c".repeat(40), bytes: 30 }],
  };
}
async function execute(
  provider: (request: AnalysisRequest) => Promise<void> | void = () => {},
  store = createDrizzleRunStore(
    database.db,
    undefined,
    {},
    { getObserverStatus: () => observer },
  ),
) {
  const executor: AnalysisExecutor = {
    async analyze(request) {
      await provider(request);
      const input = JSON.parse(request.instruction.split("\n").at(-1)!);
      return {
        output: JSON.stringify({
          version: 1,
          goalVersion: input.goalVersion,
          inputDigest: input.inputDigest,
          outcome: "wait",
          summary: "Wait for useful evidence",
          evidence: [],
          tasks: [],
        }),
        usage: null,
      };
    },
    confirmTermination: async () => new Date(),
  };
  return runTask(
    {
      taskId: planId,
      model: "fixture",
      workspace: source,
      timeoutMs: 5000,
      signal: new AbortController().signal,
    },
    store,
    createPreparedExecutor(executor, preparedInputRoot(path())),
  );
}

test.each([
  ["waiting", "reported_waiting"],
  ["stale", "observation_stale"],
  ["unavailable", "http_error"],
  ["disabled", "observer_disabled"],
  ["storage-error", "observer_error"],
  ["missing", "not_observed"],
  ["stopped", "process_stopped"],
])(
  "uses the same %s verdict as the live service view without replacing failures with historical success",
  (scenario, reason) => {
    const now = new Date();
    if (scenario !== "missing") {
      const result = good(
        new Date(now.getTime() - (scenario === "stale" ? 20000 : 0)),
      );
      if (scenario === "stopped") result.snapshot!.processState = "stopped";
      services.save(target, result);
    }
    if (scenario === "unavailable")
      services.save(target, {
        receivedAt: now,
        success: false,
        errorCode: "http_error",
        snapshot: null,
      });
    if (scenario === "disabled") observer.enabledKeys = new Set();
    if (scenario === "storage-error") observer.errors = new Set([target.key]);
    const evidence = context(now).services[0]!,
      view = services.list(projectId, observer, now)[0]!;
    expect(evidence).toMatchObject({
      state: view.state,
      reason,
      enabled: view.enabled,
      latest: view.latest,
      lastSuccessful: view.lastSuccessful,
    });
    if (scenario === "unavailable")
      expect(evidence).toMatchObject({
        state: "unavailable",
        latest: { success: false },
        lastSuccessful: { success: true },
      });
  },
);
test("scopes observations to the current project, configured target and fingerprint", () => {
  services.save(target, good());
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
  const second = { ...target, key: "other", projectId: other };
  services.configure([target, second]);
  services.save(second, good());
  expect(context().services.map((s) => s.key)).toEqual([target.key]);
  const changed = { ...target, fingerprint: "changed" };
  services.configure([changed, second]);
  expect(context().services[0]).toMatchObject({
    state: "unknown",
    reason: "not_observed",
    latest: null,
    lastSuccessful: null,
  });
  services.configure([second]);
  expect(context().services).toEqual([]);
});
test("defaults to unknown when no live observer status was supplied and redacts known credential patterns", () => {
  const result = good();
  result.snapshot!.summary = "sk-fixture_secret Bearer fixture-token";
  services.save(target, result);
  const input = readPlanningContext(database.db, planId)!;
  expect(input.services[0]).toMatchObject({
    enabled: false,
    state: "unknown",
    reason: "observer_disabled",
  });
  expect(JSON.stringify(input)).not.toContain("sk-fixture_secret");
  expect(JSON.stringify(input)).not.toContain("fixture-token");
  expect(JSON.stringify(input)).not.toContain(target.url);
  expect(JSON.stringify(input)).not.toContain(target.fingerprint);
});
test("persists the exact selected input before the provider starts, exposes evidence after restart, and does not replace it with newer observations", async () => {
  services.save(target, good());
  const original = context().services[0]!.latest!.id;
  await execute((request) => {
    const sent = JSON.parse(request.instruction.split("\n").at(-1)!);
    expect(stored().planningInput).toEqual(sent);
    expect(sent.services[0].latest.id).toBe(original);
    services.save(target, {
      receivedAt: new Date(),
      success: false,
      errorCode: "http_error",
      snapshot: null,
    });
  });
  const before = stored();
  expect(before.status).toBe("succeeded");
  expect(before.planningInput!.services[0]).toMatchObject({
    state: "waiting",
    latest: { id: original },
  });
  database.close();
  database = openDatabase(path());
  expect(stored().planningInput).toEqual(before.planningInput);
  const app = buildApp({ databasePath: path() });
  try {
    const response = await app.inject(`/runs/${before.id}`);
    const detail = parseResponse(runDetailsSchema, response.json());
    expect(detail.planningEvidence).toEqual({
      capturedAt: before.planningInput!.capturedAt,
      counts: before.planningInput!.counts,
      services: before.planningInput!.services,
    });
    expect(response.body).not.toContain(source);
    expect(response.body).not.toContain(target.url);
    expect(response.body).not.toContain(target.fingerprint);
  } finally {
    await app.close();
  }
});
test("does not invoke a model when input evidence cannot be durably saved", async () => {
  database.client.exec(
    "CREATE TRIGGER fail_evidence BEFORE UPDATE OF planning_input ON runs WHEN NEW.planning_input IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected evidence failure'); END",
  );
  let calls = 0;
  const result = await execute(() => {
    calls++;
  });
  expect(calls).toBe(0);
  expect(result.status).not.toBe("succeeded");
  expect(stored().planningInput).toBeNull();
  expect(stored().terminationConfirmedAt).not.toBeNull();
});
test("does not allow late or altered parent input to overwrite evidence", async () => {
  const store = createDrizzleRunStore(
    database.db,
    undefined,
    {},
    { getObserverStatus: () => observer },
  );
  await execute(() => {
    const run = stored();
    expect(() =>
      store.record(run.id, {
        kind: "planning.input_ready",
        planningInput: {
          ...run.planningInput!,
          capturedAt: new Date(0).toISOString(),
        },
      }),
    ).toThrow();
  }, store);
  expect(stored().planningInput!.capturedAt).not.toBe(
    new Date(0).toISOString(),
  );
  expect(() =>
    store.record(stored().id, {
      kind: "planning.input_ready",
      planningInput: stored().planningInput!,
    }),
  ).toThrow();
});
test("allocates bounded Unicode and escaped excerpts fairly without changing complete Goal authority or mutating input", () => {
  services.save(target, good());
  const input = context(),
    files = prepared();
  input.history = Array.from({ length: 20 }, (_, i) => ({
    id: randomUUID(),
    kind: "work",
    status: "succeeded",
    instruction: `history-${i}` + '한글\\"'.repeat(80),
    problemKey: null,
    lastRun: {
      status: "succeeded",
      result: "한글".repeat(500),
      errorCode: null,
      terminationConfirmed: true,
    },
  }));
  input.historyCount = 300;
  input.suppressedWork = Array.from({ length: 20 }, () => ({
    taskId: randomUUID(),
    status: "cancelled",
    paths: ["src/other"],
    acceptanceCriteria: "한글".repeat(250),
  }));
  input.suppressedWorkCount = 100;
  files.files = Array.from({ length: 500 }, (_, i) => ({
    path: `src/${i}-${"한글".repeat(90)}.ts`,
    blob: "c".repeat(40),
    bytes: 10,
  }));
  const before = structuredClone(input),
    built = buildPlanningInput(input, files);
  expect(
    Buffer.byteLength(
      JSON.stringify({ instruction: planningInstruction(built) }),
    ),
  ).toBeLessThanOrEqual(60000);
  expect(built.definition).toEqual(definition);
  expect(input).toEqual(before);
  expect(built.services).toHaveLength(1);
  expect(built.history.length).toBeGreaterThan(0);
  expect(built.suppressedWork.length).toBeGreaterThan(0);
  expect(built.files.length).toBeLessThan(500);
  expect(built.counts).toEqual({
    services: { total: 1, included: built.services.length },
    history: { total: 300, included: built.history.length },
    suppressedWork: { total: 100, included: built.suppressedWork.length },
    files: { total: 500, included: built.files.length },
  });
  built.definition.description = "mutated copy";
  expect(input.definition.description).toBe(definition.description);
});
test("refuses an oversized required Goal instead of silently dropping permissions or completion criteria", () => {
  const input = context();
  input.definition = {
    ...definition,
    description: "🧪".repeat(10000),
    completionCriteria: "🧪".repeat(6000),
  };
  expect(() => buildPlanningInput(input, prepared())).toThrow(
    "input_unavailable",
  );
});
test("fails before calling the provider when required Goal context cannot fit", async () => {
  const goalStore = createDrizzleGoalStore(database.db);
  goalStore.change(goalId, "large", 1, {
    definition: {
      ...definition,
      description: "한".repeat(10000),
      completionCriteria: "한".repeat(6000),
      allowedPaths: Array.from(
        { length: 30 },
        (_, i) => `src/${i}${"한".repeat(150)}`,
      ),
    },
  });
  planId = createPlanningStore(database.db).reserveNext(["example"])!.taskId;
  let called = false;
  const result = await execute(() => {
    called = true;
  });
  expect(called).toBe(false);
  expect(result.status).toBe("blocked");
  expect(stored().errorCode).toBe("input_unavailable");
});
test("preserves existing run records when adding durable planning input", () => {
  database.close();
  const folder = join(directory, "before-input");
  cpSync(migrationsDirectory, folder, { recursive: true });
  const journalPath = join(folder, "meta/_journal.json"),
    journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter(
    (entry: { idx: number }) => entry.idx < 22,
  );
  writeFileSync(journalPath, JSON.stringify(journal));
  const oldPath = join(directory, "old.sqlite"),
    old = openDatabase(oldPath, folder);
  old.client
    .prepare(
      "INSERT INTO projects(id,name,workspace_key,created_at) VALUES (?,?,?,?)",
    )
    .run(projectId, "Old", "example", Date.now());
  old.client
    .prepare(
      "INSERT INTO tasks(id,project_id,instruction,request_key,created_at) VALUES (?,?,?,?,?)",
    )
    .run(planId, projectId, "Old", "old", Date.now());
  const runId = randomUUID();
  old.client
    .prepare(
      "INSERT INTO runs(id,task_id,instance_id,status,model,effort,started_at,last_activity_at,result) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run(
      runId,
      planId,
      "old",
      "succeeded",
      "fixture",
      "medium",
      Date.now(),
      Date.now(),
      "Existing result",
    );
  const { execution, ...before } = old.client.prepare("SELECT * FROM runs").get() as Record<string, unknown>;
  expect(execution).toBeNull();
  old.close();
  database = openDatabase(oldPath);
  expect(database.client.prepare("SELECT * FROM runs").get()).toEqual({
    ...before,
    planning_input: null,
    development_version: null,
  });
  expect(database.client.prepare("SELECT count(*) AS count FROM run_executions").get()).toEqual({ count: 0 });
  expect(() => database.checkReady()).not.toThrow();
});

test("the HTTP observer and running app pass real collected evidence to a planning call without contacting the AI service", async () => {
  // Drop the unstarted fixture reservation so the real app can observe first.
  database.client
    .prepare("DELETE FROM planning_cycles WHERE task_id = ?")
    .run(planId);
  database.db.delete(tasks).where(eq(tasks.id, planId)).run();
  let methods: string[] = [];
  const upstream = createServer((request, response) => {
    methods.push(request.method!);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(good().snapshot));
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  closes.push(
    () =>
      new Promise<void>((resolve) => {
        upstream.closeAllConnections();
        upstream.close(() => resolve());
      }),
  );
  const serviceFile = join(directory, "service-config.json");
  writeFileSync(
    serviceFile,
    JSON.stringify({
      version: 1,
      targets: [
        {
          key: "service",
          projectId,
          name: "Collected service",
          url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/status`,
          intervalMs: 1000,
        },
      ],
    }),
    { mode: 0o600 },
  );
  mkdirSync(join(directory, "codex"));
  writeFileSync(
    join(directory, "codex/auth.json"),
    JSON.stringify({ auth_mode: "chatgpt" }),
  );
  const configFile = join(directory, "execution.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      model: "fixture",
      codexHome: "codex",
      timeoutMs: 10000,
      workspaces: { example: "source" },
    }),
  );
  let received: unknown;
  const executor: AnalysisExecutor = {
    async analyze(request) {
      const input = JSON.parse(request.instruction.split("\n").at(-1)!);
      received = input;
      return {
        output: JSON.stringify({
          version: 1,
          goalVersion: input.goalVersion,
          inputDigest: input.inputDigest,
          outcome: "wait",
          summary: "Wait for input",
          evidence: [],
          tasks: [],
        }),
        usage: null,
      };
    },
    confirmTermination: async () => new Date(),
  };
  const app = buildApp({
    databasePath: path(),
    services: loadServiceConfig(serviceFile),
    execution: {
      config: loadExecutionConfig(configFile),
      executor,
      pollIntervalMs: 20,
    },
  });
  // App must close before the upstream source and before deleting its DB.
  closes.unshift(() => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  await expect
    .poll(
      () =>
        (
          database.client
            .prepare("SELECT count(*) AS n FROM service_observations")
            .get() as { n: number }
        ).n,
    )
    .toBeGreaterThan(0);
  const token = database.db.select().from(executionOwner).get()!.token;
  planId = createPlanningStore(database.db, token).reserveNext([
    "example",
  ])!.taskId;
  await expect.poll(() => received).toBeTruthy();
  expect(received).toMatchObject({
    services: [
      {
        enabled: true,
        state: "waiting",
        latest: { success: true, snapshot: { summary: "Waiting for data" } },
      },
    ],
  });
  await expect.poll(() => stored().status).toBe("succeeded");
  expect(methods.every((method) => method === "GET")).toBe(true);
});
