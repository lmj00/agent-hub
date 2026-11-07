import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildApp } from "../../src/app.js";
import { openDatabase } from "../../src/db/connection.js";
import { projects, tasks } from "../../src/db/schema.js";
import type { AnalysisExecutor } from "../../src/modules/execution/analysis.js";
import { createDrizzleRunStore } from "../../src/modules/execution/drizzle-run-store.js";
import { loadExecutionConfig } from "../../src/modules/execution/execution-config.js";
import type { ExecutionObserver } from "../../src/modules/execution/recover-task.js";

let directory: string;
let databasePath: string;
let database: ReturnType<typeof openDatabase>;
let config: ReturnType<typeof loadExecutionConfig>;
let projectId: string;
const apps: ReturnType<typeof buildApp>[] = [];
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-recovery-api-")));
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
  for (const app of apps.splice(0).reverse()) await app.close();
  database.close();
  rmSync(directory, { recursive: true, force: true });
});
const success: AnalysisExecutor = {
  analyze: async () => ({ output: "Report", usage: null }),
  confirmTermination: async () => new Date(),
};
function app(executor = success, observer?: ExecutionObserver) {
  const instance = buildApp({
    databasePath,
    execution: { config, executor, ...(observer ? { observer } : {}), pollIntervalMs: 5 },
  });
  apps.push(instance);
  return instance;
}
function task(instruction = "Analyze", createdAt = new Date()) {
  const id = randomUUID();
  database.db.insert(tasks).values({ id, projectId, instruction, requestKey: id, createdAt }).run();
  return id;
}
function status(id: string) {
  return database.db.select().from(tasks).where(eq(tasks.id, id)).get()?.status;
}
function lostRun() {
  const store = createDrizzleRunStore(database.db);
  const run = store.claim(task(), "fixture");
  store.record(run.id, {
    kind: "execution.prepared",
    execution: {
      kind: "docker",
      containerId: "a".repeat(64),
      engineId: "fixture",
      token: randomUUID(),
    },
  });
  return run;
}
function post(base: string, taskId: string, payload: object) {
  return fetch(`${base}/tasks/${taskId}/recovery-requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

test("HTTP remains responsive during termination observation and duplicate requests produce one replacement", async () => {
  const run = lostRun();
  const observed = Promise.withResolvers<Date | null>();
  const analyze = vi.fn(success.analyze);
  const server = app(
    { ...success, analyze },
    { confirm: () => observed.promise, cleanup: async () => {} },
  );
  const base = await server.listen({ host: "127.0.0.1", port: 0 });
  try {
    const payload = { requestKey: "resume", runId: run.id, action: "resume" };
    const [first, duplicate] = await Promise.all([
      post(base, run.taskId, payload),
      post(base, run.taskId, payload),
    ]);
    expect([first.status, duplicate.status].sort()).toEqual([200, 202]);
    const receipt = (await first.json()) as { id: string };
    expect(await duplicate.json()).toMatchObject({ id: receipt.id });
    expect(first.headers.get("location")).toBe(`/recovery-requests/${receipt.id}`);
    await vi.waitFor(async () =>
      expect(await (await fetch(`${base}/execution`)).json()).toMatchObject({
        state: "recovering",
        runId: run.id,
      }),
    );
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    expect(await (await fetch(`${base}/recovery-requests/${receipt.id}`)).json()).toMatchObject({
      status: "pending",
    });
    expect(analyze).not.toHaveBeenCalled();
    observed.resolve(new Date());
    await vi.waitFor(() => expect(status(run.taskId)).toBe("succeeded"));
    expect(analyze).toHaveBeenCalledOnce();
    const attempts = (await (await fetch(`${base}/tasks/${run.taskId}/runs`)).json()) as {
      runs: { attempt: number }[];
    };
    expect(attempts.runs.map((row) => row.attempt)).toEqual([2, 1]);
    expect(await (await post(base, run.taskId, payload)).json()).toMatchObject({
      id: receipt.id,
      status: "completed",
      resultStatus: "queued",
    });
    expect((await post(base, run.taskId, { ...payload, requestKey: "stale" })).status).toBe(409);
  } finally {
    observed.resolve(new Date());
  }
});

test("cancelling the active run persists intent before signalling and the next task still executes", async () => {
  const first = task("Wait", new Date(1));
  const second = task("Next", new Date(2));
  let persistedAtAbort = false;
  const analyze = vi.fn<AnalysisExecutor["analyze"]>(async (request) => {
    if (request.instruction === "Wait")
      return new Promise((_resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => {
            persistedAtAbort =
              database.db.select().from(tasks).where(eq(tasks.id, first)).get()
                ?.cancelRequestedAt instanceof Date;
            reject(new Error("Stopped"));
          },
          { once: true },
        );
      });
    return { output: "Next report", usage: null };
  });
  const server = app({ ...success, analyze });
  const base = await server.listen({ host: "127.0.0.1", port: 0 });
  await vi.waitFor(() => expect(status(first)).toBe("running"));
  const run = createDrizzleRunStore(database.db).listByTask(first)[0]!;
  const activeResume = await post(base, first, {
    requestKey: "resume",
    runId: run.id,
    action: "resume",
  });
  expect(await activeResume.json()).toMatchObject({ error: "RUN_ACTIVE" });
  const cancel = await post(base, first, { requestKey: "cancel", runId: run.id, action: "cancel" });
  expect(cancel.status).toBe(202);
  const receipt = (await cancel.json()) as { id: string };
  await vi.waitFor(() => expect(status(second)).toBe("succeeded"));
  expect(persistedAtAbort).toBe(true);
  expect(status(first)).toBe("cancelled");
  expect(analyze).toHaveBeenCalledTimes(2);
  expect(await (await fetch(`${base}/recovery-requests/${receipt.id}`)).json()).toMatchObject({
    status: "completed",
    resultStatus: "cancelled",
  });
  expect(
    (await post(base, first, { requestKey: "cancel", runId: run.id, action: "cancel" })).status,
  ).toBe(200);
});

test("pending recovery survives a server restart and is completed before new assignment", async () => {
  const run = lostRun();
  const first = app();
  const accepted = await first.inject({
    method: "POST",
    url: `/tasks/${run.taskId}/recovery-requests`,
    payload: { requestKey: "resume", runId: run.id, action: "resume" },
  });
  expect(accepted.statusCode).toBe(202);
  expect(accepted.json().status).toBe("pending");
  await first.close();
  apps.splice(apps.indexOf(first), 1);
  const analyze = vi.fn(success.analyze);
  const confirm = vi.fn(async () => new Date());
  const second = app({ ...success, analyze }, { confirm, cleanup: async () => {} });
  await second.listen({ host: "127.0.0.1", port: 0 });
  await vi.waitFor(() => expect(status(run.taskId)).toBe("succeeded"));
  expect(confirm).toHaveBeenCalledOnce();
  expect(analyze).toHaveBeenCalledOnce();
  const response = await second.inject({ method: "GET", url: accepted.headers.location! });
  expect(response.json()).toMatchObject({ status: "completed", resultStatus: "queued" });
});

test("cancellation during HTTP recovery prevents replacement even when observation finishes later", async () => {
  const run = lostRun();
  const observed = Promise.withResolvers<Date | null>();
  const analyze = vi.fn(success.analyze);
  const server = app(
    { ...success, analyze },
    { confirm: () => observed.promise, cleanup: async () => {} },
  );
  const base = await server.listen({ host: "127.0.0.1", port: 0 });
  try {
    const resume = await post(base, run.taskId, {
      requestKey: "resume",
      runId: run.id,
      action: "resume",
    });
    const receipt = (await resume.json()) as { id: string };
    await vi.waitFor(async () =>
      expect(await (await fetch(`${base}/execution`)).json()).toMatchObject({
        state: "recovering",
      }),
    );
    expect(
      (await post(base, run.taskId, { requestKey: "cancel", runId: run.id, action: "cancel" }))
        .status,
    ).toBe(202);
    observed.resolve(new Date());
    await vi.waitFor(() => expect(status(run.taskId)).toBe("cancelled"));
    expect(await (await fetch(`${base}/recovery-requests/${receipt.id}`)).json()).toMatchObject({
      status: "rejected",
      errorCode: "TASK_CANCELLED",
    });
    expect(analyze).not.toHaveBeenCalled();
    expect(createDrizzleRunStore(database.db).listByTask(run.taskId)).toHaveLength(1);
  } finally {
    observed.resolve(new Date());
  }
});

test("recovery HTTP validation rejects forged proof, malformed JSON and unsupported content types", async () => {
  const id = task();
  const server = app();
  const url = `/tasks/${id}/recovery-requests`;
  const valid = { requestKey: "cancel", runId: null, action: "cancel" };
  for (const payload of [
    { ...valid, terminationConfirmedAt: new Date().toISOString() },
    { ...valid, providerGateVersion: "1" },
    { ...valid, requestKey: "" },
    { ...valid, runId: "invalid" },
  ])
    expect((await server.inject({ method: "POST", url, payload })).statusCode).toBe(400);
  expect(
    (
      await server.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/json" },
        payload: "{",
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await server.inject({
        method: "POST",
        url,
        headers: { "content-type": "text/plain" },
        payload: JSON.stringify(valid),
      })
    ).statusCode,
  ).toBe(415);
  expect(
    (await server.inject({ method: "GET", url: `/recovery-requests/${randomUUID()}` })).statusCode,
  ).toBe(404);
  const accepted = await server.inject({ method: "POST", url, payload: valid });
  expect(accepted.statusCode).toBe(202);
  expect(accepted.json()).toMatchObject({ status: "completed", resultStatus: "cancelled" });
  expect(
    (await server.inject({ method: "POST", url, payload: { ...valid, action: "resume" } }))
      .statusCode,
  ).toBe(409);
});

test("a server without an execution owner exposes reads but cannot accept recovery writes", async () => {
  const server = buildApp({ databasePath });
  apps.push(server);
  const response = await server.inject({
    method: "POST",
    url: `/tasks/${task()}/recovery-requests`,
    payload: { requestKey: "cancel", runId: null, action: "cancel" },
  });
  expect(response.statusCode).toBe(503);
  expect(response.json().error).toBe("EXECUTION_DISABLED");
  expect(
    (await server.inject({ method: "GET", url: `/recovery-requests/${randomUUID()}` })).statusCode,
  ).toBe(404);
});
