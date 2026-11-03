import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
const lines = input[Symbol.asyncIterator]();
const request = JSON.parse((await lines.next()).value);
if (request.responseMode === "goal-plan") {
  if (request.workflow) throw new Error("Planning must not use the analysis workflow");
  const context = JSON.parse(request.instruction.split("\n").at(-1));
  if (context.services?.[0]?.latest?.snapshot?.summary !== "container planning evidence") throw new Error("Missing server observation evidence");
  const path = context.files[0];
  readFileSync(`/workspace/${path}`, "utf8");
  console.log(JSON.stringify({ type: "event", event: { kind: "planning.proposed", planningProposal: "forged", planningInput: { capturedAt: "forged", services: [] } } }));
  console.log(JSON.stringify({ type: "result", result: { output: JSON.stringify({ version: 1, goalVersion: context.goalVersion, inputDigest: context.inputDigest, outcome: "work", summary: "Improve fixture", evidence: [path], tasks: [{ title: "Improve fixture", instruction: "Implement a change", acceptanceCriteria: "Verify the change", paths: [path], evidence: [path] }] }), usage: null } }));
  process.exit(0);
}
if (request.instruction === "scoped-report") {
  if (readFileSync("/workspace/main.ts", "utf8") !== "allowed source\n" || existsSync("/workspace/excluded.txt")) throw new Error("Incorrect prepared scope");
  let denied = false;
  try { writeFileSync("/workspace/main.ts", "forbidden"); } catch { denied = true; }
  if (!denied) throw new Error("Snapshot must be read-only");
  console.log(JSON.stringify({ type: "event", event: { kind: "input.ready", preparedInput: { id: "forged", directory: "/outside" } } }));
  console.log(JSON.stringify({ type: "result", result: { output: "scoped files verified", usage: null } }));
  process.exit(0);
}
if (request.instruction.includes("workflow-protocol")) {
  async function step(event) {
    console.log(JSON.stringify({ type: "event", event }));
    const ack = JSON.parse((await lines.next()).value);
    if (ack.type !== "step.saved" || ack.sequence !== event.step.sequence || ack.phase !== event.step.type) throw new Error("Invalid acknowledgement");
  }
  for (let sequence = 1; sequence <= 3; sequence++) {
    await step({ kind: "step.started", step: { type: "start", sequence } });
    appendFileSync("/codex-home/calls", String(sequence));
    console.log(JSON.stringify({ type: "event", event: { kind: "thread.started", sessionId: `fixture-${sequence}` } }));
    const assessment = { report: sequence === 3 ? "Final report" : "Partial finding", evidence: ["fixture"], unresolved: sequence === 3 ? [] : ["Need next"], complete: sequence === 3,
      next: sequence === 3 ? null : { purpose: "Next analysis", effort: sequence === 1 ? "xhigh" : "medium", reason: "Fixture reason" } };
    await step({ kind: "step.completed", step: { type: "complete", sequence, assessment, usage: { inputTokens: sequence, cachedInputTokens: 0, outputTokens: 1 } } });
  }
  console.log(JSON.stringify({ type: "result", result: { output: "Final report", usage: { inputTokens: 6, cachedInputTokens: 0, outputTokens: 3 } } }));
  process.exit(0);
}
const child = spawn(process.execPath, ["-e", `
const fs = require('node:fs');
fs.appendFileSync('/codex-home/heartbeat', 'x');
setInterval(() => fs.appendFileSync('/codex-home/heartbeat', 'x'), 30);
`], { detached: true, stdio: "ignore" });
child.unref();
while (!existsSync("/codex-home/heartbeat")) await new Promise(resolve => setTimeout(resolve, 10));
console.log(JSON.stringify({ type: "event", event: { kind: "fixture.ready" } }));
if (request.instruction === "wait" || (request.instruction === "wait-once" && !existsSync("/codex-home/attempted"))) {
  writeFileSync("/codex-home/attempted", "started");
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (request.instruction === "malformed") {
  console.log("invalid runner output");
  setInterval(() => {}, 1000);
} else if (request.instruction === "transient-once" && !existsSync("/codex-home/transient-attempted")) {
  writeFileSync("/codex-home/transient-attempted", "started");
  console.log(JSON.stringify({ type: "error", code: "transient" }));
  process.exit(0);
} else if (request.instruction === "capacity") {
  console.log(JSON.stringify({ type: "error", code: "capacity", retryAt: "2030-01-01T00:00:00.000Z" }));
  process.exit(0);
} else {
  console.log(JSON.stringify({ type: "result", result: { output: request.instruction.includes("effort-report") ? `applied effort: ${request.effort}` : "fixture report", usage: null } }));
  process.exit(0);
}
