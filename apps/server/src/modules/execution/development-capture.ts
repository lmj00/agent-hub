import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  allowedGoalPath,
  privateInputPath,
  type GoalScope,
  type ScopedGitFile,
} from "../goals/prepared-workspace.js";
import { safeGitPath } from "../goals/workspace-git.js";

export const maxDevelopmentRequestBytes = 1024 * 1024;
export const maxDevelopmentArtifactBytes = 12 * 1024 * 1024;
const maxFiles = 500,
  maxFileBytes = 1048576,
  maxBytes = 8 * 1048576;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const validPath = (path: unknown): path is string =>
  typeof path === "string" &&
  safeGitPath(path) &&
  Buffer.byteLength(path) <= 1024 &&
  path.split("/").length <= 32;
const revision = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export type DevelopmentExecutionInput = {
  baseRevision: string;
  inputDigest: string;
  scope: GoalScope;
  writePaths: string[];
  files: ScopedGitFile[];
};
export type DevelopmentChanges = {
  baseRevision: string;
  inputDigest: string;
  changes: {
    path: string;
    mode: "100644" | "100755" | null;
    content: string | null;
  }[];
};

// CLI 0.166.0 treats writable roots as directories (file roots fail in bwrap).
// Allow only existing parent directories in the disposable copy; capture and
// the parent candidate builder still enforce the original exact Task paths.
export function developmentWriteDirectories(input: DevelopmentExecutionInput) {
  const directories = new Set(["."]);
  for (const file of input.files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++)
      directories.add(parts.slice(0, i).join("/"));
  }
  const roots = [
    ...new Set(
      input.writePaths.map((path) => {
        let directory = path;
        while (!directories.has(directory)) directory = dirname(directory);
        return directory;
      }),
    ),
  ];
  return roots
    .filter(
      (path) =>
        !roots.some(
          (other) =>
            other !== path && (other === "." || path.startsWith(`${other}/`)),
        ),
    )
    .sort();
}

export function parseDevelopmentInput(
  value: unknown,
  options: { verification?: boolean } = {},
): DevelopmentExecutionInput {
  if (
    !object(value) ||
    Object.keys(value).length !== 5 ||
    typeof value.baseRevision !== "string" ||
    !revision.test(value.baseRevision) ||
    typeof value.inputDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.inputDigest) ||
    !object(value.scope) ||
    typeof value.scope.goalId !== "string" ||
    !Number.isSafeInteger(value.scope.goalVersion) ||
    Number(value.scope.goalVersion) < 1 ||
    !Array.isArray(value.scope.allowedPaths) ||
    !Array.isArray(value.scope.excludedPaths) ||
    value.scope.allowedPaths.length > 500 ||
    value.scope.excludedPaths.length > 500 ||
    [...value.scope.allowedPaths, ...value.scope.excludedPaths].some(
      (path) => path !== "." && !validPath(path),
    ) ||
    !Array.isArray(value.writePaths) ||
    (!value.writePaths.length && !options.verification) ||
    value.writePaths.length > 20 ||
    !Array.isArray(value.files) ||
    value.files.length > maxFiles
  )
    throw new Error("Invalid development input");
  const scope = value.scope as GoalScope;
  if (
    value.writePaths.some(
      (path) =>
        !validPath(path) ||
        !allowedGoalPath(path, scope) ||
        privateInputPath(path),
    )
  )
    throw new Error("Invalid development write scope");
  let total = 0;
  const paths = new Set<string>();
  for (const file of value.files) {
    if (
      !object(file) ||
      Object.keys(file).length !== 4 ||
      !validPath(file.path) ||
      !allowedGoalPath(file.path, scope) ||
      privateInputPath(file.path) ||
      typeof file.blob !== "string" ||
      !revision.test(file.blob) ||
      file.blob.length !== value.baseRevision.length ||
      (file.mode !== "100644" && file.mode !== "100755") ||
      !Number.isSafeInteger(file.bytes) ||
      Number(file.bytes) < 0 ||
      Number(file.bytes) > maxFileBytes ||
      (total += Number(file.bytes)) > maxBytes ||
      paths.has(file.path.normalize("NFC").toLowerCase())
    )
      throw new Error("Invalid development input manifest");
    paths.add(file.path.normalize("NFC").toLowerCase());
  }
  if (
    Buffer.byteLength(JSON.stringify(value)) >
    maxDevelopmentRequestBytes - 65536
  )
    throw new Error("Development input exceeds transport limits");
  return structuredClone(value) as DevelopmentExecutionInput;
}

export function parseDevelopmentChanges(
  value: unknown,
  input: DevelopmentExecutionInput,
): DevelopmentChanges {
  if (
    !object(value) ||
    Object.keys(value).length !== 3 ||
    value.baseRevision !== input.baseRevision ||
    value.inputDigest !== input.inputDigest ||
    !Array.isArray(value.changes) ||
    value.changes.length > maxFiles
  )
    throw new Error("Invalid development artifact");
  let total = 0;
  const paths = new Set<string>();
  for (const change of value.changes) {
    if (
      !object(change) ||
      Object.keys(change).length !== 3 ||
      !validPath(change.path) ||
      privateInputPath(change.path) ||
      !allowedGoalPath(change.path, input.scope) ||
      !allowedGoalPath(change.path, {
        allowedPaths: input.writePaths,
        excludedPaths: [],
      })
    )
      throw new Error("Development artifact exceeds permitted scope");
    const key = change.path.normalize("NFC").toLowerCase();
    if (paths.has(key)) throw new Error("Duplicate development artifact path");
    paths.add(key);
    if (change.mode === null && change.content === null) continue;
    if (
      (change.mode !== "100644" && change.mode !== "100755") ||
      typeof change.content !== "string" ||
      change.content.length > Math.ceil(maxFileBytes / 3) * 4
    )
      throw new Error("Invalid development artifact mode or size");
    const bytes = Buffer.from(change.content, "base64");
    if (
      bytes.toString("base64") !== change.content ||
      bytes.length > maxFileBytes ||
      (total += bytes.length) > maxBytes
    )
      throw new Error("Invalid development artifact bytes");
  }
  if (Buffer.byteLength(JSON.stringify(value)) > maxDevelopmentArtifactBytes)
    throw new Error("Development artifact exceeds transport limits");
  return value as DevelopmentChanges;
}

type CapturedFile = {
  path: string;
  mode: "100644" | "100755";
  content: Buffer;
};
const blobHash = (content: Buffer, base: string) =>
  createHash(base.length === 64 ? "sha256" : "sha1")
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex");

// Linux container only. Pin every ancestor FD; O_NOFOLLOW on just the last
// component would still allow a concurrently replaced ancestor to escape.
function readFiles(root: string): CapturedFile[] {
  if (process.platform !== "linux")
    throw new Error("Development capture requires the Linux container");
  const rootFd = openSync(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const files: CapturedFile[] = [];
  let total = 0,
    entries = 0;
  try {
    const device = fstatSync(rootFd).dev;
    function visit(directoryFd: number, prefix: string) {
      for (const nameBytes of readdirSync(`/proc/self/fd/${directoryFd}`, {
        encoding: "buffer",
      })) {
        const name = nameBytes.toString("utf8"),
          path = prefix ? `${prefix}/${name}` : name;
        if (!prefix && name === ".git") continue;
        if (
          ++entries > 4096 ||
          !Buffer.from(name).equals(nameBytes) ||
          !validPath(path) ||
          privateInputPath(path)
        )
          throw new Error("Invalid development file path or entry limits");
        // NONBLOCK makes FIFOs/devices fail validation without waiting for a writer.
        const fd = openSync(
          `/proc/self/fd/${directoryFd}/${name}`,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const stat = fstatSync(fd);
          if (stat.dev !== device)
            throw new Error("Development file crossed a filesystem boundary");
          if (stat.isDirectory()) {
            visit(fd, path);
            continue;
          }
          if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.size > maxFileBytes ||
            files.length >= maxFiles
          )
            throw new Error("Invalid development file type or size");
          const content = Buffer.allocUnsafe(maxFileBytes + 1);
          let bytes = 0,
            read: number;
          do {
            read = readSync(fd, content, bytes, content.length - bytes, bytes);
            bytes += read;
            if (bytes > maxFileBytes || total + bytes > maxBytes)
              throw new Error("Development file exceeds byte limits");
          } while (read > 0);
          total += bytes;
          files.push({
            path,
            mode: stat.mode & 0o111 ? "100755" : "100644",
            content: Buffer.from(content.subarray(0, bytes)),
          });
        } finally {
          closeSync(fd);
        }
      }
    }
    visit(rootFd, "");
    return files;
  } finally {
    closeSync(rootFd);
  }
}

export function initializeDevelopmentWorkspace(
  input: DevelopmentExecutionInput,
  source = "/input",
  target = "/workspace",
) {
  // The production runner calls this before starting the model, in a fresh mount.
  if (
    process.platform !== "linux" ||
    statfsSync(target).type !== 0x01021994 ||
    readdirSync(target).length
  )
    throw new Error("Development workspace must be an empty tmpfs");
  const files = readFiles(source),
    expected = new Map(input.files.map((file) => [file.path, file]));
  if (files.length !== expected.size)
    throw new Error("Development input files changed");
  for (const file of files) {
    const base = expected.get(file.path);
    if (
      !base ||
      base.bytes !== file.content.length ||
      base.mode !== file.mode ||
      base.blob !== blobHash(file.content, input.baseRevision)
    )
      throw new Error("Development input files changed");
    const path = join(target, file.path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, file.content, {
      mode: file.mode === "100755" ? 0o700 : 0o600,
      flag: "wx",
    });
  }
}

export function captureDevelopmentChanges(
  input: DevelopmentExecutionInput,
  workspace = "/workspace",
): DevelopmentChanges {
  const files = readFiles(workspace),
    remaining = new Map(input.files.map((file) => [file.path, file]));
  const changes: DevelopmentChanges["changes"] = [];
  for (const file of files) {
    const base = remaining.get(file.path);
    remaining.delete(file.path);
    if (
      !base ||
      base.blob !== blobHash(file.content, input.baseRevision) ||
      base.mode !== file.mode
    )
      changes.push({
        path: file.path,
        mode: file.mode,
        content: file.content.toString("base64"),
      });
  }
  for (const file of remaining.values())
    changes.push({ path: file.path, mode: null, content: null });
  return parseDevelopmentChanges(
    {
      baseRevision: input.baseRevision,
      inputDigest: input.inputDigest,
      changes,
    },
    input,
  );
}
