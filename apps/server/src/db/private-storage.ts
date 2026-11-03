import {
  closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync,
  openSync, realpathSync, type Stats,
} from "node:fs";
import { basename, dirname, join } from "node:path";

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

export function preparePrivateDatabase(databasePath: string): string {
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
