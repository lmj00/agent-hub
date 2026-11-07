import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  git,
  sourceRevision,
  readGitTree,
  readGitBlobs,
  safeGitPath,
  type GitEntry,
} from "./workspace-git.js";
import { isWithin } from "../../shared/path-containment.js";

import type { DevelopmentRepository } from "./development-workspace.js";

export type GoalScope = {
  goalId: string;
  goalVersion: number;
  allowedPaths: string[];
  excludedPaths: string[];
};
export type PreparedInput = {
  id: string;
  runId: string;
  directory: string;
  source: string;
  developmentRepository?: DevelopmentRepository;
  scope: GoalScope;
  phase: "preparing" | "ready";
  revision: string | null;
  digest: string | null;
  files: { path: string; blob: string; bytes: number; mode?: "100644" | "100755" }[];
};
const maxFiles = 500,
  maxFileBytes = 1048576,
  maxBytes = 8 * 1048576;
const marker = ".hub-prepared-input.json";
const contains = (parent: string, child: string) =>
  parent === "." || parent === child || child.startsWith(`${parent}/`);
export function allowedGoalPath(
  path: string,
  scope: Pick<GoalScope, "allowedPaths" | "excludedPaths">,
) {
  return (
    safeGitPath(path) &&
    scope.allowedPaths.some((parent) => contains(parent, path)) &&
    !scope.excludedPaths.some((parent) => contains(parent, path))
  );
}
export function privateInputPath(path: string) {
  return path
    .split("/")
    .some(
      (part) =>
        /^(?:\.git|\.codex|\.agents|\.claude|\.gstack|\.cursor|\.local|\.ssh|\.aws|\.kube|\.docker|\.npmrc|\.netrc|\.pypirc|\.git-credentials|node_modules|\.env(?:\..*)?|auth\.json|credentials(?:\.json)?|id_rsa|id_ed25519)$/i.test(
          part,
        ) || /\.(?:pem|key|p12|pfx|sqlite(?:3)?|db)(?:-(?:wal|shm|journal))?$/i.test(part),
    );
}
export type ScopedGitFile = {
  path: string;
  blob: string;
  bytes: number;
  mode: "100644" | "100755";
};
export function scopedGitFiles(entries: GitEntry[], scope: GoalScope): ScopedGitFile[] {
  const files: ScopedGitFile[] = [];
  let total = 0;
  for (const entry of entries) {
    if (
      entry.type === "tree" ||
      !allowedGoalPath(entry.path, scope) ||
      privateInputPath(entry.path)
    )
      continue;
    if ((entry.mode !== "100644" && entry.mode !== "100755") || entry.type !== "blob")
      throw new Error("Goal scope contains a symlink or submodule");
    const bytes = entry.bytes;
    if (
      bytes === null ||
      bytes > maxFileBytes ||
      (total += bytes) > maxBytes ||
      files.length >= maxFiles
    )
      throw new Error("Prepared input exceeds file or byte limits");
    files.push({ path: entry.path, blob: entry.blob, bytes, mode: entry.mode });
  }
  return files;
}
export function privateDirectory(path: string) {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error("Prepared input directory must be private and owned by this user");
}
export function preparedDirectoryName(databasePath: string) {
  return `.prepared-${createHash("sha256").update(resolve(databasePath)).digest("hex").slice(0, 16)}`;
}

export function preparedInputRoot(databasePath: string) {
  const parent = realpathSync(dirname(resolve(databasePath)));
  const root = join(parent, preparedDirectoryName(databasePath));
  privateDirectory(root);
  return root;
}
export function inputIntent(
  root: string,
  source: string,
  runId: string,
  scope: GoalScope,
): PreparedInput {
  privateDirectory(root);
  if (
    !/^[a-f0-9-]{36}$/.test(runId) ||
    realpathSync(source) !== source ||
    isWithin(source, root) ||
    isWithin(root, source)
  )
    throw new Error("Invalid source or prepared input location");
  const id = randomUUID();
  return {
    id,
    runId,
    directory: join(root, `${runId}-${id}`),
    source,
    scope,
    phase: "preparing",
    revision: null,
    digest: null,
    files: [],
  };
}
export async function assertSourceUnchanged(input: PreparedInput, signal: AbortSignal) {
  if (input.phase !== "ready" || (await sourceRevision(input.source, signal)) !== input.revision)
    throw new Error("Prepared source changed during execution");
}

// Read immutable Git blobs, never follow a source worktree symlink or copy an untracked credential.
export async function prepareWorkspace(
  intent: PreparedInput,
  signal: AbortSignal,
): Promise<PreparedInput> {
  const revision = await sourceRevision(intent.source, signal);
  const input = await prepareGitWorkspace(intent, signal, { directory: intent.source, revision });
  await assertSourceUnchanged(input, signal);
  return input;
}

// The caller verifies the recorded source before and after copying. Both original
// and accepted development inputs use the same scoped immutable-blob reader.
export async function prepareGitWorkspace(
  intent: PreparedInput,
  signal: AbortSignal,
  snapshot: { directory: string; revision: string },
): Promise<PreparedInput> {
  signal.throwIfAborted();
  mkdirSync(intent.directory, { mode: 0o700 });
  writeFileSync(
    join(intent.directory, marker),
    JSON.stringify({ id: intent.id, runId: intent.runId }),
    { mode: 0o600, flag: "wx" },
  );
  const { revision } = snapshot;
  const files = scopedGitFiles(
    await readGitTree(snapshot.directory, revision, signal),
    intent.scope,
  );
  const contents = await readGitBlobs(snapshot.directory, files, signal);
  for (const [index, file] of files.entries()) {
    signal.throwIfAborted();
    const destination = join(intent.directory, file.path);
    if (!isWithin(intent.directory, destination) || file.path === marker)
      throw new Error("Invalid prepared destination");
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, contents[index]!, {
      mode: file.mode === "100755" ? 0o700 : 0o600,
      flag: "wx",
    });
  }
  // A fresh Git root prevents discovery of configuration in the server's ancestor repository.
  await git(intent.directory, ["init", "--quiet", "--template="], signal);
  const input: PreparedInput = {
    ...intent,
    phase: "ready",
    revision,
    files,
    digest: createHash("sha256")
      .update(JSON.stringify({ revision, scope: intent.scope, files }))
      .digest("hex"),
  };
  return input;
}

export function removePreparedWorkspace(root: string, input: PreparedInput) {
  privateDirectory(root);
  if (
    input.directory !== join(root, `${input.runId}-${input.id}`) ||
    !isWithin(root, input.directory)
  )
    throw new Error("Prepared input identity mismatch");
  let stat;
  try {
    stat = lstatSync(input.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
    throw new Error("Prepared input ownership changed");
  const markerPath = join(input.directory, marker),
    markerStat = lstatSync(markerPath);
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 1024)
    throw new Error("Prepared input marker changed");
  const identity = JSON.parse(readFileSync(markerPath, "utf8"));
  if (identity.id !== input.id || identity.runId !== input.runId)
    throw new Error("Prepared input identity mismatch");
  rmSync(input.directory, { recursive: true });
}
