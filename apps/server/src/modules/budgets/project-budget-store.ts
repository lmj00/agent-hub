import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { PeriodBudgetPolicy, ProjectBudget } from "@agent-hub/contracts";
import type { openDatabase } from "../../db/connection.js";
import { budgetReservations, goals, projectBudgets, projects } from "../../db/schema.js";
import { BudgetError, defaultProjectBudget, validateBudget } from "./budget-policy.js";
import { latestPeriod } from "./budget-store.js";

export function createProjectBudgetStore(db: ReturnType<typeof openDatabase>["db"]) {
  function view(projectId: string): ProjectBudget {
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) throw new BudgetError("PROJECT_NOT_FOUND");
    const configured = db
      .select()
      .from(projectBudgets)
      .where(eq(projectBudgets.projectId, projectId))
      .get();
    const accounts = [
      { scope: "project" as const, id: projectId, label: project.name },
      ...db
        .select()
        .from(goals)
        .where(eq(goals.projectId, projectId))
        .all()
        .map((goal) => ({
          scope: "goal" as const,
          id: goal.id,
          label: goal.definition.description,
        })),
    ];
    return {
      version: configured?.version ?? 0,
      policy: configured?.policy ?? defaultProjectBudget,
      accounts: accounts.map((account) => {
        const period = latestPeriod(db, `${account.scope}:${account.id}`);
        if (!period) return { ...account, period: null };
        const reservedRunMs = db
          .select({
            total: sql<number>`coalesce(sum(${budgetReservations.reservedRunMs}), 0)`,
          })
          .from(budgetReservations)
          .where(
            and(
              isNull(budgetReservations.settledAt),
              or(
                eq(budgetReservations.projectPeriodId, period.id),
                eq(budgetReservations.goalPeriodId, period.id),
              ),
            ),
          )
          .get()!.total;
        return {
          ...account,
          period: {
            startedAt: period.startedAt.toISOString(),
            endsAt: period.endsAt.toISOString(),
            policy: period.policy,
            calls: period.calls,
            chargedRunMs: Math.max(0, period.runMs - reservedRunMs),
            reservedRunMs,
          },
        };
      }),
    };
  }
  return {
    view,
    change(projectId: string, expectedVersion: number, input: PeriodBudgetPolicy) {
      const policy = validateBudget(input);
      return db.transaction(
        (tx) => {
          if (!tx.select().from(projects).where(eq(projects.id, projectId)).get())
            throw new BudgetError("PROJECT_NOT_FOUND");
          const previous = tx
            .select()
            .from(projectBudgets)
            .where(eq(projectBudgets.projectId, projectId))
            .get();
          if ((previous?.version ?? 0) !== expectedVersion)
            throw new BudgetError("BUDGET_VERSION_CHANGED");
          const updated = {
            policy,
            version: expectedVersion + 1,
            updatedAt: new Date(),
          };
          if (previous)
            tx.update(projectBudgets)
              .set(updated)
              .where(eq(projectBudgets.projectId, projectId))
              .run();
          else
            tx.insert(projectBudgets)
              .values({ projectId, ...updated })
              .run();
          // Existing periods deliberately retain their policy and usage.
          return view(projectId);
        },
        { behavior: "immediate" },
      );
    },
  };
}
