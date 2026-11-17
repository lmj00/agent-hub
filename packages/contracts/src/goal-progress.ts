import { Type, type Static } from "@sinclair/typebox";
import { object, nullable, id, date, enumeration } from "./schema.js";

export const criterionSchema = object({
  id: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  text: Type.String({ minLength: 1, maxLength: 6000 }),
});
export type GoalCriterion = Static<typeof criterionSchema>;
export const criterionChecksSchema = Type.Array(
  object({
    id: criterionSchema.properties.id,
    status: enumeration(["verified", "unmet", "unknown"] as const),
    evidence: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
      minItems: 1,
      maxItems: 3,
    }),
  }),
  { maxItems: 32 },
);
export const goalProgressSchema = object({
  goalId: id,
  goalVersion: Type.Integer({ minimum: 1 }),
  sourceRevision: nullable(Type.String()),
  verifiedCount: Type.Integer({ minimum: 0 }),
  nextAction: Type.String(),
  criteria: Type.Array(
    object({
      ...criterionSchema.properties,
      status: enumeration([
        "pending",
        "queued",
        "running",
        "blocked",
        "applied",
        "verified",
        "recheck",
      ] as const),
      reason: Type.String(),
      taskId: nullable(id),
      agentName: nullable(Type.String()),
      proof: nullable(
        object({
          runId: id,
          sourceRevision: Type.String(),
          recordedAt: date,
          evidence: Type.Array(Type.String()),
        }),
      ),
    }),
    { maxItems: 32 },
  ),
});
export type GoalProgress = Static<typeof goalProgressSchema>;
