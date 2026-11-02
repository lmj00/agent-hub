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
    public readonly retryAt: Date | null = null,
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
  if (/usage limit|quota|rate.?limit|too many requests|\b429\b/i.test(message)) return new AnalysisError("capacity", false, providerRetryAt(message));
  if (/unauthori[sz]ed|\b401\b|authentication|not logged in|sign in|refresh.token/i.test(message)) return new AnalysisError("authentication");
  if (/unsupported|not supported|model.*not found|invalid.*model|invalid.*config/i.test(message)) return new AnalysisError("unsupported_settings");
  return new AnalysisError("provider_error");
}

// SDK 0.166.0은 오류 메시지만 제공합니다. 시간대가 명시된 절대 시각만
// 받아들이며 "내일", "오전 9시" 등은 제공 시각으로 추측하지 않습니다.
function providerRetryAt(message: string): Date | null {
  const text = /(?:retry|try again)\s+at\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2}))(?![\d:.])/i.exec(message)?.[1];
  if (!text) return null;
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) return null;
  const day = text.slice(0, 10);
  const calendar = new Date(`${day}T00:00:00.000Z`);
  return Number.isFinite(calendar.getTime()) && calendar.toISOString().startsWith(day) ? date : null;
}
