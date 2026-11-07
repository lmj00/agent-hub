import {
  AnalysisError,
  analysisErrorCodes,
  type AnalysisEvent,
  type AnalysisExecutor,
  type AnalysisResult,
  type AnalysisRequest,
  type ExecutionIdentity,
  maxRunExecutions,
} from "./analysis.js";
import { createCodexExecutor } from "./codex-executor.js";
import { createAnalysisWorkflow, parseStepUpdate } from "./analysis-workflow.js";
import type { ExecutionConfig } from "./execution-config.js";
import { runVerificationContainer, verificationRunnerInput } from "./verification-process.js";
import {
  parseRuntimeSkillContext,
  runtimeSkillPolicyVersion,
  sameRuntimeSkill,
  selectRuntimeSkill,
} from "./runtime-skills.js";
import { parseVerificationRequest } from "./verification-config.js";
import {
  maxDevelopmentArtifactBytes,
  maxDevelopmentRequestBytes,
  parseDevelopmentInput,
  parseDevelopmentChanges,
} from "./development-capture.js";
import {
  attachContainer,
  prepareContainer,
  removeFinishedContainer,
  stopAndConfirmContainer,
} from "./container-runtime.js";

type RunnerMessage =
  | { type: "runner.ready"; runtimeSkillVersion: number; bundleDigest: string }
  | { type: "event"; event: AnalysisEvent }
  | { type: "result"; result: AnalysisResult }
  | { type: "error"; code: AnalysisError["code"]; retryAt?: string | null };

export function createConfiguredExecutor(config: ExecutionConfig): AnalysisExecutor {
  if (!config.containerImage) return createAnalysisWorkflow(createCodexExecutor(config.codexHome));
  return createContainerExecutor(config.containerImage, config.codexHome);
}

type PendingExecution = {
  prepared: Promise<ExecutionIdentity | null>;
  confirmedAt: Date | null;
  saved: boolean;
  observation?: Promise<Date | null>;
};
type RunExecutions = {
  entries: PendingExecution[];
  active: boolean;
  sealed: boolean;
};

function confirmExecution(entry: PendingExecution): Promise<Date | null> {
  if (entry.confirmedAt) return Promise.resolve(entry.confirmedAt);
  // Normal phase completion and cancellation can arrive together. Share the
  // in-flight observation so a second stop cannot discard the first proof.
  entry.observation ??= (async () => {
    const identity = await entry.prepared;
    const proof = identity ? await stopAndConfirmContainer(identity) : new Date();
    if (proof) entry.confirmedAt = proof;
    return proof;
  })().finally(() => {
    delete entry.observation;
  });
  return entry.observation;
}

export function createContainerExecutor(image: string, codexHome: string): AnalysisExecutor {
  const executions = new Map<string, RunExecutions>();
  return {
    runtimeSkillVersion: runtimeSkillPolicyVersion,
    async analyze(request, onEvent) {
      if (!request.runId) throw new Error("A run ID is required for container execution");
      const runId = request.runId;
      request.signal.throwIfAborted();
      if (request.development) {
        if (request.workflow || request.responseMode === "goal-plan")
          throw new AnalysisError("unsupported_settings");
        request = {
          ...request,
          development: parseDevelopmentInput(request.development, {
            verification: !!request.verification,
          }),
        };
      }
      if (request.verification) {
        request = { ...request, verification: parseVerificationRequest(request.verification) };
        verificationRunnerInput(request);
      } else runnerInput(request);
      const run = executions.get(runId) ?? {
        entries: [],
        active: false,
        sealed: false,
      };
      if (
        run.sealed ||
        run.active ||
        run.entries.some((entry) => !entry.saved) ||
        run.entries.length >= maxRunExecutions
      )
        throw new Error("Previous execution must be confirmed before another phase");
      executions.set(runId, run);
      run.active = true;
      try {
        if (!request.verification) request = await selectRuntimeSkill(request, onEvent);
        if (run.sealed) throw new Error("Execution stopped before preparation");
        request.signal.throwIfAborted();
        if (!request.verification) runnerInput(request);
        const prepared = prepareContainer(image, codexHome, request);
        // Retain every identity, including preparation still pending after abort.
        const entry: PendingExecution = {
          prepared: prepared.catch(() => null),
          confirmedAt: null,
          saved: false,
        };
        run.entries.push(entry);
        let identity: ExecutionIdentity;
        try {
          identity = await prepared;
        } catch {
          throw new AnalysisError("unsupported_settings");
        }
        await onEvent({ kind: "execution.prepared", execution: identity });
        request.signal.throwIfAborted();
        if (run.sealed) throw new Error("Execution was stopped during preparation");
        const result = request.verification
          ? await runVerificationContainer(identity, request, () => confirmExecution(entry))
          : await runContainerProtocol(identity, request, onEvent);
        const confirmedAt = await confirmExecution(entry);
        if (!confirmedAt) throw new AnalysisError("provider_error", true);
        await onEvent({
          kind: "execution.terminated",
          executionTermination: { identity, confirmedAt },
        });
        request.signal.throwIfAborted();
        if (run.sealed) throw new Error("Execution was stopped before phase completion");
        entry.saved = true;
        return result;
      } catch (error) {
        run.sealed = true;
        throw error;
      } finally {
        run.active = false;
      }
    },
    async confirmTermination(runId) {
      const run = executions.get(runId);
      if (!run) return null;
      // Seal synchronously: late preparation cannot start after this observation.
      run.sealed = true;
      if (!run.entries.length) return new Date();
      for (const entry of run.entries) {
        if (entry.confirmedAt) continue;
        // A failed create is never started; an unidentified shell cannot run code.
        if (!(await confirmExecution(entry))) return null;
      }
      return new Date(Math.max(...run.entries.map((entry) => entry.confirmedAt!.getTime())));
    },
    async cleanup(runId) {
      const run = executions.get(runId);
      if (!run || !run.sealed || run.entries.some((entry) => !entry.confirmedAt)) return;
      for (const entry of run.entries) {
        const identity = await entry.prepared;
        if (identity) await removeFinishedContainer(identity);
      }
      executions.delete(runId);
    },
  };
}

function runContainerProtocol(
  identity: ExecutionIdentity,
  request: AnalysisRequest,
  onEvent: (event: AnalysisEvent) => void | Promise<void>,
): Promise<AnalysisResult> {
  const child = attachContainer(identity);
  return new Promise<AnalysisResult>((resolve, reject) => {
    let buffer = "";
    let bytes = 0;
    let result: AnalysisResult | undefined;
    let failure: AnalysisError | undefined;
    let processing = Promise.resolve();
    let currentSkill = request.runtimeSkill;
    let runnerReady = !currentSkill;
    let skillLoaded = !currentSkill;
    let stepStarted = !request.workflow;
    const fail = (error?: unknown) => {
      // Preserve policy refusals across the child-protocol boundary.
      failure =
        error instanceof AnalysisError &&
        (error.code === "budget_limit" || error.code === "unsupported_settings")
          ? error
          : new AnalysisError("provider_error", true);
      reject(failure);
      child.kill("SIGKILL");
    };
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 2 * 1024 * 1024 + (request.development ? maxDevelopmentArtifactBytes : 0)) {
        fail();
        return;
      }
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        processing = processing
          .then(async () => {
            if (failure) return;
            const message = JSON.parse(line) as RunnerMessage;
            if (!runnerReady) {
              if (
                message?.type !== "runner.ready" ||
                Object.keys(message).length !== 3 ||
                message.runtimeSkillVersion !== runtimeSkillPolicyVersion ||
                message.bundleDigest !== currentSkill!.selection.bundleDigest
              )
                throw new AnalysisError("unsupported_settings");
              request.signal.throwIfAborted();
              runnerReady = true;
              child.stdin!.write(runnerInput(request));
              return;
            }
            if (message.type === "event" && typeof message.event?.kind === "string") {
              const skill = message.event.runtimeSkill;
              if (
                skill ||
                message.event.kind === "skill.selected" ||
                message.event.kind === "skill.loaded"
              ) {
                if (
                  !currentSkill ||
                  !stepStarted ||
                  skillLoaded ||
                  !skill ||
                  skill.type !== "loaded" ||
                  Object.keys(skill).length !== 3 ||
                  message.event.kind !== "skill.loaded"
                )
                  throw new Error("Invalid skill event");
                const loaded = parseRuntimeSkillContext({
                  sequence: skill.sequence,
                  selection: skill.selection,
                });
                if (!sameRuntimeSkill(loaded, currentSkill))
                  throw new Error("Skill confirmation differs");
                request.signal.throwIfAborted();
                await onEvent({
                  kind: "skill.loaded",
                  runtimeSkill: { type: "loaded", ...loaded },
                });
                request.signal.throwIfAborted();
                skillLoaded = true;
                child.stdin!.write(
                  JSON.stringify({
                    type: "skill.saved",
                    sequence: loaded.sequence,
                    digest: loaded.selection.digest,
                  }) + "\n",
                );
                return;
              }
              // 자식이 보낸 실행 ID는 신뢰하지 않고 SDK 이벤트만 전달합니다.
              const step = message.event.step ? parseStepUpdate(message.event.step) : undefined;
              if (step && !request.workflow)
                throw new Error("Child cannot manage parent-owned workflow steps");
              if (
                message.event.sessionId !== undefined &&
                (typeof message.event.sessionId !== "string" ||
                  message.event.sessionId.length > 200)
              )
                throw new Error("Invalid session ID");
              if (
                step &&
                message.event.kind !== (step.type === "start" ? "step.started" : "step.completed")
              )
                throw new Error("Invalid step event");
              if (currentSkill && !skillLoaded && step?.type !== "start")
                throw new Error("Skill must be saved before model events");
              request.signal.throwIfAborted();
              await onEvent({
                kind: message.event.kind,
                ...(message.event.sessionId ? { sessionId: message.event.sessionId } : {}),
                ...(step ? { step } : {}),
              });
              if (step) {
                if (step.type === "start" && request.runtimeSkill) {
                  currentSkill = {
                    sequence: step.sequence,
                    selection: request.runtimeSkill.selection,
                  };
                  await onEvent({
                    kind: "skill.selected",
                    runtimeSkill: { type: "selected", ...currentSkill },
                  });
                  skillLoaded = false;
                  stepStarted = true;
                } else if (step.type === "complete") stepStarted = false;
                request.signal.throwIfAborted();
                child.stdin!.write(
                  JSON.stringify({
                    type: "step.saved",
                    sequence: step.sequence,
                    phase: step.type,
                  }) + "\n",
                );
              }
            } else if (
              message.type === "result" &&
              typeof message.result?.output === "string" &&
              !result
            ) {
              if (!skillLoaded) throw new Error("Skill load is unconfirmed");
              if (Buffer.byteLength(message.result.output) > 65536)
                throw new Error("Runner output exceeds limits");
              result = {
                output: message.result.output,
                usage: message.result.usage,
                ...(request.development
                  ? {
                      development: parseDevelopmentChanges(
                        message.result.development,
                        request.development,
                      ),
                    }
                  : {}),
              };
              child.stdin!.end();
            } else if (message.type === "error" && analysisErrorCodes.includes(message.code)) {
              const retryAt =
                message.code === "capacity" && typeof message.retryAt === "string"
                  ? new Date(message.retryAt)
                  : null;
              if (retryAt && !Number.isFinite(retryAt.getTime()))
                throw new Error("Invalid provider retry time");
              failure = new AnalysisError(message.code, false, retryAt);
            } else throw new Error("Invalid runner message");
          })
          .catch(fail);
      }
      if (
        Buffer.byteLength(buffer) >
        (request.development ? maxDevelopmentArtifactBytes + 65536 : 512 * 1024)
      )
        fail();
    });
    // SDK 진단 원문·명령 인자는 서버 로그로 전달하지 않습니다.
    child.stderr!.resume();
    child.once("error", fail);
    child.stdin!.on("error", fail);
    child.once("close", async (code) => {
      await processing;
      if (failure) reject(failure);
      else if (!runnerReady) reject(new AnalysisError("unsupported_settings"));
      else if (code !== 0 || buffer || !result) reject(new AnalysisError("provider_error", true));
      else resolve(result);
    });
    // No executable task goes to an image until it confirms the protocol and
    // bundle. Old runners reject this message before constructing their SDK.
    child.stdin!.write(
      currentSkill
        ? JSON.stringify({
            type: "runner.hello",
            runtimeSkillVersion: runtimeSkillPolicyVersion,
            bundleDigest: currentSkill.selection.bundleDigest,
          }) + "\n"
        : runnerInput(request),
    );
  });
}

function runnerInput(request: AnalysisRequest) {
  const line = JSON.stringify({
    instruction: request.instruction,
    model: request.model,
    effort: request.effort ?? "medium",
    effortPolicy: request.effortPolicy,
    workflow: request.workflow,
    responseMode: request.responseMode,
    development: request.development,
    runtimeSkillVersion: request.runtimeSkillVersion,
    stepSequence: request.stepSequence,
    runtimeSkill: request.runtimeSkill,
  });
  if (Buffer.byteLength(line) > (request.development ? maxDevelopmentRequestBytes : 65536))
    throw new AnalysisError("input_unavailable");
  return line + "\n";
}
