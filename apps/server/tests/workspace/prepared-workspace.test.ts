import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  assertSourceUnchanged,
  inputIntent,
  prepareWorkspace,
  preparedInputRoot,
  removePreparedWorkspace,
  type GoalScope,
} from "../../src/modules/workspace/prepared-workspace.js";

let directory: string, source: string, root: string;
const scope: GoalScope = {
  goalId: "goal",
  goalVersion: 1,
  allowedPaths: ["."],
  excludedPaths: ["src/private"],
};
const signal = () => new AbortController().signal;
function git(...args: string[]) {
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
      cwd: source,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}
function file(path: string, content = "fixture") {
  mkdirSync(dirname(join(source, path)), { recursive: true });
  writeFileSync(join(source, path), content);
}
function commit() {
  git("add", "--all");
  git("commit", "--quiet", "--allow-empty", "-m", "fixture");
}
const intent = (selected = scope) => inputIntent(root, source, randomUUID(), selected);
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-prepared-source-")));
  source = join(directory, "source");
  mkdirSync(source);
  git("init", "--quiet", "--template=");
  root = preparedInputRoot(join(directory, "hub.sqlite"));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

test("copies only allowed immutable blobs and records a private revision-bound manifest", async () => {
  file("src/main.ts", "export const answer = 42;\n");
  file("src/private/customer.json", "excluded");
  file("docs/outside.md", "outside");
  file("src/.env", "credential fixture");
  file("src/auth.json");
  file("src/database.sqlite-wal");
  file("src/.codex/config.toml");
  file("src/.npmrc");
  file("src/.claude/settings.json");
  commit();
  const prepared = await prepareWorkspace(intent({ ...scope, allowedPaths: ["src"] }), signal());
  expect(prepared).toMatchObject({
    phase: "ready",
    revision: git("rev-parse", "HEAD"),
    digest: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(prepared.files.map((value) => value.path)).toEqual(["src/main.ts"]);
  expect(readFileSync(join(prepared.directory, "src/main.ts"), "utf8")).toContain("42");
  for (const path of [
    "src/private",
    "docs",
    "src/.env",
    "src/auth.json",
    "src/database.sqlite-wal",
    "src/.codex",
    "src/.npmrc",
    "src/.claude",
  ])
    expect(existsSync(join(prepared.directory, path))).toBe(false);
  expect(lstatSync(prepared.directory).mode & 0o777).toBe(0o700);
  expect(lstatSync(join(prepared.directory, "src/main.ts")).mode & 0o777).toBe(0o600);
  expect(existsSync(join(prepared.directory, ".git"))).toBe(true);
  expect(git("status", "--porcelain")).toBe("");
  await assertSourceUnchanged(prepared, signal());
  git("commit", "--quiet", "--allow-empty", "-m", "new revision");
  await expect(assertSourceUnchanged(prepared, signal())).rejects.toThrow();
  file("src/main.ts", "changed");
  await expect(assertSourceUnchanged(prepared, signal())).rejects.toThrow();
  expect(readFileSync(join(prepared.directory, "src/main.ts"), "utf8")).toContain("42");
  removePreparedWorkspace(root, prepared);
  expect(existsSync(prepared.directory)).toBe(false);
  removePreparedWorkspace(root, prepared);
});

test.each(["dirty", "untracked", "initial", "hidden"])(
  "rejects %s source state before supplying input",
  async (state) => {
    if (state !== "initial") {
      file("main.ts");
      commit();
    }
    if (state === "dirty") file("main.ts", "modified");
    if (state === "untracked") file("new.ts");
    if (state === "hidden") {
      git("update-index", "--assume-unchanged", "main.ts");
      file("main.ts", "hidden");
    }
    const input = intent();
    await expect(prepareWorkspace(input, signal())).rejects.toThrow();
    removePreparedWorkspace(root, input);
  },
);

test("rejects a subdirectory instead of silently reading the ancestor repository", async () => {
  file("src/main.ts");
  commit();
  const input = inputIntent(root, join(source, "src"), randomUUID(), scope);
  await expect(prepareWorkspace(input, signal())).rejects.toThrow("working tree root");
});

test.each([false, true])("never follows a source symlink; excluded=%s", async (excluded) => {
  file("src/main.ts");
  writeFileSync(join(directory, "outside"), "outside secret fixture");
  symlinkSync(join(directory, "outside"), join(source, "src/link"));
  commit();
  const input = intent({
    ...scope,
    excludedPaths: excluded ? ["src/link"] : [],
  });
  if (excluded) {
    const prepared = await prepareWorkspace(input, signal());
    expect(prepared.files.map((value) => value.path)).toEqual(["src/main.ts"]);
    expect(existsSync(join(input.directory, "src/link"))).toBe(false);
  } else await expect(prepareWorkspace(input, signal())).rejects.toThrow("symlink or submodule");
});

test("rejects a submodule without initializing or traversing it", async () => {
  file("main.ts");
  commit();
  git("update-index", "--add", "--cacheinfo", `160000,${git("rev-parse", "HEAD")},vendor`);
  git("commit", "--quiet", "-m", "submodule");
  await expect(prepareWorkspace(intent(), signal())).rejects.toThrow("symlink or submodule");
});

test("does not execute repository fsmonitor hooks or inherit host Git configuration", async () => {
  file("main.ts");
  commit();
  const executed = join(directory, "hook-ran"),
    hook = join(directory, "hook");
  writeFileSync(
    hook,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(executed)},'ran');\n`,
    { mode: 0o700 },
  );
  git("config", "core.fsmonitor", hook);
  const input = await prepareWorkspace(intent(), signal());
  expect(input.files).toHaveLength(1);
  expect(existsSync(executed)).toBe(false);
});

test("rejects configured clean filters before status can launch a repository command", async () => {
  file("main.ts");
  file(".gitattributes", "*.ts filter=unsafe\n");
  commit();
  const executed = join(directory, "filter-ran"),
    script = join(directory, "filter");
  writeFileSync(
    script,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(executed)},'ran');\n`,
    { mode: 0o700 },
  );
  git("config", "filter.unsafe.clean", script);
  file("main.ts", "modified");
  await expect(prepareWorkspace(intent(), signal())).rejects.toThrow("Git filters");
  expect(existsSync(executed)).toBe(false);
});

test("missing promised blobs cannot invoke a remote helper or silently supply incomplete input", async () => {
  file("main.ts");
  commit();
  const blob = git("rev-parse", "HEAD:main.ts"),
    executed = join(directory, "remote-ran"),
    helper = join(directory, "remote-helper");
  writeFileSync(
    helper,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(executed)},'ran');\n`,
    { mode: 0o700 },
  );
  git("config", "core.repositoryformatversion", "1");
  git("config", "extensions.partialClone", "origin");
  git("config", "remote.origin.promisor", "true");
  git("config", "remote.origin.url", `ext::${helper}`);
  git("config", "protocol.ext.allow", "always");
  rmSync(join(source, ".git/objects", blob.slice(0, 2), blob.slice(2)));
  await expect(prepareWorkspace(intent(), signal())).rejects.toThrow();
  expect(existsSync(executed)).toBe(false);
});

test.each(["file", "total", "count"])(
  "refuses oversized %s input without silently truncating scope",
  async (bound) => {
    if (bound === "file") file("large.txt", "x".repeat(1048577));
    if (bound === "total") for (let i = 0; i < 9; i++) file(`large-${i}.txt`, "x".repeat(1048576));
    if (bound === "count") for (let i = 0; i < 501; i++) file(`small-${i}.txt`);
    commit();
    await expect(prepareWorkspace(intent(), signal())).rejects.toThrow("limits");
  },
);

test("cleanup refuses replaced markers, links and directories outside the private root", async () => {
  file("main.ts");
  commit();
  const input = await prepareWorkspace(intent(), signal());
  await expect(prepareWorkspace(input, signal())).rejects.toThrow();
  expect(() => removePreparedWorkspace(root, { ...input, directory: source })).toThrow();
  writeFileSync(
    join(input.directory, ".hub-prepared-input.json"),
    JSON.stringify({ id: "other", runId: input.runId }),
  );
  expect(() => removePreparedWorkspace(root, input)).toThrow("identity mismatch");
  expect(existsSync(join(source, "main.ts"))).toBe(true);
  rmSync(input.directory, { recursive: true });
  symlinkSync(source, input.directory);
  expect(() => removePreparedWorkspace(root, input)).toThrow("ownership");
  expect(existsSync(join(source, "main.ts"))).toBe(true);
});

test("an aborted preparation does not create files and cannot use a linked root", async () => {
  const input = intent();
  await expect(prepareWorkspace(input, AbortSignal.abort())).rejects.toThrow();
  expect(existsSync(input.directory)).toBe(false);
  const link = join(directory, "root-link");
  symlinkSync(root, link);
  expect(() => inputIntent(link, source, randomUUID(), scope)).toThrow("private");
});
