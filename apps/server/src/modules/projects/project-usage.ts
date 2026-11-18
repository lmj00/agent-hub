import { eq, sql } from "drizzle-orm";
import type { ProjectUsage } from "@agent-hub/contracts";
import type { openDatabase } from "../../db/connection.js";
import { runs, steps, tasks } from "../../db/schema.js";
import pricing from "./reference-pricing.json" with { type: "json" };

const rates: Record<string, { input: number; cached: number; output: number }> = pricing.rates;

export function readProjectUsage(
  db: Pick<ReturnType<typeof openDatabase>["db"], "select">,
  projectId: string,
): ProjectUsage {
  const model = sql<string>`coalesce(${steps.model}, ${runs.model})`;
  // Older reconciliation could copy the first result into unfinished workflow
  // steps. Only an assessment proves that a workflow step reported its own usage.
  const usage = sql`case when ${runs.workflowPolicy} is not null and ${steps.assessment} is null then null else ${steps.usage} end`;
  const rows = db
    .select({
      model,
      inputTokens: sql<number>`coalesce(sum(json_extract(${usage}, '$.inputTokens')), 0)`,
      cachedInputTokens: sql<number>`coalesce(sum(json_extract(${usage}, '$.cachedInputTokens')), 0)`,
      outputTokens: sql<number>`coalesce(sum(json_extract(${usage}, '$.outputTokens')), 0)`,
      reportedSteps: sql<number>`sum(case when ${usage} is not null then 1 else 0 end)`,
      unreportedSteps: sql<number>`sum(case when ${usage} is null and (${steps.finishedAt} is not null or ${runs.terminationConfirmedAt} is not null) then 1 else 0 end)`,
      pendingSteps: sql<number>`sum(case when ${usage} is null and ${steps.finishedAt} is null and ${runs.terminationConfirmedAt} is null then 1 else 0 end)`,
    })
    .from(steps)
    .innerJoin(runs, eq(steps.runId, runs.id))
    .innerJoin(tasks, eq(runs.taskId, tasks.id))
    .where(eq(tasks.projectId, projectId))
    .groupBy(model)
    .orderBy(model)
    .all();
  const models = rows.map((row) => {
    const rate = Object.hasOwn(rates, row.model) ? rates[row.model] : undefined;
    return {
      ...row,
      referenceCostUsd:
        rate && row.reportedSteps > 0
          ? ((row.inputTokens - row.cachedInputTokens) * rate.input +
              row.cachedInputTokens * rate.cached +
              row.outputTokens * rate.output) /
            1_000_000
          : null,
    };
  });
  const sum = (
    key:
      | "inputTokens"
      | "cachedInputTokens"
      | "outputTokens"
      | "reportedSteps"
      | "unreportedSteps"
      | "pendingSteps",
  ) => models.reduce((total, row) => total + row[key], 0);
  const priced = models.filter((row) => row.referenceCostUsd !== null);
  return {
    projectId,
    inputTokens: sum("inputTokens"),
    cachedInputTokens: sum("cachedInputTokens"),
    outputTokens: sum("outputTokens"),
    reportedSteps: sum("reportedSteps"),
    unreportedSteps: sum("unreportedSteps"),
    pendingSteps: sum("pendingSteps"),
    referenceCostUsd: priced.length
      ? priced.reduce((total, row) => total + row.referenceCostUsd!, 0)
      : null,
    unpricedSteps: models
      .filter((row) => row.referenceCostUsd === null)
      .reduce((total, row) => total + row.reportedSteps, 0),
    pricing: {
      date: pricing.date,
      source: pricing.source,
      basis: "api-standard-short-context",
    },
    models,
  };
}
