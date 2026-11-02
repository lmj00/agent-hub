import { efforts, type Effort } from "@agent-hub/contracts";
import { createInterface } from "node:readline";
import { AnalysisError } from "./analysis.js";
import { createCodexExecutor } from "./codex-executor.js";

function send(message: unknown) { process.stdout.write(JSON.stringify(message) + "\n"); }

async function main() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let line: string | undefined;
  for await (const value of input) { line = value; break; }
  if (!line || Buffer.byteLength(line) > 65536) throw new Error("Invalid runner input");
  const request = JSON.parse(line) as { instruction?: unknown; model?: unknown; effort?: unknown };
  if (typeof request.instruction !== "string" || typeof request.model !== "string") throw new Error("Invalid runner input");
  const effort = request.effort ?? "medium";
  if (!efforts.includes(effort as Effort)) throw new AnalysisError("unsupported_settings");
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  try {
    const result = await createCodexExecutor("/codex-home", "/usr/local/lib/codex/bin/codex").analyze({
      instruction: request.instruction, model: request.model, effort: effort as Effort, workspace: "/workspace", signal: controller.signal,
    }, event => send({ type: "event", event }));
    send({ type: "result", result });
  } catch (error) {
    send({ type: "error", code: error instanceof AnalysisError ? error.code : "provider_error", retryAt: error instanceof AnalysisError ? error.retryAt?.toISOString() ?? null : null });
  }
}

// SDK가 남긴 핸들이 있어도 PID namespace의 init 종료로 모든 하위 명령을 닫습니다.
main().then(() => process.stdout.write("", () => process.exit(0)), () => {
  send({ type: "error", code: "provider_error" });
  process.stdout.write("", () => process.exit(1));
});
