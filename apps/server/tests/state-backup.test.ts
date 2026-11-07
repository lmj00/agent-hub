import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase } from "../src/db/connection.js";
import {
  changeApplications,
  developmentRepositories,
  executionOwner,
  projects,
  runExecutions,
  runs,
  tasks,
} from "../src/db/schema.js";
import {
  createStateBackup,
  inspectStateBackup,
  previewStateRestore,
  restoreStateBackup,
} from "../src/modules/operations/state-backup.js";
import { preparedInputRoot } from "../src/modules/goals/prepared-workspace.js";
import { acquireExecutionOwner } from "../src/modules/execution/execution-owner.js";
import {
  developmentRef,
  developmentRepositoryIntent,
  developmentRoot,
  prepareDevelopmentRepository,
} from "../src/modules/goals/development-workspace.js";
import { applicationCommit } from "../src/modules/goals/change-application-git.js";
import { git } from "../src/modules/goals/workspace-git.js";

let directory: string, databasePath: string, backup: string;
const databases: ReturnType<typeof openDatabase>[] = [];
function connect() {
  const database = openDatabase(databasePath);
  databases.push(database);
  return database;
}
const signal = () => new AbortController().signal;
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-backup-")));
  databasePath = join(directory, "state", "hub.sqlite");
  backup = join(directory, "saved");
});
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  rmSync(directory, { recursive: true, force: true });
});

function completedRun(database: ReturnType<typeof openDatabase>) {
  const projectId = randomUUID(),
    taskId = randomUUID(),
    runId = randomUUID(),
    now = new Date();
  database.db
    .insert(projects)
    .values({
      id: projectId,
      name: "Fixture",
      workspaceKey: "example",
      createdAt: now,
    })
    .run();
  database.db
    .insert(tasks)
    .values({
      id: taskId,
      projectId,
      instruction: "Fixture",
      requestKey: randomUUID(),
      status: "succeeded",
      createdAt: now,
    })
    .run();
  database.db
    .insert(runs)
    .values({
      id: runId,
      taskId,
      instanceId: randomUUID(),
      status: "succeeded",
      model: "fixture",
      effort: "medium",
      startedAt: now,
      finishedAt: now,
      lastActivityAt: now,
      terminationConfirmedAt: now,
    })
    .run();
  return { projectId, taskId, runId, now };
}

async function acceptedGitFixture() {
  const database = connect(),
    ids = completedRun(database);
  const source = join(directory, "source");
  mkdirSync(source, { mode: 0o700 });
  writeFileSync(join(source, "answer.mjs"), "export const answer = 1;\n");
  await git(source, ["init", "--quiet", "--template="], signal());
  await git(source, ["add", "--all"], signal());
  await git(
    source,
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    signal(),
  );
  const intent = developmentRepositoryIntent(
    developmentRoot(databasePath),
    source,
    ids.projectId,
  );
  const initial = await prepareDevelopmentRepository(intent, signal());
  const storage = join(initial.directory, "git");
  const blob = (
    await git(
      storage,
      ["hash-object", "-w", "--stdin"],
      signal(),
      "export const answer = 42;\n",
    )
  )
    .toString()
    .trim();
  const tree = (
    await git(
      storage,
      ["mktree"],
      signal(),
      `100644 blob ${blob}\tanswer.mjs\n`,
    )
  )
    .toString()
    .trim();
  const identity = {
    id: randomUUID(),
    baseRevision: initial.head,
    tree,
    createdAt: ids.now,
  };
  const commit = applicationCommit(identity);
  expect(
    (
      await git(
        storage,
        ["hash-object", "-w", "-t", "commit", "--stdin"],
        signal(),
        commit.body,
      )
    )
      .toString()
      .trim(),
  ).toBe(commit.oid);
  await git(
    storage,
    ["update-ref", developmentRef, commit.oid, initial.head],
    signal(),
  );
  const repository = { ...initial, head: commit.oid, headTree: tree };
  database.db
    .insert(developmentRepositories)
    .values({
      id: intent.id,
      projectId: ids.projectId,
      createdByRunId: ids.runId,
      intent,
      prepared: repository,
      createdAt: ids.now,
      preparedAt: ids.now,
    })
    .run();
  // Persisted application fixture: this test verifies backup consistency, not independent model approval.
  database.db
    .insert(changeApplications)
    .values({
      ...identity,
      taskId: ids.taskId,
      runId: ids.runId,
      repositoryId: intent.id,
      roundSequence: 1,
      goalVersion: 1,
      candidateDigest: "a".repeat(64),
      evidenceDigest: "b".repeat(64),
      resultCommit: commit.oid,
      targetRef: developmentRef,
      status: "applied",
      appliedAt: ids.now,
    })
    .run();
  return { database, repository, initial, storage, ids };
}

test("backs up committed WAL state and remaining prepared input, previews it and restores without losing rows", async () => {
  const database = connect();
  const project = {
    id: randomUUID(),
    name: "Backup fixture",
    workspaceKey: "example",
    createdAt: new Date(),
  };
  database.db.insert(projects).values(project).run();
  // Keep a connection open so the source still has committed WAL pages; no executor is active.
  const inputs = preparedInputRoot(databasePath);
  mkdirSync(join(inputs, "remaining"), { mode: 0o700 });
  writeFileSync(join(inputs, "remaining/input.txt"), "prepared fixture\n", {
    mode: 0o600,
  });
  try {
    expect(existsSync(`${databasePath}-wal`)).toBe(true);
    const created = await createStateBackup(databasePath, backup, signal());
    expect(created.databasePath).toBe(databasePath);
    expect(await inspectStateBackup(backup, signal())).toEqual(created);
    expect(database.db.select().from(projects).get()?.id).toBe(project.id);
    await expect(
      restoreStateBackup(backup, databasePath, signal()),
    ).rejects.toThrow("must not already exist");
  } finally {
    database.close();
  }
  renameSync(join(directory, "state"), join(directory, "old-state"));
  await restoreStateBackup(backup, databasePath, signal());
  const restored = connect();
  try {
    expect(restored.db.select().from(projects).get()).toMatchObject(project);
  } finally {
    restored.close();
  }
  expect(readFileSync(join(inputs, "remaining/input.txt"), "utf8")).toBe(
    "prepared fixture\n",
  );
  expect(existsSync(join(directory, "old-state/hub.sqlite"))).toBe(true);
});

test("refuses a live execution owner without creating a completed backup", async () => {
  const database = connect(),
    owner = acquireExecutionOwner(database.db);
  try {
    await expect(
      createStateBackup(databasePath, backup, signal()),
    ).rejects.toThrow("already owns");
    expect(existsSync(backup)).toBe(false);
  } finally {
    owner.release();
    database.close();
  }
});

test("restores the actual accepted Git commit and its database journal at the original paths", async () => {
  const fixture = await acceptedGitFixture();
  await createStateBackup(databasePath, backup, signal());
  fixture.database.close();
  renameSync(join(directory, "state"), join(directory, "old-state"));
  const before = readFileSync(join(backup, "manifest.json"));
  expect(
    (await previewStateRestore(backup, databasePath, signal())).databasePath,
  ).toBe(databasePath);
  expect(existsSync(join(directory, "state"))).toBe(false);
  await restoreStateBackup(backup, databasePath, signal());
  const restored = connect();
  expect(
    restored.db.select().from(developmentRepositories).get()?.prepared?.head,
  ).toBe(fixture.repository.head);
  expect(
    restored.db.select().from(changeApplications).get()?.resultCommit,
  ).toBe(fixture.repository.head);
  expect(
    (
      await git(
        fixture.storage,
        ["show", `${developmentRef}:answer.mjs`],
        signal(),
      )
    ).toString(),
  ).toBe("export const answer = 42;\n");
  expect(readFileSync(join(backup, "manifest.json"))).toEqual(before);
  expect(
    (await git(join(directory, "source"), ["rev-parse", "HEAD"], signal()))
      .toString()
      .trim(),
  ).toBe(fixture.initial.sourceRevision);
});

test.each(["running", "unconfirmed-run", "unconfirmed-container"])(
  "refuses %s before copying state",
  async (mode) => {
    const database = connect(),
      ids = completedRun(database);
    if (mode === "running")
      database.db
        .update(runs)
        .set({ status: "running" })
        .where(eq(runs.id, ids.runId))
        .run();
    if (mode === "unconfirmed-run")
      database.db
        .update(runs)
        .set({ terminationConfirmedAt: null })
        .where(eq(runs.id, ids.runId))
        .run();
    if (mode === "unconfirmed-container")
      database.db
        .insert(runExecutions)
        .values({
          runId: ids.runId,
          sequence: 1,
          containerId: "synthetic-container",
          token: "fixture",
          engineId: "fixture",
          createdAt: ids.now,
        })
        .run();
    await expect(
      createStateBackup(databasePath, backup, signal()),
    ).rejects.toThrow("reconcile");
    expect(existsSync(backup)).toBe(false);
    expect(database.db.select().from(runs).get()?.id).toBe(ids.runId);
  },
);

test("refuses pending Git application rather than backing up an ambiguous acceptance state", async () => {
  const { database } = await acceptedGitFixture();
  database.db
    .update(changeApplications)
    .set({ status: "pending", appliedAt: null })
    .run();
  await expect(
    createStateBackup(databasePath, backup, signal()),
  ).rejects.toThrow("reconcile");
  expect(existsSync(backup)).toBe(false);
});

test("refuses inconsistent Git refs and cleans its owned partial bundle and owner", async () => {
  const fixture = await acceptedGitFixture();
  await git(
    fixture.storage,
    ["update-ref", developmentRef, fixture.initial.head],
    signal(),
  );
  await expect(
    createStateBackup(databasePath, backup, signal()),
  ).rejects.toThrow("Git head disagrees");
  expect(existsSync(backup)).toBe(false);
  expect(
    readdirSync(directory).filter((name) =>
      name.startsWith(".agent-hub-backup-"),
    ),
  ).toEqual([]);
  expect(fixture.database.db.select().from(executionOwner).all()).toEqual([]);
});

test("checks stored application history even when the accepted Git head still matches", async () => {
  const fixture = await acceptedGitFixture();
  // A valid ref and object store do not prove the stored acceptance record agrees.
  fixture.database.db
    .update(changeApplications)
    .set({ tree: fixture.initial.headTree })
    .run();
  await expect(
    createStateBackup(databasePath, backup, signal()),
  ).rejects.toThrow("Applied change tree");
  expect(existsSync(backup)).toBe(false);
  expect(fixture.database.db.select().from(executionOwner).all()).toEqual([]);
});

test.each(["changed", "missing", "extra", "symlink", "traversal"])(
  "inspection rejects %s bundle content before any restore writes",
  async (mode) => {
    const database = connect();
    database.close();
    await createStateBackup(databasePath, backup, signal());
    const snapshot = join(backup, "state/hub.sqlite");
    if (mode === "changed") writeFileSync(snapshot, "corrupted database");
    if (mode === "missing") rmSync(snapshot);
    if (mode === "extra")
      writeFileSync(join(backup, "state/extra.txt"), "unexpected");
    if (mode === "symlink") {
      rmSync(snapshot);
      symlinkSync(databasePath, snapshot);
    }
    if (mode === "traversal") {
      const manifest = JSON.parse(
        readFileSync(join(backup, "manifest.json"), "utf8"),
      );
      manifest.entries[0].path = "../outside";
      writeFileSync(join(backup, "manifest.json"), JSON.stringify(manifest));
    }
    await expect(inspectStateBackup(backup, signal())).rejects.toThrow();
    expect(existsSync(databasePath)).toBe(true);
  },
);

test("rejects schema drift without migrating or removing the source schema", async () => {
  const database = connect();
  database.client.exec("CREATE TABLE unexpected (value TEXT)");
  await expect(
    createStateBackup(databasePath, backup, signal()),
  ).rejects.toThrow("exact database schema");
  expect(
    database.client
      .prepare("SELECT name FROM sqlite_schema WHERE name = 'unexpected'")
      .get(),
  ).toEqual({ name: "unexpected" });
  expect(existsSync(backup)).toBe(false);
});

test("rejects relocation and an existing backup directory while preserving the existing content", async () => {
  const database = connect();
  database.close();
  await createStateBackup(databasePath, backup, signal());
  const manifest = readFileSync(join(backup, "manifest.json"));
  await expect(
    createStateBackup(databasePath, backup, signal()),
  ).rejects.toThrow("must not already exist");
  await expect(
    previewStateRestore(
      backup,
      join(directory, "relocated/hub.sqlite"),
      signal(),
    ),
  ).rejects.toThrow("original absolute");
  expect(readFileSync(join(backup, "manifest.json"))).toEqual(manifest);
  expect(existsSync(join(directory, "relocated"))).toBe(false);
});

test("partial copy failure removes only owned temporary output and leaves source inputs intact", async () => {
  const database = connect();
  const inputs = preparedInputRoot(databasePath);
  writeFileSync(join(inputs, "first.txt"), "private source", { mode: 0o600 });
  symlinkSync(databasePath, join(inputs, "zz-link"));
  await expect(
    createStateBackup(databasePath, backup, signal()),
  ).rejects.toThrow("symbolic links");
  expect(readFileSync(join(inputs, "first.txt"), "utf8")).toBe(
    "private source",
  );
  expect(existsSync(backup)).toBe(false);
  expect(
    readdirSync(directory).filter((name) =>
      name.startsWith(".agent-hub-backup-"),
    ),
  ).toEqual([]);
  expect(database.db.select().from(executionOwner).all()).toEqual([]);
});

test("a cancelled operation creates no completed backup", async () => {
  const database = connect();
  database.close();
  const controller = new AbortController();
  controller.abort(new Error("cancelled fixture"));
  await expect(
    createStateBackup(databasePath, backup, controller.signal),
  ).rejects.toThrow("cancelled fixture");
  expect(existsSync(backup)).toBe(false);
});

test("refuses an owner on another host without clearing its ownership record", async () => {
  const database = connect();
  const owner = {
    slot: 1,
    token: randomUUID(),
    hostname: "another-fixture-host",
    pid: 2147483647,
  };
  database.db.insert(executionOwner).values(owner).run();
  await expect(
    createStateBackup(databasePath, backup, signal()),
  ).rejects.toThrow("termination cannot be confirmed");
  expect(database.db.select().from(executionOwner).get()).toEqual(owner);
  expect(existsSync(backup)).toBe(false);
});

test.each(["hardlink", "public-parent", "foreign-key"])(
  "refuses unsafe %s source state",
  async (mode) => {
    const database = connect();
    if (mode === "hardlink")
      linkSync(databasePath, join(directory, "shared.sqlite"));
    if (mode === "public-parent") chmodSync(join(directory, "state"), 0o755);
    if (mode === "foreign-key") {
      const ids = completedRun(database);
      database.client.pragma("foreign_keys = OFF");
      database.db.delete(projects).where(eq(projects.id, ids.projectId)).run();
    }
    await expect(
      createStateBackup(databasePath, backup, signal()),
    ).rejects.toThrow();
    expect(existsSync(backup)).toBe(false);
    expect(database.db.select().from(executionOwner).all()).toEqual([]);
  },
);

test("refuses a Git repository that depends on objects outside its state bundle", async () => {
  const fixture = await acceptedGitFixture();
  writeFileSync(
    join(fixture.storage, "objects/info/alternates"),
    "/synthetic/other/objects\n",
    { mode: 0o600 },
  );
  await expect(
    createStateBackup(databasePath, backup, signal()),
  ).rejects.toThrow("self-contained");
  expect(existsSync(backup)).toBe(false);
});

const runCli = (args: string[]) =>
  promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "src/backup-cli.ts", ...args],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      timeout: 8000,
      maxBuffer: 65536,
    },
  );

// Keep one process startup per case: these check command contracts, not the
// combined startup time of several independent CLI invocations.
test("actual CLI creates a private, inspectable bundle", async () => {
  const database = connect();
  const ids = completedRun(database);
  database.close();
  const created = JSON.parse(
    (
      await runCli([
        "create",
        "--database",
        databasePath,
        "--destination",
        backup,
      ])
    ).stdout,
  );
  expect(created).toMatchObject({
    action: "create",
    originalDatabasePath: databasePath,
  });
  expect(created.files).toBeGreaterThan(0);
  expect(statSync(backup).mode & 0o777).toBe(0o700);
  expect(statSync(join(backup, "manifest.json")).mode & 0o777).toBe(0o600);
  expect((await inspectStateBackup(backup, signal())).schemaDigest).toBe(
    created.schemaDigest,
  );
  renameSync(join(directory, "state"), join(directory, "old-state"));
  await restoreStateBackup(backup, databasePath, signal());
  expect(connect().db.select().from(runs).get()?.id).toBe(ids.runId);
});

async function stoppedCliBackup() {
  const database = connect();
  const ids = completedRun(database);
  database.close();
  const manifest = await createStateBackup(databasePath, backup, signal());
  return { ids, manifest };
}

test("actual CLI inspects the saved bundle schema", async () => {
  const { manifest } = await stoppedCliBackup();
  expect(
    JSON.parse((await runCli(["inspect", "--backup", backup])).stdout),
  ).toMatchObject({ action: "inspect", schemaDigest: manifest.schemaDigest });
});

test("actual CLI previews restoration without writing state", async () => {
  await stoppedCliBackup();
  renameSync(join(directory, "state"), join(directory, "old-state"));
  const args = ["restore", "--backup", backup, "--database", databasePath];
  expect(JSON.parse((await runCli(args)).stdout).action).toBe(
    "restore-preview",
  );
  expect(existsSync(join(directory, "state"))).toBe(false);
});

test("actual CLI restores the saved records with --apply", async () => {
  const { ids } = await stoppedCliBackup();
  renameSync(join(directory, "state"), join(directory, "old-state"));
  expect(
    JSON.parse(
      (
        await runCli([
          "restore",
          "--backup",
          backup,
          "--database",
          databasePath,
          "--apply",
        ])
      ).stdout,
    ).action,
  ).toBe("restore");
  expect(connect().db.select().from(runs).get()?.id).toBe(ids.runId);
});

test("CLI creation failure has a nonzero exit and does not expose private record contents", async () => {
  const database = connect();
  database.close();
  const privateText = "private-fixture-record-never-print";
  writeFileSync(databasePath, privateText);
  await expect(
    runCli(["create", "--database", databasePath, "--destination", backup]),
  ).rejects.toMatchObject({
    code: 1,
    stdout: "",
    stderr: expect.stringContaining("Backup operation failed."),
  });
  expect(existsSync(backup)).toBe(false);
});

test("CLI inspection failure has a nonzero exit and does not expose private paths", async () => {
  const privateText = "private-fixture-record-never-print";
  await expect(
    runCli(["inspect", "--backup", join(directory, privateText)]),
  ).rejects.toMatchObject({
    code: 1,
    stdout: "",
    stderr:
      "Backup operation failed. Check private paths, compatibility, integrity and that all execution is stopped and reconciled.\n",
  });
  expect(existsSync(backup)).toBe(false);
});
