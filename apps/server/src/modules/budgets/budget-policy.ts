import {
  parseResponse,
  periodBudgetPolicySchema,
  type PeriodBudgetPolicy,
  type BudgetWait,
} from "@agent-hub/contracts";

export const defaultProjectBudget: PeriodBudgetPolicy = {
  windowMs: 3600000,
  maxCalls: 60,
  maxRunMs: 2700000,
};
export class BudgetError extends Error {
  constructor(
    public readonly code: "INVALID_BUDGET" | "BUDGET_VERSION_CHANGED" | "PROJECT_NOT_FOUND",
  ) {
    super(code);
  }
}
export function validateBudget(value: PeriodBudgetPolicy): PeriodBudgetPolicy {
  try {
    parseResponse(periodBudgetPolicySchema, value);
  } catch {
    throw new BudgetError("INVALID_BUDGET");
  }
  if (value.maxRunMs > value.windowMs) throw new BudgetError("INVALID_BUDGET");
  return {
    windowMs: value.windowMs,
    maxCalls: value.maxCalls,
    maxRunMs: value.maxRunMs,
  };
}
export type Period = {
  id: string;
  goalId: string | null;
  startedAt: Date;
  endsAt: Date;
  policy: PeriodBudgetPolicy;
  calls: number;
  runMs: number;
};
export function periodWait(periods: Period[], now: Date): BudgetWait | null {
  const waits = periods.flatMap((period): BudgetWait[] => {
    const reason =
      now >= period.endsAt
        ? "period_end"
        : period.calls >= period.policy.maxCalls
          ? "call_limit"
          : period.runMs >= period.policy.maxRunMs
            ? "time_limit"
            : null;
    return reason
      ? [
          {
            scope: period.goalId ? "goal" : "project",
            reason,
            retryAt: period.endsAt.toISOString(),
          },
        ]
      : [];
  });
  return waits.sort((a, b) => b.retryAt.localeCompare(a.retryAt))[0] ?? null;
}
