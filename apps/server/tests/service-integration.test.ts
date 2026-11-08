import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { parseResponse, servicesSchema } from "@agent-hub/contracts";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db/connection.js";
import { projects, tasks } from "../src/db/schema.js";
import { loadServiceConfig, type ServiceConfig } from "../src/modules/services/service-config.js";
import { loadExecutionConfig } from "../src/modules/execution/execution-config.js";
import { createDrizzleRunStore } from "../src/modules/execution/drizzle-run-store.js";

let directory: string;
let databasePath: string;
let database: ReturnType<typeof openDatabase>;
let app: ReturnType<typeof buildApp> | undefined;
let source: Server;
let projectId: string;
let services: ServiceConfig;
let mode: "waiting" | "failure" | "pending";
let methods: string[];
let execution: ReturnType<typeof loadExecutionConfig>;
beforeEach(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-service-api-")));
  databasePath = join(directory, "hub.sqlite");
  database = openDatabase(databasePath);
  projectId = randomUUID();
  database.db
    .insert(projects)
    .values({
      id: projectId,
      name: "Observed project",
      workspaceKey: "example",
      createdAt: new Date(),
    })
    .run();
  mode = "waiting";
  methods = [];
  source = createServer((request, response) => {
    methods.push(request.method!);
    if (request.url === "/alive") {
      response.end("alive");
      return;
    }
    if (mode === "pending") return;
    if (mode === "failure") {
      response.writeHead(503);
      response.end("private upstream error");
      return;
    }
    const now = new Date().toISOString();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        observedAt: now,
        processState: "running",
        activityState: "waiting",
        lastSuccessAt: null,
        nextExpectedAt: null,
        errorCount: 0,
        summary: "No input",
      }),
    );
  });
  await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
  const file = join(directory, "services.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      targets: [
        {
          key: "service",
          projectId,
          name: "Observed service",
          url: `http://127.0.0.1:${(source.address() as AddressInfo).port}/status`,
          intervalMs: 1000,
        },
      ],
    }),
    { mode: 0o600 },
  );
  services = loadServiceConfig(file);
  mkdirSync(join(directory, "workspace"));
  mkdirSync(join(directory, "codex"));
  writeFileSync(join(directory, "codex/auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
  const executionFile = join(directory, "execution.json");
  writeFileSync(
    executionFile,
    JSON.stringify({
      model: "test-model",
      codexHome: "codex",
      workspaces: { example: "workspace" },
    }),
  );
  execution = loadExecutionConfig(executionFile);
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  source.closeAllConnections();
  await new Promise<void>((resolve) => source.close(() => resolve()));
  database.close();
  rmSync(directory, { recursive: true, force: true });
});
async function list() {
  const response = await app!.inject(`/projects/${projectId}/services`);
  expect(response.statusCode).toBe(200);
  expect(response.body).not.toContain(services.targets[0]!.url);
  return parseResponse(servicesSchema, response.json()).services[0]!;
}
function registerTask() {
  const id = randomUUID();
  database.db
    .insert(tasks)
    .values({
      id,
      projectId,
      instruction: "Fixture analysis",
      requestKey: randomUUID(),
      createdAt: new Date(),
    })
    .run();
  return id;
}

test("service query returns stored observations, a failed read keeps historical success, and restart without config disables observation", async () => {
  app = buildApp({ databasePath, services });
  await app.listen({ host: "127.0.0.1", port: 0 });
  await vi.waitFor(async () => expect((await list()).state).toBe("waiting"));
  mode = "failure";
  await vi.waitFor(async () => expect((await list()).state).toBe("unavailable"), { timeout: 3000 });
  expect(await list()).toMatchObject({
    latest: { success: false, errorCode: "http_error" },
    lastSuccessful: { success: true },
  });
  const count = methods.length;
  await list();
  await list();
  expect(methods).toHaveLength(count);
  await app.close();
  app = buildApp({ databasePath });
  await app.ready();
  expect(await list()).toMatchObject({
    enabled: false,
    state: "unknown",
    reason: "observer_disabled",
    lastSuccessful: { success: true },
  });
  expect((await app.inject(`/projects/${randomUUID()}/services`)).statusCode).toBe(404);
});
test("an unresolved AI run holds new execution while independent service observation continues", async () => {
  const taskId = registerTask();
  createDrizzleRunStore(database.db).claim(taskId, "test-model");
  const analyze = vi.fn();
  app = buildApp({
    databasePath,
    services,
    execution: { config: execution, executor: { analyze }, pollIntervalMs: 20 },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  await vi.waitFor(async () => expect((await list()).state).toBe("waiting"));
  expect((await app.inject("/execution")).json().state).toBe("held");
  expect(analyze).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(methods.length).toBeGreaterThan(1), {
    timeout: 3000,
  });
  expect(methods.every((method) => method === "GET")).toBe(true);
});
test("cancelling analysis leaves the observed service alive and its next observation still runs", async () => {
  const taskId = registerTask();
  app = buildApp({
    databasePath,
    services,
    execution: {
      config: execution,
      executor: {
        analyze: () => new Promise(() => {}),
        confirmTermination: async () => new Date(),
      },
      pollIntervalMs: 20,
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  await vi.waitFor(async () => expect((await list()).state).toBe("waiting"));
  const run = createDrizzleRunStore(database.db).listByTask(taskId)[0]!;
  const accepted = await app.inject({
    method: "POST",
    url: `/tasks/${taskId}/recovery-requests`,
    payload: {
      requestKey: "cancel-analysis-only",
      action: "cancel",
      runId: run.id,
    },
  });
  expect(accepted.statusCode).toBe(202);
  await vi.waitFor(() =>
    expect(createDrizzleRunStore(database.db).findById(run.id)?.status).toBe("cancelled"),
  );
  const count = methods.length;
  await vi.waitFor(() => expect(methods.length).toBeGreaterThan(count), {
    timeout: 3000,
  });
  expect(await (await fetch(services.targets[0]!.url.replace("/status", "/alive"))).text()).toBe(
    "alive",
  );
  expect((await list()).state).toBe("waiting");
  expect(methods.every((method) => method === "GET")).toBe(true);
});
test("a slow status endpoint does not hold API responses or prevent bounded shutdown", async () => {
  mode = "pending";
  app = buildApp({ databasePath, services });
  await app.listen({ host: "127.0.0.1", port: 0 });
  await vi.waitFor(() => expect(methods.length).toBe(1));
  const start = performance.now();
  expect((await app.inject("/health/live")).statusCode).toBe(200);
  expect((await list()).state).toBe("unknown");
  expect(performance.now() - start).toBeLessThan(1000);
  await app.close();
  app = undefined;
  expect(performance.now() - start).toBeLessThan(1500);
  expect(
    database.client.prepare("SELECT count(*) AS count FROM service_observations").get(),
  ).toEqual({ count: 0 });
});
test("service-only ownership prevents duplicate observers and initialization failure releases its ownership", async () => {
  app = buildApp({ databasePath, services });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const second = buildApp({ databasePath, services });
  await expect(second.ready()).rejects.toThrow("already owns");
  await second.close();
  await app.close();
  app = undefined;
  const invalid = buildApp({
    databasePath,
    services: {
      ...services,
      targets: [{ ...services.targets[0]!, projectId: randomUUID() }],
    },
  });
  await expect(invalid.ready()).rejects.toThrow("unknown project");
  await invalid.close();
  expect(database.client.prepare("SELECT count(*) AS count FROM execution_owner").get()).toEqual({
    count: 0,
  });
});
test("service credentials inside an analysis workspace are rejected before any execution or observation", async () => {
  const privatePath = join(execution.workspaces.get("example")!, "services.json");
  writeFileSync(privatePath, "private config", { mode: 0o600 });
  app = buildApp({
    databasePath,
    services: { ...services, sourcePath: privatePath },
    execution: { config: execution, executor: { analyze: vi.fn() } },
  });
  await expect(app.ready()).rejects.toThrow("Private server configuration");
  expect(methods).toEqual([]);
});
