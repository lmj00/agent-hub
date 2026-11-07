import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { safeGitPath } from "../workspace/workspace-git.js";

export class BackupError extends Error {}

export const maxBackupEntries = 50000;
export const maxManifestBytes = 16 * 1024 * 1024;
export type BackupEntry =
  | { path: string; kind: "directory" }
  | {
      path: string;
      kind: "file";
      bytes: number;
      sha256: string;
      executable: boolean;
    };

export async function privateBackupDirectory(path: string) {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    (await realpath(path)) !== path
  )
    throw new BackupError(
      "Backup directories must be canonical private directories owned by this user",
    );
}

function safeEntryPath(path: string) {
  return safeGitPath(path) && Buffer.byteLength(path) <= 1024;
}

async function readFileDigest(path: string, signal: AbortSignal, destination?: string) {
  signal.throwIfAborted();
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await input.stat();
    if (!before.isFile() || before.uid !== process.getuid?.() || before.nlink !== 1)
      throw new BackupError("Backup files must be owned regular files without hard links");
    const sha = createHash("sha256");
    let bytes = 0;
    const source = input.createReadStream({ autoClose: false });
    async function* chunks() {
      for await (const chunk of source) {
        signal.throwIfAborted();
        const buffer = chunk as Buffer;
        sha.update(buffer);
        bytes += buffer.length;
        yield buffer;
      }
    }
    if (destination) {
      await pipeline(
        chunks(),
        createWriteStream(destination, {
          flags: "wx",
          mode: 0o600 | (before.mode & 0o100),
        }),
        { signal },
      );
      const output = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await output.sync();
      } finally {
        await output.close();
      }
    } else {
      for await (const _chunk of chunks()) {
        /* Hash incrementally without retaining file contents. */
      }
    }
    const after = await input.stat(),
      named = await lstat(path);
    if (
      before.dev !== named.dev ||
      before.ino !== named.ino ||
      before.size !== bytes ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new BackupError("Backup source changed while reading it");
    return {
      bytes,
      sha256: sha.digest("hex"),
      executable: (before.mode & 0o100) !== 0,
    };
  } finally {
    await input.close();
  }
}

// The traversal deliberately rejects links and special files rather than following them outside state.
export async function inventoryBackupTree(root: string, signal: AbortSignal, destination?: string) {
  await privateBackupDirectory(root);
  const entries: BackupEntry[] = [];
  async function visit(directory: string, prefix: string) {
    signal.throwIfAborted();
    const info = await lstat(directory);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0)
      throw new BackupError("Backup state directory is not owned or permits other writers");
    for (const name of (await readdir(directory)).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (!safeEntryPath(path) || entries.length >= maxBackupEntries)
        throw new BackupError("Backup file inventory exceeds its supported shape or count");
      const source = join(root, path),
        stat = await lstat(source);
      if (stat.isDirectory()) {
        entries.push({ path, kind: "directory" });
        if (destination) await mkdir(join(destination, path), { mode: 0o700 });
        await visit(source, path);
      } else if (stat.isFile()) {
        entries.push({
          path,
          kind: "file",
          ...(await readFileDigest(
            source,
            signal,
            destination ? join(destination, path) : undefined,
          )),
        });
      } else throw new BackupError("Backup state cannot contain symbolic links or special files");
    }
    if (destination) await syncBackupDirectory(join(destination, prefix));
  }
  await visit(root, "");
  return entries;
}

export async function syncBackupDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function validateBackupEntries(value: unknown): asserts value is BackupEntry[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxBackupEntries)
    throw new BackupError("Invalid backup inventory");
  const seen = new Set<string>();
  const directories = new Set(["."]);
  for (const entry of value as Record<string, unknown>[]) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.path !== "string" ||
      !safeEntryPath(entry.path) ||
      seen.has(entry.path) ||
      !directories.has(dirname(entry.path))
    )
      throw new BackupError("Invalid backup entry path or ordering");
    seen.add(entry.path);
    if (entry.kind === "directory" && Object.keys(entry).length === 2) directories.add(entry.path);
    else if (
      entry.kind !== "file" ||
      Object.keys(entry).length !== 5 ||
      !Number.isSafeInteger(entry.bytes) ||
      Number(entry.bytes) < 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      typeof entry.executable !== "boolean"
    )
      throw new BackupError("Invalid backup file metadata");
  }
}
