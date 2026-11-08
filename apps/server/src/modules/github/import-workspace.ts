import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { lstatSync, mkdirSync, realpathSync, statfsSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { extract } from "tar";
import { git, safeGitPath, sourceRevision } from "../workspace/workspace-git.js";
import { readPrivateJson } from "../../private-config.js";

const unzip = promisify(gunzip);
export class ImportError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
export function privateDirectory(path: string, create = true) {
  try {
    if (create) mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077 ||
    realpathSync(path) !== resolve(path)
  )
    throw new ImportError("IMPORT_STORAGE_UNSAFE");
  return path;
}
export function importRoot(databasePath: string) {
  const database = realpathSync(databasePath);
  return privateDirectory(`${database}.sources`);
}
export function importedDirectoryName(databasePath: string) {
  return `${basename(databasePath)}.sources`;
}
function identity(value: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))
    throw new ImportError("IMPORT_STORAGE_UNSAFE");
  return value;
}
export function importPaths(root: string, jobId: string, attemptId: string, create = true) {
  privateDirectory(root, create);
  const directory = privateDirectory(join(root, identity(jobId)), create);
  const attempt = privateDirectory(join(directory, identity(attemptId)), create);
  return { attempt, workspace: join(attempt, "source"), marker: join(attempt, "source.json") };
}
export type SourceIdentity = {
  jobId: string;
  attemptId: string;
  repositoryId: number;
  revision: string;
  localRevision: string;
};

export async function prepareImportedSource(
  root: string,
  identity: Omit<SourceIdentity, "localRevision">,
  archive: Buffer,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (archive.length > 16 * 1048576) throw new ImportError("IMPORT_SOURCE_LIMIT");
  const paths = importPaths(root, identity.jobId, identity.attemptId);
  // Attempts are never reused; restart/retry gets a new identity and leaves old data untouched.
  mkdirSync(paths.workspace, { mode: 0o700 });
  const disk = statfsSync(paths.attempt);
  if (disk.bavail * disk.bsize < 1024 * 1048576) throw new ImportError("IMPORT_DISK_FULL");
  let expanded: Buffer;
  try {
    expanded = await unzip(archive, { maxOutputLength: 64 * 1048576 });
  } catch {
    throw new ImportError("IMPORT_ARCHIVE_INVALID");
  }
  signal.throwIfAborted();
  const archiveFile = join(paths.attempt, "source.tar");
  await writeFile(archiveFile, expanded, { mode: 0o600, flag: "wx" });
  expanded = Buffer.alloc(0);
  let invalid = false,
    count = 0,
    bytes = 0,
    prefix: string | undefined;
  const seen = new Set<string>();
  const spelling = new Map<string, string>();
  try {
    await extract({
      file: archiveFile,
      cwd: paths.workspace,
      strip: 1,
      strict: true,
      preserveOwner: false,
      noMtime: true,
      maxDepth: 32,
      maxMetaEntrySize: 65536,
      maxReadSize: 65536,
      filter(path, entry) {
        if (!("type" in entry)) {
          invalid = true;
          return false;
        }
        const clean = path.endsWith("/") ? path.slice(0, -1) : path;
        const parts = clean.split("/");
        prefix ??= parts[0];
        const key = clean.normalize("NFC").toLowerCase();
        let consistent = true;
        for (let i = 1; i <= parts.length; i++) {
          const segment = parts.slice(0, i).join("/"),
            folded = segment.normalize("NFC").toLowerCase();
          if (spelling.has(folded) && spelling.get(folded) !== segment) consistent = false;
          spelling.set(folded, segment);
        }
        const valid =
          consistent &&
          !signal.aborted &&
          safeGitPath(clean) &&
          parts[0] === prefix &&
          parts.length <= 33 &&
          ++count <= 10000 &&
          !seen.has(key) &&
          ["File", "Directory"].includes(entry.type) &&
          Number.isSafeInteger(entry.size) &&
          entry.size >= 0 &&
          entry.size <= 16 * 1048576 &&
          (bytes += entry.size) <= 64 * 1048576 &&
          !parts
            .slice(1)
            .some((part) => [".git", ".codex", ".gitmodules"].includes(part.toLowerCase())) &&
          (parts.length > 1 || entry.type === "Directory");
        entry.mode = entry.type === "Directory" || (entry.mode ?? 0) & 0o111 ? 0o700 : 0o600;
        seen.add(key);
        if (!valid) invalid = true;
        return valid;
      },
    });
  } catch {
    throw new ImportError("IMPORT_ARCHIVE_INVALID");
  } finally {
    await unlink(archiveFile);
  }
  if (invalid || count < 1) throw new ImportError("IMPORT_ARCHIVE_INVALID");
  signal.throwIfAborted();
  await git(paths.workspace, ["init", "--template=", "--initial-branch=main"], signal);
  await git(paths.workspace, ["add", "--all", "--force", "--", "."], signal);
  await git(
    paths.workspace,
    [
      "-c",
      "user.name=agent-hub",
      "-c",
      "user.email=agent-hub@localhost",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "Import GitHub source snapshot",
    ],
    signal,
  );
  const localRevision = await sourceRevision(paths.workspace, signal);
  const marker: SourceIdentity = { ...identity, localRevision };
  await writeFile(paths.marker, JSON.stringify(marker), { mode: 0o600, flag: "wx" });
  return { workspace: paths.workspace, localRevision };
}
export async function verifyImportedSource(
  root: string,
  expected: SourceIdentity,
  signal: AbortSignal,
) {
  try {
    const paths = importPaths(root, expected.jobId, expected.attemptId, false);
    privateDirectory(paths.workspace, false);
    const { value } = readPrivateJson(paths.marker, "Imported source", 2048);
    if (
      !value ||
      typeof value !== "object" ||
      Object.keys(value).length !== 5 ||
      Object.entries(expected).some(
        ([key, entry]) => (value as Record<string, unknown>)[key] !== entry,
      ) ||
      (await sourceRevision(paths.workspace, signal)) !== expected.localRevision
    )
      throw new ImportError("IMPORT_SOURCE_CHANGED");
    return paths.workspace;
  } catch {
    signal.throwIfAborted();
    throw new ImportError("IMPORT_SOURCE_CHANGED");
  }
}
