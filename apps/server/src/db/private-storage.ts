import { spawnSync } from "node:child_process";
import {
  closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, type Stats,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function regularOwnedFile(stat: Stats, uid: number) {
  if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1) {
    throw new Error("Database files must be regular files owned by this user, without symbolic or hard links");
  }
}

function makePrivate(path: string, uid: number, create: boolean) {
  let previous: Stats | undefined;
  try { previous = lstatSync(path); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (!previous && !create) return;
  if (previous) regularOwnedFile(previous, uid);

  // Create with private permissions before SQLite can write any records.
  const descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW |
    (previous ? 0 : constants.O_CREAT | constants.O_EXCL), 0o600);
  try {
    const current = fstatSync(descriptor);
    regularOwnedFile(current, uid);
    if (previous && (previous.dev !== current.dev || previous.ino !== current.ino)) {
      throw new Error("Database storage changed while opening it");
    }
    // Restrict only the verified file; never chmod a link target or an unrelated parent.
    fchmodSync(descriptor, 0o600);
  } finally { closeSync(descriptor); }
}

function prepareFiles(databasePath: string): string {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Private database storage requires Unix file permissions");
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const directory = realpathSync(dirname(databasePath));
  const parent = lstatSync(directory);
  // Other accounts must not be able to replace the files after validation.
  if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o022) !== 0) {
    throw new Error("Use a database directory owned by this user without group or other write permissions");
  }
  const path = join(directory, basename(databasePath));
  makePrivate(path, uid, true);
  // Existing WAL/SHM/journal files can also contain private records. New SQLite
  // sidecars inherit the main file's 0600 mode, including with a permissive umask.
  for (const suffix of ["-wal", "-shm", "-journal"]) makePrivate(path + suffix, uid, false);
  return path;
}

const workerPath = fileURLToPath(import.meta.url);
const workerFlag = "--prepare-private-database";

export function preparePrivateDatabase(databasePath: string): string {
  // Closing any descriptor for a SQLite file releases this process's POSIX locks
  // on that inode, even those held by another live SQLite connection. Keep all
  // permission checks and descriptor closes in a separate, short-lived process.
  const worker = spawnSync(process.execPath, [workerPath, workerFlag], {
    input: JSON.stringify(databasePath), encoding: "utf8", timeout: 5000, maxBuffer: 65536,
  });
  if (worker.error || worker.signal) {
    throw new Error("Could not prepare private database storage", { cause: worker.error });
  }
  let result: unknown;
  try { result = JSON.parse(worker.stdout); }
  catch { throw new Error("Private database preparation did not return a result"); }
  if (typeof result !== "object" || result === null) {
    throw new Error("Invalid private database preparation result");
  }
  if (worker.status === 0 && "path" in result && typeof result.path === "string") return result.path;
  if ("error" in result && typeof result.error === "string") {
    const error: NodeJS.ErrnoException = new Error(result.error);
    if ("code" in result && typeof result.code === "string") error.code = result.code;
    throw error;
  }
  throw new Error("Private database preparation failed");
}

// Node 24 also runs this module directly from TypeScript during local development.
if (process.argv[1] === workerPath && process.argv[2] === workerFlag) {
  try {
    const databasePath: unknown = JSON.parse(readFileSync(0, "utf8"));
    if (typeof databasePath !== "string") throw new Error("Database path must be a string");
    process.stdout.write(JSON.stringify({ path: prepareFiles(databasePath) }));
  } catch (error) {
    process.stdout.write(JSON.stringify({
      error: error instanceof Error ? error.message : "Private database preparation failed",
      code: error instanceof Error && "code" in error ? error.code : undefined,
    }));
    process.exitCode = 1;
  }
}
