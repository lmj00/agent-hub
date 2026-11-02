import { execFile, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { AnalysisEvent, ExecutionIdentity } from "../src/modules/execution/analysis.js";
import { createContainerExecutor } from "../src/modules/execution/execution-process.js";
import { prepareContainer, removeFinishedContainer, stopAndConfirmContainer } from "../src/modules/execution/container-runtime.js";
import { openDatabase } from "../src/db/connection.js";
import { projects, runs, tasks } from "../src/db/schema.js";
import { createDrizzleRunStore } from "../src/modules/execution/drizzle-run-store.js";
import { runTask } from "../src/modules/execution/run-task.js";

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
    directory = mkdtempSync(join(tmpdir(), "hub-container-"));
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
    expect(result.status).toBe("interrupted");
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
});
