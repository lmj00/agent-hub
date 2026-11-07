import type { CapacityState } from "@agent-hub/contracts";
export type CapacityPolicy = CapacityState["policy"];
export const defaultCapacityPolicy: CapacityPolicy = {
  version: 1,
  initialDelayMs: 900000,
  maxDelayMs: 21600000,
  jitterRatio: 0.2,
  maxChecks: 3,
};
export function parseCapacityPolicy(value: unknown): CapacityPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("automaticRecovery.capacity must be an object or false");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => !["initialDelayMs", "maxDelayMs", "jitterRatio", "maxChecks"].includes(key),
    )
  )
    throw new Error("Unknown capacity recovery option");
  const policy = { ...defaultCapacityPolicy, ...input } as CapacityPolicy;
  for (const field of ["initialDelayMs", "maxDelayMs"] as const) {
    if (!Number.isInteger(policy[field]) || policy[field] < 1000 || policy[field] > 86400000)
      throw new Error("Invalid capacity check interval");
  }
  if (
    policy.maxDelayMs < policy.initialDelayMs ||
    typeof policy.jitterRatio !== "number" ||
    !Number.isFinite(policy.jitterRatio) ||
    policy.jitterRatio < 0 ||
    policy.jitterRatio > 0.5 ||
    !Number.isInteger(policy.maxChecks) ||
    policy.maxChecks < 1 ||
    policy.maxChecks > 20
  )
    throw new Error("Invalid capacity recovery limits");
  return policy;
}
export function capacityCheckAt(
  policy: CapacityPolicy,
  checks: number,
  now: Date,
  retryAt: Date | null,
  random: number,
) {
  const base = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** Math.min(checks, 20));
  const delay = Math.min(
    policy.maxDelayMs,
    Math.ceil(base * (1 + Math.max(0, Math.min(1, random)) * policy.jitterRatio)),
  );
  return new Date(Math.max(now.getTime() + delay, retryAt?.getTime() ?? 0)).toISOString();
}
