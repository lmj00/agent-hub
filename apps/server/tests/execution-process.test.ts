import { readExecutions } from "../src/modules/execution/execution-record-store.js";
import { createDrizzleServiceStore } from "../src/modules/services/drizzle-service-store.js";
import { parseEffortPolicy } from "../src/modules/execution/effort-policy.js";
import { parseAnalysisWorkflow } from "../src/modules/execution/analysis-workflow.js";
import { execFile, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { projects, runs, steps, tasks } from "../src/db/schema.js";
import { createDrizzleRunStore } from "../src/modules/execution/drizzle-run-store.js";
import { runTask } from "../src/modules/execution/run-task.js";
import { loadExecutionConfig } from "../src/modules/execution/execution-config.js";
import { createProjectBudgetStore } from "../src/modules/budgets/project-budget-store.js";
import { createDrizzleGoalStore } from "../src/modules/goals/drizzle-goal-store.js";
import { createPreparedExecutor, cleanupPreparedRun, verifyPreparedResult } from "../src/modules/goals/prepared-executor.js";
import { preparedInputRoot } from "../src/modules/goals/prepared-workspace.js";
import { createPlanningStore } from "../src/modules/goals/planning-store.js";
import { createDrizzleRecoveryStore } from "../src/modules/execution/drizzle-recovery-store.js";
import { createRecoveryProcessor } from "../src/modules/execution/recover-task.js";

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
    for (const row of database.db.select().from(runs).all()) identities.push(...readExecutions(database.db, row.id).map(entry => entry.identity));
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
        const started = performance.now();
        const events: Array<{ kind: string; elapsedMs: number }> = [];
        const tracedStore: typeof selected = {
          ...selected,
          record(runId, event) {
            events.push({ kind: event.kind, elapsedMs: Math.round(performance.now() - started) });
            return selected.record(runId, event);
          },
        };
        const result = await runTask({ taskId: id, model: "fixture", workspace, timeoutMs: 10000, signal: new AbortController().signal }, tracedStore, createContainerExecutor(image, home));
        // Keep the deadline and assertions intact; a CI failure should show whether
        // preparation, the fixture or termination was reached, without private IDs.
        expect(result, JSON.stringify({ effort, elapsedMs: Math.round(performance.now() - started), events })).toMatchObject({ status: "succeeded", errorCode: null, result: `applied effort: ${effort}`, terminationConfirmedAt: expect.any(Date) });
        expect(selected.findById(result.runId)?.steps[0]?.effort).toBe(effort);
      }
    } finally { for (const row of database.db.select().from(runs).all()) identities.push(...readExecutions(database.db, row.id).map(entry => entry.identity)); }
  }, 20000);

  test.each(["executor", "cli"])("%s mounts only prepared goal files read-only and ignores child-supplied input metadata", async mode => {
    const git = (...args: string[]) => exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: workspace, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    await git("init", "--quiet", "--template=");
    writeFileSync(join(workspace, "main.ts"), "allowed source\n"); writeFileSync(join(workspace, "excluded.txt"), "excluded fixture");
    await git("add", "--all"); await git("commit", "--quiet", "-m", "fixture");
    const projectId = database.db.select().from(tasks).get()!.projectId;
    const goal = createDrizzleGoalStore(database.db).register(projectId, "scope", { description: "Inspect", completionCriteria: "Verified", kind: "finite", priority: 50, allowedPaths: ["main.ts"], excludedPaths: [], checkIntervalMs: 60000, budget: { windowMs: 3600000, maxCalls: 20, maxRunMs: 1800000 } }).goal;
    database.client.prepare("UPDATE tasks SET instruction = 'scoped-report', goal_id = ?, goal_version = 1").run(goal.id);
    if (mode === "executor") {
      const executor = createPreparedExecutor(createContainerExecutor(image, home), preparedInputRoot(join(directory, "hub.sqlite")));
      expect(await runTask({ taskId, model: "fixture", workspace, timeoutMs: 10000, signal: new AbortController().signal }, store, executor)).toMatchObject({ status: "succeeded", result: "scoped files verified" });
    } else {
      writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
      const config = join(directory, "execution.json");
      writeFileSync(config, JSON.stringify({ model: "fixture", codexHome: home, containerImage: image, workspaces: { example: workspace } }));
      await exec(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/run-task-cli.ts", import.meta.url)), "--task", taskId, "--config", config], { env: { ...process.env, DATABASE_PATH: join(directory, "hub.sqlite") }, timeout: 15000 });
    }
    const stored = database.db.select().from(runs).get()!;
    expect(stored).toMatchObject({ status: "succeeded", result: "scoped files verified", terminationConfirmedAt: expect.any(Date), preparedInput: { phase: "ready", source: workspace, scope: { goalId: goal.id } } });
    expect(stored.preparedInput!.id).not.toBe("forged");
    expect(existsSync(stored.preparedInput!.directory)).toBe(false);
    expect(readFileSync(join(workspace, "main.ts"), "utf8")).toBe("allowed source\n");
  }, 20000);

  test.each([false, true])("applies a structured container plan exactly once; completion write fails=%s", async failWrite => {
    const git = (...args: string[]) => exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: workspace, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    await git("init", "--quiet", "--template="); writeFileSync(join(workspace, "main.ts"), "fixture source\n"); await git("add", "--all"); await git("commit", "--quiet", "-m", "fixture");
    const projectId = database.db.select().from(tasks).get()!.projectId;
    createDrizzleGoalStore(database.db).register(projectId, "plan-goal", { description: "Improve fixture", completionCriteria: "Verified", kind: "finite", priority: 50, allowedPaths: ["main.ts"], excludedPaths: [], checkIntervalMs: 60000, budget: { windowMs: 3600000, maxCalls: 20, maxRunMs: 1800000 } });
    const plan = createPlanningStore(database.db).reserveNext(["example"])!;
    const root = preparedInputRoot(join(directory, "hub.sqlite"));
    const serviceStore = createDrizzleServiceStore(database.db);
    const target = { key: "planning-fixture", projectId, name: "Planning fixture service", fingerprint: "fixture", url: "http://127.0.0.1:4321/unused", intervalMs: 1000, timeoutMs: 1000, staleAfterMs: 60000, allowWaiting: true, activityTimeoutMs: null };
    serviceStore.configure([target]);
    serviceStore.save(target, { receivedAt: new Date(), success: true, errorCode: null, snapshot: { observedAt: new Date().toISOString(), processState: "running", activityState: "waiting", lastSuccessAt: null, nextExpectedAt: null, errorCount: 0, summary: "container planning evidence" } });
    store = createDrizzleRunStore(database.db, undefined, { analysisWorkflow: parseAnalysisWorkflow({}) }, { getObserverStatus: () => ({ enabledKeys: new Set([target.key]), errors: new Set(), nextChecks: new Map() }) });
    if (failWrite) database.client.exec("CREATE TRIGGER fail_plan_apply BEFORE INSERT ON tasks WHEN NEW.planned_work IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    const pending = runTask({ taskId: plan.taskId, model: "fixture", workspace, timeoutMs: 10000, signal: new AbortController().signal }, store, createPreparedExecutor(createContainerExecutor(image, home), root));
    if (failWrite) {
      await expect(pending).rejects.toThrow("injected failure");
      const run = database.db.select().from(runs).get()!;
      expect(run.planResult?.status).toBe("proposed");
      expect(database.client.prepare("SELECT count(*) AS count FROM tasks WHERE planned_work IS NOT NULL").get()).toEqual({ count: 0 });
      database.client.exec("DROP TRIGGER fail_plan_apply");
      const recovery = createDrizzleRecoveryStore(database.db);
      const request = recovery.request({ taskId: plan.taskId, runId: run.id, requestKey: "plan-recovery", action: "reconcile", providerGateVersion: null }, null, true).request;
      const processor = createRecoveryProcessor(recovery, { confirm: stopAndConfirmContainer, cleanup: removeFinishedContainer }, id => cleanupPreparedRun(database.db, root, id), id => verifyPreparedResult(database.db, id));
      await processor.process(request.id); await processor.process(request.id);
    } else expect((await pending).status).toBe("succeeded");
    const run = database.db.select().from(runs).get()!;
    expect(run).toMatchObject({ status: "succeeded", terminationConfirmedAt: expect.any(Date), planResult: { status: "applied", createdTaskIds: [expect.any(String)] } });
    expect(run.planResult!.proposal).not.toBe("forged");
    expect(run.planningInput).toMatchObject({ version: 1, capturedAt: expect.any(String), services: [{ state: "waiting", latest: { snapshot: { summary: "container planning evidence" } } }], inputDigest: run.preparedInput!.digest });
    expect(run.planningInput!.capturedAt).not.toBe("forged");
    expect(database.client.prepare("SELECT count(*) AS count FROM tasks WHERE planned_work IS NOT NULL").get()).toEqual({ count: 1 });
    expect(existsSync(run.preparedInput!.directory)).toBe(false);
    expect(readFileSync(join(workspace, "main.ts"), "utf8")).toBe("fixture source\n");
  }, 20000);

  test("refuses child workflow events when steps are owned by the parent", async () => {
    database.client.prepare("UPDATE tasks SET instruction = 'workflow-protocol'").run();
    const result = await runTask({ taskId, model: "fixture", workspace, timeoutMs: 10000, signal: new AbortController().signal }, store, createContainerExecutor(image, home));
    expect(result).toMatchObject({ status: "interrupted", terminationConfirmedAt: expect.any(Date) });
    expect(existsSync(join(home, "calls"))).toBe(false);
    expect(store.findById(result.runId)!.steps).toMatchObject([{ purpose: null, assessment: null }]);
  }, 15000);

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
    expect(readExecutions(database.db, run.id)[0]?.identity.containerId).toMatch(/^[a-f0-9]{64}$/);
    const heartbeat = readFileSync(join(home, "heartbeat"), "utf8");
    await delay(150);
    expect(readFileSync(join(home, "heartbeat"), "utf8")).toBe(heartbeat);
    await expect(exec("docker", ["inspect", readExecutions(database.db, run.id)[0]!.identity.containerId])).rejects.toThrow();
  }, 15000);

  test.each(["result", "log", "sequence", "digest", "role", "selected", "duplicate"])("rejects the child's %s skill evidence before granting a call", async mode => {
    database.client.prepare("UPDATE tasks SET instruction = ?").run(`bad-skill:${mode}`);
    const result = await runTask({ taskId, model: "fixture", workspace, timeoutMs: 10000, signal: new AbortController().signal }, store, createContainerExecutor(image, home));
    expect(result.status).not.toBe("succeeded");
    expect(result.terminationConfirmedAt).toBeInstanceOf(Date);
    expect(existsSync(join(home, "skill-calls"))).toBe(false);
    const step = database.db.select().from(steps).get()!;
    expect(step.runtimeSkill?.role).toBe("analyst");
    expect(step.runtimeSkillLoadedAt).toEqual(mode === "duplicate" ? expect.any(Date) : null);
  }, 15000);

  test.each(["save-failed", "cancelled"])("withholds the child load ACK when %s", async mode => {
    database.client.prepare("UPDATE tasks SET instruction = 'skill-call'").run();
    const controller = new AbortController();
    const selected: typeof store = { ...store, record(runId, event) {
      if (event.runtimeSkill?.type === "loaded" && mode === "save-failed") throw new Error("Fixture store failure");
      store.record(runId, event);
      if (event.runtimeSkill?.type === "loaded" && mode === "cancelled") controller.abort();
    } };
    const result = await runTask({ taskId, model: "fixture", workspace, timeoutMs: 10000, signal: controller.signal }, selected, createContainerExecutor(image, home));
    expect(result.status).not.toBe("succeeded");
    expect(result.terminationConfirmedAt).toBeInstanceOf(Date);
    expect(existsSync(join(home, "skill-calls"))).toBe(false);
  }, 15000);

  test("keeps both sequential container identities and waits for saved termination before the next phase", async () => {
    const executor = createContainerExecutor(image, home);
    const selected = createDrizzleRunStore(database.db, undefined, { analysisWorkflow: parseAnalysisWorkflow({ maxSteps: 2 }) });
    const result = await runTask({ taskId, model: "fixture", workspace, timeoutMs: 15000, signal: new AbortController().signal }, selected, {
      ...executor,
      async analyze(request, onEvent) {
        await onEvent({ kind: "step.started", step: { type: "start", sequence: 1 } });
        const { workflow: _workflow, ...call } = request;
        await executor.analyze({ ...call, instruction: "forged-termination" }, async event => {
          if (event.kind === "development.candidate.ready") expect(event.development).toBeUndefined();
          await onEvent(event);
          if (event.kind === "execution.terminated" && !event.executionTermination) expect(readExecutions(database.db, request.runId!)[0]?.terminationConfirmedAt).toBeNull();
        });

        const first = readExecutions(database.db, request.runId!)[0]!;
        expect(first.terminationConfirmedAt).toBeInstanceOf(Date);
        expect((await exec("docker", ["inspect", "--format", "{{.State.Running}}", first.identity.containerId])).stdout.trim()).toBe("false");
        await onEvent({ kind: "step.completed", step: { type: "complete", sequence: 1, assessment: { report: "First phase", evidence: ["fixture"], unresolved: ["Next phase"], complete: false, next: { purpose: "Next phase", effort: "medium", reason: "Check sequential execution" } }, usage: null } });
        await onEvent({ kind: "step.started", step: { type: "start", sequence: 2 } });
        const second = await executor.analyze({ ...call, stepSequence: 2 }, onEvent);
        await onEvent({ kind: "step.completed", step: { type: "complete", sequence: 2, assessment: { report: second.output, evidence: ["fixture"], unresolved: [], complete: true, next: null }, usage: null } });
        return second;
      },
    });
    expect(result.status).toBe("succeeded");
    const records = readExecutions(database.db, result.runId);
    expect(records).toHaveLength(2);
    expect(records[0]!.identity.containerId).not.toBe(records[1]!.identity.containerId);
    expect(records[0]!.terminationConfirmedAt!.getTime()).toBeLessThanOrEqual(records[1]!.createdAt.getTime());
    for (const record of records) {
      expect(record.terminationConfirmedAt).toBeInstanceOf(Date);
      await expect(exec("docker", ["inspect", record.identity.containerId])).rejects.toThrow();
    }
  }, 20000);

  test.each(["save", "reject", "stop"])("waits for an asynchronous prepared acknowledgement: %s", async action => {
    const executor = createContainerExecutor(image, home);
    const run = store.claim(taskId, "fixture");
    const gate = Promise.withResolvers<void>();
    let prepared: ExecutionIdentity | undefined;
    const result = executor.analyze({ runId: run.id, model: "fixture", instruction: "normal", workspace, signal: new AbortController().signal }, async event => {
      if (event.execution) {
        prepared = event.execution; identities.push(prepared);
        await gate.promise;
      }
      store.record(run.id, event);
    }).then(value => ({ value }), error => ({ error }));
    try {
      await expect.poll(() => prepared, { timeout: 5000 }).toBeDefined();
      expect((await exec("docker", ["inspect", "--format", "{{.State.Status}}", prepared!.containerId])).stdout.trim()).toBe("created");
      expect(existsSync(join(home, "heartbeat"))).toBe(false);
      if (action === "stop") {
        const proofs = await Promise.all([executor.confirmTermination!(run.id), executor.confirmTermination!(run.id)]);
        expect(proofs).toEqual([expect.any(Date), expect.any(Date)]);
        expect(proofs[0]).toEqual(proofs[1]);
      }
      if (action === "reject") gate.reject(new Error("fixture storage failure")); else gate.resolve();
      const completed = await result;
      if (action === "save") expect(completed).toMatchObject({ value: { output: "fixture report" } });
      else {
        expect(completed).toMatchObject({ error: expect.any(Error) });
        expect(existsSync(join(home, "heartbeat"))).toBe(false);
      }
      const confirmedAt = await executor.confirmTermination!(run.id);
      expect(confirmedAt).toBeInstanceOf(Date);
      store.finish(run.id, { status: action === "save" ? "succeeded" : "blocked", result: null, errorCode: null, usage: null, terminationConfirmedAt: confirmedAt });
      await executor.cleanup!(run.id);
    } finally { gate.resolve(); await result; }
  }, 15000);

  test("does not allocate a concurrent phase while the first container is waiting for persistence", async () => {
    const executor = createContainerExecutor(image, home);
    const gate = Promise.withResolvers<void>();
    const request = { runId: randomUUID(), model: "fixture", instruction: "normal", workspace, signal: new AbortController().signal };
    let prepared: ExecutionIdentity | undefined;
    const first = executor.analyze(request, async event => {
      if (event.execution) { prepared = event.execution; identities.push(prepared); await gate.promise; }
    }).catch(error => error);
    try {
      await expect.poll(() => prepared, { timeout: 5000 }).toBeDefined();
      await expect(executor.analyze(request, () => {})).rejects.toThrow("Previous execution must be confirmed");
      expect(existsSync(join(home, "heartbeat"))).toBe(false);
      expect(await executor.confirmTermination!(request.runId)).toBeInstanceOf(Date);
      gate.resolve(); expect(await first).toBeInstanceOf(Error);
      await executor.cleanup!(request.runId);
    } finally { gate.resolve(); await first; }
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
    expect(readExecutions(database.db, outcome.runId)).toEqual([]);
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

  test.each(["executor", "cli"])("%s observes a durable scope reduction during a quiet container call and stops its descendants", async mode => {
    const git = (...args: string[]) => exec("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: workspace, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    await git("init", "--quiet", "--template="); writeFileSync(join(workspace, "main.ts"), "fixture source\n"); await git("add", "--all"); await git("commit", "--quiet", "-m", "fixture");
    const projectId = database.db.select().from(tasks).get()!.projectId;
    const goalStore = createDrizzleGoalStore(database.db);
    const goal = goalStore.register(projectId, "scope-stop", { description: "Inspect", completionCriteria: "Verified", kind: "finite", priority: 50, allowedPaths: ["."], excludedPaths: [], checkIntervalMs: 60000, budget: { windowMs: 3600000, maxCalls: 20, maxRunMs: 1800000 } }).goal;
    database.client.prepare("UPDATE tasks SET instruction = 'wait', goal_id = ?, goal_version = 1").run(goal.id);
    const root = preparedInputRoot(join(directory, "hub.sqlite"));
    const start = () => {
      if (mode === "executor") return runTask({ taskId, model: "fixture", workspace, timeoutMs: 15000, signal: new AbortController().signal }, store, createPreparedExecutor(createContainerExecutor(image, home), root));
      writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
      const config = join(directory, "execution.json"); writeFileSync(config, JSON.stringify({ model: "fixture", codexHome: home, containerImage: image, workspaces: { example: workspace } }));
      return exec(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/run-task-cli.ts", import.meta.url)), "--task", taskId, "--config", config], { env: { ...process.env, DATABASE_PATH: join(directory, "hub.sqlite") }, timeout: 18000 }).then(() => ({ exitCode: 0 }), error => ({ exitCode: error.code }));
    };
    const pending = start();
    await vi.waitFor(() => expect(database.client.prepare("SELECT kind FROM events WHERE kind = 'fixture.ready'").get()).toBeDefined(), { timeout: 10000 });
    goalStore.change(goal.id, "reduce", 1, { definition: { ...goal.definition, allowedPaths: ["tests"] } });
    const result = await pending;
    expect(result).toMatchObject(mode === "executor" ? { status: "cancelled", errorCode: "scope_changed" } : { exitCode: 1 });
    const run = database.db.select().from(runs).get()!;
    expect(run).toMatchObject({ status: "cancelled", stopReason: "scope_changed", result: null, terminationConfirmedAt: expect.any(Date) });
    expect(database.db.select().from(tasks).get()?.cancelRequestedAt).toBeNull();
    expect(goalStore.findById(goal.id).status).toBe("active");
    expect(existsSync(run.preparedInput!.directory)).toBe(false);
    const heartbeat = readFileSync(join(home, "heartbeat"), "utf8"); await delay(150); expect(readFileSync(join(home, "heartbeat"), "utf8")).toBe(heartbeat);
    expect(readFileSync(join(workspace, "main.ts"), "utf8")).toBe("fixture source\n");
  }, 22000);

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
      for (const row of database.db.select().from(runs).all()) identities.push(...readExecutions(database.db, row.id).map(entry => entry.identity));
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
      expect((await exec("docker", ["inspect", "--format", "{{.State.Running}}", readExecutions(database.db, original.id)[0]!.identity.containerId])).stdout.trim()).toBe("true");
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
      await expect(exec("docker", ["inspect", readExecutions(database.db, original.id)[0]!.identity.containerId])).rejects.toThrow();
    } finally {
      host.kill("SIGKILL");
      await server?.close();
      for (const row of database.db.select().from(runs).all()) identities.push(...readExecutions(database.db, row.id).map(entry => entry.identity));
    }
  }, 20000);
});
