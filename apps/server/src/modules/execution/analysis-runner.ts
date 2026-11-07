import { efforts, type Effort } from "@agent-hub/contracts";
import { createInterface } from "node:readline";
import { AnalysisError } from "./analysis.js";
import { createCodexExecutor } from "./codex-executor.js";
import { createAnalysisWorkflow, parseAnalysisWorkflow } from "./analysis-workflow.js";
import { parseEffortPolicy } from "./effort-policy.js";
import { captureDevelopmentChanges, initializeDevelopmentWorkspace, maxDevelopmentRequestBytes, parseDevelopmentInput } from "./development-capture.js";
import { loadRuntimeSkill, parseRuntimeSkillContext, runtimeSkillPolicyVersion } from "./runtime-skills.js";

function send(message: unknown) { process.stdout.write(JSON.stringify(message) + "\n"); }

async function main() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = input[Symbol.asyncIterator]();
  let line = (await lines.next()).value as string | undefined;
  if (!line || Buffer.byteLength(line) > maxDevelopmentRequestBytes) throw new Error("Invalid runner input");
  const hello = JSON.parse(line) as { type?: unknown; runtimeSkillVersion?: unknown; bundleDigest?: unknown } | null;
  let ready = false;
  if (hello?.type === "runner.hello") {
    if (Object.keys(hello).length !== 3 || hello.runtimeSkillVersion !== runtimeSkillPolicyVersion ||
        hello.bundleDigest !== loadRuntimeSkill("analyst").selection.bundleDigest) throw new AnalysisError("unsupported_settings");
    send({ type: "runner.ready", runtimeSkillVersion: runtimeSkillPolicyVersion, bundleDigest: hello.bundleDigest });
    ready = true;
    line = (await lines.next()).value as string | undefined;
    if (!line || Buffer.byteLength(line) > maxDevelopmentRequestBytes) throw new AnalysisError("unsupported_settings");
  }
  const request = JSON.parse(line) as { instruction?: unknown; model?: unknown; effort?: unknown; workflow?: unknown; responseMode?: unknown; development?: unknown; runtimeSkillVersion?: unknown; stepSequence?: unknown; runtimeSkill?: unknown; effortPolicy?: { mode?: unknown; maxEffort?: unknown } };
  if (ready !== (request?.runtimeSkillVersion === runtimeSkillPolicyVersion)) throw new AnalysisError("unsupported_settings");
  if (typeof request.instruction !== "string" || typeof request.model !== "string") throw new Error("Invalid runner input");
  if (request.responseMode !== undefined && request.responseMode !== "goal-plan" && request.responseMode !== "assessment") throw new AnalysisError("unsupported_settings");
  if (request.responseMode && request.workflow) throw new AnalysisError("unsupported_settings");
  const development = request.development === undefined ? undefined : parseDevelopmentInput(request.development);
  if (development && (request.responseMode === "goal-plan" || request.workflow)) throw new AnalysisError("unsupported_settings");
  if (!development && Buffer.byteLength(line) > 65536) throw new Error("Invalid runner input");
  const effort = request.effort ?? "medium";
  if (!efforts.includes(effort as Effort)) throw new AnalysisError("unsupported_settings");
  const workflow = request.workflow ? parseAnalysisWorkflow(request.workflow) : undefined;
  const effortPolicy = request.effortPolicy ? parseEffortPolicy({ mode: request.effortPolicy.mode, maxEffort: request.effortPolicy.maxEffort }) : undefined;
  // Selection belongs to the parent. A new-policy child may only confirm the
  // supplied selection; it cannot silently choose or omit its own profile.
  const runtimeSkill = request.runtimeSkillVersion === undefined ? undefined : parseRuntimeSkillContext(request.runtimeSkill);
  if (runtimeSkill ? request.runtimeSkillVersion !== runtimeSkillPolicyVersion || request.stepSequence !== runtimeSkill.sequence
    : request.runtimeSkill !== undefined || request.stepSequence !== undefined) throw new AnalysisError("unsupported_settings");
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  try {
    if (development) {
      try { initializeDevelopmentWorkspace(development); }
      catch { throw new AnalysisError("input_changed"); }
    }
    const result = await createAnalysisWorkflow(createCodexExecutor("/codex-home", "/usr/local/lib/codex/bin/codex", true)).analyze({
      instruction: request.instruction, model: request.model, effort: effort as Effort, ...(request.responseMode ? { responseMode: request.responseMode } : {}), ...(effortPolicy ? { effortPolicy } : {}), ...(workflow ? { workflow } : {}), ...(development ? { development } : {}), workspace: "/workspace", signal: controller.signal,
      ...(runtimeSkill ? { runtimeSkillVersion: runtimeSkillPolicyVersion, stepSequence: runtimeSkill.sequence, runtimeSkill } : {}),
    }, async event => {
      send({ type: "event", event });
      if (event.step) {
        const line = (await lines.next()).value as string | undefined;
        if (!line || line.length > 1024) throw new Error("Missing step acknowledgement");
        const saved = JSON.parse(line) as { type?: string; sequence?: number; phase?: string };
        if (saved.type !== "step.saved" || saved.sequence !== event.step.sequence || saved.phase !== event.step.type) throw new Error("Invalid step acknowledgement");
      }
      if (event.runtimeSkill) {
        if (event.runtimeSkill.type !== "loaded") throw new Error("Child cannot select a skill");
        const line = (await lines.next()).value as string | undefined;
        if (!line || line.length > 1024) throw new Error("Missing skill acknowledgement");
        const saved = JSON.parse(line) as { type?: unknown; sequence?: unknown; digest?: unknown };
        if (saved.type !== "skill.saved" || saved.sequence !== event.runtimeSkill.sequence || saved.digest !== event.runtimeSkill.selection.digest) throw new Error("Invalid skill acknowledgement");
        controller.signal.throwIfAborted();
      }
    });
    if (development) {
      try { result.development = captureDevelopmentChanges(development); }
      catch { throw new AnalysisError("invalid_change"); }
    }
    send({ type: "result", result });
  } catch (error) {
    send({ type: "error", code: error instanceof AnalysisError ? error.code : "provider_error", retryAt: error instanceof AnalysisError ? error.retryAt?.toISOString() ?? null : null });
  }
}

// SDK가 남긴 핸들이 있어도 PID namespace의 init 종료로 모든 하위 명령을 닫습니다.
main().then(() => process.stdout.write("", () => process.exit(0)), error => {
  send({ type: "error", code: error instanceof AnalysisError ? error.code : "provider_error" });
  process.stdout.write("", () => process.exit(1));
});
