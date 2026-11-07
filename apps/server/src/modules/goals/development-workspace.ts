import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
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
export const developmentRef = "refs/heads/development";
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
  headTree: string;
};
export type DevelopmentInput = {
  id: string;
  runId: string;
  repositoryId: string;
  directory: string;
  revision: string;
  tree: string;
  previousCandidate: string | null;
  scope: GoalScope;
  writePaths: string[];
  files: ScopedGitFile[];
  digest: string;
};
export type DevelopmentInputIntent = Omit<DevelopmentInput, "files" | "digest">;
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
    headTree: tree,
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
  publishRecord(intent.directory, "repository.ready.json", repository);
  return repository;
}

function publishRecord(directory: string, name: string, value: unknown) {
  const temporary = join(directory, `${name}-${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(value), {
    mode: 0o600,
    flag: "wx",
    flush: true,
  });
  renameSync(temporary, join(directory, name));
}

function readPrivateRecord(path: string, maxBytes: number): unknown {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > maxBytes
  )
    throw new Error("Development record identity changed");
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertPrivateDirectory(path: string) {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(path) !== path ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error("Development directory identity changed");
}

export async function recoverDevelopmentRepository(
  intent: DevelopmentRepositoryIntent,
  signal: AbortSignal,
): Promise<DevelopmentRepository> {
  assertPrivateDirectory(intent.directory);
  const repository = readPrivateRecord(
    join(intent.directory, "repository.ready.json"),
    16384,
  ) as DevelopmentRepository;
  if (
    repository.id !== intent.id ||
    repository.projectId !== intent.projectId ||
    repository.directory !== intent.directory ||
    repository.source !== intent.source
  )
    throw new Error("Development repository identity changed");
  await assertDevelopmentBase(repository, signal);
  await git(
    join(repository.directory, "git"),
    ["fsck", "--connectivity-only"],
    signal,
    undefined,
    { timeout: 15000 },
  );
  return repository;
}

export async function assertDevelopmentRepository(
  repository: DevelopmentRepository,
  signal: AbortSignal,
) {
  if (
    !oid.test(repository.sourceRevision) ||
    !oid.test(repository.head) ||
    !oid.test(repository.headTree)
  )
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
  return storage;
}

export async function assertDevelopmentBase(
  repository: DevelopmentRepository,
  signal: AbortSignal,
) {
  const storage = await assertDevelopmentRepository(repository, signal);
  const actual = (
    await git(storage, ["rev-parse", "--verify", developmentRef], signal)
  )
    .toString()
    .trim();
  if (actual !== repository.head)
    throw new Error(
      "Development branch changed outside the recorded application",
    );
  if (
    (await git(storage, ["rev-parse", `${actual}^{tree}`], signal))
      .toString()
      .trim() !== repository.headTree
  )
    throw new Error("Development branch tree changed");
}

function inputIdentity(input: Omit<DevelopmentInput, "digest">) {
  return {
    id: input.id,
    runId: input.runId,
    repositoryId: input.repositoryId,
    revision: input.revision,
    tree: input.tree,
    previousCandidate: input.previousCandidate,
    scope: input.scope,
    writePaths: input.writePaths,
    files: input.files,
  };
}

export function developmentInputIntent(
  root: string,
  repository: DevelopmentRepository,
  runId: string,
  scope: GoalScope,
  writePaths: string[],
  previous?: DevelopmentCandidate,
): DevelopmentInputIntent {
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
  if (
    previous &&
    (previous.repositoryId !== repository.id ||
      previous.baseRevision !== repository.head ||
      !validCandidateDigest(previous))
  )
    throw new Error(
      "Previous development candidate does not match this repository",
    );
  const id = randomUUID();
  return {
    id,
    runId,
    repositoryId: repository.id,
    directory: join(root, `${runId}-${id}`, "workspace"),
    revision: repository.head,
    tree: previous?.tree ?? repository.headTree,
    previousCandidate: previous?.digest ?? null,
    scope: structuredClone(scope),
    writePaths: [...writePaths],
  };
}

export async function prepareDevelopmentInput(
  intent: DevelopmentInputIntent,
  repository: DevelopmentRepository,
  signal: AbortSignal,
): Promise<DevelopmentInput> {
  signal.throwIfAborted();
  if (
    intent.repositoryId !== repository.id ||
    intent.revision !== repository.head ||
    !oid.test(intent.tree)
  )
    throw new Error("Development input is stale");
  await assertDevelopmentBase(repository, signal);
  const storage = join(repository.directory, "git");
  const files = scopedGitFiles(
    await readGitTree(storage, intent.tree, signal),
    intent.scope,
  );
  const contents = await readGitBlobs(storage, files, signal);
  const directory = intent.directory,
    parent = dirname(directory);
  const prepared = { ...intent, files };
  mkdirSync(parent, { mode: 0o700 });
  writeFileSync(join(parent, "input.intent.json"), JSON.stringify(intent), {
    mode: 0o600,
    flag: "wx",
  });
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
  const input = { ...prepared, digest: digest(inputIdentity(prepared)) };
  publishRecord(parent, "input.ready.json", input);
  return input;
}

export function validInputDigest(input: DevelopmentInput) {
  return input.digest === digest(inputIdentity(input));
}

export function validCandidateDigest(candidate: DevelopmentCandidate) {
  const { digest: expected, ...record } = candidate;
  return expected === digest(record);
}

export async function recoverDevelopmentInput(
  intent: DevelopmentInputIntent,
  repository: DevelopmentRepository,
  signal: AbortSignal,
): Promise<DevelopmentInput> {
  if (
    intent.repositoryId !== repository.id ||
    intent.revision !== repository.head ||
    !oid.test(intent.tree)
  )
    throw new Error("Development input is stale");
  assertPrivateDirectory(dirname(intent.directory));
  assertPrivateDirectory(intent.directory);
  const input = readPrivateRecord(
    join(dirname(intent.directory), "input.ready.json"),
    1024 * 1024,
  ) as DevelopmentInput;
  const { files, digest: _digest, ...identity } = input;
  if (
    JSON.stringify(identity) !== JSON.stringify(intent) ||
    !validInputDigest(input)
  )
    throw new Error("Development input identity changed");
  await assertDevelopmentBase(repository, signal);
  const expected = scopedGitFiles(
    await readGitTree(join(repository.directory, "git"), input.tree, signal),
    input.scope,
  );
  if (JSON.stringify(expected) !== JSON.stringify(files))
    throw new Error("Development input manifest changed");
  const expectedPaths = new Set(files.map((file) => file.path));
  const walk = (directory: string, prefix = "") => {
    for (const name of readdirSync(directory)) {
      if (!prefix && name === ".git") continue;
      const relative = prefix ? `${prefix}/${name}` : name,
        path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        assertPrivateDirectory(path);
        if (!files.some((file) => file.path.startsWith(`${relative}/`)))
          throw new Error("Unexpected development input directory");
        walk(path, relative);
      } else if (!stat.isFile() || !expectedPaths.has(relative))
        throw new Error("Unexpected development input file");
    }
  };
  walk(input.directory);
  for (const file of files) {
    const path = join(input.directory, file.path);
    if (realpathSync(path) !== path)
      throw new Error("Development input file became a link");
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size !== file.bytes ||
      (stat.mode & 0o111 ? "100755" : "100644") !== file.mode
    )
      throw new Error("Development input file changed");
    const content = readFileSync(path);
    const hash = createHash(input.revision.length === 64 ? "sha256" : "sha1")
      .update(`blob ${content.length}\0`)
      .update(content)
      .digest("hex");
    if (hash !== file.blob) throw new Error("Development input file changed");
  }
  return input;
}

export function removeDevelopmentInput(
  root: string,
  input: DevelopmentInputIntent,
) {
  privateDirectory(root);
  const parent = join(root, `${input.runId}-${input.id}`);
  if (input.directory !== join(parent, "workspace") || !isWithin(root, parent))
    throw new Error("Development input identity mismatch");
  try {
    lstatSync(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  assertPrivateDirectory(parent);
  const stored = readPrivateRecord(
    join(parent, "input.intent.json"),
    1024 * 1024,
  ) as DevelopmentInputIntent;
  if (
    stored.id !== input.id ||
    stored.runId !== input.runId ||
    stored.repositoryId !== input.repositoryId ||
    stored.directory !== input.directory
  )
    throw new Error("Development input identity mismatch");
  rmSync(parent, { recursive: true });
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
    !validInputDigest(input)
  )
    throw new Error("Development input is stale or changed");
  const changes = readChanges(input, result);
  await assertDevelopmentBase(repository, signal);
  const storage = join(repository.directory, "git");
  const entries = (await readGitTree(storage, input.tree, signal)).filter(
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
  const updates: string[] = [];
  try {
    await git(storage, ["read-tree", input.tree], signal, undefined, {
      indexFile,
    });
    // Delete first so an explicitly authorized file -> directory replacement can succeed.
    for (const change of [...changes].sort(
      (a, b) => Number(a.content !== null) - Number(b.content !== null),
    )) {
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
    const manifest = await describeChanges(repository, input, tree, signal);
    await assertDevelopmentBase(repository, signal);
    const candidate = {
      repositoryId: repository.id,
      runId: input.runId,
      baseRevision: input.revision,
      inputDigest: input.digest,
      tree,
      changes: manifest,
    };
    return { ...candidate, digest: digest(candidate) };
  } finally {
    rmSync(indexFile, { force: true });
    rmSync(`${indexFile}.lock`, { force: true });
  }
}

async function describeChanges(
  repository: DevelopmentRepository,
  input: DevelopmentInput,
  tree: string,
  signal: AbortSignal,
): Promise<DevelopmentCandidate["changes"]> {
  const storage = join(repository.directory, "git");
  const original = new Map(
    (await readGitTree(storage, repository.headTree, signal))
      .filter((entry) => entry.type !== "tree")
      .map((entry) => [entry.path, entry]),
  );
  const entries = await readGitTree(storage, tree, signal);
  checkBaseline(entries);
  scopedGitFiles(entries, input.scope);
  const final = new Map(
    entries
      .filter((entry) => entry.type !== "tree")
      .map((entry) => [entry.path, entry]),
  );
  const changes: DevelopmentCandidate["changes"] = [];
  for (const path of new Set([...original.keys(), ...final.keys()])) {
    const before = original.get(path),
      after = final.get(path);
    if (before?.blob === after?.blob && before?.mode === after?.mode) continue;
    if (
      !allowedGoalPath(path, input.scope) ||
      !allowedGoalPath(path, {
        allowedPaths: input.writePaths,
        excludedPaths: [],
      }) ||
      privateInputPath(path) ||
      (after &&
        (after.type !== "blob" || !["100644", "100755"].includes(after.mode)))
    )
      throw new Error("Cumulative development changes exceed permitted scope");
    changes.push({
      path,
      before: before?.blob ?? null,
      after: after?.blob ?? null,
      mode: after?.mode ?? null,
      bytes: after?.bytes ?? 0,
    });
  }
  if (changes.length > maxChanges)
    throw new Error("Cumulative development changes exceed limits");
  return changes.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

export async function verifyDevelopmentCandidate(
  repository: DevelopmentRepository,
  input: DevelopmentInput,
  candidate: DevelopmentCandidate,
  signal: AbortSignal,
) {
  if (
    !validCandidateDigest(candidate) ||
    !validInputDigest(input) ||
    input.repositoryId !== repository.id ||
    candidate.repositoryId !== repository.id ||
    candidate.runId !== input.runId ||
    candidate.baseRevision !== repository.head ||
    input.revision !== repository.head ||
    candidate.inputDigest !== input.digest
  )
    throw new Error("Development candidate identity changed");
  await assertDevelopmentBase(repository, signal);
  if (
    JSON.stringify(candidate.changes) !==
    JSON.stringify(
      await describeChanges(repository, input, candidate.tree, signal),
    )
  )
    throw new Error("Development candidate tree changed");
}
