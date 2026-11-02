import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
let request;
for await (const line of input) { request = JSON.parse(line); break; }
const child = spawn(process.execPath, ["-e", `
const fs = require('node:fs');
fs.appendFileSync('/codex-home/heartbeat', 'x');
setInterval(() => fs.appendFileSync('/codex-home/heartbeat', 'x'), 30);
`], { detached: true, stdio: "ignore" });
child.unref();
while (!existsSync("/codex-home/heartbeat")) await new Promise(resolve => setTimeout(resolve, 10));
console.log(JSON.stringify({ type: "event", event: { kind: "fixture.ready" } }));
if (request.instruction === "wait") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (request.instruction === "malformed") {
  console.log("invalid runner output");
  setInterval(() => {}, 1000);
} else if (request.instruction === "capacity") {
  console.log(JSON.stringify({ type: "error", code: "capacity" }));
  process.exit(0);
} else {
  console.log(JSON.stringify({ type: "result", result: { output: "fixture report", usage: null } }));
  process.exit(0);
}
