import { modelTiers, type ModelTier, type ModelRecommendation } from "@agent-hub/contracts";

export type ModelRouting = { models: Record<ModelTier, string> };
export type ModelPolicy = ModelRouting & { version: 1; minimumTier: "luna" | "sol" };

export function isModelId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value);
}

export function parseModelRouting(value: unknown): ModelRouting {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("modelRouting must contain models for luna, sol and astra");
  const input = value as Record<string, unknown>;
  const models = input.models;
  if (
    Object.keys(input).some((key) => key !== "models") ||
    !models ||
    typeof models !== "object" ||
    Array.isArray(models)
  )
    throw new Error("Invalid model routing settings");
  const entries = models as Record<string, unknown>;
  if (
    Object.keys(entries).length !== modelTiers.length ||
    modelTiers.some((tier) => !isModelId(entries[tier]))
  )
    throw new Error("Each model tier requires an explicit valid model ID");
  return {
    models: {
      luna: entries.luna as string,
      sol: entries.sol as string,
      astra: entries.astra as string,
    },
  };
}

export function parseModelPolicy(value: unknown): ModelPolicy {
  if (!value || typeof value !== "object") throw new Error("Invalid model policy snapshot");
  const input = value as Record<string, unknown>;
  if (
    input.version !== 1 ||
    !["luna", "sol"].includes(String(input.minimumTier)) ||
    Object.keys(input).some((key) => !["version", "minimumTier", "models"].includes(key))
  )
    throw new Error("Invalid model policy snapshot");
  return {
    ...parseModelRouting({ models: input.models }),
    version: 1,
    minimumTier: input.minimumTier as "luna" | "sol",
  };
}

// This is a conservative extra floor, not a semantic security classifier.
export function sensitiveModelScope(text: string): boolean {
  return /보안|인증|권한|결제|실거래|security|auth(?:entication|orization)?|permission|payment|credential|secret|migration|동시성|concurren|race.condition/i.test(
    text,
  );
}

export function selectModel(
  fallback: string,
  policy: ModelPolicy | null | undefined,
  proposed?: ModelRecommendation | null,
  independentReview = false,
) {
  if (!policy) return { model: fallback, reason: "고정 모델 설정을 적용했습니다." };
  const tier = proposed?.tier ?? "sol";
  const minimum = independentReview || policy.minimumTier === "sol" ? "sol" : "luna";
  const selected = modelTiers[Math.max(modelTiers.indexOf(tier), modelTiers.indexOf(minimum))]!;
  return {
    model: policy.models[selected],
    reason: `${proposed ? `${tier} 제안` : "기본 Sol"} → ${selected}.${selected !== tier ? " 독립 검토 또는 민감한 작업의 최소 등급을 적용했습니다." : ""}${proposed ? ` 근거: ${proposed.reason}` : ""}`,
  };
}

export const modelRecommendationInstruction =
  "Recommend the next call's model tier in next.model: luna for focused low-risk summaries or mechanical edits, sol for ordinary implementation and review, astra for difficult design, uncertain root causes or complex reasoning; null uses the server default. Explain the choice in next.reason. Consider complexity, uncertainty and impact, not file count alone. Do not escalate for network errors, missing credentials or quota. This recommendation never changes permissions, budgets or verification; the server applies its configured models and minimum tier.";
