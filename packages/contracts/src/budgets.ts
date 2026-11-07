import { object, nullable, enumeration, text, id, date } from "./schema.js";
import { Type, type Static } from "@sinclair/typebox";

export const periodBudgetPolicySchema = object({
  windowMs: Type.Integer({ minimum: 600000, maximum: 86400000 }),
  maxCalls: Type.Integer({ minimum: 1, maximum: 1000 }),
  maxRunMs: Type.Integer({ minimum: 1000, maximum: 86400000 }),
});
export type PeriodBudgetPolicy = Static<typeof periodBudgetPolicySchema>;
export const budgetWaitSchema = object({
  scope: enumeration(["project", "goal"] as const),
  reason: enumeration(["call_limit", "time_limit", "period_end"] as const),
  retryAt: date,
});
export type BudgetWait = Static<typeof budgetWaitSchema>;
export const budgetPeriodSchema = object({
  startedAt: date,
  endsAt: date,
  policy: periodBudgetPolicySchema,
  calls: Type.Integer({ minimum: 0 }),
  chargedRunMs: Type.Integer({ minimum: 0 }),
  reservedRunMs: Type.Integer({ minimum: 0 }),
});
export const projectBudgetSchema = object({
  version: Type.Integer({ minimum: 0 }),
  policy: periodBudgetPolicySchema,
  accounts: Type.Array(
    object({
      scope: enumeration(["project", "goal"] as const),
      id,
      label: text,
      period: nullable(budgetPeriodSchema),
    }),
  ),
});
export const updateProjectBudgetSchema = object({
  expectedVersion: Type.Integer({ minimum: 0 }),
  policy: periodBudgetPolicySchema,
});
export type ProjectBudget = Static<typeof projectBudgetSchema>;
