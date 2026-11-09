import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { acquireExecutionOwner } from "../src/modules/execution/execution-owner.js";
import { createCreationStore } from "../src/modules/github/creation-store.js";
import { createCreationWorker } from "../src/modules/github/creation-worker.js";
import { createImportStore } from "../src/modules/github/import-store.js";
import { GitHubError } from "../src/modules/github/github-client.js";
import { createStateBackup, restoreStateBackup } from "../src/modules/operations/state-backup.js";

let root: string,
  path: string,
  database: ReturnType<typeof openDatabase>,
  owner: ReturnType<typeof acquireExecutionOwner>,
  store: ReturnType<typeof createCreationStore>;
let workers: ReturnType<typeof createCreationWorker>[];
const input = (name = "sample") => ({
  requestKey: randomUUID(),
  repositoryName: name,
  name: "프로젝트",
  profile: "node",
});
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hub-create-")));
  mkdirSync(join(root, "state"), { mode: 0o700 });
  path = join(root, "state", "hub.sqlite");
  database = openDatabase(path);
  owner = acquireExecutionOwner(database.db);
  store = createCreationStore(database.db, owner.token);
  workers = [];
});
afterEach(async () => {
  for (const worker of workers) await worker.stop();
  if (database.client.open) {
    owner.release();
    database.close();
  }
  rmSync(root, { recursive: true, force: true });
});

test("deduplicates request identities, reserves case-insensitive names and never retries an uncertain creation", () => {
  const request = input();
  const job = store.register(request);
  expect(store.register(request).id).toBe(job.id);
  expect(() => store.register({ ...request, name: "different" })).toThrow(
    "CREATION_REQUEST_CONFLICT",
  );
  expect(() => store.register(input("SAMPLE"))).toThrow("CREATION_NAME_RESERVED");
  const claimed = store.claim()!;
  store.dispatch(claimed);
  store.fail(claimed, "GITHUB_UNAVAILABLE");
  expect(store.find(job.id)).toMatchObject({
    status: "uncertain",
    errorCode: "GITHUB_CREATE_UNCERTAIN",
  });
  expect(store.action(job.id, "retry").status).toBe("uncertain");
  expect(store.action(job.id, "cancel").status).toBe("uncertain");
  expect(store.claim()).toBeUndefined();
});

test("recovers pre-dispatch failure separately from dispatched writes and preserves the known repository on restart", () => {
  const job = store.register(input());
  store.claim();
  store.recover();
  expect(store.find(job.id)?.status).toBe("failed");
  store.action(job.id, "retry");
  const claimed = store.claim()!;
  store.dispatch(claimed);
  store.created(claimed, { repositoryId: 42, fullName: "fixture-owner/sample" });
  owner.release();
  database.close();
  database = openDatabase(path);
  owner = acquireExecutionOwner(database.db);
  store = createCreationStore(database.db, owner.token);
  store.recover();
  expect(store.nextCreated()).toMatchObject({ id: job.id, repositoryId: 42, status: "created" });
  expect(store.claim()).toBeUndefined();
  const second = store.register(input("second"));
  const active = store.claim()!;
  store.dispatch(active);
  store.recover();
  expect(store.find(second.id)?.status).toBe("uncertain");
  expect(() => store.dispatch(active)).toThrow("CREATION_STATE_CONFLICT");
});

test("limits explicit retries and queue size, including retries of cancelled jobs", () => {
  const job = store.register(input());
  for (let attempt = 1; attempt <= 5; attempt++) {
    const claimed = store.claim()!;
    expect(claimed.attempt).toBe(attempt);
    store.dispatch(claimed);
    store.fail(claimed, "GITHUB_CREATE_REJECTED");
    if (attempt < 5) store.action(job.id, "retry");
  }
  expect(() => store.action(job.id, "retry")).toThrow("CREATION_ATTEMPT_LIMIT");
  const cancelled = store.register(input("cancel"));
  store.action(cancelled.id, "cancel");
  for (let i = 0; i < 20; i++) store.register(input(`queued-${i}`));
  expect(() => store.register(input("overflow"))).toThrow("CREATION_QUEUE_FULL");
  expect(() => store.action(cancelled.id, "retry")).toThrow("CREATION_QUEUE_FULL");
});

test("persists intent before the write and resumes a lost import handoff without another remote create", async () => {
  const job = store.register(input());
  const imports = createImportStore(database.db, owner.token),
    wakeImporter = vi.fn();
  const createRepository = vi.fn(
    async (_name: string, _signal: AbortSignal, dispatch: () => void) => {
      expect(store.find(job.id)?.status).toBe("authorizing");
      dispatch();
      expect(store.find(job.id)?.status).toBe("creating");
      return { repositoryId: 42, fullName: "fixture-owner/sample" };
    },
  );
  const worker = createCreationWorker({
    store,
    imports,
    client: { createRepository, isBusy: () => false },
    profiles: new Set(["node"]),
    wakeImporter,
    report: () => {
      throw new Error("unexpected storage failure");
    },
  });
  workers.push(worker);
  worker.wake();
  await vi.waitFor(() => expect(store.find(job.id)?.status).toBe("created"));
  // The import transaction committed, but the creation-to-import link was not recorded.
  const imported = imports.register({
    requestKey: job.id,
    repositoryId: 42,
    name: job.name,
    profile: job.profile,
  });
  worker.wake();
  await vi.waitFor(() =>
    expect(store.find(job.id)).toMatchObject({ status: "linked", importId: imported.id }),
  );
  worker.wake();
  await worker.stop();
  expect(createRepository).toHaveBeenCalledOnce();
  expect(imports.list()).toHaveLength(1);
  expect(wakeImporter).toHaveBeenCalledOnce();
  expect(store.action(job.id, "retry").status).toBe("linked");
});

test("shutdown after dispatch leaves uncertainty and cannot silently repeat the external write", async () => {
  const job = store.register(input()),
    imports = createImportStore(database.db, owner.token);
  const createRepository = vi.fn(
    async (_name: string, signal: AbortSignal, dispatch: () => void) => {
      dispatch();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      throw new GitHubError("GITHUB_CREATE_UNCERTAIN");
    },
  );
  const worker = createCreationWorker({
    store,
    imports,
    client: { createRepository, isBusy: () => false },
    profiles: new Set(["node"]),
    wakeImporter: () => {},
    report: () => {},
  });
  workers.push(worker);
  worker.wake();
  await vi.waitFor(() => expect(store.find(job.id)?.status).toBe("creating"));
  await worker.stop();
  store.recover();
  store.action(job.id, "retry");
  expect(store.find(job.id)?.status).toBe("uncertain");
  expect(store.claim()).toBeUndefined();
  expect(createRepository).toHaveBeenCalledOnce();
});

test("waits without consuming an attempt while the GitHub client is occupied, then rejects a removed profile before any write", async () => {
  const job = store.register(input());
  let busy = true;
  const createRepository = vi.fn(async () => {
    throw new Error("must not dispatch");
  });
  const worker = createCreationWorker({
    store,
    imports: createImportStore(database.db, owner.token),
    client: { createRepository, isBusy: () => busy },
    profiles: new Set(["different-profile"]),
    wakeImporter: () => {},
    report: () => {
      throw new Error("unexpected storage error");
    },
  });
  workers.push(worker);
  worker.wake();
  await worker.stop();
  expect(store.find(job.id)).toMatchObject({ status: "queued", attempt: 0 });
  expect(createRepository).not.toHaveBeenCalled();
  busy = false;
  worker.start();
  await vi.waitFor(() =>
    expect(store.find(job.id)).toMatchObject({
      status: "failed",
      errorCode: "CREATION_PROFILE_UNAVAILABLE",
      attempt: 1,
    }),
  );
  expect(createRepository).not.toHaveBeenCalled();
});

test("backup excludes pending remote writes and preserves uncertain outcomes after restore", async () => {
  const job = store.register(input());
  owner.release();
  await expect(
    createStateBackup(path, join(root, "unsafe"), new AbortController().signal),
  ).rejects.toThrow("reconcile");
  owner = acquireExecutionOwner(database.db);
  store = createCreationStore(database.db, owner.token);
  const claimed = store.claim()!;
  store.dispatch(claimed);
  store.recover();
  owner.release();
  database.close();
  const backup = join(root, "safe");
  await createStateBackup(path, backup, new AbortController().signal);
  renameSync(join(root, "state"), join(root, "old-state"));
  await restoreStateBackup(backup, path, new AbortController().signal);
  database = openDatabase(path);
  owner = acquireExecutionOwner(database.db);
  store = createCreationStore(database.db, owner.token);
  store.recover();
  expect(store.find(job.id)?.status).toBe("uncertain");
  expect(store.claim()).toBeUndefined();
});
