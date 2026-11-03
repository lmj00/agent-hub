import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import {
  captureDevelopmentChanges,
  initializeDevelopmentWorkspace,
  parseDevelopmentInput,
} from "/app/apps/server/dist/modules/execution/development-capture.js";

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const lines = input[Symbol.asyncIterator]();
const request = JSON.parse((await lines.next()).value);
const development = parseDevelopmentInput(request.development);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
try {
  initializeDevelopmentWorkspace(development);
  if (request.instruction === "wait") {
    writeFileSync("/workspace/src/main.txt", "pending");
    send({ type: "event", event: { kind: "fixture.ready" } });
    await new Promise(() => {});
  }
  if (request.instruction === "outside")
    writeFileSync("/workspace/tests/fixed.txt", "bad");
  else
    for (let i = 0; i < 3; i++)
      writeFileSync(`/workspace/src/large-${i}.txt`, "x".repeat(700000));
  const artifact = captureDevelopmentChanges(development);
  if (request.instruction === "forged") artifact.inputDigest = "f".repeat(64);
  send({
    type: "result",
    result: {
      output: "Synthetic developer, verification pending",
      usage: null,
      development: artifact,
    },
  });
} catch {
  send({ type: "error", code: "invalid_change" });
}
process.stdout.write("", () => process.exit(0));
