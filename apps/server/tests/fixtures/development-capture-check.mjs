import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, get } from "node:http";
import { promisify } from "node:util";
import {
  captureDevelopmentChanges,
  initializeDevelopmentWorkspace,
  parseDevelopmentInput,
  developmentWriteDirectories,
} from "/app/apps/server/dist/modules/execution/development-capture.js";
import { codexOptions } from "/app/apps/server/dist/modules/execution/codex-executor.js";

const exec = promisify(execFile);
const input = parseDevelopmentInput(JSON.parse(process.env.DEVELOPMENT_INPUT));
initializeDevelopmentWorkspace(input);
assert.equal(readFileSync("/workspace/src/main.txt", "utf8"), "original");
assert.throws(() => writeFileSync("/input/src/main.txt", "overwrite"));
const runtime = "/usr/local/lib/codex/bin/codex";
const options = codexOptions(
  "/codex-home",
  "/workspace",
  runtime,
  input.writePaths,
);
const args = [
  "sandbox",
  "-c",
  'default_permissions="hub-development"',
  ...options.configOverrides.flatMap((value) => ["-c", value]),
  "--",
];
const command = (...parts) =>
  exec(runtime, [...args, ...parts], { env: options.env, timeout: 10000 });
await command("/bin/sh", "-c", "printf updated > /workspace/src/main.txt");
await assert.rejects(
  command("/bin/sh", "-c", "printf bad > /workspace/tests/fixed.txt"),
);
await assert.rejects(command("/bin/cat", "/input/src/main.txt"));
await assert.rejects(command("/bin/cat", "/codex-home/auth.json"));
const exactInput = { ...input, writePaths: ["src/main.txt"] };
const exactOptions = codexOptions(
  "/codex-home",
  "/workspace",
  runtime,
  developmentWriteDirectories(exactInput),
);
const exactArgs = [
  "sandbox",
  "-c",
  'default_permissions="hub-development"',
  ...exactOptions.configOverrides.flatMap((value) => ["-c", value]),
  "--",
];
const exactCommand = (...parts) =>
  exec(runtime, [...exactArgs, ...parts], {
    env: exactOptions.env,
    timeout: 10000,
  });
assert.equal(
  (await exactCommand("/bin/cat", "/workspace/tests/fixed.txt")).stdout,
  "readonly context",
);
await exactCommand("/bin/sh", "-c", "printf updated > /workspace/src/main.txt");
assert.deepEqual(
  captureDevelopmentChanges(exactInput).changes.map((file) => file.path),
  ["src/main.txt"],
);
await exactCommand(
  "/bin/sh",
  "-c",
  "printf bad > /workspace/src/forbidden.txt",
);
assert.throws(() => captureDevelopmentChanges(exactInput));
rmSync("/workspace/src/forbidden.txt");
assert.equal(captureDevelopmentChanges(exactInput).changes.length, 1);
await command("/bin/sh", "-c", "printf new > /workspace/src/new.txt");
const server = createServer((_, response) => response.end("reachable"));
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const url = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve, reject) =>
    get(url, (response) => {
      response.resume();
      response.on("end", resolve);
    }).on("error", reject),
  );
  await assert.rejects(
    command(
      "/usr/local/bin/node",
      "-e",
      `fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(1000) }).then(() => process.exit(0), () => process.exit(1))`,
    ),
  );
} finally {
  server.close();
}
chmodSync("/workspace/src/new.txt", 0o700);
rmSync("/workspace/src/delete.txt");
const result = captureDevelopmentChanges(input);
assert.deepEqual(result.changes.map((file) => [file.path, file.mode]).sort(), [
  ["src/delete.txt", null],
  ["src/main.txt", "100644"],
  ["src/new.txt", "100755"],
]);
assert.equal(
  Buffer.from(
    result.changes.find((file) => file.path === "src/main.txt").content,
    "base64",
  ).toString(),
  "updated",
);

// Parent path replacements must not expose the synthetic credential through capture.
for (const kind of [
  "file-link",
  "directory-link",
  "hardlink",
  "fifo",
  "outside-scope",
  "large",
  "private",
]) {
  if (kind === "file-link")
    symlinkSync("/codex-home/auth.json", "/workspace/src/attack");
  if (kind === "directory-link")
    symlinkSync("/codex-home", "/workspace/src/attack");
  if (kind === "hardlink")
    linkSync("/workspace/src/main.txt", "/workspace/src/attack");
  if (kind === "fifo") await exec("/usr/bin/mkfifo", ["/workspace/src/attack"]);
  if (kind === "outside-scope")
    writeFileSync("/workspace/tests/fixed.txt", "bad");
  if (kind === "large")
    writeFileSync("/workspace/src/attack", Buffer.alloc(1048577));
  if (kind === "private") writeFileSync("/workspace/src/.env", "private");
  assert.throws(() => captureDevelopmentChanges(input), kind);
  rmSync("/workspace/src/attack", { recursive: true, force: true });
  rmSync("/workspace/src/.env", { force: true });
  writeFileSync("/workspace/tests/fixed.txt", "readonly context");
}

// A concurrent process alternates a real directory and a link to the auth mount.
mkdirSync("/workspace/src/race");
writeFileSync("/workspace/src/race/auth.json", "safe fixture");
// Use an ordinary filename so this is a parent traversal test, not a private-name rejection.
renameSync("/workspace/src/race/auth.json", "/workspace/src/race/value.txt");
const attacker = spawn(
  process.execPath,
  [
    "-e",
    `
const fs = require('node:fs');
process.stdout.write('ready\\n');
for (;;) { try {
 fs.renameSync('/workspace/src/race','/workspace/src/held');
 fs.symlinkSync('/codex-home','/workspace/src/race');
 fs.unlinkSync('/workspace/src/race');
 fs.renameSync('/workspace/src/held','/workspace/src/race');
} catch {} }
`,
  ],
  { stdio: ["ignore", "pipe", "ignore"] },
);
await once(attacker.stdout, "data");
try {
  for (let i = 0; i < 100; i++) {
    try {
      const captured = captureDevelopmentChanges(input);
      for (const file of captured.changes)
        if (file.content !== null)
          assert.ok(
            !Buffer.from(file.content, "base64")
              .toString()
              .includes("synthetic credential"),
          );
    } catch (error) {
      if (error.code === "ERR_ASSERTION") throw error;
    }
  }
} finally {
  attacker.kill("SIGKILL");
  await once(attacker, "close");
}
// tmpfs itself limits writes even when untrusted commands ignore the artifact limits.
assert.throws(
  () => writeFileSync("/workspace/fill", Buffer.alloc(33 * 1048576)),
  { code: "ENOSPC" },
);
console.log(
  "development edits, fixed context, auth/network denial, scoped capture, link races and tmpfs bound: passed",
);
