import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  captureDevelopmentChanges,
  initializeDevelopmentWorkspace,
  parseDevelopmentInput,
} from "/app/apps/server/dist/modules/execution/development-capture.js";
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const request = JSON.parse((await lines.next()).value);
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
if (request.responseMode !== "assessment" || request.workflow)
  throw new Error("Incorrect workflow protocol");
const context = JSON.parse(request.instruction.split("\n").at(-1));
let development;
if (request.development) {
  const input = parseDevelopmentInput(request.development);
  initializeDevelopmentWorkspace(input);
  if (context.actualTest) {
    if (
      context.actualTest.status !== "failed" ||
      !context.actualTest.output.includes("AssertionError")
    )
      throw new Error("Missing test feedback");
    writeFileSync(
      "/workspace/src/main.mjs",
      "export const total = (price, quantity) => price * quantity;\n",
    );
  }
  development = captureDevelopmentChanges(input);
} else {
  if (!context.actualTest || !context.candidateDigest)
    throw new Error("Missing review evidence");
  let denied = false;
  try {
    writeFileSync("/workspace/src/main.mjs", "reviewer write");
  } catch {
    denied = true;
  }
  if (!denied) throw new Error("Reviewer must be read-only");
  readFileSync("/workspace/src/main.mjs", "utf8");
}
send({
  type: "event",
  event: { kind: "thread.started", sessionId: randomUUID() },
});
// Deliberately approve the failed first candidate: the parent must reject it.
send({
  type: "result",
  result: {
    output: JSON.stringify({
      report: "Synthetic independent review",
      evidence: ["src/main.mjs"],
      unresolved: [],
      complete: true,
      next: null,
    }),
    usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 3 },
    ...(development ? { development } : {}),
  },
});
process.stdout.write("", () => process.exit(0));
