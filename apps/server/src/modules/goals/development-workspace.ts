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
import {
  allowedGoalPath,
  privateDirectory,
  privateInputPath,
  scopedGitFiles,
  type GoalScope,
  type ScopedGitFile,
} from "./prepared-workspace.js";
import {
  git,
  readGitBlobs,
  readGitTree,
  safeGitPath,
  sourceRevision,
  type GitEntry,
} from "./workspace-git.js";

const maxBaselineBytes = 64 * 1048576,
  maxBaselineEntries = 10000;
const maxChangeBytes = 8 * 1048576,
  maxFileBytes = 1048576,
  maxChanges = 500;
const developmentRef = "refs/heads/development";
const marker = "repository.json";
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const uuid = /^[a-f0-9-]{36}$/;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export type DevelopmentRepositoryIntent = {
  id: string;
  projectId: string;
  directory: string;
  source: string;
};
export type DevelopmentRepository = DevelopmentRepositoryIntent & {
  sourceRevision: string;
  // The caller persists this expected head. Never infer acceptance from a changed ref.
  head: string;
};
export type DevelopmentInput = {
  id: string;
  runId: string;
  repositoryId: string;
  directory: string;
  revision: string;
  scope: GoalScope;
  writePaths: string[];
  files: ScopedGitFile[];
  digest: string;
};
export type DevelopmentCandidate = {
  repositoryId: string;
  runId: string;
  baseRevision: string;
  inputDigest: string;
  tree: string;
  digest: string;
  changes: {
    path: string;
    before: string | null;
    after: string | null;
    mode: string | null;
    bytes: number;
  }[];
};

export function developmentRoot(databasePath: string) {
  const root = join(
    realpathSync(dirname(resolve(databasePath))),
    `.development-${digest(resolve(databasePath)).slice(0, 16)}`,
  );
  privateDirectory(root);
  return root;
}

// Persist this intent before creating files. Failed preparations are not automatically reused.
export function developmentRepositoryIntent(
  root: string,
  source: string,
  projectId: string,
): DevelopmentRepositoryIntent {
  privateDirectory(root);
  if (
    !uuid.test(projectId) ||
    realpathSync(root) !== root ||
    realpathSync(source) !== source ||
    isWithin(source, root) ||
    isWithin(root, source)
  )
    throw new Error("Invalid development repository location or project");
  const id = randomUUID();
  return { id, projectId, directory: join(root, id), source };
}

function assertPaths(entries: { path: string }[]) {
  const spelling = new Map<string, string>(),
    leaves = new Set<string>(),
    directories = new Set<string>();
  for (const { path } of entries) {
    if (
      !safeGitPath(path) ||
      Buffer.byteLength(path) > 1024 ||
      path.split("/").length > 32
    )
      throw new Error("Invalid development path or depth limits");
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/"),
        key = prefix.normalize("NFC").toLowerCase();
      if (spelling.has(key) && spelling.get(key) !== prefix)
        throw new Error("Development paths have a case or Unicode collision");
      spelling.set(key, prefix);
      if (i < parts.length) directories.add(key);
      if (i < parts.length && leaves.has(key))
        throw new Error("Development file conflicts with directory");
    }
    const key = path.normalize("NFC").toLowerCase();
    if (leaves.has(key)) throw new Error("Duplicate development path");
    leaves.add(key);
  }
  for (const key of leaves)
    if (directories.has(key))
      throw new Error("Development file conflicts with directory");
}

function checkBaseline(entries: GitEntry[]) {
  if (
    entries.length > maxBaselineEntries ||
    entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0) >
      maxBaselineBytes
  )
    throw new Error("Development baseline exceeds file or byte limits");
  assertPaths(entries.filter((entry) => entry.type !== "tree"));
}

export async function prepareDevelopmentRepository(
  intent: DevelopmentRepositoryIntent,
  signal: AbortSignal,
): Promise<DevelopmentRepository> {
  signal.throwIfAborted();
  const revision = await sourceRevision(intent.source, signal);
  const entries = await readGitTree(intent.source, revision, signal);
  checkBaseline(entries);
  const tree = (
    await git(intent.source, ["rev-parse", `${revision}^{tree}`], signal)
  )
    .toString()
    .trim();
  const objects = [
    ...new Set([
      revision,
      tree,
      ...entries
        .filter((entry) => entry.type !== "commit")
        .map((entry) => entry.blob),
    ]),
  ];
  // Explicit objects, without --revs: import this snapshot, not the original history.
  const pack = await git(
    intent.source,
    [
      "pack-objects",
      "--stdout",
      "--compression=0",
      "--window=0",
      "--depth=0",
      "--no-reuse-object",
      "--no-reuse-delta",
    ],
    signal,
    objects.join("\n") + "\n",
    { maxBuffer: maxBaselineBytes + 8 * 1048576, timeout: 15000 },
  );
  mkdirSync(intent.directory, { mode: 0o700 });
  const repository: DevelopmentRepository = {
    ...intent,
    sourceRevision: revision,
    head: revision,
  };
  writeFileSync(join(intent.directory, marker), JSON.stringify(repository), {
    mode: 0o600,
    flag: "wx",
  });
  const storage = join(intent.directory, "git");
  mkdirSync(storage, { mode: 0o700 });
  await git(
    storage,
    [
      "init",
      "--bare",
      "--quiet",
      "--template=",
      `--object-format=${revision.length === 64 ? "sha256" : "sha1"}`,
    ],
    signal,
  );
  writeFileSync(join(storage, "shallow"), `${revision}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await git(storage, ["index-pack", "--stdin"], signal, pack, {
    timeout: 15000,
  });
  await git(
    storage,
    ["update-ref", developmentRef, revision, "0".repeat(revision.length)],
    signal,
  );
  await git(storage, ["symbolic-ref", "HEAD", developmentRef], signal);
  await git(storage, ["fsck", "--connectivity-only"], signal, undefined, {
    timeout: 15000,
  });
  await assertDevelopmentBase(repository, signal);
  return repository;
}

export async function assertDevelopmentBase(
  repository: DevelopmentRepository,
  signal: AbortSignal,
) {
  if (!oid.test(repository.sourceRevision) || !oid.test(repository.head))
    throw new Error("Invalid development revision");
  privateDirectory(repository.directory);
  const path = join(repository.directory, marker),
    stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384)
    throw new Error("Development repository identity changed");
  const identity = JSON.parse(
    readFileSync(path, "utf8"),
  ) as DevelopmentRepository;
  if (
    identity.id !== repository.id ||
    identity.projectId !== repository.projectId ||
    identity.source !== repository.source ||
    identity.sourceRevision !== repository.sourceRevision
  )
    throw new Error("Development repository identity changed");
  const storage = join(repository.directory, "git");
  privateDirectory(storage);
  if (
    (await sourceRevision(repository.source, signal)) !==
    repository.sourceRevision
  )
    throw new Error("Original source changed during development");
  const actual = (
    await git(storage, ["rev-parse", "--verify", developmentRef], signal)
  )
    .toString()
    .trim();
  if (actual !== repository.head)
    throw new Error(
      "Development branch changed outside the recorded application",
    );
}

function inputIdentity(input: Omit<DevelopmentInput, "digest">) {
  return {
    id: input.id,
    runId: input.runId,
    repositoryId: input.repositoryId,
    revision: input.revision,
    scope: input.scope,
    writePaths: input.writePaths,
    files: input.files,
  };
}

export async function prepareDevelopmentInput(
  root: string,
  repository: DevelopmentRepository,
  runId: string,
  scope: GoalScope,
  writePaths: string[],
  signal: AbortSignal,
): Promise<DevelopmentInput> {
  signal.throwIfAborted();
  privateDirectory(root);
  if (
    !uuid.test(runId) ||
    realpathSync(root) !== root ||
    isWithin(repository.source, root) ||
    isWithin(root, repository.source) ||
    isWithin(repository.directory, root) ||
    isWithin(root, repository.directory)
  )
    throw new Error("Invalid development input location or Run");
  if (
    !writePaths.length ||
    writePaths.length > maxChanges ||
    writePaths.some(
      (path) => !allowedGoalPath(path, scope) || privateInputPath(path),
    )
  )
    throw new Error("Task write paths exceed Goal scope");
  await assertDevelopmentBase(repository, signal);
  const storage = join(repository.directory, "git");
  const files = scopedGitFiles(
    await readGitTree(storage, repository.head, signal),
    scope,
  );
  const contents = await readGitBlobs(storage, files, signal);
  const id = randomUUID(),
    directory = join(root, `${runId}-${id}`);
  const prepared = {
    id,
    runId,
    repositoryId: repository.id,
    directory,
    revision: repository.head,
    scope: structuredClone(scope),
    writePaths: [...writePaths],
    files,
  };
  mkdirSync(directory, { mode: 0o700 });
  for (const [index, file] of files.entries()) {
    const path = join(directory, file.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, contents[index]!, {
      mode: file.mode === "100755" ? 0o700 : 0o600,
      flag: "wx",
    });
  }
  // Empty Git root only; no private objects, configuration, remotes or source history.
  await git(directory, ["init", "--quiet", "--template="], signal);
  await assertDevelopmentBase(repository, signal);
  return { ...prepared, digest: digest(inputIdentity(prepared)) };
}

type Change = {
  path: string;
  mode: "100644" | "100755" | null;
  content: Buffer | null;
};
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readChanges(input: DevelopmentInput, result: unknown): Change[] {
  if (
    !object(result) ||
    Object.keys(result).length !== 3 ||
    result.baseRevision !== input.revision ||
    result.inputDigest !== input.digest ||
    !Array.isArray(result.changes) ||
    result.changes.length > maxChanges
  )
    throw new Error(
      "Development change bundle does not match input or exceeds limits",
    );
  let total = 0;
  const paths = new Set<string>();
  return result.changes.map((change): Change => {
    if (
      !object(change) ||
      Object.keys(change).length !== 3 ||
      typeof change.path !== "string" ||
      !allowedGoalPath(change.path, input.scope) ||
      privateInputPath(change.path) ||
      !allowedGoalPath(change.path, {
        allowedPaths: input.writePaths,
        excludedPaths: [],
      })
    )
      throw new Error("Development change exceeds Task or Goal scope");
    const key = change.path.normalize("NFC").toLowerCase();
    if (paths.has(key)) throw new Error("Duplicate development change");
    paths.add(key);
    if (change.content === null && change.mode === null)
      return { path: change.path, mode: null, content: null };
    if (
      (change.mode !== "100644" && change.mode !== "100755") ||
      typeof change.content !== "string" ||
      change.content.length > Math.ceil(maxFileBytes / 3) * 4
    )
      throw new Error("Invalid development file mode or byte limits");
    const content = Buffer.from(change.content, "base64");
    if (
      content.toString("base64") !== change.content ||
      content.length > maxFileBytes ||
      (total += content.length) > maxChangeBytes
    )
      throw new Error("Invalid development content or byte limits");
    return { path: change.path, mode: change.mode, content };
  });
}

// Construct from immutable base + validated bytes. Never run Git against AI-writable files/config.
// This does not advance the branch. Tests/review and ChangeApplication must approve that separately.
export async function stageDevelopmentCandidate(
  repository: DevelopmentRepository,
  input: DevelopmentInput,
  result: unknown,
  signal: AbortSignal,
): Promise<DevelopmentCandidate> {
  signal.throwIfAborted();
  if (
    input.repositoryId !== repository.id ||
    input.revision !== repository.head ||
    input.digest !== digest(inputIdentity(input))
  )
    throw new Error("Development input is stale or changed");
  const changes = readChanges(input, result);
  await assertDevelopmentBase(repository, signal);
  const storage = join(repository.directory, "git");
  const entries = (await readGitTree(storage, input.revision, signal)).filter(
    (entry) => entry.type !== "tree",
  );
  const final = new Map(entries.map((entry) => [entry.path, entry]));
  for (const change of changes) {
    if (change.content === null) {
      if (!final.delete(change.path))
        throw new Error("Cannot delete an absent development file");
    } else
      final.set(change.path, {
        path: change.path,
        mode: change.mode!,
        type: "blob",
        blob: "",
        bytes: change.content.length,
      });
  }
  checkBaseline([...final.values()]);
  // The complete scoped result must still fit, including unchanged context files.
  scopedGitFiles([...final.values()], input.scope);
  const indexFile = join(repository.directory, `index-${randomUUID()}`);
  const manifest: DevelopmentCandidate["changes"] = [];
  const updates: string[] = [];
  try {
    await git(storage, ["read-tree", input.revision], signal, undefined, {
      indexFile,
    });
    // Delete first so an explicitly authorized file -> directory replacement can succeed.
    for (const change of [...changes].sort(
      (a, b) => Number(a.content !== null) - Number(b.content !== null),
    )) {
      const before =
        entries.find((entry) => entry.path === change.path)?.blob ?? null;
      const after =
        change.content === null
          ? null
          : (
              await git(
                storage,
                ["hash-object", "-w", "--stdin", "-t", "blob"],
                signal,
                change.content,
              )
            )
              .toString()
              .trim();
      const line =
        after === null
          ? `0 ${"0".repeat(input.revision.length)}\t${change.path}\0`
          : `${change.mode} ${after}\t${change.path}\0`;
      updates.push(line);
      manifest.push({
        path: change.path,
        before,
        after,
        mode: change.mode,
        bytes: change.content?.length ?? 0,
      });
    }
    if (updates.length)
      await git(
        storage,
        ["update-index", "-z", "--index-info"],
        signal,
        updates.join(""),
        { indexFile },
      );
    const tree = (
      await git(storage, ["write-tree"], signal, undefined, { indexFile })
    )
      .toString()
      .trim();
    checkBaseline(await readGitTree(storage, tree, signal));
    await assertDevelopmentBase(repository, signal);
    const candidate = {
      repositoryId: repository.id,
      runId: input.runId,
      baseRevision: input.revision,
      inputDigest: input.digest,
      tree,
      changes: manifest.sort((a, b) => a.path.localeCompare(b.path, "en")),
    };
    return { ...candidate, digest: digest(candidate) };
  } finally {
    rmSync(indexFile, { force: true });
    rmSync(`${indexFile}.lock`, { force: true });
  }
}
