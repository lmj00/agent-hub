import { object, nullable, enumeration, text, id, date, requestKey } from "./schema.js";
import {
  planningEvidenceSchema,
  developmentEvidenceSchema,
  goalVerificationEvidenceSchema,
  runtimeSkillEvidenceSchema,
} from "./evidence.js";
import { efforts, stopReasons, recoveryActions, status } from "./states.js";
import { analysisAssessmentSchema } from "./assessments.js";
import { Type, type Static } from "@sinclair/typebox";

export const runSchema = object({
  id: text,
  taskId: text,
  attempt: Type.Integer({ minimum: 1 }),
  goalVersion: nullable(Type.Integer({ minimum: 1 })),
  status,
  model: text,
  effort: text,
  startedAt: date,
  finishedAt: nullable(date),
});
export const runsSchema = object({ runs: Type.Array(runSchema) });
export const runDetailsSchema = object({
  ...runSchema.properties,
  planningEvidence: nullable(planningEvidenceSchema),
  developmentEvidence: nullable(developmentEvidenceSchema),
  goalVerification: nullable(goalVerificationEvidenceSchema),
  runtimeSkillVersion: nullable(Type.Integer({ minimum: 1 })),
  lastActivityAt: date,
  result: nullable(text),
  errorCode: nullable(text),
  stopReason: nullable(enumeration(stopReasons)),
  stopRequestedAt: nullable(date),
  terminationConfirmedAt: nullable(date),
  retryAt: nullable(date),
  steps: Type.Array(
    object({
      sequence: Type.Integer(),
      status,
      sessionId: nullable(text),
      effort: nullable(enumeration(efforts)),
      effortReason: nullable(text),
      effortPolicyVersion: nullable(Type.Integer()),
      proposedEffort: nullable(text),
      purpose: nullable(text),
      model: nullable(text),
      assessment: nullable(analysisAssessmentSchema),
      runtimeSkill: nullable(runtimeSkillEvidenceSchema),
      usage: nullable(
        object({
          inputTokens: Type.Integer(),
          cachedInputTokens: Type.Integer(),
          outputTokens: Type.Integer(),
        }),
      ),
      startedAt: date,
      finishedAt: nullable(date),
    }),
  ),
  events: Type.Array(object({ sequence: Type.Integer(), kind: text, createdAt: date })),
});
export type Run = Static<typeof runSchema>;
export type RunDetails = Static<typeof runDetailsSchema>;
export const queueSchema = object({
  state: enumeration([
    "disabled",
    "idle",
    "running",
    "recovering",
    "held",
    "error",
    "stopping",
    "stopped",
  ] as const),
  runId: nullable(text),
  taskId: nullable(text),
  reason: nullable(text),
  lastCheckedAt: nullable(date),
  automaticRecoveryEnabled: Type.Boolean(),
  capacityRecoveryEnabled: Type.Boolean(),
});
export type Queue = Static<typeof queueSchema>;
export const capacityStateSchema = object({
  policy: object({
    version: Type.Literal(1),
    initialDelayMs: Type.Integer(),
    maxDelayMs: Type.Integer(),
    jitterRatio: Type.Number(),
    maxChecks: Type.Integer(),
  }),
  checks: Type.Integer(),
  nextCheckAt: nullable(date),
  decisionVersion: Type.Integer(),
  reason: text,
});
export type CapacityState = Static<typeof capacityStateSchema>;
export const providerGateSchema = object({
  version: Type.Integer({ minimum: 0 }),
  blocked: Type.Boolean(),
  reason: nullable(enumeration(["authentication", "capacity", "configuration"] as const)),
  blockedAt: nullable(date),
  retryAt: nullable(date),
  sourceRunId: nullable(text),
  probeTaskId: nullable(text),
  probeRunId: nullable(text),
  capacityState: nullable(capacityStateSchema),
});
export type ProviderGate = Static<typeof providerGateSchema>;

export const recoveryInputSchema = object({
  requestKey,
  runId: nullable(id),
  action: enumeration(recoveryActions),
  providerGateVersion: Type.Optional(nullable(Type.Integer({ minimum: 0 }))),
});
export const recoverySchema = object({
  id,
  taskId: id,
  runId: nullable(id),
  requestKey: text,
  action: enumeration(recoveryActions),
  providerGateVersion: nullable(Type.Integer()),
  status: enumeration(["pending", "completed", "rejected"] as const),
  resultStatus: nullable(status),
  errorCode: nullable(text),
  createdAt: date,
  finishedAt: nullable(date),
});
export type RecoveryInput = Static<typeof recoveryInputSchema>;
export type Recovery = Static<typeof recoverySchema>;
