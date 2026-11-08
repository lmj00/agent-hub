import { createHash } from "node:crypto";
import { constants, existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { migrationsDirectory } from "../../db/connection.js";
import { preparePrivateDatabase } from "../../db/private-storage.js";
import * as schema from "../../db/schema.js";
import { readPrivateJson } from "../../private-config.js";
import { acquireExecutionOwner, assertExecutionOwner } from "../execution/execution-owner.js";
import { isWithin } from "../../shared/path-containment.js";
import { developmentDirectoryName, developmentRef } from "../workspace/development-workspace.js";
import { preparedDirectoryName } from "../workspace/prepared-workspace.js";
import { git } from "../workspace/workspace-git.js";
import {
  BackupError,
  inventoryBackupTree,
  maxBackupEntries,
  maxManifestBytes,
  privateBackupDirectory,
  syncBackupDirectory,
  validateBackupEntries,
  type BackupEntry,
} from "./backup-files.js";

type Manifest = {
  version: 1;
  createdAt: string;
  databasePath: string;
  schemaDigest: string;
  entries: BackupEntry[];
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function stateNames(databasePath: string) {
  return [
    basename(databasePath),
    developmentDirectoryName(databasePath),
    preparedDirectoryName(databasePath),
  ];
}
function schemaDigest(client: Database.Database) {
  return hash({
    schema: client
      .prepare(
        "SELECT name, type, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all(),
    migrations: client
      .prepare('SELECT hash, created_at FROM "__drizzle_migrations" ORDER BY created_at, id')
      .all(),
  });
}
function expectedSchemaDigest() {
  const client = new Database(":memory:");
  try {
    client.pragma("foreign_keys = ON");
    migrate(drizzle(client, { schema }), {
      migrationsFolder: migrationsDirectory,
    });
    return schemaDigest(client);
  } finally {
    client.close();
  }
}
function validateDatabase(client: Database.Database, expected: string) {
  if (schemaDigest(client) !== expected)
    throw new BackupError(
      "Backup requires the current application's exact database schema and migrations",
    );
  const violation = client.prepare("PRAGMA foreign_key_check").get();
  if (client.pragma("integrity_check", { simple: true }) !== "ok" || violation)
    throw new BackupError("Backup database integrity check failed");
  if (
    client
      .prepare(
        "SELECT 1 FROM runs WHERE status = 'running' OR termination_confirmed_at IS NULL LIMIT 1",
      )
      .get() ||
    client
      .prepare("SELECT 1 FROM run_executions WHERE termination_confirmed_at IS NULL LIMIT 1")
      .get() ||
    client.prepare("SELECT 1 FROM change_applications WHERE status = 'pending' LIMIT 1").get()
  )
    throw new BackupError(
      "Stop and reconcile all executions and pending changes before backup or restore",
    );
}
function openExisting(path: string, readonly = true) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new BackupError("Backup database must be a private owned regular file");
  return new Database(readonly ? path : preparePrivateDatabase(path), {
    readonly,
    fileMustExist: true,
    timeout: 1000,
  });
}
function requireAbsent(path: string) {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new BackupError("Backup and restore destinations must not already exist");
}

async function validateGitState(
  client: Database.Database,
  state: string,
  databasePath: string,
  signal: AbortSignal,
) {
  const db = drizzle(client, { schema });
  const repositories = db
    .select()
    .from(schema.developmentRepositories)
    .limit(maxBackupEntries + 1)
    .all();
  if (repositories.length > maxBackupEntries)
    throw new BackupError("Too many development repositories for one backup");
  const originalRoot = join(dirname(databasePath), developmentDirectoryName(databasePath));
  for (const stored of repositories) {
    signal.throwIfAborted();
    if (
      !uuid.test(stored.id) ||
      stored.intent.id !== stored.id ||
      stored.intent.directory !== join(originalRoot, stored.id)
    )
      throw new BackupError("Stored development repository path does not match this database");
    const repository = stored.prepared;
    // A failed preparation remains unfinished in the restored DB; never promote it to accepted state.
    if (!repository) continue;
    if (
      repository.id !== stored.id ||
      repository.projectId !== stored.projectId ||
      repository.directory !== stored.intent.directory ||
      repository.source !== stored.intent.source ||
      !isAbsolute(repository.source) ||
      !oid.test(repository.head) ||
      !oid.test(repository.headTree) ||
      !oid.test(repository.sourceRevision)
    )
      throw new BackupError("Invalid stored development repository identity");
    const directory = join(state, developmentDirectoryName(databasePath), stored.id);
    const marker = readPrivateJson(join(directory, "repository.json"), "Repository identity", 16384)
      .value as Record<string, unknown>;
    if (
      !marker ||
      marker.id !== stored.id ||
      marker.projectId !== stored.projectId ||
      marker.directory !== repository.directory ||
      marker.source !== repository.source ||
      marker.sourceRevision !== repository.sourceRevision
    )
      throw new BackupError("Backup Git identity disagrees with database history");
    const storage = join(directory, "git");
    for (const name of [
      "commondir",
      "gitdir",
      "objects/info/alternates",
      "objects/info/http-alternates",
    ])
      if (existsSync(join(storage, name)))
        throw new BackupError("Backup Git objects must be self-contained");
    const head = (await git(storage, ["rev-parse", "--verify", developmentRef], signal))
      .toString()
      .trim();
    const tree = (await git(storage, ["rev-parse", `${head}^{tree}`], signal)).toString().trim();
    if (head !== repository.head || tree !== repository.headTree)
      throw new BackupError("Backup Git head disagrees with accepted database state");
    await git(storage, ["fsck", "--full", "--no-reflogs"], signal, undefined, {
      timeout: 15000,
    });
    const applications = client
      .prepare<[string], { resultCommit: string; tree: string }>(
        "SELECT result_commit AS resultCommit, tree FROM change_applications WHERE repository_id = ?",
      )
      .iterate(stored.id);
    for (const application of applications) {
      if (!oid.test(application.resultCommit) || !oid.test(application.tree))
        throw new BackupError("Invalid applied Git revision");
      const appliedTree = (
        await git(storage, ["rev-parse", `${application.resultCommit}^{tree}`], signal)
      )
        .toString()
        .trim();
      if (appliedTree !== application.tree)
        throw new BackupError("Applied change tree is missing from the backup");
      await git(storage, ["merge-base", "--is-ancestor", application.resultCommit, head], signal);
    }
  }
}

function readManifest(backupPath: string): Manifest {
  const stat = lstatSync(join(backupPath, "manifest.json"));
  if (stat.uid !== process.getuid?.() || stat.nlink !== 1)
    throw new BackupError("Backup manifest must be owned without hard links");
  const { value } = readPrivateJson(
    join(backupPath, "manifest.json"),
    "Backup manifest",
    maxManifestBytes,
  );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BackupError("Invalid backup manifest");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 5 ||
    record.version !== 1 ||
    typeof record.databasePath !== "string" ||
    !isAbsolute(record.databasePath) ||
    resolve(record.databasePath) !== record.databasePath ||
    record.databasePath.includes("\0") ||
    dirname(record.databasePath) === "/" ||
    typeof record.schemaDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.schemaDigest) ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt))
  )
    throw new BackupError("Invalid backup manifest header");
  validateBackupEntries(record.entries);
  const names = stateNames(record.databasePath);
  if (
    new Set(names).size !== 3 ||
    record.entries.some((entry) => !names.includes(entry.path.split("/")[0]!))
  )
    throw new BackupError("Backup contains data outside its declared state paths");
  return record as Manifest;
}

export async function inspectStateBackup(backupPath: string, signal: AbortSignal) {
  const directory = resolve(backupPath);
  await privateBackupDirectory(directory);
  if ((await readdir(directory)).sort().join("\n") !== "manifest.json\nstate")
    throw new BackupError("Unexpected backup contents");
  const manifest = readManifest(directory);
  const expected = expectedSchemaDigest();
  if (manifest.schemaDigest !== expected)
    throw new BackupError("Backup is incompatible with this application's schema");
  const state = join(directory, "state");
  const actual = await inventoryBackupTree(state, signal);
  if (hash(actual) !== hash(manifest.entries))
    throw new BackupError("Backup inventory or file hashes do not match");
  const client = openExisting(join(state, basename(manifest.databasePath)));
  try {
    validateDatabase(client, expected);
    if (client.prepare("SELECT 1 FROM execution_owner LIMIT 1").get())
      throw new BackupError("Backup still contains an execution owner");
    await validateGitState(client, state, manifest.databasePath, signal);
  } finally {
    client.close();
  }
  return manifest;
}

export async function createStateBackup(
  databasePath: string,
  destination: string,
  signal: AbortSignal,
) {
  const source = resolve(databasePath),
    target = resolve(destination);
  if (
    realpathSync(source) !== source ||
    isWithin(dirname(source), target) ||
    isWithin(target, source)
  )
    throw new BackupError("Use a canonical database path and a backup outside its state directory");
  await privateBackupDirectory(dirname(source));
  await privateBackupDirectory(dirname(target));
  requireAbsent(target);
  signal.throwIfAborted();
  const client = openExisting(source, false),
    db = drizzle(client, { schema });
  let owner: ReturnType<typeof acquireExecutionOwner> | undefined;
  let temporary: string | undefined;
  try {
    const expected = expectedSchemaDigest();
    validateDatabase(client, expected);
    owner = acquireExecutionOwner(db);
    validateDatabase(client, expected);
    temporary = await mkdtemp(join(dirname(target), ".agent-hub-backup-"));
    const state = join(temporary, "state");
    await mkdir(state, { mode: 0o700 });
    const snapshot = join(state, basename(source));
    // SQLite's backup API folds committed WAL pages into the snapshot. Never copy a live main file alone.
    await client.backup(snapshot, {
      progress: () => {
        signal.throwIfAborted();
        return 100;
      },
    });
    const snapshotHandle = await open(snapshot, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      await snapshotHandle.chmod(0o600);
    } finally {
      await snapshotHandle.close();
    }
    const copy = openExisting(snapshot, false);
    try {
      copy.prepare("DELETE FROM execution_owner WHERE token = ?").run(owner.token);
      copy.pragma("journal_mode = DELETE");
      validateDatabase(copy, expected);
    } finally {
      copy.close();
    }
    for (const name of stateNames(source).slice(1)) {
      const destinationRoot = join(state, name);
      await mkdir(destinationRoot, { mode: 0o700 });
      let present = true;
      try {
        lstatSync(join(dirname(source), name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        present = false;
      }
      if (present) await inventoryBackupTree(join(dirname(source), name), signal, destinationRoot);
    }
    assertExecutionOwner(db, owner.token);
    const entries = await inventoryBackupTree(state, signal);
    const manifest: Manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      databasePath: source,
      schemaDigest: expected,
      entries,
    };
    const bytes = JSON.stringify(manifest, null, 2) + "\n";
    if (Buffer.byteLength(bytes) > maxManifestBytes)
      throw new BackupError("Backup manifest is too large");
    const file = await open(join(temporary, "manifest.json"), "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await inspectStateBackup(temporary, signal);
    const snapshotFile = await open(snapshot, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await snapshotFile.sync();
    } finally {
      await snapshotFile.close();
    }
    await syncBackupDirectory(state);
    await syncBackupDirectory(temporary);
    signal.throwIfAborted();
    requireAbsent(target);
    await rename(temporary, target);
    temporary = undefined;
    await syncBackupDirectory(dirname(target));
    return manifest;
  } finally {
    try {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    } finally {
      try {
        owner?.release();
      } finally {
        client.close();
      }
    }
  }
}

export async function previewStateRestore(
  backupPath: string,
  databasePath: string,
  signal: AbortSignal,
) {
  const backup = resolve(backupPath),
    targetDatabase = resolve(databasePath),
    target = dirname(targetDatabase);
  const manifest = await inspectStateBackup(backup, signal);
  if (targetDatabase !== manifest.databasePath)
    throw new BackupError("Restore requires the original absolute database path");
  await privateBackupDirectory(dirname(target));
  if (isWithin(target, backup) || isWithin(backup, target))
    throw new BackupError("Restore target and backup must be separate");
  requireAbsent(target);
  return manifest;
}

export async function restoreStateBackup(
  backupPath: string,
  databasePath: string,
  signal: AbortSignal,
) {
  const backup = resolve(backupPath),
    targetDatabase = resolve(databasePath),
    target = dirname(targetDatabase);
  const manifest = await previewStateRestore(backup, targetDatabase, signal);
  let temporary: string | undefined = await mkdtemp(join(dirname(target), ".agent-hub-restore-"));
  try {
    const entries = await inventoryBackupTree(join(backup, "state"), signal, temporary);
    if (hash(entries) !== hash(manifest.entries))
      throw new BackupError("Backup changed during restore");
    const client = openExisting(join(temporary, basename(targetDatabase)));
    try {
      validateDatabase(client, manifest.schemaDigest);
      await validateGitState(client, temporary, targetDatabase, signal);
    } finally {
      client.close();
    }
    await syncBackupDirectory(temporary);
    signal.throwIfAborted();
    requireAbsent(target);
    await rename(temporary, target);
    temporary = undefined;
    await syncBackupDirectory(dirname(target));
    return manifest;
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
