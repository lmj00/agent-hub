import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isWithin } from "../execution/execution-config.js";

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
  scope: GoalScope;
  phase: "preparing" | "ready";
  revision: string | null;
  digest: string | null;
  files: { path: string; blob: string; bytes: number }[];
};
const maxFiles = 500,
  maxFileBytes = 1048576,
  maxBytes = 8 * 1048576;
const marker = ".hub-prepared-input.json";
const gitEnv = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_NO_LAZY_FETCH: "1",
  GIT_ALLOW_PROTOCOL: "",
};
const gitOptions = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
];

function git(
  source: string,
  args: string[],
  signal: AbortSignal,
  input?: string,
): Promise<Buffer> {
  return new Promise((accept, reject) => {
    const child = execFile(
      "git",
      [...gitOptions, ...args],
      {
        cwd: source,
        env: gitEnv,
        signal,
        timeout: 5000,
        killSignal: "SIGKILL",
        maxBuffer: maxBytes + 1048576,
        encoding: "buffer",
      },
      (error, stdout) =>
        error
          ? reject(new Error("Unable to read prepared Git source"))
          : accept(stdout),
    );
    child.stdin?.on("error", () => child.kill("SIGKILL"));
    child.stdin?.end(input);
  });
}
function safePath(path: string) {
  return (
    path !== "" &&
    !path.startsWith("/") &&
    !/[\\\x00-\x1f]/.test(path) &&
    path
      .split("/")
      .every((part) => part !== "." && part !== ".." && part !== "")
  );
}
const contains = (parent: string, child: string) =>
  parent === "." || parent === child || child.startsWith(`${parent}/`);
export function allowedGoalPath(
  path: string,
  scope: Pick<GoalScope, "allowedPaths" | "excludedPaths">,
) {
  return (
    safePath(path) &&
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
        ) ||
        /\.(?:pem|key|p12|pfx|sqlite(?:3)?|db)(?:-(?:wal|shm|journal))?$/i.test(
          part,
        ),
    );
}
function privateDirectory(path: string) {
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
    throw new Error(
      "Prepared input directory must be private and owned by this user",
    );
}
export function preparedInputRoot(databasePath: string) {
  const parent = realpathSync(dirname(resolve(databasePath)));
  const root = join(
    parent,
    `.prepared-${createHash("sha256").update(resolve(databasePath)).digest("hex").slice(0, 16)}`,
  );
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
async function sourceRevision(source: string, signal: AbortSignal) {
  // Even status may execute a repository's clean filter. Inspect names without
  // returning config values, and reject filters before touching the worktree.
  const configNames = (
    await git(source, ["config", "--null", "--name-only", "--list"], signal)
  )
    .toString()
    .split("\0");
  if (configNames.some((name) => /^filter\./i.test(name)))
    throw new Error("Goal source cannot configure Git filters");
  const top = (await git(source, ["rev-parse", "--show-toplevel"], signal))
    .toString()
    .trim();
  if (realpathSync(top) !== source)
    throw new Error("Goal source must be a Git working tree root");
  const tracked = (await git(source, ["ls-files", "-v", "-z"], signal))
    .toString()
    .split("\0")
    .filter(Boolean);
  if (tracked.some((entry) => /^[a-zS]/.test(entry)))
    throw new Error("Goal source cannot hide worktree changes");
  const status = await git(
    source,
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=normal",
      "--ignore-submodules=all",
    ],
    signal,
  );
  if (status.length)
    throw new Error(
      "Goal source must have committed changes before preparation",
    );
  const revision = (
    await git(source, ["rev-parse", "--verify", "HEAD"], signal)
  )
    .toString()
    .trim();
  if (!/^[a-f0-9]{40,64}$/.test(revision))
    throw new Error("Goal source requires an initial commit");
  return revision;
}
export async function assertSourceUnchanged(
  input: PreparedInput,
  signal: AbortSignal,
) {
  if (
    input.phase !== "ready" ||
    (await sourceRevision(input.source, signal)) !== input.revision
  )
    throw new Error("Prepared source changed during execution");
}

// Read immutable Git blobs, never follow a source worktree symlink or copy an untracked credential.
export async function prepareWorkspace(
  intent: PreparedInput,
  signal: AbortSignal,
): Promise<PreparedInput> {
  signal.throwIfAborted();
  mkdirSync(intent.directory, { mode: 0o700 });
  writeFileSync(
    join(intent.directory, marker),
    JSON.stringify({ id: intent.id, runId: intent.runId }),
    { mode: 0o600, flag: "wx" },
  );
  const revision = await sourceRevision(intent.source, signal);
  const tree = await git(
    intent.source,
    ["ls-tree", "-r", "-l", "-z", "--full-tree", revision],
    signal,
  );
  if (!Buffer.from(tree.toString("utf8")).equals(tree))
    throw new Error("Git tree paths must be UTF-8");
  const files: PreparedInput["files"] = [];
  let total = 0;
  for (const entry of tree.toString("utf8").split("\0").filter(Boolean)) {
    const match = /^(\d+) (\w+) ([a-f0-9]{40,64})\s+([\d-]+)\t([\s\S]+)$/.exec(
      entry,
    );
    if (!match) throw new Error("Invalid Git tree entry");
    const [, mode, type, blob, size, path] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (!safePath(path)) throw new Error("Invalid Git tree path");
    if (!allowedGoalPath(path, intent.scope) || privateInputPath(path))
      continue;
    if (!["100644", "100755"].includes(mode) || type !== "blob")
      throw new Error("Goal scope contains a symlink or submodule");
    const bytes = Number(size);
    total += bytes;
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > maxFileBytes ||
      total > maxBytes ||
      files.length >= maxFiles
    )
      throw new Error("Prepared input exceeds file or byte limits");
    files.push({ path, blob, bytes });
  }
  if (files.length) {
    const contents = await git(
      intent.source,
      ["cat-file", "--batch"],
      signal,
      files.map((file) => file.blob).join("\n") + "\n",
    );
    let position = 0;
    for (const file of files) {
      signal.throwIfAborted();
      const end = contents.indexOf(10, position);
      if (
        end < 0 ||
        contents.subarray(position, end).toString() !==
          `${file.blob} blob ${file.bytes}`
      )
        throw new Error("Git blob does not match manifest");
      const start = end + 1,
        next = start + file.bytes;
      if (contents[next] !== 10) throw new Error("Incomplete Git blob");
      const destination = join(intent.directory, file.path);
      if (!isWithin(intent.directory, destination) || file.path === marker)
        throw new Error("Invalid prepared destination");
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, contents.subarray(start, next), {
        mode: 0o600,
        flag: "wx",
      });
      position = next + 1;
    }
    if (position !== contents.length)
      throw new Error("Unexpected Git blob data");
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
  await assertSourceUnchanged(input, signal);
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
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.()
  )
    throw new Error("Prepared input ownership changed");
  const markerPath = join(input.directory, marker),
    markerStat = lstatSync(markerPath);
  if (
    !markerStat.isFile() ||
    markerStat.isSymbolicLink() ||
    markerStat.size > 1024
  )
    throw new Error("Prepared input marker changed");
  const identity = JSON.parse(readFileSync(markerPath, "utf8"));
  if (identity.id !== input.id || identity.runId !== input.runId)
    throw new Error("Prepared input identity mismatch");
  rmSync(input.directory, { recursive: true });
}
