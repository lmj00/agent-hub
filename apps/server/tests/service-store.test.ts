import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { projects, serviceObservations } from "../src/db/schema.js";
import {
  loadServiceConfig,
  type ServiceTargetConfig,
} from "../src/modules/services/service-config.js";
import {
  createDrizzleServiceStore,
  type ObserverStatus,
} from "../src/modules/services/drizzle-service-store.js";
import { acquireExecutionOwner } from "../src/modules/execution/execution-owner.js";
import { createServiceObserver } from "../src/modules/services/service-observer.js";
import type { ObservationResult } from "../src/modules/services/observe-service.js";

let directory: string;
let databasePath: string;
let database: ReturnType<typeof openDatabase>;
let owner: ReturnType<typeof acquireExecutionOwner>;
let target: ServiceTargetConfig;
let store: ReturnType<typeof createDrizzleServiceStore>;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-service-store-")));
  databasePath = join(directory, "hub.sqlite");
  database = openDatabase(databasePath);
  owner = acquireExecutionOwner(database.db);
  store = createDrizzleServiceStore(database.db, owner.token);
  const projectId = randomUUID();
  database.db
    .insert(projects)
    .values({
      id: projectId,
      name: "Service project",
      workspaceKey: "example",
      createdAt: new Date(),
    })
    .run();
  const file = join(directory, "services.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      targets: [
        {
          key: "fixture",
          projectId,
          name: "Service fixture",
          url: "http://127.0.0.1:4321/status",
        },
      ],
    }),
    { mode: 0o600 },
  );
  target = loadServiceConfig(file).targets[0]!;
  store.configure([target]);
});
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  owner.release();
  database.close();
  rmSync(directory, { recursive: true, force: true });
});
const observer = (): ObserverStatus => ({
  enabledKeys: new Set([target.key]),
  errors: new Set(),
  nextChecks: new Map(),
});
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
      summary: "No input available",
    },
  };
}
function bad(now = new Date()): ObservationResult {
  return {
    receivedAt: now,
    success: false,
    errorCode: "request_failed",
    snapshot: null,
  };
}

test("keeps failure and historical success across restart without presenting the success as current health", () => {
  store.save(target, good());
  store.save(target, bad());
  owner.release();
  database.close();
  database = openDatabase(databasePath);
  owner = acquireExecutionOwner(database.db);
  store = createDrizzleServiceStore(database.db, owner.token);
  store.configure([target]);
  const result = store.list(target.projectId, observer())[0]!;
  expect(result).toMatchObject({
    state: "unavailable",
    latest: { success: false },
    lastSuccessful: { success: true, snapshot: { activityState: "waiting" } },
  });
  expect(JSON.stringify(result)).not.toContain(target.url);
  expect(JSON.stringify(result)).not.toContain(target.fingerprint);
  expect(store.list(target.projectId, { ...observer(), enabledKeys: new Set() })[0]).toMatchObject({
    state: "unknown",
    reason: "observer_disabled",
  });
});
test("insertion sequence, rather than UUID or clock order, determines the latest observation", () => {
  const time = new Date();
  store.save(target, good(time));
  store.save(target, bad(new Date(time.getTime() - 1000)));
  expect(store.list(target.projectId, observer())[0]?.latest?.success).toBe(false);
});
test("configuration changes invalidate old evidence and removed targets remain historical only", () => {
  store.save(target, good());
  const changed = { ...target, fingerprint: "different-endpoint" };
  store.configure([changed]);
  expect(store.list(target.projectId, observer())[0]).toMatchObject({
    state: "unknown",
    reason: "not_observed",
    latest: null,
    lastSuccessful: null,
  });
  expect(() => store.save(target, good())).toThrow("configuration changed");
  store.configure([]);
  expect(store.list(target.projectId, observer())[0]).toMatchObject({
    enabled: false,
    reason: "observer_disabled",
  });
  expect(database.db.select().from(serviceObservations).all()).toHaveLength(1);
});
test("an invalid project rolls back config changes and a failed observation write preserves prior evidence", () => {
  store.save(target, good());
  expect(() => store.configure([{ ...target, projectId: randomUUID() }])).toThrow(
    "unknown project",
  );
  expect(store.list(target.projectId, observer())[0]?.enabled).toBe(true);
  database.client.exec(
    "CREATE TRIGGER reject_observation BEFORE INSERT ON service_observations BEGIN SELECT RAISE(ABORT, 'fixture'); END;",
  );
  expect(() => store.save(target, bad())).toThrow();
  expect(database.db.select().from(serviceObservations).all()).toHaveLength(1);
});
test("retention bounds the latest history while preserving the last successful observation", () => {
  store.save(target, good());
  for (let index = 0; index < 1005; index++) store.save(target, bad());
  expect(database.db.select().from(serviceObservations).all()).toHaveLength(1001);
  expect(store.list(target.projectId, observer())[0]?.lastSuccessful?.success).toBe(true);
  store.save(target, good());
  expect(database.db.select().from(serviceObservations).all()).toHaveLength(1000);
});
test("the observer serializes requests and stopping it aborts only its pending read", async () => {
  const signals: AbortSignal[] = [];
  const callbacks: (() => void)[] = [];
  const read = vi.fn((_target: ServiceTargetConfig, signal: AbortSignal) => {
    signals.push(signal);
    return new Promise<ObservationResult>((resolve) => {
      callbacks.push(() => resolve(good()));
      signal.addEventListener("abort", () => resolve(bad()), { once: true });
    });
  });
  const next = { ...target, key: "second", fingerprint: "second" };
  store.configure([target, next]);
  const monitor = createServiceObserver({
    targets: [target, next],
    store,
    observe: read,
    report: () => {},
  });
  cleanup.push(() => monitor.stop());
  monitor.start();
  monitor.start();
  expect(read).toHaveBeenCalledTimes(1);
  callbacks[0]!();
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  await monitor.stop();
  expect(signals[1]?.aborted).toBe(true);
  expect(database.db.select().from(serviceObservations).all()).toHaveLength(1);
  expect(monitor.getStatus().enabledKeys.size).toBe(0);
});
test("persistence failure marks that target unknown and does not prevent other targets from being observed", async () => {
  const next = { ...target, key: "second", fingerprint: "second" };
  store.configure([target, next]);
  const report = vi.fn();
  const monitor = createServiceObserver({
    targets: [target, next],
    store: {
      ...store,
      save(selected, result) {
        if (selected.key === target.key) throw new Error("private DB failure");
        store.save(selected, result);
      },
    },
    observe: async () => good(),
    report,
  });
  cleanup.push(() => monitor.stop());
  monitor.start();
  await vi.waitFor(() =>
    expect(database.db.select().from(serviceObservations).all()).toHaveLength(1),
  );
  expect(
    store.list(target.projectId, monitor.getStatus()).find((item) => item.key === target.key),
  ).toMatchObject({ state: "unknown", reason: "observer_error" });
  expect(
    store.list(target.projectId, monitor.getStatus()).find((item) => item.key === next.key),
  ).toMatchObject({ state: "waiting" });
  expect(report).toHaveBeenCalledWith({
    code: "SERVICE_OBSERVER_ERROR",
    targetKey: target.key,
  });
});
