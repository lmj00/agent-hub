import type { Effort } from "@agent-hub/contracts";
export type EffortPolicy = {
  version: 1;
  mode: "fixed" | "adaptive";
  maxEffort: Effort;
};
export type EffortSelection = {
  effort: Effort;
  reason: string;
  policyVersion: 1;
};
export const defaultEffortPolicy: EffortPolicy = {
  version: 1,
  mode: "fixed",
  maxEffort: "medium",
};
const levels = ["medium", "high", "xhigh"] as const;
export function parseEffortPolicy(value: unknown): EffortPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("effortPolicy must be an object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["mode", "maxEffort"].includes(key)))
    throw new Error("Unknown effort policy field");
  const mode = input.mode ?? "adaptive";
  const maxEffort = input.maxEffort ?? (mode === "fixed" ? "medium" : "xhigh");
  if (
    !["fixed", "adaptive"].includes(String(mode)) ||
    !levels.includes(maxEffort as Effort) ||
    (mode === "fixed" && maxEffort !== "medium")
  )
    throw new Error(
      "Effort policy must use medium, high or xhigh; fixed mode uses medium",
    );
  return {
    version: 1,
    mode: mode as EffortPolicy["mode"],
    maxEffort: maxEffort as Effort,
  };
}
export function selectInitialEffort(
  instruction: string,
  policy = defaultEffortPolicy,
): EffortSelection {
  if (policy.mode === "fixed")
    return {
      effort: "medium",
      reason: "고정 기본 정책으로 medium을 적용했습니다.",
      policyVersion: 1,
    };
  const signals = [
    {
      pattern: /동시성|경합|교착|concurren|race.condition|deadlock/i,
      label: "동시성·경합",
    },
    {
      pattern: /보안|인증|권한|security|authentication|authorization/i,
      label: "보안·인증",
    },
    {
      pattern:
        /아키텍처|설계|마이그레이션|트랜잭션|architecture|migration|transaction/i,
      label: "설계·데이터 변경",
    },
  ].filter((signal) => signal.pattern.test(instruction));
  const distributedCause =
    /분산|여러 시스템|다중 시스템|distributed|cross.system/i.test(
      instruction,
    ) && /원인|인과|복잡|교착|consistency|causal|deadlock/i.test(instruction);
  const suggested: Effort =
    distributedCause || signals.length >= 3
      ? "xhigh"
      : signals.length
        ? "high"
        : "medium";
  const effort =
    levels[
      Math.min(levels.indexOf(suggested), levels.indexOf(policy.maxEffort))
    ]!;
  const basis = distributedCause
    ? "여러 시스템의 복잡한 원인 분석"
    : signals.length
      ? signals.map((signal) => signal.label).join(", ")
      : "범위가 명확한 초기 분석";
  return {
    effort,
    reason: `${basis} 기준으로 ${suggested}를 선택했습니다.${effort !== suggested ? ` 허용 상한에 따라 ${effort}로 제한했습니다.` : ""}`,
    policyVersion: 1,
  };
}
