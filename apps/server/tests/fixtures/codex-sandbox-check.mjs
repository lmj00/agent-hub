import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer, get } from "node:http";
import { promisify } from "node:util";
import { codexOptions } from "/app/apps/server/dist/modules/execution/codex-executor.js";

const exec = promisify(execFile);
const runtime = "/usr/local/lib/codex/bin/codex";
const options = codexOptions("/codex-home", "/workspace", runtime);
const args = ["sandbox", "-c", 'default_permissions="hub-readonly"', ...options.configOverrides.flatMap(value => ["-c", value]), "--"];
const command = (...parts) => exec(runtime, [...args, ...parts], { env: options.env, timeout: 10000 });
assert.match((await command(runtime, "--version")).stdout, /codex-cli 0\.166\.0/);
assert.equal((await command("/bin/cat", "/workspace/example.txt")).stdout, "prepared input");
assert.match((await command("/usr/local/lib/codex/codex-path/rg", "prepared", "/workspace/example.txt")).stdout, /prepared input/);
await assert.rejects(command("/bin/sh", "-c", "echo changed > /workspace/example.txt"));
await assert.rejects(command("/bin/cat", "/codex-home/auth.json"));
await assert.rejects(command("/bin/cat", "/outside/private.txt"));

// An endpoint known to be reachable outside the sandbox must be unreachable inside.
const server = createServer((_, response) => response.end("reachable"));
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const url = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve, reject) => get(url, response => { response.resume(); response.on("end", resolve); }).on("error", reject));
  await assert.rejects(command("/usr/local/bin/node", "-e", `fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(1500) }).then(() => process.exit(0), () => process.exit(1))`));
} finally { server.close(); }
console.log("runtime, prepared reads, write denial, private path denial, network denial: passed");
