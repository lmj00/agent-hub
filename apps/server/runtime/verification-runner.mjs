// Trusted bootstrap for operator-configured test images with Node.js 24.
// No credentials, server configuration, SDK protocol or model calls are used.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, join } from "node:path";

try {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    if ((bytes += chunk.length) > 1024 * 1024) throw new Error("input limit");
    chunks.push(chunk);
  }
  const { input, command } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    !Array.isArray(input?.files) ||
    input.files.length > 500 ||
    !Array.isArray(command) ||
    !command.length
  )
    throw new Error("invalid input");
  let total = 0;
  for (const file of input.files) {
    if (
      typeof file.path !== "string" ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path
        .split("/")
        .some((part) => !part || [".", "..", ".git"].includes(part)) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > 1048576 ||
      (total += file.bytes) > 8 * 1048576
    )
      throw new Error("invalid manifest");
    const source = join("/input", file.path);
    if (realpathSync(source) !== source) throw new Error("input link");
    const fd = openSync(
      source,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let content;
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size !== file.bytes ||
        (stat.mode & 0o111 ? "100755" : "100644") !== file.mode
      )
        throw new Error("input changed");
      content = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
    const hash = createHash(
      input.baseRevision.length === 64 ? "sha256" : "sha1",
    )
      .update(`blob ${content.length}\0`)
      .update(content)
      .digest("hex");
    if (hash !== file.blob) throw new Error("input changed");
    const target = join("/workspace", file.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, content, {
      mode: file.mode === "100755" ? 0o700 : 0o600,
      flag: "wx",
    });
  }
  const child = spawn(command[0], command.slice(1), {
    cwd: "/workspace",
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.on("error", () => {
    process.stderr.write("Verification command could not start\n");
    process.exitCode = 127;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? 128 + (osConstants.signals[signal] ?? 1);
  });
} catch {
  process.stderr.write("Verification input could not be prepared\n");
  process.exitCode = 125;
}
