import { object, nullable } from "./schema.js";
import { Type, type Static } from "@sinclair/typebox";

export const analysisAssessmentSchema = object({
  report: Type.String({ minLength: 1, maxLength: 16000 }),
  evidence: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
    maxItems: 8,
  }),
  unresolved: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
    maxItems: 8,
  }),
  complete: Type.Boolean(),
  next: nullable(
    object({
      purpose: Type.String({ minLength: 1, maxLength: 1000 }),
      effort: Type.String({ minLength: 1, maxLength: 20 }),
      reason: Type.String({ minLength: 1, maxLength: 500 }),
    }),
  ),
});
export type AnalysisAssessment = Static<typeof analysisAssessmentSchema>;
// A developer only produces a candidate. Independent verification owns approval.
export const developmentAssessmentSchema = object({
  ...analysisAssessmentSchema.properties,
  complete: Type.Literal(false),
});
