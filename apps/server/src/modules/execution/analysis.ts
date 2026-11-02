export type AnalysisUsage = { inputTokens: number; cachedInputTokens: number; outputTokens: number };
export type ExecutionIdentity = { kind: "docker"; containerId: string; token: string; engineId: string };
export type AnalysisEvent = { kind: string; sessionId?: string; execution?: ExecutionIdentity };
export type AnalysisRequest = { instruction: string; workspace: string; model: string; signal: AbortSignal; runId?: string };
export type AnalysisResult = { output: string; usage: AnalysisUsage | null };

export const stopReasons = ["user_cancel", "server_shutdown", "timeout", "unknown"] as const;
export type StopReason = typeof stopReasons[number];

// 이유가 없는 외부 중단 신호는 재실행하지 않는 사용자 취소로 취급합니다.
export function signalStopReason(signal: AbortSignal): StopReason {
  return signal.reason === "server_shutdown" ? "server_shutdown" : "user_cancel";
}

export type AnalysisExecutor = {
  analyze(request: AnalysisRequest, onEvent: (event: AnalysisEvent) => void): Promise<AnalysisResult>;
  // 신호 전송 여부가 아니라 이 실행의 모든 명령이 끝났는지 관측합니다. 확인 불가는 null입니다.
  confirmTermination?(runId: string): Promise<Date | null>;
  cleanup?(runId: string): Promise<void>;
};

export class AnalysisError extends Error {
  constructor(
    public readonly code: "authentication" | "capacity" | "unsupported_settings" | "provider_error" | "output_limit",
    public readonly completionUncertain = false,
  ) {
    super(code);
  }
}

// 출력은 비공개 기록이지만 흔한 인증 문자열은 저장 전에 한 번 더 제거합니다.
export function redactOutput(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED]");
}

export function classifyCodexError(message: string): AnalysisError {
  if (/usage limit|quota|rate.?limit|too many requests|429/i.test(message)) return new AnalysisError("capacity");
  if (/unauthori[sz]ed|401|authentication|not logged in|sign in|refresh.token/i.test(message)) return new AnalysisError("authentication");
  if (/unsupported|not supported|model.*not found|invalid.*model|invalid.*config/i.test(message)) return new AnalysisError("unsupported_settings");
  return new AnalysisError("provider_error");
}
