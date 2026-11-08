import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  assertDevelopmentBase,
  developmentRepositoryIntent,
  developmentRoot,
  prepareDevelopmentInput,
  developmentInputIntent,
  prepareDevelopmentRepository,
  stageDevelopmentCandidate,
  recoverDevelopmentRepository,
  recoverDevelopmentInput,
  removeDevelopmentInput,
  verifyDevelopmentCandidate,
  type DevelopmentInput,
  type DevelopmentRepository,
} from "../../src/modules/workspace/development-workspace.js";
import {
  preparedInputRoot,
  type GoalScope,
} from "../../src/modules/workspace/prepared-workspace.js";

let directory: string, source: string, root: string, inputs: string;
const signal = () => new AbortController().signal;
const scope: GoalScope = {
  goalId: "goal",
  goalVersion: 1,
  allowedPaths: ["src", "tests"],
  excludedPaths: ["src/private"],
};
function git(cwd: string, args: string[], input?: string) {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd,
      input,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    },
  ).trim();
}
function file(path: string, content: string | Buffer = "fixture") {
  mkdirSync(dirname(join(source, path)), { recursive: true });
  writeFileSync(join(source, path), content);
}
function commit() {
  git(source, ["add", "--all"]);
  git(source, ["commit", "--quiet", "--allow-empty", "-m", "fixture"]);
  return git(source, ["rev-parse", "HEAD"]);
}
async function repository() {
  return prepareDevelopmentRepository(
    developmentRepositoryIntent(root, source, randomUUID()),
    signal(),
  );
}
function input(repo: DevelopmentRepository, paths = ["src"], selected = scope) {
  return prepareDevelopmentInput(
    developmentInputIntent(inputs, repo, randomUUID(), selected, paths),
    repo,
    signal(),
  );
}
function change(path: string, content: string | Buffer | null, mode: string = "100644") {
  return {
    path,
    mode: content === null ? null : mode,
    content: content === null ? null : Buffer.from(content).toString("base64"),
  };
}
function bundle(prepared: DevelopmentInput, changes: unknown[]) {
  return {
    baseRevision: prepared.revision,
    inputDigest: prepared.digest,
    changes,
  };
}
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-development-")));
  source = join(directory, "source");
  mkdirSync(source);
  git(source, ["init", "--quiet", "--template="]);
  root = developmentRoot(join(directory, "hub.sqlite"));
  inputs = preparedInputRoot(join(directory, "hub.sqlite"));
  file("src/main.ts", "export const answer = 1;\n");
  file("src/delete.ts", "old\n");
  file("tests/main.test.ts", "test context\n");
  file("src/private/customer.json", "excluded fixture");
  file("src/.env", "secret fixture");
  file("outside.txt", "outside\n");
  commit();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

test("only a fully published repository can be adopted after restart", async () => {
  const intent = developmentRepositoryIntent(root, source, randomUUID());
  const repo = await prepareDevelopmentRepository(intent, signal());
  expect(await recoverDevelopmentRepository(intent, signal())).toEqual(repo);
  rmSync(join(repo.directory, "repository.ready.json"));
  await expect(recoverDevelopmentRepository(intent, signal())).rejects.toThrow();
  expect(git(source, ["status", "--porcelain"])).toBe("");
  const missing = developmentRepositoryIntent(root, source, randomUUID());
  await expect(recoverDevelopmentRepository(missing, signal())).rejects.toThrow();
  expect(existsSync(missing.directory)).toBe(false);
});

test("input recovery checks publication, contents, repository identity and accepted head tree", async () => {
  const repo = await repository();
  const intent = developmentInputIntent(inputs, repo, randomUUID(), scope, ["src"]);
  const prepared = await prepareDevelopmentInput(intent, repo, signal());
  expect(await recoverDevelopmentInput(intent, repo, signal())).toEqual(prepared);
  await expect(
    recoverDevelopmentInput(intent, { ...repo, id: randomUUID() }, signal()),
  ).rejects.toThrow("stale");
  await expect(
    assertDevelopmentBase({ ...repo, headTree: "a".repeat(40) }, signal()),
  ).rejects.toThrow("tree changed");
  writeFileSync(join(prepared.directory, "src/main.ts"), "export const answer = 9;\n");
  await expect(recoverDevelopmentInput(intent, repo, signal())).rejects.toThrow("file changed");
  rmSync(join(dirname(prepared.directory), "input.ready.json"));
  await expect(recoverDevelopmentInput(intent, repo, signal())).rejects.toThrow();
});

test("input recovery refuses additional files and directory links", async () => {
  const repo = await repository();
  const intent = developmentInputIntent(inputs, repo, randomUUID(), scope, ["src"]);
  const prepared = await prepareDevelopmentInput(intent, repo, signal());
  writeFileSync(join(prepared.directory, "src/.env"), "unexpected");
  await expect(recoverDevelopmentInput(intent, repo, signal())).rejects.toThrow("Unexpected");
  rmSync(join(prepared.directory, "src/.env"));
  rmSync(join(prepared.directory, "src"), { recursive: true });
  symlinkSync(join(source, "src"), join(prepared.directory, "src"));
  await expect(recoverDevelopmentInput(intent, repo, signal())).rejects.toThrow();
});

test("input cleanup is idempotent and requires the saved identity", async () => {
  const repo = await repository(),
    prepared = await input(repo);
  expect(() => removeDevelopmentInput(inputs, { ...prepared, repositoryId: randomUUID() })).toThrow(
    "identity",
  );
  expect(existsSync(prepared.directory)).toBe(true);
  removeDevelopmentInput(inputs, prepared);
  removeDevelopmentInput(inputs, prepared);
  expect(existsSync(dirname(prepared.directory))).toBe(false);
  expect(existsSync(repo.directory)).toBe(true);
});

test("rework starts from the previous candidate and records the cumulative change against the accepted base", async () => {
  const repo = await repository(),
    first = await input(repo);
  const firstCandidate = await stageDevelopmentCandidate(
    repo,
    first,
    bundle(first, [change("src/main.ts", "first fix\n")]),
    signal(),
  );
  const second = await prepareDevelopmentInput(
    developmentInputIntent(inputs, repo, first.runId, scope, ["src"], firstCandidate),
    repo,
    signal(),
  );
  expect(second).toMatchObject({
    revision: repo.head,
    tree: firstCandidate.tree,
    previousCandidate: firstCandidate.digest,
  });
  expect(readFileSync(join(second.directory, "src/main.ts"), "utf8")).toBe("first fix\n");
  const final = await stageDevelopmentCandidate(
    repo,
    second,
    bundle(second, [change("src/extra.ts", "second fix\n")]),
    signal(),
  );
  expect(final.changes.map((entry) => entry.path)).toEqual(["src/extra.ts", "src/main.ts"]);
  expect(git(join(repo.directory, "git"), ["show", `${final.tree}:src/main.ts`])).toBe("first fix");
  await expect(verifyDevelopmentCandidate(repo, second, final, signal())).resolves.toBeUndefined();
  expect(git(join(repo.directory, "git"), ["rev-parse", "HEAD"])).toBe(repo.head);
  expect(git(source, ["status", "--porcelain"])).toBe("");
});

test("rework can revert an earlier edit and cannot hide an earlier change outside the new Task paths", async () => {
  const repo = await repository(),
    first = await input(repo);
  const candidate = await stageDevelopmentCandidate(
    repo,
    first,
    bundle(first, [change("src/main.ts", "fix\n")]),
    signal(),
  );
  const narrower = await prepareDevelopmentInput(
    developmentInputIntent(inputs, repo, first.runId, scope, ["src/delete.ts"], candidate),
    repo,
    signal(),
  );
  await expect(
    stageDevelopmentCandidate(repo, narrower, bundle(narrower, []), signal()),
  ).rejects.toThrow("Cumulative");
  const second = await prepareDevelopmentInput(
    developmentInputIntent(inputs, repo, first.runId, scope, ["src"], candidate),
    repo,
    signal(),
  );
  const reverted = await stageDevelopmentCandidate(
    repo,
    second,
    bundle(second, [change("src/main.ts", "export const answer = 1;\n")]),
    signal(),
  );
  expect(reverted.changes).toEqual([]);
  expect(reverted.tree).toBe(repo.headTree);
});

test("candidate verification recomputes the tree diff even when a forged manifest has a valid digest", async () => {
  const repo = await repository(),
    prepared = await input(repo);
  const candidate = await stageDevelopmentCandidate(
    repo,
    prepared,
    bundle(prepared, [change("src/main.ts", "fix\n")]),
    signal(),
  );
  const { digest: _digest, ...record } = { ...candidate, changes: [] };
  const forged = {
    ...record,
    digest: createHash("sha256").update(JSON.stringify(record)).digest("hex"),
  };
  await expect(verifyDevelopmentCandidate(repo, prepared, forged, signal())).rejects.toThrow(
    "tree changed",
  );
});

test("imports only the current tree into a private repository and supplies scoped context without history or secrets", async () => {
  const old = git(source, ["rev-parse", "HEAD"]);
  file("src/main.ts", "current\n");
  const head = commit();
  git(source, ["gc", "--prune=now"]);
  const repo = await repository(),
    prepared = await input(repo);
  expect(repo.sourceRevision).toBe(head);
  expect(repo.head).toBe(head);
  const storage = join(repo.directory, "git");
  expect(git(storage, ["rev-list", "--count", "HEAD"])).toBe("1");
  expect(() => git(storage, ["cat-file", "-e", old])).toThrow();
  expect(existsSync(join(storage, "objects/info/alternates"))).toBe(false);
  expect(git(storage, ["remote"])).toBe("");
  expect(lstatSync(repo.directory).mode & 0o777).toBe(0o700);
  expect(lstatSync(join(repo.directory, "repository.json")).mode & 0o777).toBe(0o600);
  expect(prepared.files.map((entry) => entry.path)).toEqual([
    "src/delete.ts",
    "src/main.ts",
    "tests/main.test.ts",
  ]);
  expect(readFileSync(join(prepared.directory, "src/main.ts"), "utf8")).toBe("current\n");
  for (const path of ["src/.env", "src/private", "outside.txt"])
    expect(existsSync(join(prepared.directory, path))).toBe(false);
  expect(() => git(prepared.directory, ["rev-parse", "HEAD"])).toThrow();
  expect(() => git(prepared.directory, ["cat-file", "-e", head])).toThrow();
  expect(git(source, ["status", "--porcelain"])).toBe("");
});

test("stages exact additions, deletion and executable bytes while preserving outside files and both original heads", async () => {
  const repo = await repository(),
    prepared = await input(repo),
    storage = join(repo.directory, "git");
  const binary = Buffer.from([0, 255, 10, 42]);
  const candidate = await stageDevelopmentCandidate(
    repo,
    prepared,
    bundle(prepared, [
      change("src/main.ts", "export const answer = 2;\n"),
      change("src/delete.ts", null),
      change("src/run.sh", "#!/bin/sh\nexit 0\n", "100755"),
      change("src/binary.bin", binary),
    ]),
    signal(),
  );
  expect(candidate.changes).toHaveLength(4);
  expect(candidate).toMatchObject({
    baseRevision: repo.head,
    inputDigest: prepared.digest,
    digest: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(git(storage, ["show", `${candidate.tree}:src/main.ts`])).toContain("2");
  expect(git(storage, ["show", `${candidate.tree}:outside.txt`])).toBe("outside");
  expect(git(storage, ["show", `${candidate.tree}:src/.env`])).toBe("secret fixture");
  expect(() => git(storage, ["show", `${candidate.tree}:src/delete.ts`])).toThrow();
  expect(git(storage, ["ls-tree", candidate.tree, "src/run.sh"])).toMatch(/^100755 blob/);
  expect(
    execFileSync("git", ["show", `${candidate.tree}:src/binary.bin`], {
      cwd: storage,
    }),
  ).toEqual(binary);
  expect(git(storage, ["rev-parse", "HEAD"])).toBe(repo.head);
  expect(git(source, ["rev-parse", "HEAD"])).toBe(repo.sourceRevision);
  expect(readFileSync(join(source, "src/main.ts"), "utf8")).toContain("1");
  expect(git(source, ["status", "--porcelain"])).toBe("");
});

test("the next input includes an accepted commit, while a stale descriptor or unrecorded ref change is rejected", async () => {
  const repo = await repository(),
    first = await input(repo),
    storage = join(repo.directory, "git");
  const candidate = await stageDevelopmentCandidate(
    repo,
    first,
    bundle(first, [change("src/main.ts", "accepted\n")]),
    signal(),
  );
  // Simulate a future verified ChangeApplication, not model approval or automatic application.
  const accepted = git(
    storage,
    ["commit-tree", candidate.tree, "-p", repo.head],
    "verified fixture\n",
  );
  git(storage, ["update-ref", "refs/heads/development", accepted, repo.head]);
  await expect(input(repo)).rejects.toThrow("outside the recorded application");
  const nextRepo = { ...repo, head: accepted, headTree: candidate.tree },
    second = await input(nextRepo);
  expect(second.revision).toBe(accepted);
  expect(readFileSync(join(second.directory, "src/main.ts"), "utf8")).toBe("accepted\n");
  expect(readFileSync(join(first.directory, "src/main.ts"), "utf8")).toContain("1");
  await expect(
    stageDevelopmentCandidate(nextRepo, first, bundle(first, []), signal()),
  ).rejects.toThrow("stale");
  expect(git(source, ["rev-parse", "HEAD"])).toBe(repo.sourceRevision);
});

test.each(["dirty", "head", "hidden"])(
  "holds development when original source changes: %s",
  async (kind) => {
    const repo = await repository(),
      prepared = await input(repo);
    if (kind === "head") commit();
    else {
      if (kind === "hidden") git(source, ["update-index", "--assume-unchanged", "src/main.ts"]);
      file("src/main.ts", "external edit");
    }
    await expect(
      stageDevelopmentCandidate(
        repo,
        prepared,
        bundle(prepared, [change("src/main.ts", "mine")]),
        signal(),
      ),
    ).rejects.toThrow();
    expect(git(join(repo.directory, "git"), ["rev-parse", "HEAD"])).toBe(repo.head);
  },
);

test.each([
  "../escape",
  "/absolute",
  "src/../../escape",
  "src\\escape",
  "src/a\u0000b",
  "src/a\ud800b",
  "src/.git/config",
  "src/.env",
  "src/private/new.ts",
  "tests/main.test.ts",
  "outside.txt",
])("refuses unauthorized changes: %s", async (path) => {
  const repo = await repository(),
    prepared = await input(repo);
  await expect(
    stageDevelopmentCandidate(repo, prepared, bundle(prepared, [change(path, "bad")]), signal()),
  ).rejects.toThrow("scope");
});

test.each([
  "symlink",
  "submodule",
  "bad-base64",
  "duplicate",
  "base",
  "digest",
  "mutated-input",
  "delete-missing",
  "case",
  "file-directory",
])("rejects an invalid candidate: %s", async (kind) => {
  const repo = await repository(),
    prepared = await input(repo);
  const result = bundle(prepared, [change("src/main.ts", "new")]);
  if (kind === "symlink") result.changes = [change("src/link", "/outside", "120000")];
  if (kind === "submodule") result.changes = [change("src/vendor", "object", "160000")];
  if (kind === "bad-base64")
    result.changes = [{ path: "src/main.ts", mode: "100644", content: "a===!" }];
  if (kind === "duplicate") result.changes.push(change("src/main.ts", "another"));
  if (kind === "base") result.baseRevision = "0".repeat(40);
  if (kind === "digest") result.inputDigest = "0".repeat(64);
  if (kind === "mutated-input") prepared.writePaths.push("tests");
  if (kind === "delete-missing") result.changes = [change("src/missing.ts", null)];
  if (kind === "case") result.changes = [change("src/Main.ts", "alias")];
  if (kind === "file-directory") result.changes = [change("src/main.ts/child", "collision")];
  await expect(stageDevelopmentCandidate(repo, prepared, result, signal())).rejects.toThrow();
  expect(git(join(repo.directory, "git"), ["rev-parse", "HEAD"])).toBe(repo.head);
});

test("a declared file-to-directory replacement preserves every unrelated tree entry", async () => {
  const repo = await repository(),
    prepared = await input(repo);
  const candidate = await stageDevelopmentCandidate(
    repo,
    prepared,
    bundle(prepared, [change("src/main.ts/child", "replacement"), change("src/main.ts", null)]),
    signal(),
  );
  expect(git(join(repo.directory, "git"), ["show", `${candidate.tree}:src/main.ts/child`])).toBe(
    "replacement",
  );
  expect(git(join(repo.directory, "git"), ["show", `${candidate.tree}:outside.txt`])).toBe(
    "outside",
  );
});

test("rejects case and Unicode aliases of directories, duplicate normalization and excessive path depth", async () => {
  const repo = await repository(),
    prepared = await input(repo);
  for (const changes of [
    [change("src/One/a", "a"), change("src/one/b", "b")],
    [change("src/caf\u00e9.ts", "a"), change("src/cafe\u0301.ts", "b")],
    [change(`src/${"d/".repeat(32)}file`, "deep")],
    [change(`src/${"a".repeat(1025)}`, "long")],
  ])
    await expect(
      stageDevelopmentCandidate(repo, prepared, bundle(prepared, changes), signal()),
    ).rejects.toThrow();
});

test("imports SHA-256 repositories and retains their object format for new candidates", async () => {
  const shaSource = join(directory, "sha256-source");
  mkdirSync(shaSource);
  git(shaSource, ["init", "--quiet", "--template=", "--object-format=sha256"]);
  mkdirSync(join(shaSource, "src"));
  writeFileSync(join(shaSource, "src/main.ts"), "sha256");
  git(shaSource, ["add", "."]);
  git(shaSource, ["commit", "--quiet", "-m", "fixture"]);
  const repo = await prepareDevelopmentRepository(
    developmentRepositoryIntent(root, shaSource, randomUUID()),
    signal(),
  );
  const prepared = await input(repo);
  const candidate = await stageDevelopmentCandidate(
    repo,
    prepared,
    bundle(prepared, [change("src/main.ts", "changed")]),
    signal(),
  );
  expect(repo.head).toHaveLength(64);
  expect(candidate.tree).toHaveLength(64);
  expect(git(join(repo.directory, "git"), ["show", `${candidate.tree}:src/main.ts`])).toBe(
    "changed",
  );
});

test("does not read a model-modified worktree, Git configuration, hook or symlink when building a candidate", async () => {
  const repo = await repository(),
    prepared = await input(repo);
  const executed = join(directory, "hook-ran"),
    hook = join(directory, "hook");
  writeFileSync(
    hook,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(executed)},'ran');\n`,
    { mode: 0o700 },
  );
  git(prepared.directory, ["config", "core.fsmonitor", hook]);
  rmSync(join(prepared.directory, "src/main.ts"));
  symlinkSync(join(source, "src/.env"), join(prepared.directory, "src/main.ts"));
  const candidate = await stageDevelopmentCandidate(
    repo,
    prepared,
    bundle(prepared, [change("src/main.ts", "declared bytes")]),
    signal(),
  );
  expect(git(join(repo.directory, "git"), ["show", `${candidate.tree}:src/main.ts`])).toBe(
    "declared bytes",
  );
  expect(existsSync(executed)).toBe(false);
  expect(readFileSync(join(source, "src/.env"), "utf8")).toBe("secret fixture");
});

test.each(["file", "total", "count", "result-count"])(
  "enforces %s candidate limits",
  async (bound) => {
    const repo = await repository(),
      prepared = await input(repo);
    const changes =
      bound === "file"
        ? [change("src/big", "x".repeat(1048577))]
        : bound === "total"
          ? Array.from({ length: 9 }, (_, i) => change(`src/big-${i}`, "x".repeat(1048576)))
          : Array.from({ length: bound === "count" ? 501 : 498 }, (_, i) =>
              change(`src/new-${i}`, "small"),
            );
    await expect(
      stageDevelopmentCandidate(repo, prepared, bundle(prepared, changes), signal()),
    ).rejects.toThrow("limits");
  },
);

test("baseline limits include files outside the AI scope, and original symbolic links are never followed", async () => {
  file("outside-large", Buffer.alloc(64 * 1048576));
  commit();
  await expect(repository()).rejects.toThrow("baseline exceeds");
  rmSync(join(source, "outside-large"));
  symlinkSync(join(source, "src/.env"), join(source, "outside-link"));
  commit();
  const repo = await repository(),
    prepared = await input(repo);
  expect(existsSync(join(prepared.directory, "outside-link"))).toBe(false);
  await expect(input(repo, ["src"], { ...scope, allowedPaths: ["."] })).rejects.toThrow(
    "symlink or submodule",
  );
});

test("refuses linked storage and replaced identity markers; aborted preparation creates no repository", async () => {
  const intent = developmentRepositoryIntent(root, source, randomUUID());
  await expect(prepareDevelopmentRepository(intent, AbortSignal.abort())).rejects.toThrow();
  expect(existsSync(intent.directory)).toBe(false);
  const linked = join(directory, "linked");
  symlinkSync(root, linked);
  expect(() => developmentRepositoryIntent(linked, source, randomUUID())).toThrow();
  const repo = await repository();
  writeFileSync(
    join(repo.directory, "repository.json"),
    JSON.stringify({ ...repo, projectId: "another" }),
  );
  await expect(assertDevelopmentBase(repo, signal())).rejects.toThrow("identity changed");
  expect(git(source, ["status", "--porcelain"])).toBe("");
});

test("preserves an out-of-scope submodule reference without importing or exposing its repository", async () => {
  const linkedCommit = git(source, ["rev-parse", "HEAD"]);
  git(source, ["update-index", "--add", "--cacheinfo", `160000,${linkedCommit},vendor`]);
  git(source, ["commit", "--quiet", "-m", "submodule fixture"]);
  const repo = await repository(),
    prepared = await input(repo);
  const candidate = await stageDevelopmentCandidate(
    repo,
    prepared,
    bundle(prepared, [change("src/main.ts", "changed")]),
    signal(),
  );
  const storage = join(repo.directory, "git");
  expect(git(storage, ["ls-tree", candidate.tree, "vendor"])).toContain(
    `160000 commit ${linkedCommit}`,
  );
  expect(() => git(storage, ["cat-file", "-e", linkedCommit])).toThrow();
  expect(existsSync(join(prepared.directory, "vendor"))).toBe(false);
});
