import { parseEffortPolicy } from "../src/modules/execution/effort-policy.js";
import { parseAnalysisWorkflow } from "../src/modules/execution/analysis-workflow.js";
import { execFile, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AnalysisEvent, ExecutionIdentity } from "../src/modules/execution/analysis.js";
import { createContainerExecutor } from "../src/modules/execution/execution-process.js";
import { prepareContainer, removeFinishedContainer, stopAndConfirmContainer } from "../src/modules/execution/container-runtime.js";
import { openDatabase } from "../src/db/connection.js";
import { projects, runs, tasks } from "../src/db/schema.js";
import { createDrizzleRunStore } from "../src/modules/execution/drizzle-run-store.js";
import { runTask } from "../src/modules/execution/run-task.js";
import { loadExecutionConfig } from "../src/modules/execution/execution-config.js";
import { createProjectBudgetStore } from "../src/modules/budgets/project-budget-store.js";

const exec = promisify(execFile);
const image = "agent-hub-execution-test:local";
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Docker가 필요한 검증은 명시적으로 실행합니다. 모델 호출이나 실제 인증은 사용하지 않습니다.
describe.skipIf(process.env.RUN_CONTAINER_TESTS !== "1")("real container execution", () => {
  let directory: string;
  let home: string;
  let workspace: string;
  let database: ReturnType<typeof openDatabase>;
  let store: ReturnType<typeof createDrizzleRunStore>;
  let taskId: string;
  const identities: ExecutionIdentity[] = [];

  beforeAll(async () => {
    await exec("docker", ["build", "-t", image, fileURLToPath(new URL("./fixtures/container-runner/", import.meta.url))], { timeout: 30000 });
  }, 35000);
  beforeEach(() => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-container-")));
    home = join(directory, "home"); workspace = join(directory, "workspace");
    mkdirSync(home); mkdirSync(workspace);
    database = openDatabase(join(directory, "hub.sqlite"));
    store = createDrizzleRunStore(database.db);
    const projectId = randomUUID(); taskId = randomUUID();
    database.db.insert(projects).values({ id: projectId, name: "Example", workspaceKey: "example", createdAt: new Date() }).run();
    database.db.insert(tasks).values({ id: taskId, projectId, instruction: "normal", requestKey: "first", createdAt: new Date() }).run();
  });
  afterEach(async () => {
    const stored = database.db.select().from(runs).get()?.execution;
    if (stored) identities.push(stored);
    database.close();
    for (const identity of identities.splice(0)) {
      await stopAndConfirmContainer(identity);
      await removeFinishedContainer(identity);
    }
    rmSync(directory, { recursive: true, force: true });
  });

  test("passes every allowed effort through the real container protocol", async () => {
    const selected = createDrizzleRunStore(database.db, undefined, { effortPolicy: parseEffortPolicy({}) });
    const projectId = database.db.select().from(tasks).get()!.projectId;
    try {
      for (const [instruction, effort] of [["effort-report", "medium"], ["effort-report 동시성", "high"], ["effort-report 여러 시스템의 복잡한 원인", "xhigh"]]) {
        const id = randomUUID(); database.db.insert(tasks).values({ id, projectId, instruction: instruction!, requestKey: id, createdAt: new Date() }).run();
        const result = await runTask({ taskId: id, model: "fixture", workspace, timeoutMs: 10000, signal: new AbortController().signal }, selected, createContainerExecutor(image, home));
        expect(result).toMatchObject({ status: "succeeded", errorCode: null, result: `applied effort: ${effort}`, terminationConfirmedAt: expect.any(Date) });
        expect(selected.findById(result.runId)?.steps[0]?.effort).toBe(effort);
      }
    } finally { for (const row of database.db.select().from(runs).all()) if (row.execution) identities.push(row.execution); }
  }, 20000);

  test("acknowledges persisted workflow steps before the child starts each next call", async () => {
    database.client.prepare("UPDATE tasks SET instruction = 'workflow-protocol 보안 검토'").run();
    store = createDrizzleRunStore(database.db, undefined, { effortPolicy: parseEffortPolicy({}), analysisWorkflow: parseAnalysisWorkflow({}) });
    const result = await runTask({ taskId, model: "fixture", workspace, timeoutMs: 10000, signal: new AbortController().signal }, store, createContainerExecutor(image, home));
    expect(result).toMatchObject({ status: "succeeded", terminationConfirmedAt: expect.any(Date) });
    expect(readFileSync(join(home, "calls"), "utf8")).toBe("123");
    expect(store.findById(result.runId)!.steps.map(step => [step.effort, step.sessionId, step.usage?.inputTokens])).toEqual([
      ["high", "fixture-1", 1], ["xhigh", "fixture-2", 2], ["medium", "fixture-3", 3],
    ]);
  }, 15000);

  test("does not acknowledge a failed step write or allow the child to start its next call", async () => {
    database.client.prepare("UPDATE tasks SET instruction = 'workflow-protocol'").run();
    database.client.exec("CREATE TRIGGER fail_next_step BEFORE INSERT ON steps WHEN NEW.sequence = 2 BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    store = createDrizzleRunStore(database.db, undefined, { effortPolicy: parseEffortPolicy({}), analysisWorkflow: parseAnalysisWorkflow({}) });
    const result = await runTask({ taskId, model: "fixture", workspace, timeoutMs: 10000, signal: new AbortController().signal }, store, createContainerExecutor(image, home));
    expect(result).toMatchObject({ status: "interrupted", terminationConfirmedAt: expect.any(Date) });
    expect(readFileSync(join(home, "calls"), "utf8")).toBe("1");
    expect(store.findById(result.runId)!.steps).toHaveLength(1);
  }, 15000);

  test("stops at a persisted budget refusal without acknowledging the next container call", async () => {
    const projectId = database.db.select().from(tasks).get()!.projectId;
    createProjectBudgetStore(database.db).change(projectId, 0, { windowMs: 600000, maxCalls: 1, maxRunMs: 60000 });
    database.client.prepare("UPDATE tasks SET instruction = 'workflow-protocol'").run();
    store = createDrizzleRunStore(database.db, undefined, { analysisWorkflow: parseAnalysisWorkflow({}) });
    const result = await runTask({ taskId, model: "fixture", workspace, timeoutMs: 10000, signal: new AbortController().signal }, store, createContainerExecutor(image, home));
    expect(result).toMatchObject({ status: "waiting_capacity", errorCode: "budget_limit", terminationConfirmedAt: expect.any(Date) });
    expect(readFileSync(join(home, "calls"), "utf8")).toBe("1");
    expect(store.findById(result.runId)!.steps).toMatchObject([{ sequence: 1, status: "succeeded" }]);
    expect(database.db.select().from(tasks).get()?.budgetWait).toMatchObject({ scope: "project", reason: "call_limit" });
    expect(store.getProviderGate().blocked).toBe(false);
  }, 15000);

  test("records termination only after detached descendants stop, then removes the container", async () => {
    const outcome = await runTask({ taskId, model: "fixture", workspace, timeoutMs: 10000, signal: new AbortController().signal }, store, createContainerExecutor(image, home));
    expect(outcome.status).toBe("succeeded");
    const run = database.db.select().from(runs).get()!;
    expect(run.terminationConfirmedAt).toBeInstanceOf(Date);
    expect(run.execution?.containerId).toMatch(/^[a-f0-9]{64}$/);
    const heartbeat = readFileSync(join(home, "heartbeat"), "utf8");
    await delay(150);
    expect(readFileSync(join(home, "heartbeat"), "utf8")).toBe(heartbeat);
    await expect(exec("docker", ["inspect", run.execution!.containerId])).rejects.toThrow();
  }, 15000);

  test("retires an unstarted container so a delayed start cannot run after confirmation", async () => {
    const identity = await prepareContainer(image, home, { runId: randomUUID(), instruction: "wait", model: "fixture", workspace, signal: new AbortController().signal });
    identities.push(identity);
    expect(await stopAndConfirmContainer(identity)).toBeInstanceOf(Date);
    await expect(exec("docker", ["start", identity.containerId])).rejects.toThrow();
    expect(await stopAndConfirmContainer(identity)).toBeNull();
  }, 15000);

  test("a missing image is a configuration failure before any execution starts", async () => {
    const outcome = await runTask({ taskId, model: "fixture", workspace, timeoutMs: 10000, signal: new AbortController().signal }, store,
      createContainerExecutor(`agent-hub-missing:${randomUUID()}`, home));
    expect(outcome).toMatchObject({ status: "blocked", errorCode: "unsupported_settings", terminationConfirmedAt: expect.any(Date) });
    expect(database.db.select().from(runs).get()?.execution).toBeNull();
  }, 15000);

  test("stops SIGTERM-resistant commands on cancellation and persists the proof", async () => {
    database.client.prepare("UPDATE tasks SET instruction = 'wait'").run();
    const controller = new AbortController();
    const originalRecord = store.record;
    store.record = (id, event) => { originalRecord(id, event); if (event.kind === "fixture.ready") controller.abort("user_cancel"); };
    const result = await runTask({ taskId, model: "fixture", workspace, timeoutMs: 10000, signal: controller.signal }, store, createContainerExecutor(image, home));
    expect(result.status).toBe("cancelled");
    expect(store.findById(result.runId)).toMatchObject({ stopReason: "user_cancel", terminationConfirmedAt: expect.any(Date) });
    const heartbeat = readFileSync(join(home, "heartbeat"), "utf8");
    await delay(150);
    expect(readFileSync(join(home, "heartbeat"), "utf8")).toBe(heartbeat);
  }, 15000);

  test("invalid output cannot become success even when all commands terminate", async () => {
    database.client.prepare("UPDATE tasks SET instruction = 'malformed'").run();
    const result = await runTask({ taskId, model: "fixture", workspace, timeoutMs: 10000, signal: new AbortController().signal }, store, createContainerExecutor(image, home));
    expect(result).toMatchObject({ status: "interrupted", terminationConfirmedAt: expect.any(Date), result: null });
  }, 15000);

  test("transfers a provider retry time from the runner to durable gate storage", async () => {
    database.client.prepare("UPDATE tasks SET instruction = 'capacity'").run();
    const result = await runTask({ taskId, model: "fixture", workspace, timeoutMs: 10000, signal: new AbortController().signal }, store, createContainerExecutor(image, home));
    expect(result).toMatchObject({ status: "waiting_capacity", terminationConfirmedAt: expect.any(Date) });
    expect(store.getProviderGate()).toMatchObject({ blocked: true, reason: "capacity", retryAt: new Date("2030-01-01T00:00:00Z") });
  }, 15000);

  test("recovers observation after host SIGKILL without trusting a mismatched token or engine", async () => {
    const host = fork(fileURLToPath(new URL("./fixtures/execution-host.ts", import.meta.url)), [image, home, workspace, randomUUID()], {
      execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    try {
      const identity = await new Promise<ExecutionIdentity>((resolve, reject) => {
        let prepared: ExecutionIdentity | undefined;
        const deadline = setTimeout(() => reject(new Error("Fixture host did not start")), 5000);
        host.on("message", (event: AnalysisEvent) => {
          if (event.execution) { prepared = event.execution; identities.push(prepared); }
          if (event.kind === "fixture.ready" && prepared) { clearTimeout(deadline); resolve(prepared); }
        });
        host.once("error", reject);
      });
      const exited = once(host, "exit");
      host.kill("SIGKILL"); await exited;
      expect((await exec("docker", ["inspect", "--format", "{{.State.Running}}", identity.containerId])).stdout.trim()).toBe("true");
      expect(await stopAndConfirmContainer({ ...identity, token: randomUUID() })).toBeNull();
      expect(await stopAndConfirmContainer({ ...identity, engineId: "different-engine" })).toBeNull();
      expect((await exec("docker", ["inspect", "--format", "{{.State.Running}}", identity.containerId])).stdout.trim()).toBe("true");
      expect(await stopAndConfirmContainer(identity)).toBeInstanceOf(Date);
      const heartbeat = readFileSync(join(home, "heartbeat"), "utf8");
      await delay(150);
      expect(readFileSync(join(home, "heartbeat"), "utf8")).toBe(heartbeat);
      await removeFinishedContainer(identity);
      expect(await stopAndConfirmContainer(identity)).toBeNull();
    } finally { host.kill("SIGKILL"); }
  }, 15000);

  test("automatically retries a transient runner error after confirmed container termination", async () => {
    database.client.exec("UPDATE tasks SET instruction = 'transient-once'");
    writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
    const configPath = join(directory, "execution.json");
    writeFileSync(configPath, JSON.stringify({ model: "fixture", codexHome: home, containerImage: image, workspaces: { example: workspace }, automaticRecovery: { initialDelayMs: 1000, jitterRatio: 0 } }));
    const server = buildApp({ databasePath: join(directory, "hub.sqlite"), execution: { config: loadExecutionConfig(configPath), pollIntervalMs: 5 } });
    try {
      await server.listen({ host: "127.0.0.1", port: 0 });
      await vi.waitFor(() => expect(store.listByTask(taskId)).toMatchObject([{ attempt: 2, status: "succeeded" }, { attempt: 1, status: "failed" }]), { timeout: 10000 });
      const first = store.findById(store.listByTask(taskId)[1]!.id)!;
      expect(first).toMatchObject({ errorCode: "transient", terminationConfirmedAt: expect.any(Date) });
      expect((await server.inject({ method: "GET", url: `/tasks/${taskId}` })).json().retryState.retries).toBe(1);
    } finally {
      await server.close();
      for (const row of database.db.select().from(runs).all()) if (row.execution) identities.push(row.execution);
    }
  }, 15000);

  test.each(["manual", "automatic"] as const)("%s recovery after server SIGKILL stops the old container before creating a replacement attempt", async (mode) => {
    database.client.exec("UPDATE tasks SET instruction = 'wait-once'");
    writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
    const configPath = join(directory, "execution.json");
    writeFileSync(configPath, JSON.stringify({ model: "fixture", codexHome: home, containerImage: image, workspaces: { example: workspace }, ...(mode === "automatic" ? { automaticRecovery: { initialDelayMs: 1000, jitterRatio: 0 } } : {}) }));
    const host = fork(fileURLToPath(new URL("./fixtures/execution-server.ts", import.meta.url)), [join(directory, "hub.sqlite"), configPath], {
      execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let server: ReturnType<typeof buildApp> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("Fixture server did not start")), 5000);
        host.on("message", (event: AnalysisEvent) => {
          if (event.execution) identities.push(event.execution);
          if (event.kind === "fixture.ready") { clearTimeout(deadline); resolve(); }
        });
        host.once("error", reject);
      });
      const original = database.db.select().from(runs).get()!;
      const exited = once(host, "exit"); host.kill("SIGKILL"); await exited;
      expect((await exec("docker", ["inspect", "--format", "{{.State.Running}}", original.execution!.containerId])).stdout.trim()).toBe("true");
      server = buildApp({ databasePath: join(directory, "hub.sqlite"), execution: { config: loadExecutionConfig(configPath), pollIntervalMs: 5 } });
      const base = await server.listen({ host: "127.0.0.1", port: 0 });
      if (mode === "manual") {
      expect((await server.inject({ method: "GET", url: "/execution" })).json()).toMatchObject({ state: "held", runId: original.id });
      const response = await fetch(`${base}/tasks/${taskId}/recovery-requests`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestKey: "resume-after-crash", runId: original.id, action: "resume" }),
      });
      expect(response.status).toBe(202);
      }
      await vi.waitFor(() => expect(store.listByTask(taskId)).toMatchObject([{ attempt: 2, status: "succeeded" }, { attempt: 1, status: "waiting_retry" }]), { timeout: 10000 });
      expect(store.findById(original.id)).toMatchObject({ errorCode: "owner_lost", terminationConfirmedAt: expect.any(Date) });
      if (mode === "automatic") {
        const view = (await server.inject({ method: "GET", url: `/tasks/${taskId}` })).json();
        expect(view.retryState).toMatchObject({ retries: 1, reason: null, nextAttemptAt: null });
        expect(view.retryState.totalRunMs).toBeGreaterThan(0);
        expect(store.listByTask(taskId)[0]!.startedAt.getTime()).toBeGreaterThan(store.findById(original.id)!.terminationConfirmedAt!.getTime());
      }
      expect(database.client.pragma("foreign_key_check")).toEqual([]);
      await expect(exec("docker", ["inspect", original.execution!.containerId])).rejects.toThrow();
    } finally {
      host.kill("SIGKILL");
      await server?.close();
      for (const row of database.db.select().from(runs).all()) if (row.execution) identities.push(row.execution);
    }
  }, 20000);
});
