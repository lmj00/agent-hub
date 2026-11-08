import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openDatabase } from "../src/db/connection.js";

let directory: string;
const connections: Array<{ close(): void }> = [];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "hub-private-db-"));
});
afterEach(() => {
  for (const connection of connections.splice(0).reverse()) connection.close();
  rmSync(directory, { recursive: true, force: true });
});
const mode = (path: string) => statSync(path).mode & 0o777;

test.each(["WAL", "DELETE"])(
  "preparing private files preserves another connection's active SQLite write lock (%s)",
  (journalMode) => {
    // Isolate the whole probe: a regression can invalidate SQLite's shared-memory mapping.
    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./fixtures/database-lock-probe.mjs", import.meta.url)),
        new URL("../src/db/private-storage.ts", import.meta.url).href,
        join(directory, "locked.sqlite"),
        journalMode,
      ],
      { encoding: "utf8", timeout: 15000, maxBuffer: 65536 },
    );
    expect(child.error).toBeUndefined();
    expect({ status: child.status, signal: child.signal, stderr: child.stderr }).toMatchObject({
      status: 0,
      signal: null,
    });
    expect(JSON.parse(child.stdout)).toEqual({ before: "SQLITE_BUSY", after: "SQLITE_BUSY" });
  },
);

test("creates private SQLite storage and sidecars even when the process umask permits public reads", () => {
  const parent = join(directory, "data");
  const path = join(parent, "hub.sqlite");
  const previous = process.umask(0);
  try {
    const database = openDatabase(path);
    connections.push(database);
    database.client.exec(
      "CREATE TABLE private_fixture (value TEXT); INSERT INTO private_fixture VALUES ('private report')",
    );
    expect(mode(parent)).toBe(0o700);
    for (const suffix of ["", "-wal", "-shm"]) {
      expect(existsSync(path + suffix)).toBe(true);
      expect(mode(path + suffix)).toBe(0o600);
    }
    expect(database.client.prepare("SELECT value FROM private_fixture").get()).toEqual({
      value: "private report",
    });
  } finally {
    process.umask(previous);
  }
});

test("restricts legacy database and live sidecars without losing data or changing parent permissions", () => {
  const path = join(directory, "legacy.sqlite");
  chmodSync(directory, 0o755);
  const legacy = new Database(path);
  connections.push(legacy);
  legacy.pragma("journal_mode = WAL");
  legacy.exec(
    "CREATE TABLE private_fixture (value TEXT); INSERT INTO private_fixture VALUES ('retained report')",
  );
  for (const suffix of ["", "-wal", "-shm"]) chmodSync(path + suffix, 0o644);
  const database = openDatabase(path);
  connections.push(database);
  for (const suffix of ["", "-wal", "-shm"]) expect(mode(path + suffix)).toBe(0o600);
  expect(mode(directory)).toBe(0o755);
  expect(database.client.prepare("SELECT value FROM private_fixture").get()).toEqual({
    value: "retained report",
  });
});

test.each(["", "-wal", "-shm", "-journal"])(
  "rejects a symbolic link at the database path or sidecar %s without touching its target",
  (suffix) => {
    const path = join(directory, "hub.sqlite");
    const target = join(directory, "unrelated.txt");
    writeFileSync(target, "keep this file", { mode: 0o644 });
    if (suffix) writeFileSync(path, "", { mode: 0o600 });
    symlinkSync(target, path + suffix);
    expect(() => openDatabase(path)).toThrow("without symbolic or hard links");
    expect(readFileSync(target, "utf8")).toBe("keep this file");
    expect(mode(target)).toBe(0o644);
  },
);

test("rejects hard-linked files and directories instead of modifying another file's permissions", () => {
  const target = join(directory, "original.sqlite");
  writeFileSync(target, "", { mode: 0o644 });
  const path = join(directory, "linked.sqlite");
  linkSync(target, path);
  expect(() => openDatabase(path)).toThrow("without symbolic or hard links");
  expect(mode(target)).toBe(0o644);
  const subdirectory = join(directory, "not-a-file");
  mkdirSync(subdirectory);
  expect(() => openDatabase(subdirectory)).toThrow("regular files");
});

test("rejects a directory writable by another account before creating a database", () => {
  chmodSync(directory, 0o777);
  const path = join(directory, "hub.sqlite");
  expect(() => openDatabase(path)).toThrow("without group or other write permissions");
  expect(existsSync(path)).toBe(false);
  expect(mode(directory)).toBe(0o777);
});
