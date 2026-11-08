import { randomUUID, generateKeyPairSync } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { projects } from "../src/db/schema.js";
import { acquireExecutionOwner } from "../src/modules/execution/execution-owner.js";
import { loadExecutionConfig } from "../src/modules/execution/execution-config.js";
import { createImportStore, importedWorkspaceKey } from "../src/modules/github/import-store.js";
import { importRuntime, hydrateImports } from "../src/modules/github/import-runtime.js";
import { createImportWorker } from "../src/modules/github/import-worker.js";
import { prepareImportedSource, importRoot } from "../src/modules/github/import-workspace.js";
import { Header, type HeaderData } from "tar";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/modules/auth/password.js";
import { createStateBackup, restoreStateBackup } from "../src/modules/operations/state-backup.js";
import { gzipSync } from "node:zlib";
import { AnalysisError } from "../src/modules/execution/analysis.js";

let directory: string,
  databasePath: string,
  database: ReturnType<typeof openDatabase>,
  owner: ReturnType<typeof acquireExecutionOwner>;
let workers: ReturnType<typeof createImportWorker>[];
const revision = "a".repeat(40);
const profile = { image: "test:local", command: ["node", "--test"], timeoutMs: 1000 };
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-import-")));
  databasePath = join(directory, "hub.sqlite");
  database = openDatabase(databasePath);
  owner = acquireExecutionOwner(database.db);
  workers = [];
  mkdirSync(join(directory, "auth"));
  writeFileSync(join(directory, "auth/auth.json"), JSON.stringify({ auth_mode: "chatgpt" }));
  writeFileSync(
    join(directory, "execution.json"),
    JSON.stringify({
      model: "fixture",
      codexHome: "auth",
      workspaces: {},
      containerImage: "runner:local",
      importProfiles: { node: profile },
      automaticRecovery: {
        initialDelayMs: 1000,
        maxDelayMs: 1000,
        jitterRatio: 0,
        capacity: { initialDelayMs: 1000, maxDelayMs: 1000, jitterRatio: 0 },
      },
    }),
  );
});
afterEach(async () => {
  for (const worker of workers) await worker.stop();
  if (database.client.open) {
    owner.release();
    database.close();
  }
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});
const input = () => ({
  requestKey: randomUUID(),
  repositoryId: 78,
  name: "Imported example",
  profile: "node",
});
const config = () => loadExecutionConfig(join(directory, "execution.json"));

test("imports real files and Git, deduplicates a lost response and restores the runtime mapping after restart", async () => {
  const store = createImportStore(database.db, owner.token),
    settings = config();
  const job = store.register(input());
  const worker = createImportWorker({
    store,
    runtime: importRuntime(settings, databasePath, []),
    report: () => {
      throw new Error("unexpected storage failure");
    },
    client: {
      downloadRepository: async () => ({
        repositoryId: 78,
        fullName: "fixture/example",
        revision,
        archive: githubArchive(),
      }),
    },
  });
  workers.push(worker);
  worker.start();
  await expect.poll(() => store.find(job.id)?.status).toBe("ready");
  const saved = store.find(job.id)!;
  expect(saved.projectId).toBe(job.id);
  const workspace = settings.workspaces.get(importedWorkspaceKey(job))!;
  expect(readFileSync(join(workspace, "src/main.ts"), "utf8")).toContain("42");
  expect(settings.verification?.get(importedWorkspaceKey(job))).toEqual(profile);
  expect(store.register(input()).id).toBe(job.id);
  expect(database.db.select().from(projects).all()).toHaveLength(1);
  await worker.stop();
  owner.release();
  database.close();
  database = openDatabase(databasePath);
  owner = acquireExecutionOwner(database.db);
  const fresh = config();
  await hydrateImports(database.db, fresh, databasePath, []);
  expect(fresh.workspaces.get(importedWorkspaceKey(job))).toBe(workspace);
  writeFileSync(join(workspace, "src/main.ts"), "changed");
  await expect(hydrateImports(database.db, config(), databasePath, [])).rejects.toThrow();
});

test("cancellation prevents project activation and interrupted attempts can retry with a new directory identity", async () => {
  const store = createImportStore(database.db, owner.token),
    job = store.register(input());
  const claimed = store.claim()!;
  store.recover();
  expect(store.find(job.id)).toMatchObject({ status: "failed", errorCode: "IMPORT_INTERRUPTED" });
  store.action(job.id, "retry");
  const retried = store.claim()!;
  expect(retried.attemptId).not.toBe(claimed.attemptId);
  store.action(job.id, "cancel");
  expect(
    store.finish(retried, { fullName: "fixture/example", revision, localRevision: revision }),
  ).toBeUndefined();
  expect(database.db.select().from(projects).all()).toHaveLength(0);
  expect(store.find(job.id)?.status).toBe("cancelled");
  for (let i = 2; i < 5; i++) {
    store.action(job.id, "retry");
    const next = store.claim()!;
    store.fail(next, "IMPORT_FAILED");
  }
  expect(() => store.action(job.id, "retry")).toThrow("IMPORT_ATTEMPT_LIMIT");
});

test("cancel aborts an in-flight download without creating a project", async () => {
  const store = createImportStore(database.db, owner.token),
    job = store.register(input());
  let seenSignal: AbortSignal | undefined;
  const worker = createImportWorker({
    store,
    runtime: importRuntime(config(), databasePath, []),
    report: () => {},
    client: {
      downloadRepository: async (_id, signal) => {
        seenSignal = signal;
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        );
      },
    },
  });
  workers.push(worker);
  worker.start();
  await expect.poll(() => seenSignal !== undefined).toBe(true);
  store.action(job.id, "cancel");
  worker.cancel(job.id);
  await worker.stop();
  expect(seenSignal!.aborted).toBe(true);
  expect(store.find(job.id)?.status).toBe("cancelled");
  expect(database.db.select().from(projects).all()).toEqual([]);
});

test.each(
  [
    [{ path: "snapshot/../escape", content: "bad" }],
    [{ path: "snapshot/link", type: "SymbolicLink" as const, linkpath: "../../escape" }],
    [{ path: "snapshot/link", type: "Link" as const, linkpath: "../../escape" }],
    [{ path: "snapshot/.git/config", content: "bad" }],
    [{ path: "snapshot/.codex/config.toml", content: "bad" }],
    [{ path: "snapshot/.gitmodules", content: "submodule" }],
    [
      { path: "snapshot/Foo/a", content: "a" },
      { path: "snapshot/foo/b", content: "b" },
    ],
    [
      { path: "snapshot/a", content: "a" },
      { path: "snapshot/a", content: "b" },
    ],
  ].map((entries) => ({ entries })),
)("rejects an unsafe archive without creating an active project %#", async ({ entries }) => {
  await expect(
    prepareImportedSource(
      importRoot(databasePath),
      { jobId: randomUUID(), attemptId: randomUUID(), repositoryId: 78, revision },
      githubArchive(entries),
      new AbortController().signal,
    ),
  ).rejects.toThrow("IMPORT_ARCHIVE_INVALID");
  expect(database.db.select().from(projects).all()).toEqual([]);
});

test("rejects root symlinks, conflicting requests and missing trusted profiles", async () => {
  mkdirSync(join(directory, "elsewhere"));
  symlinkSync(join(directory, "elsewhere"), `${databasePath}.sources`);
  expect(() => importRoot(databasePath)).toThrow("IMPORT_STORAGE_UNSAFE");
  const store = createImportStore(database.db, owner.token),
    command = input();
  store.register(command);
  expect(() => store.register({ ...command, name: "another" })).toThrow("IMPORT_REQUEST_CONFLICT");
  writeFileSync(
    join(directory, "execution.json"),
    JSON.stringify({
      model: "fixture",
      codexHome: "auth",
      workspaces: {},
      importProfiles: { node: profile },
    }),
  );
  expect(config).toThrow("importProfiles requires");
});

test("authenticated API imports into an initially empty running server and planning/retry/capacity see the new project", async () => {
  owner.release();
  database.close();
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const auth = {
    sourcePath: join(directory, "login.json"),
    origin: "http://localhost",
    sessionSecret: "a".repeat(64),
    password: await hashPassword("fixture-password"),
  };
  writeFileSync(auth.sourcePath, "{}", { mode: 0o600 });
  const github = {
    sourcePath: join(directory, "github.json"),
    appId: 12,
    installationId: 34,
    ownerId: 56,
    privateKey: keys.privateKey,
  };
  writeFileSync(github.sourcePath, "{}", { mode: 0o600 });
  const repo = {
    id: 78,
    name: "example",
    full_name: "fixture/example",
    owner: { id: 56, login: "fixture" },
    private: true,
    archived: false,
    default_branch: "main",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (url) => {
      const path = String(url);
      const json = (value: unknown) => new Response(JSON.stringify(value));
      if (path.includes("codeload.github.com"))
        return new Response(new Uint8Array(githubArchive()));
      if (path.includes("/tarball/"))
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://codeload.github.com/fixture/example/legacy.tar.gz/${revision}`,
          },
        });
      if (path.includes("/commits/")) return json({ sha: revision });
      if (path.endsWith("access_tokens"))
        return json({
          token: "ghs_fixture_not_a_real_access_token",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
      if (path.includes("/installation/repositories"))
        return json({ total_count: 1, repositories: [repo] });
      return json({
        id: 34,
        app_id: 12,
        account: { id: 56, login: "fixture", type: "User" },
        suspended_at: null,
        repository_selection: "selected",
      });
    }),
  );
  let calls = 0;
  const app = buildApp({
    databasePath,
    auth,
    github,
    execution: {
      config: config(),
      pollIntervalMs: 25,
      executor: {
        async analyze(request) {
          expect(request.responseMode).toBe("goal-plan");
          expect(readFileSync(join(request.workspace, "src/main.ts"), "utf8")).toContain("42");
          calls++;
          throw new AnalysisError(
            calls === 1 ? "transient" : calls === 2 ? "capacity" : "provider_error",
          );
        },
        confirmTermination: async () => new Date(),
      },
    },
  });
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    expect((await app.inject("/integrations/github/imports")).statusCode).toBe(401);
    const anonymous = await app.inject("/auth/session");
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: {
        cookie: anonymous.headers["set-cookie"]!.toString().split(";")[0]!,
        "x-csrf-token": anonymous.json().csrfToken,
      },
      payload: { password: "fixture-password" },
    });
    const headers = {
      cookie: login.headers["set-cookie"]!.toString().split(";")[0]!,
      "x-csrf-token": login.json().csrfToken,
    };
    const command = input();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/integrations/github/imports",
          headers: { cookie: headers.cookie },
          payload: command,
        })
      ).statusCode,
    ).toBe(403);
    const registered = await app.inject({
      method: "POST",
      url: "/integrations/github/imports",
      headers,
      payload: command,
    });
    expect(registered.statusCode).toBe(202);
    const id = registered.json().id;
    await expect
      .poll(
        async () =>
          (await app.inject({ url: "/integrations/github/imports", headers })).json().imports[0]
            .status,
      )
      .toBe("ready");
    const goal = await app.inject({
      method: "POST",
      url: `/projects/${id}/goals`,
      headers,
      payload: {
        requestKey: "goal",
        definition: {
          description: "Improve example",
          completionCriteria: "Tests pass",
          kind: "finite",
          priority: 50,
          allowedPaths: ["src"],
          excludedPaths: [],
          checkIntervalMs: 60000,
          budget: { windowMs: 3600000, maxCalls: 20, maxRunMs: 1800000 },
        },
      },
    });
    expect(goal.statusCode).toBe(201);
    await expect.poll(() => calls, { timeout: 15000 }).toBeGreaterThanOrEqual(3);
    const again = await app.inject({
      method: "POST",
      url: "/integrations/github/imports",
      headers,
      payload: command,
    });
    expect(again.json().projectId).toBe(id);
  } finally {
    await app.close();
  }
}, 25000);

test("backup restores the imported source and identity alongside its project, and rejects modified source", async () => {
  const state = join(directory, "state");
  mkdirSync(state, { mode: 0o700 });
  const path = join(state, "hub.sqlite");
  const isolated = openDatabase(path),
    lease = acquireExecutionOwner(isolated.db);
  const store = createImportStore(isolated.db, lease.token);
  const job = store.register(input()),
    claimed = store.claim()!;
  const prepared = await prepareImportedSource(
    importRoot(path),
    { jobId: job.id, attemptId: claimed.attemptId!, repositoryId: 78, revision },
    githubArchive(),
    new AbortController().signal,
  );
  store.finish(claimed, {
    fullName: "fixture/example",
    revision,
    localRevision: prepared.localRevision,
  });
  lease.release();
  isolated.close();
  const backup = join(directory, "saved");
  await createStateBackup(path, backup, new AbortController().signal);
  renameSync(state, join(directory, "old-state"));
  await restoreStateBackup(backup, path, new AbortController().signal);
  const restored = openDatabase(path);
  try {
    const runtime = config();
    await hydrateImports(restored.db, runtime, path, []);
    expect(
      readFileSync(join(runtime.workspaces.get(importedWorkspaceKey(job))!, "src/main.ts"), "utf8"),
    ).toContain("42");
  } finally {
    restored.close();
  }
  writeFileSync(join(prepared.workspace, "src/main.ts"), "modified");
  await expect(
    createStateBackup(path, join(directory, "bad-backup"), new AbortController().signal),
  ).rejects.toThrow("IMPORT_SOURCE_CHANGED");
});

test("bounds compressed bytes, expanded bytes and entry size before activating any project", async () => {
  for (const archive of [
    Buffer.alloc(16 * 1048576 + 1),
    gzipSync(Buffer.alloc(64 * 1048576 + 1)),
    githubArchive([{ path: "snapshot/large", content: "a".repeat(16 * 1048576 + 1) }]),
  ]) {
    await expect(
      prepareImportedSource(
        importRoot(databasePath),
        { jobId: randomUUID(), attemptId: randomUUID(), repositoryId: 78, revision },
        archive,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/IMPORT_(SOURCE_LIMIT|ARCHIVE_INVALID)/);
  }
  expect(database.db.select().from(projects).all()).toEqual([]);
});

test("limits the waiting queue, including retries of earlier failed imports", () => {
  const store = createImportStore(database.db, owner.token),
    initial = store.register(input());
  store.fail(store.claim()!, "IMPORT_FAILED");
  for (let i = 0; i < 20; i++) store.register({ ...input(), repositoryId: 100 + i });
  expect(() => store.register({ ...input(), repositoryId: 999 })).toThrow("IMPORT_QUEUE_FULL");
  expect(() => store.action(initial.id, "retry")).toThrow("IMPORT_QUEUE_FULL");
  expect(store.find(initial.id)?.status).toBe("failed");
});

function githubArchive(
  entries: (HeaderData & { content?: string })[] = [
    { path: "snapshot/src/main.ts", content: "export const answer = 42;\n" },
  ],
) {
  const blocks: Buffer[] = [];
  for (const entry of [{ path: "snapshot/", type: "Directory" as const }, ...entries]) {
    const content = Buffer.from("content" in entry ? (entry.content ?? "") : "");
    const header = new Header({ type: "File", size: content.length, mode: 0o644, ...entry });
    header.encode();
    blocks.push(header.block!, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
