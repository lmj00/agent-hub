import type { RetryState } from "@agent-hub/contracts";
export type { RetryState };
export type RetryPolicy = RetryState["policy"];

// 판단은 외부 호출이나 DB 없이 수행하며 정책은 작업에 보존합니다.
export const defaultRetryPolicy: RetryPolicy = {
  version: 1,
  initialDelayMs: 10000,
  maxDelayMs: 300000,
  jitterRatio: 0.2,
  maxRetries: 3,
  maxConsecutiveErrors: 3,
  maxTotalRunMs: 1800000,
};
export function parseRetryPolicy(value: unknown): RetryPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("automaticRecovery must be an object");
  const { capacity: _capacity, ...input } = value as Record<string, unknown>;
  const fields = [
    "initialDelayMs",
    "maxDelayMs",
    "jitterRatio",
    "maxRetries",
    "maxConsecutiveErrors",
    "maxTotalRunMs",
  ];
  if (Object.keys(input).some((key) => !fields.includes(key)))
    throw new Error("Unknown automaticRecovery option");
  const policy = { ...defaultRetryPolicy, ...input } as RetryPolicy;
  const ranges = {
    initialDelayMs: [1000, 3600000],
    maxDelayMs: [1000, 86400000],
    maxRetries: [0, 20],
    maxConsecutiveErrors: [1, 20],
    maxTotalRunMs: [1000, 86400000],
  } as const;
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const number = policy[key as keyof typeof ranges];
    if (!Number.isInteger(number) || number < min || number > max)
      throw new Error(`Invalid automaticRecovery ${key}`);
  }
  if (
    typeof policy.jitterRatio !== "number" ||
    !Number.isFinite(policy.jitterRatio) ||
    policy.jitterRatio < 0 ||
    policy.jitterRatio > 0.5 ||
    policy.maxDelayMs < policy.initialDelayMs
  )
    throw new Error("Invalid automaticRecovery delay limits");
  return policy;
}
export function initialRetryState(policy: RetryPolicy): RetryState {
  return {
    policy: { ...policy },
    retries: 0,
    consecutiveErrors: 0,
    lastError: null,
    decisionRunId: null,
    nextAttemptAt: null,
    reason: null,
    totalRunMs: 0,
  };
}
export function retryLimitReason(state: RetryState): string | null {
  if (state.totalRunMs >= state.policy.maxTotalRunMs) return "task_time_limit";
  if (state.retries >= state.policy.maxRetries) return "retry_limit";
  if (state.consecutiveErrors >= state.policy.maxConsecutiveErrors)
    return "repeated_error_limit";
  return null;
}
export function retryDelay(
  policy: RetryPolicy,
  retries: number,
  random: number,
): number {
  const base = Math.min(
    policy.maxDelayMs,
    policy.initialDelayMs * 2 ** Math.min(20, retries),
  );
  return Math.min(
    policy.maxDelayMs,
    Math.ceil(
      base * (1 + Math.max(0, Math.min(1, random)) * policy.jitterRatio),
    ),
  );
}
export function retryableError(code: string | null) {
  return (
    code === "transient" || code === "server_shutdown" || code === "owner_lost"
  );
}
