import { object, nullable, enumeration } from "./schema.js";
import { Type, type Static } from "@sinclair/typebox";
import { criterionChecksSchema } from "./goal-progress.js";
import { modelTierSchema } from "./model-selection.js";

const nextStepSchema = object({
  purpose: Type.String({ minLength: 1, maxLength: 1000 }),
  effort: Type.String({ minLength: 1, maxLength: 20 }),
  reason: Type.String({ minLength: 1, maxLength: 500 }),
  model: Type.Optional(nullable(modelTierSchema)),
});

const scopeExpansionSchema = nullable(
  object({
    paths: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
      minItems: 1,
      maxItems: 20,
    }),
    reason: Type.String({ minLength: 1, maxLength: 1000 }),
  }),
);

const blockerSchema = nullable(
  object({
    kind: enumeration([
      "implementation",
      "information",
      "environment",
      "permission",
      "decision",
      "unknown",
    ] as const),
    reason: Type.String({ minLength: 1, maxLength: 500 }),
    nextAction: Type.String({ minLength: 1, maxLength: 500 }),
  }),
);

export const analysisAssessmentSchema = object({
  blocker: Type.Optional(blockerSchema),
  criterionChecks: Type.Optional(criterionChecksSchema),
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
  next: nullable(nextStepSchema),
});
export type AnalysisAssessment = Static<typeof analysisAssessmentSchema>;
// Structured model output requires every property; stored history stays compatible.
export const analysisResponseSchema = object({
  ...analysisAssessmentSchema.properties,
  next: nullable(Type.Required(nextStepSchema)),
  criterionChecks: criterionChecksSchema,
  scopeExpansion: scopeExpansionSchema,
  blocker: blockerSchema,
});
// A developer only produces a candidate. Independent verification owns approval.
export const developmentAssessmentSchema = object({
  ...analysisResponseSchema.properties,
  complete: Type.Literal(false),
});
