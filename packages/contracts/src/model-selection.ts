import { Type, type Static } from "@sinclair/typebox";
import { enumeration, object } from "./schema.js";

export const modelTiers = ["luna", "sol", "astra"] as const;
export const modelTierSchema = enumeration(modelTiers);
export type ModelTier = Static<typeof modelTierSchema>;
export const modelRecommendationSchema = object({
  tier: modelTierSchema,
  reason: Type.String({ minLength: 1, maxLength: 500 }),
});
export type ModelRecommendation = Static<typeof modelRecommendationSchema>;
