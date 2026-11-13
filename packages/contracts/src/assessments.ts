import { object, nullable } from "./schema.js";
import { Type, type Static } from "@sinclair/typebox";

const scopeExpansionSchema = nullable(
  object({
    paths: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
    }),
    reason: Type.String({ minLength: 1, maxLength: 1000 }),
  }),
);

export const analysisAssessmentSchema = object({
  report: Type.String({ minLength: 1, maxLength: 16000 }),
  evidence: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
    maxItems: 8,
  }),
  unresolved: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
    maxItems: 8,
  }),
  complete: Type.Boolean(),
  // Older saved assessments have no scope request.
  scopeExpansion: Type.Optional(scopeExpansionSchema),
  next: nullable(
    object({
      purpose: Type.String({ minLength: 1, maxLength: 1000 }),
      effort: Type.String({ minLength: 1, maxLength: 20 }),
      reason: Type.String({ minLength: 1, maxLength: 500 }),
    }),
  ),
});
export type AnalysisAssessment = Static<typeof analysisAssessmentSchema>;
// Structured model output requires every property; stored history stays compatible.
export const analysisResponseSchema = object({
  ...analysisAssessmentSchema.properties,
  scopeExpansion: scopeExpansionSchema,
});
// A developer only produces a candidate. Independent verification owns approval.
export const developmentAssessmentSchema = object({
  ...analysisResponseSchema.properties,
  complete: Type.Literal(false),
});
