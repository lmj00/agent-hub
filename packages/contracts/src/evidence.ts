import { object, nullable, enumeration, text, id, date } from "./schema.js";
import { analysisAssessmentSchema } from "./assessments.js";
import { planningServiceSchema } from "./services.js";
import { Type, type Static } from "@sinclair/typebox";

const inputCountSchema = object({
  total: Type.Integer({ minimum: 0 }),
  included: Type.Integer({ minimum: 0 }),
});
export const planningEvidenceSchema = object({
  capturedAt: date,
  services: Type.Array(planningServiceSchema, { maxItems: 10 }),
  counts: object({
    files: inputCountSchema,
    history: inputCountSchema,
    suppressedWork: inputCountSchema,
    services: inputCountSchema,
  }),
});
export type PlanningEvidence = Static<typeof planningEvidenceSchema>;
export const developmentPhases = [
  "preparing",
  "developing",
  "preparing_test",
  "testing",
  "reviewing",
  "needs_changes",
  "verified",
] as const;
const developmentRoundSchema = object({
  sequence: Type.Integer({ minimum: 1, maximum: 3 }),
  phase: enumeration(developmentPhases),
  createdAt: date,
  capturedAt: nullable(date),
  candidateDigest: nullable(text),
  changes: Type.Array(
    object({
      path: text,
      action: enumeration(["add", "modify", "delete"] as const),
      bytes: Type.Integer({ minimum: 0 }),
    }),
    { maxItems: 500 },
  ),
  test: nullable(
    object({
      status: enumeration(["passed", "failed", "timed_out", "output_limit"] as const),
      exitCode: Type.Integer({ minimum: 0, maximum: 255 }),
      oomKilled: Type.Boolean(),
      elapsedMs: Type.Integer({ minimum: 0 }),
      output: text,
      recordedAt: date,
    }),
  ),
  review: nullable(object({ assessment: analysisAssessmentSchema, recordedAt: date })),
});
export const developmentEvidenceSchema = object({
  phase: enumeration([...developmentPhases, "applying", "applied"] as const),
  maxRounds: Type.Literal(3),
  rounds: Type.Array(developmentRoundSchema, { maxItems: 3 }),
  application: nullable(
    object({
      id,
      status: enumeration(["pending", "applied"] as const),
      roundSequence: Type.Integer({ minimum: 1, maximum: 3 }),
      baseRevision: text,
      resultCommit: text,
      candidateDigest: text,
      createdAt: date,
      appliedAt: nullable(date),
    }),
  ),
});
export type DevelopmentEvidence = Static<typeof developmentEvidenceSchema>;
export const goalVerificationEvidenceSchema = object({
  sourceRevision: text,
  inputDigest: text,
  startedAt: date,
  phase: enumeration(["testing", "reviewing", "verified", "needs_changes"] as const),
  completionApplied: Type.Boolean(),
  test: developmentRoundSchema.properties.test,
  review: developmentRoundSchema.properties.review,
});
export type GoalVerificationEvidence = Static<typeof goalVerificationEvidenceSchema>;
export const runtimeSkillRoles = ["planner", "developer", "reviewer", "analyst"] as const;
export type RuntimeSkillRole = (typeof runtimeSkillRoles)[number];
// Historical descriptors remain readable after the installed bundle changes.
export const runtimeSkillSelectionSchema = object({
  id: Type.String({ pattern: "^gstack-agent-hub/(planner|developer|reviewer|analyst)$" }),
  role: enumeration(runtimeSkillRoles),
  version: Type.Integer({ minimum: 1 }),
  mode: Type.Literal("adapted_instructions"),
  upstreamVersion: Type.String({ minLength: 1, maxLength: 64, pattern: "^[0-9]+(\\.[0-9]+)*$" }),
  upstreamCommit: Type.String({ pattern: "^[a-f0-9]{40}$" }),
  digest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  bundleDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  bytes: Type.Integer({ minimum: 1, maximum: 32768 }),
});
export type RuntimeSkillSelection = Static<typeof runtimeSkillSelectionSchema>;
export const runtimeSkillEvidenceSchema = object({
  ...runtimeSkillSelectionSchema.properties,
  selectedAt: date,
  loadedAt: nullable(date),
});
export type RuntimeSkillEvidence = Static<typeof runtimeSkillEvidenceSchema>;
