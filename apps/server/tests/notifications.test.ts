import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { migrationsDirectory, openDatabase } from "../src/db/connection.js";
import {
  changeApplications,
  developmentRepositories,
  executionOwner,
  notifications,
  projects,
  providerGates,
  runs,
  tasks,
} from "../src/db/schema.js";
import { acquireExecutionOwner } from "../src/modules/execution/execution-owner.js";
import {
  createExecutionQueue,
  type QueueStatus,
} from "../src/modules/execution/execution-queue.js";
import { createDrizzleRunStore } from "../src/modules/execution/drizzle-run-store.js";
import { initialRetryState, defaultRetryPolicy } from "../src/modules/execution/retry-policy.js";
import { loadExecutionConfig } from "../src/modules/execution/execution-config.js";
import { providerScope } from "../src/modules/execution/provider-gate.js";
import { defaultCapacityPolicy } from "../src/modules/execution/capacity-policy.js";
import { readinessToken } from "../src/modules/auth/readiness-token.js";
import {
  loadNotificationConfig,
  type NotificationConfig,
} from "../src/modules/operations/notification-config.js";
import { deliverNotification } from "../src/modules/operations/notification-delivery.js";
import {
  createNotificationStore,
  listNotifications,
} from "../src/modules/operations/notification-store.js";
import { createNotificationWorker } from "../src/modules/operations/notification-worker.js";

let directory: string;
let path: string;
let database: ReturnType<typeof openDatabase>;
let owner: ReturnType<typeof acquireExecutionOwner>;
let config: NotificationConfig;
let projectId: string;
let queue: QueueStatus | undefined;
const servers: Server[] = [];
const cleanup: (() => Promise<unknown>)[] = [];
const time = (ms = 0) => new Date(1800000000000 + ms);

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-notifications-")));
  path = join(directory, "hub.sqlite");
  database = openDatabase(path);
  owner = acquireExecutionOwner(database.db);
  projectId = randomUUID();
  database.db
    .insert(projects)
    .values({
      id: projectId,
      name: "Private project title",
      workspaceKey: "example",
      createdAt: time(),
    })
    .run();
  queue = undefined;
  config = configFile();
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (database.client.open) {
    owner.release();
    database.close();
  }
  rmSync(directory, { recursive: true, force: true });
});
function configFile(input: Record<string, unknown> = {}) {
  const file = join(directory, "notifications.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      url: "https://example.invalid/receiver",
      graceMs: 1000,
      initialDelayMs: 1000,
      maxDelayMs: 2000,
      maxAttempts: 3,
      ...input,
    }),
    { mode: 0o600 },
  );
  return loadNotificationConfig(file);
}
function store(c = config) {
  return createNotificationStore(database.db, owner.token, c, () => queue);
}
function receipt(sourceKey?: string) {
  return sourceKey
    ? database.db.select().from(notifications).where(eq(notifications.sourceKey, sourceKey)).get()!
    : database.db.select().from(notifications).get()!;
}
function task(
  status: typeof tasks.$inferSelect.status = "failed",
  errorCode = "provider_error",
  confirmed = true,
) {
  const id = randomUUID();
  const runId = randomUUID();
  database.db
    .insert(tasks)
    .values({
      id,
      projectId,
      instruction: "Private model instruction",
      requestKey: id,
      status,
      createdAt: time(),
    })
    .run();
  database.db
    .insert(runs)
    .values({
      id: runId,
      taskId: id,
      instanceId: "fixture",
      status,
      model: "fixture",
      effort: "medium",
      startedAt: time(),
      lastActivityAt: time(),
      finishedAt: status === "running" ? null : time(),
      errorCode,
      terminationConfirmedAt: confirmed ? time() : null,
      result: "Private model result",
    })
    .run();
  return { id, runId };
}
function changeTask(id: string, status: typeof tasks.$inferSelect.status) {
  database.db.update(tasks).set({ status }).where(eq(tasks.id, id)).run();
}
async function receiver(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP fixture");
  return configFile({
    url: `http://127.0.0.1:${address.port}/receiver`,
    timeoutMs: 200,
  });
}
const signal = () => new AbortController().signal;

test("preserves existing state when the notification migration is applied, including across restart", () => {
  owner.release();
  database.close();
  const legacyFolder = join(directory, "old-migrations");
  cpSync(migrationsDirectory, legacyFolder, { recursive: true });
  const journalPath = join(legacyFolder, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  // Recreate the version before notifications, excluding all later migrations too.
  // Drizzle advances from the latest recorded timestamp, not from missing tags.
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 29);
  writeFileSync(journalPath, JSON.stringify(journal));
  const legacyPath = join(directory, "legacy.sqlite");
  const legacy = openDatabase(legacyPath, legacyFolder);
  legacy.db
    .insert(projects)
    .values({
      id: projectId,
      name: "Retained",
      workspaceKey: "example",
      createdAt: time(),
    })
    .run();
  expect(() => legacy.client.prepare("SELECT * FROM notifications").all()).toThrow();
  expect(() => legacy.client.prepare("SELECT * FROM repository_imports").all()).toThrow();
  legacy.close();
  database = openDatabase(legacyPath);
  owner = acquireExecutionOwner(database.db);
  expect(database.db.select().from(projects).get()?.name).toBe("Retained");
  expect(database.client.pragma("foreign_key_check")).toEqual([]);
  expect(database.client.prepare("SELECT * FROM repository_imports").all()).toEqual([]);
  expect(() => database.checkReady()).not.toThrow();
});

test("delivers one receipt per unchanged issue across DB reopen, then creates a new episode after observed recovery", () => {
  const { id } = task();
  const s = store();
  s.scan(time());
  expect(s.claim(time(999))).toBeUndefined();
  const claim = s.claim(time(1000))!;
  s.finish(claim.id, claim.attempt, "delivered", time(1001));
  owner.release();
  database.close();
  database = openDatabase(path);
  owner = acquireExecutionOwner(database.db);
  const restarted = store();
  restarted.scan(time(5000));
  expect(restarted.claim(time(5000))).toBeUndefined();
  expect(receipt()).toMatchObject({
    id: claim.id,
    status: "delivered",
    attempts: 1,
  });
  changeTask(id, "succeeded");
  restarted.scan(time(6000));
  expect(receipt().status).toBe("resolved");
  changeTask(id, "failed");
  restarted.scan(time(7000));
  expect(restarted.claim(time(8000))?.id).not.toBe(claim.id);
});

test("persists reservations before network I/O and retries the same ID after an ambiguous crash with a bounded delay and attempt count", () => {
  task();
  let s = store();
  s.scan(time());
  const first = s.claim(time(1000))!;
  expect(receipt()).toMatchObject({
    attempts: 1,
    nextAttemptAt: time(2000),
    lastResult: null,
  });
  owner.release();
  database.close();
  database = openDatabase(path);
  owner = acquireExecutionOwner(database.db);
  s = store();
  expect(s.claim(time(1999))).toBeUndefined();
  const second = s.claim(time(2000))!;
  expect(second.id).toBe(first.id);
  expect(second.attempt).toBe(2);
  s.finish(second.id, second.attempt, "http_error", time(2001));
  const third = s.claim(time(4000))!;
  expect(third.id).toBe(first.id);
  // No acknowledgement for the final attempt: a restart still cannot exceed the cap.
  s = store();
  expect(s.claim(time(6000))).toBeUndefined();
  expect(receipt()).toMatchObject({
    status: "exhausted",
    attempts: 3,
    nextAttemptAt: null,
  });
  s.scan(time(9000));
  expect(s.claim(time(9000))).toBeUndefined();
});

test("rechecks resolution before delivery and refuses a late acknowledgement for a replaced issue", () => {
  const { id } = task();
  const s = store();
  s.scan(time());
  changeTask(id, "succeeded");
  expect(s.claim(time(1000))).toBeUndefined();
  expect(receipt().status).toBe("resolved");
  changeTask(id, "failed");
  s.scan(time(2000));
  const first = s.claim(time(3000))!;
  database.db
    .update(tasks)
    .set({
      status: "blocked",
      retryState: {
        ...initialRetryState(defaultRetryPolicy),
        reason: "retry_limit",
      },
    })
    .where(eq(tasks.id, id))
    .run();
  s.scan(time(3001));
  const replacement = receipt();
  s.finish(first.id, first.attempt, "delivered", time(3002));
  expect(receipt()).toMatchObject({
    id: replacement.id,
    reason: "retry_limit",
    status: "pending",
    attempts: 0,
  });
});

test("rotating the explicitly configured destination creates a new delivery only while the issue is active", () => {
  const { id } = task();
  const s = store();
  s.scan(time());
  const first = s.claim(time(1000))!;
  s.finish(first.id, first.attempt, "delivered");
  const rotated = store(configFile({ url: "https://example.invalid/new-receiver" }));
  rotated.scan(time(2000));
  expect(receipt().id).not.toBe(first.id);
  expect(receipt().attempts).toBe(0);
  changeTask(id, "succeeded");
  rotated.scan(time(3000));
  store(config).scan(time(4000));
  expect(receipt().status).toBe("resolved");
});

test.each([
  "queued",
  "running",
  "succeeded",
  "cancelled",
  "waiting_retry",
  "waiting_capacity",
] as const)("%s is not itself an actionable failure", (status) => {
  task(status, status === "waiting_capacity" ? "capacity" : "provider_error");
  queue = {
    state: status === "running" ? "running" : "idle",
    taskId: null,
    runId: null,
    reason: "period_budget_wait",
    lastCheckedAt: time(-86400000).toISOString(),
    automaticRecoveryEnabled: true,
    capacityRecoveryEnabled: true,
  };
  store().scan(time());
  expect(listNotifications(database.db)).toEqual([]);
});

test("budget waits, pending automatic retries and requested cancellations do not produce failure notices", () => {
  const one = task();
  const two = task();
  const three = task();
  database.db
    .update(tasks)
    .set({
      budgetWait: {
        scope: "project",
        reason: "call_limit",
        retryAt: time(10000).toISOString(),
      },
    })
    .where(eq(tasks.id, one.id))
    .run();
  database.db
    .update(tasks)
    .set({
      retryState: {
        ...initialRetryState(defaultRetryPolicy),
        nextAttemptAt: time(10000).toISOString(),
      },
    })
    .where(eq(tasks.id, two.id))
    .run();
  database.db.update(tasks).set({ cancelRequestedAt: time() }).where(eq(tasks.id, three.id)).run();
  store().scan(time());
  expect(listNotifications(database.db)).toEqual([]);
});

test.each(["retry_limit", "repeated_error_limit", "task_time_limit"])(
  "uses the stored %s decision without changing task or run state",
  (reason) => {
    const { id } = task("blocked", "transient");
    database.db
      .update(tasks)
      .set({ retryState: { ...initialRetryState(defaultRetryPolicy), reason } })
      .where(eq(tasks.id, id))
      .run();
    const before = database.db.select().from(tasks).all();
    const beforeRuns = database.db.select().from(runs).all();
    store().scan(time());
    expect(receipt().reason).toBe(reason);
    expect(database.db.select().from(tasks).all()).toEqual(before);
    expect(database.db.select().from(runs).all()).toEqual(beforeRuns);
  },
);

test("unconfirmed termination takes priority even when a stop was requested", () => {
  const { id } = task("interrupted", "server_shutdown", false);
  database.db.update(tasks).set({ cancelRequestedAt: time() }).where(eq(tasks.id, id)).run();
  const s = store();
  s.scan(time());
  expect(receipt().reason).toBe("termination_unconfirmed");
  database.db
    .update(runs)
    .set({ terminationConfirmedAt: time(1) })
    .run();
  s.scan(time(1));
  expect(receipt().status).toBe("resolved");
});

test("account authentication/configuration holds are deduplicated across affected tasks, while ordinary capacity waiting stays quiet", () => {
  const { runId } = task("blocked", "authentication");
  task("blocked", "authentication");
  database.db
    .insert(providerGates)
    .values({
      scope: providerScope,
      version: 1,
      blocked: true,
      reason: "authentication",
      sourceRunId: runId,
    })
    .run();
  const s = store();
  s.scan(time());
  expect(listNotifications(database.db)).toHaveLength(1);
  expect(receipt().reason).toBe("authentication_required");
  database.db.update(providerGates).set({ version: 2, reason: "configuration" }).run();
  database.db.update(runs).set({ errorCode: "unsupported_settings" }).run();
  s.scan(time(1));
  expect(receipt().reason).toBe("configuration_required");
  database.db.update(providerGates).set({ version: 3, reason: "capacity" }).run();
  database.db.update(runs).set({ errorCode: "capacity" }).run();
  s.scan(time(2));
  expect(receipt().status).toBe("resolved");
  database.db
    .update(providerGates)
    .set({
      capacityState: {
        policy: defaultCapacityPolicy,
        checks: defaultCapacityPolicy.maxChecks,
        reason: "check_limit",
        decisionVersion: 3,
        nextCheckAt: null,
      },
    })
    .run();
  s.scan(time(3));
  expect(receipt().reason).toBe("capacity_recovery_exhausted");
});

test("records pre-run configuration errors but never exports their raw cause or private execution context", () => {
  queue = {
    state: "error",
    runId: "private",
    taskId: "private",
    reason: "configuration_invalid",
    lastCheckedAt: time().toISOString(),
    automaticRecoveryEnabled: false,
    capacityRecoveryEnabled: false,
  };
  const s = store();
  s.scan(time());
  const first = s.claim(time(1000))!;
  expect(first.payload).toEqual({
    version: 1,
    id: first.id,
    type: "action_required",
    reason: "configuration_required",
    projectId: null,
    taskId: null,
    runId: null,
    detectedAt: time().toISOString(),
  });
  s.finish(first.id, first.attempt, "delivered", time(1001));
  queue.lastCheckedAt = null;
  store().scan(time(2000));
  expect(receipt().status).toBe("delivered");
  queue.lastCheckedAt = time(3000).toISOString();
  queue.state = "idle";
  s.scan(time(3000));
  expect(receipt().status).toBe("resolved");
});

test("bounded pages eventually discover all issues and never resolve a receipt merely because it is off the current page", () => {
  for (let i = 0; i < 70; i++) task();
  const s = store();
  s.scan(time());
  expect(database.db.select().from(notifications).all()).toHaveLength(25);
  const first = s.claim(time(1000))!;
  s.finish(first.id, first.attempt, "delivered", time(1001));
  s.scan(time(2000));
  s.scan(time(3000));
  expect(database.db.select().from(notifications).all()).toHaveLength(70);
  expect(
    database.db.select().from(notifications).where(eq(notifications.id, first.id)).get()?.status,
  ).toBe("delivered");
  expect(listNotifications(database.db)).toHaveLength(50);
});

test("ownership loss prevents reservation and acknowledgement without changing receipts", () => {
  task();
  const s = store();
  s.scan(time());
  const claim = s.claim(time(1000))!;
  const before = receipt();
  database.db.update(executionOwner).set({ token: "another-owner" }).run();
  expect(() => s.scan(time(2000))).toThrow();
  expect(() => s.claim(time(2000))).toThrow();
  expect(() => s.finish(claim.id, claim.attempt, "delivered", time(2000))).toThrow();
  expect(receipt()).toEqual(before);
});

test("posts the exact safe envelope and stable idempotency key; retries a receiver failure and cancels even an unbounded response body", async () => {
  const received: {
    body: string;
    id: string | string[] | undefined;
    method: string | undefined;
  }[] = [];
  const c = await receiver((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      received.push({
        body,
        id: request.headers["idempotency-key"],
        method: request.method,
      });
      if (received.length === 1) {
        response.writeHead(503);
        response.end("Private remote error");
      } else {
        response.writeHead(200);
        response.flushHeaders();
        response.write("Private unbounded response");
      }
    });
  });
  task();
  const s = store(c);
  s.scan(time());
  const first = s.claim(time(1000))!;
  const failed = await deliverNotification(c, first.payload, signal());
  expect(failed).toBe("http_error");
  s.finish(first.id, first.attempt, failed, time(1001));
  const second = s.claim(time(2000))!;
  const result = await deliverNotification(c, second.payload, signal());
  expect(result).toBe("delivered");
  s.finish(second.id, second.attempt, result, time(2001));
  expect(received.map((x) => x.id)).toEqual([first.id, first.id]);
  expect(received[0]?.method).toBe("POST");
  expect(JSON.parse(received[0]!.body)).toEqual(first.payload);
  expect(received[1]?.body).toBe(received[0]?.body);
  expect(JSON.stringify(listNotifications(database.db))).not.toMatch(
    /Private|example.invalid|destinationHash|conditionKey/,
  );
  expect(receipt()).toMatchObject({ status: "delivered", attempts: 2 });
});

test("does not follow receiver redirects or forward credentials to the redirect target", async () => {
  let redirected = 0;
  const target = await receiver((_request, response) => {
    redirected++;
    response.end();
  });
  const c = await receiver((_request, response) => {
    response.writeHead(302, { Location: target.url });
    response.end();
  });
  task();
  const s = store(c);
  s.scan(time());
  const claim = s.claim(time(1000))!;
  expect(await deliverNotification(c, claim.payload, signal())).toBe("redirect_refused");
  expect(redirected).toBe(0);
});

test("bounds a stalled receiver, honors cancellation and returns fixed error codes for connection failure", async () => {
  const c = await receiver(() => {});
  task();
  const s = store(c);
  s.scan(time());
  const claim = s.claim(time(1000))!;
  expect(await deliverNotification(c, claim.payload, signal())).toBe("timeout");
  const stopped = new AbortController();
  stopped.abort();
  expect(await deliverNotification(c, claim.payload, stopped.signal)).toBe("stopped");
  const server = servers.pop()!;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  expect(await deliverNotification(c, claim.payload, signal())).toBe("request_failed");
});

test("worker catches storage failure, reports recovery and stops permanently without unhandled rejections", async () => {
  task();
  const c = { ...config, pollIntervalMs: 10 };
  const report = vi.fn();
  const s = store(c);
  database.db.update(executionOwner).set({ token: "unavailable" }).run();
  const worker = createNotificationWorker({ config: c, store: s, report });
  cleanup.push(() => worker.stop());
  worker.start();
  await vi.waitFor(() => expect(worker.getStatus().storageError).toBe(true));
  database.db.update(executionOwner).set({ token: owner.token }).run();
  await vi.waitFor(() => expect(worker.getStatus().storageError).toBe(false));
  expect(report.mock.calls.map((call) => call[0].code)).toEqual([
    "NOTIFICATION_STORAGE_ERROR",
    "NOTIFICATION_STORAGE_RECOVERED",
  ]);
  await worker.stop();
  worker.start();
  expect(worker.getStatus().enabled).toBe(false);
});

test("stalled notification delivery does not block actual queue work or API responses, and app close aborts delivery before releasing ownership", async () => {
  let received = 0;
  const c = await receiver(() => {
    received++;
  });
  const blocked = task("failed");
  // Seed the canonical delivery state before app startup so the real loop sends immediately.
  const s = store(c);
  s.scan(time());
  database.db
    .update(notifications)
    .set({ nextAttemptAt: new Date(0) })
    .run();
  owner.release();
  mkdirSync(join(directory, "auth"));
  mkdirSync(join(directory, "workspace"));
  writeFileSync(join(directory, "auth/auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
  const file = join(directory, "execution.json");
  writeFileSync(
    file,
    JSON.stringify({
      model: "fixture",
      codexHome: "auth",
      workspaces: { example: "workspace" },
    }),
  );
  const app = buildApp({
    databasePath: path,
    notifications: { ...c, timeoutMs: 10000 },
    execution: {
      config: loadExecutionConfig(file),
      pollIntervalMs: 10,
      executor: {
        async analyze() {
          return { output: "Done", usage: null };
        },
      },
    },
  });
  cleanup.push(() => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  await vi.waitFor(() => expect(received).toBe(1));
  const id = randomUUID();
  database.db
    .insert(tasks)
    .values({
      id,
      projectId,
      instruction: "Next task",
      requestKey: id,
      createdAt: new Date(),
    })
    .run();
  await vi.waitFor(() =>
    expect(database.db.select().from(tasks).where(eq(tasks.id, id)).get()?.status).toBe(
      "succeeded",
    ),
  );
  const status = await app.inject("/operations/notifications");
  expect(status.statusCode).toBe(200);
  expect(status.json().worker.delivering).toBe(true);
  expect(database.db.select().from(tasks).where(eq(tasks.id, blocked.id)).get()?.status).toBe(
    "failed",
  );
  await app.close();
  expect(database.db.select().from(executionOwner).get()).toBeUndefined();
  expect(receipt().lastResult).toBe("stopped");
});

test("status remains protected by admin auth; the readiness capability cannot read notification receipts", async () => {
  owner.release();
  const sessionSecret = randomBytes(32).toString("hex");
  const auth = {
    sourcePath: join(directory, "auth.json"),
    origin: "http://localhost",
    sessionSecret,
    password: { salt: "00".repeat(16), hash: "00".repeat(64) },
  };
  const app = buildApp({ databasePath: path, auth });
  cleanup.push(() => app.close());
  expect((await app.inject("/operations/notifications")).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        url: "/operations/notifications",
        headers: { authorization: `Bearer ${readinessToken(auth)}` },
      })
    ).statusCode,
  ).toBe(401);
});

test("notification config has private permissions, fixed safe errors, validated endpoints/limits and repository-root env resolution", () => {
  const c = configFile();
  expect(c.url).toBe("https://example.invalid/receiver");
  expect(
    loadConfig({ NOTIFICATION_CONFIG: "private/notifications.json" }).notificationConfigPath,
  ).toBe(fileURLToPath(new URL("../../../private/notifications.json", import.meta.url)));
  expect(() => loadConfig({ NOTIFICATION_CONFIG: " " })).toThrow();
  chmodSync(c.sourcePath, 0o644);
  expect(() => loadNotificationConfig(c.sourcePath)).toThrow("Invalid notification config");
  chmodSync(c.sourcePath, 0o600);
  const link = join(directory, "linked.json");
  symlinkSync(c.sourcePath, link);
  expect(() => loadNotificationConfig(link)).toThrow("Invalid notification config");
  try {
    loadNotificationConfig(join(directory, "private-missing-file"));
  } catch (e) {
    expect(String(e)).not.toContain("private-missing-file");
  }
});

test.each([
  { version: 2 },
  { unknown: true },
  { url: "http://example.invalid/receiver" },
  { url: "https://example:YOUR_PASSWORD@example.invalid/receiver" },
  { url: "https://example.invalid/#fragment" },
  { url: "file:///tmp/receiver" },
  { bearerToken: "bad\nheader" },
  { timeoutMs: 10001 },
  { pollIntervalMs: 999 },
  { graceMs: 0 },
  { maxAttempts: 21 },
  { initialDelayMs: 2000, maxDelayMs: 1000 },
])("rejects invalid notification settings without copying sensitive input: %j", (input) => {
  expect(() => configFile(input)).toThrow("Invalid notification config");
});

test("a notification-only process owns delivery exclusively and releases it on close", async () => {
  owner.release();
  const c = await receiver((_request, response) => response.end());
  const first = buildApp({ databasePath: path, notifications: c });
  cleanup.push(() => first.close());
  await first.listen({ host: "127.0.0.1", port: 0 });
  const second = buildApp({ databasePath: path, notifications: c });
  cleanup.push(() => second.close());
  await expect(second.ready()).rejects.toThrow("already owns");
  await first.close();
  const third = buildApp({ databasePath: path, notifications: c });
  cleanup.push(() => third.close());
  await third.listen({ host: "127.0.0.1", port: 0 });
  expect((await third.inject("/operations/notifications")).json().worker.enabled).toBe(true);
});

test("the notification credential file cannot be exposed through an agent workspace", async () => {
  owner.release();
  mkdirSync(join(directory, "auth"));
  mkdirSync(join(directory, "workspace"));
  writeFileSync(join(directory, "auth/auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
  const file = join(directory, "execution.json");
  writeFileSync(
    file,
    JSON.stringify({
      model: "fixture",
      codexHome: "auth",
      workspaces: { example: "workspace" },
    }),
  );
  const privatePath = join(directory, "workspace/notifications.json");
  writeFileSync(
    privatePath,
    JSON.stringify({ version: 1, url: "https://example.invalid/receiver" }),
    { mode: 0o600 },
  );
  const app = buildApp({
    databasePath: path,
    notifications: loadNotificationConfig(privatePath),
    execution: { config: loadExecutionConfig(file) },
  });
  cleanup.push(() => app.close());
  await expect(app.ready()).rejects.toThrow();
  expect(database.db.select().from(executionOwner).get()).toBeUndefined();
});

test("configured bearer authentication is sent only in the request header", async () => {
  let header: string | undefined;
  let body = "";
  const c = await receiver((request, response) => {
    header = request.headers.authorization;
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => response.end());
  });
  const bearerToken = randomUUID();
  task();
  const s = store(c);
  s.scan(time());
  const claim = s.claim(time(1000))!;
  expect(await deliverNotification({ ...c, bearerToken }, claim.payload, signal())).toBe(
    "delivered",
  );
  expect(header).toBe(`Bearer ${bearerToken}`);
  expect(body).not.toContain(bearerToken);
});

test("regression: a surviving running record held by the restarted queue requires recovery even with automatic recovery disabled", async () => {
  const surviving = task("running", "owner_lost", false);
  mkdirSync(join(directory, "auth"));
  mkdirSync(join(directory, "workspace"));
  writeFileSync(join(directory, "auth/auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
  const file = join(directory, "execution.json");
  writeFileSync(
    file,
    JSON.stringify({
      model: "fixture",
      codexHome: "auth",
      workspaces: { example: "workspace" },
    }),
  );
  const analyze = vi.fn(async () => ({ output: "must not run", usage: null }));
  const execution = createExecutionQueue({
    config: loadExecutionConfig(file),
    store: createDrizzleRunStore(database.db, owner.token),
    executor: { analyze },
    validate: () => {},
    reportDiagnostic: () => {},
    pollIntervalMs: 10,
  });
  cleanup.push(() => execution.stop());
  execution.start();
  queue = execution.getStatus();
  expect(queue).toMatchObject({
    state: "held",
    reason: "running",
    runId: surviving.runId,
    automaticRecoveryEnabled: false,
  });
  const s = store();
  s.scan(time());
  expect(receipt()).toMatchObject({
    reason: "execution_recovery_required",
    runId: surviving.runId,
  });
  expect(analyze).not.toHaveBeenCalled();
  // Rechecking the actual record prevents a stale queue snapshot from sending after recovery.
  database.db
    .update(runs)
    .set({ status: "succeeded", terminationConfirmedAt: time(1) })
    .where(eq(runs.id, surviving.runId))
    .run();
  changeTask(surviving.id, "succeeded");
  expect(s.claim(time(1000))).toBeUndefined();
  expect(receipt().status).toBe("resolved");
});

test.each(["waiting_capacity", "cancelled"] as const)(
  "regression: pending Git application still needs attention when task is %s and unrelated work is running",
  (status) => {
    const held = task(status);
    database.db
      .update(tasks)
      .set(
        status === "waiting_capacity"
          ? {
              budgetWait: {
                scope: "project",
                reason: "call_limit",
                retryAt: time(100000).toISOString(),
              },
            }
          : { cancelRequestedAt: time() },
      )
      .where(eq(tasks.id, held.id))
      .run();
    const repositoryId = randomUUID();
    const applicationId = randomUUID();
    database.db
      .insert(developmentRepositories)
      .values({
        id: repositoryId,
        projectId,
        createdByRunId: held.runId,
        intent: {
          id: repositoryId,
          projectId,
          directory: join(directory, "private-git"),
          source: join(directory, "private-source"),
        },
        createdAt: time(),
      })
      .run();
    database.db
      .insert(changeApplications)
      .values({
        id: applicationId,
        taskId: held.id,
        runId: held.runId,
        repositoryId,
        roundSequence: 1,
        goalVersion: 1,
        baseRevision: "0".repeat(40),
        tree: "1".repeat(40),
        candidateDigest: "2".repeat(64),
        evidenceDigest: "3".repeat(64),
        resultCommit: "4".repeat(40),
        targetRef: "refs/heads/development",
        status: "pending",
        createdAt: time(),
      })
      .run();
    queue = {
      state: "running",
      runId: "unrelated",
      taskId: "unrelated",
      reason: null,
      lastCheckedAt: time().toISOString(),
      automaticRecoveryEnabled: true,
      capacityRecoveryEnabled: true,
    };
    const s = store();
    s.scan(time());
    expect(receipt()).toMatchObject({
      reason: "change_application_unconfirmed",
      runId: held.runId,
      taskId: held.id,
    });
    expect(listNotifications(database.db)).toHaveLength(1);
    database.db
      .update(changeApplications)
      .set({ status: "applied", appliedAt: time(1) })
      .run();
    expect(s.claim(time(1000))).toBeUndefined();
    expect(receipt().status).toBe("resolved");
  },
);
