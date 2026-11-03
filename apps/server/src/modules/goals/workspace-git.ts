import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";

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

export function git(
  source: string,
  args: string[],
  signal: AbortSignal,
  input?: string | Buffer,
  options: { maxBuffer?: number; timeout?: number; indexFile?: string } = {},
): Promise<Buffer> {
  return new Promise((accept, reject) => {
    const child = execFile(
      "git",
      [...gitOptions, ...args],
      {
        cwd: source,
        env: {
          ...gitEnv,
          ...(options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}),
        },
        signal,
        timeout: options.timeout ?? 5000,
        killSignal: "SIGKILL",
        maxBuffer: options.maxBuffer ?? 9 * 1048576,
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

export async function sourceRevision(source: string, signal: AbortSignal) {
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

export type GitEntry = {
  path: string;
  mode: string;
  type: string;
  blob: string;
  bytes: number | null;
};

export async function readGitTree(
  source: string,
  revision: string,
  signal: AbortSignal,
) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision))
    throw new Error("Invalid Git revision");
  const tree = await git(
    source,
    ["ls-tree", "-r", "-t", "-l", "-z", "--full-tree", revision],
    signal,
  );
  if (!Buffer.from(tree.toString("utf8")).equals(tree))
    throw new Error("Git tree paths must be UTF-8");
  return tree
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry): GitEntry => {
      const match =
        /^(\d+) (\w+) ([a-f0-9]{40,64})\s+([\d-]+)\t([\s\S]+)$/.exec(entry);
      if (!match) throw new Error("Invalid Git tree entry");
      const [, mode, type, blob, size, path] = match as unknown as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      if (!safeGitPath(path)) throw new Error("Invalid Git tree path");
      const bytes = size === "-" ? null : Number(size);
      if (bytes !== null && (!Number.isSafeInteger(bytes) || bytes < 0))
        throw new Error("Invalid Git object size");
      return { path, mode, type, blob, bytes };
    });
}

export function safeGitPath(path: string) {
  return (
    path !== "" &&
    Buffer.from(path, "utf8").toString("utf8") === path &&
    !path.startsWith("/") &&
    !/[\\\x00-\x1f\x7f]/.test(path) &&
    path
      .split("/")
      .every((part) => part !== "." && part !== ".." && part !== "")
  );
}

export async function readGitBlobs(
  source: string,
  files: { blob: string; bytes: number }[],
  signal: AbortSignal,
) {
  if (!files.length) return [];
  const contents = await git(
    source,
    ["cat-file", "--batch"],
    signal,
    files.map((file) => file.blob).join("\n") + "\n",
  );
  let position = 0;
  const blobs = files.map((file) => {
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
    position = next + 1;
    return contents.subarray(start, next);
  });
  if (position !== contents.length) throw new Error("Unexpected Git blob data");
  return blobs;
}
