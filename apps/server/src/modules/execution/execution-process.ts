import { AnalysisError, analysisErrorCodes, type AnalysisEvent, type AnalysisExecutor, type AnalysisResult, type ExecutionIdentity } from "./analysis.js";
import { createCodexExecutor } from "./codex-executor.js";
import type { ExecutionConfig } from "./execution-config.js";
import { attachContainer, prepareContainer, removeFinishedContainer, stopAndConfirmContainer } from "./container-runtime.js";

type RunnerMessage =
  | { type: "event"; event: AnalysisEvent }
  | { type: "result"; result: AnalysisResult }
  | { type: "error"; code: AnalysisError["code"]; retryAt?: string | null };

export function createConfiguredExecutor(config: ExecutionConfig): AnalysisExecutor {
  if (!config.containerImage) return createCodexExecutor(config.codexHome);
  return createContainerExecutor(config.containerImage, config.codexHome);
}

export function createContainerExecutor(image: string, codexHome: string): AnalysisExecutor {
  const executions = new Map<string, Promise<ExecutionIdentity | null>>();
  return {
    async analyze(request, onEvent) {
      if (!request.runId) throw new Error("A run ID is required for container execution");
      request.signal.throwIfAborted();
      const prepared = prepareContainer(image, codexHome, request);
      // 중단으로 analyze 대기가 끝나도 생성 중인 컨테이너를 같은 식별자로 확인합니다.
      executions.set(request.runId, prepared.catch(() => null));
      let identity: ExecutionIdentity;
      try { identity = await prepared; }
      catch { throw new AnalysisError("unsupported_settings"); }
      onEvent({ kind: "execution.prepared", execution: identity });
      request.signal.throwIfAborted();
      const child = attachContainer(identity);
      return new Promise<AnalysisResult>((resolve, reject) => {
        let buffer = "";
        let bytes = 0;
        let result: AnalysisResult | undefined;
        let failure: AnalysisError | undefined;
        const fail = () => {
          failure = new AnalysisError("provider_error", true);
          reject(failure);
          child.kill("SIGKILL");
        };
        child.stdout!.setEncoding("utf8");
        child.stdout!.on("data", (chunk: string) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 2 * 1024 * 1024) { fail(); return; }
          buffer += chunk;
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            try {
              const message = JSON.parse(line) as RunnerMessage;
              if (message.type === "event" && typeof message.event?.kind === "string") {
                // 자식이 보낸 실행 ID는 신뢰하지 않고 SDK 이벤트만 전달합니다.
                onEvent({ kind: message.event.kind, ...(message.event.sessionId ? { sessionId: message.event.sessionId } : {}) });
              } else if (message.type === "result" && typeof message.result?.output === "string" && !result) {
                result = message.result;
              } else if (message.type === "error" && analysisErrorCodes.includes(message.code)) {
                const retryAt = message.code === "capacity" && typeof message.retryAt === "string" ? new Date(message.retryAt) : null;
                if (retryAt && !Number.isFinite(retryAt.getTime())) throw new Error("Invalid provider retry time");
                failure = new AnalysisError(message.code, false, retryAt);
              } else throw new Error("Invalid runner message");
            } catch { fail(); return; }
          }
          if (buffer.length > 512 * 1024) fail();
        });
        // SDK 진단 원문·명령 인자는 서버 로그로 전달하지 않습니다.
        child.stderr!.resume();
        child.once("error", fail);
        child.stdin!.on("error", fail);
        child.once("close", (code) => {
          if (failure) reject(failure);
          else if (code !== 0 || buffer || !result) reject(new AnalysisError("provider_error", true));
          else resolve(result);
        });
        child.stdin!.end(JSON.stringify({ instruction: request.instruction, model: request.model, effort: request.effort ?? "medium" }) + "\n");
      });
    },
    async confirmTermination(runId) {
      const prepared = executions.get(runId);
      if (!prepared) return null;
      const identity = await prepared;
      // create 단계 실패 뒤에는 start를 호출하지 않습니다. 만들어진 껍데기가
      // 있더라도 모델·명령을 시작하지 않았다는 사실은 이 호출에서 확인됩니다.
      return identity ? await stopAndConfirmContainer(identity) : new Date();
    },
    async cleanup(runId) {
      const identity = await executions.get(runId);
      if (identity) await removeFinishedContainer(identity);
      executions.delete(runId);
    },
  };
}
