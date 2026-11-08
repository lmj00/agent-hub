import { object, nullable, enumeration, id, date, requestKey } from "./schema.js";
import { periodBudgetPolicySchema } from "./budgets.js";
import { Type, type Static } from "@sinclair/typebox";

export const goalDefinitionSchema = object({
  description: Type.String({ minLength: 1, maxLength: 10000 }),
  completionCriteria: Type.String({ minLength: 1, maxLength: 6000 }),
  kind: enumeration(["finite", "continuous"] as const),
  priority: Type.Integer({ minimum: 0, maximum: 100 }),
  allowedPaths: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), {
    minItems: 1,
    maxItems: 30,
    uniqueItems: true,
  }),
  excludedPaths: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), {
    maxItems: 30,
    uniqueItems: true,
  }),
  checkIntervalMs: Type.Integer({ minimum: 60000, maximum: 86400000 }),
  budget: periodBudgetPolicySchema,
});
export type GoalDefinition = Static<typeof goalDefinitionSchema>;
export const goalSchema = object({
  id,
  projectId: id,
  definition: goalDefinitionSchema,
  status: enumeration(["active", "paused", "completed"] as const),
  version: Type.Integer({ minimum: 1 }),
  nextCheckAt: nullable(date),
  createdAt: date,
  updatedAt: date,
});
export type Goal = Static<typeof goalSchema>;
export const goalsSchema = object({ goals: Type.Array(goalSchema) });
export const createGoalSchema = object({
  requestKey,
  definition: goalDefinitionSchema,
});
export const updateGoalSchema = object({
  requestKey,
  expectedVersion: Type.Integer({ minimum: 1 }),
  definition: goalDefinitionSchema,
});
export const controlGoalSchema = object({
  requestKey,
  expectedVersion: Type.Integer({ minimum: 1 }),
  action: enumeration(["pause", "resume"] as const),
});
export const goalHistorySchema = object({ revisions: Type.Array(goalSchema) });
