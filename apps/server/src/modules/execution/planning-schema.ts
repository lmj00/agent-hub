import { goalPlanOutputSchema } from "@agent-hub/contracts";
import { AnalysisError } from "./analysis.js";

export function parsePlanningCriterionIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 32 ||
    value.some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) ||
    new Set(value).size !== value.length
  )
    throw new AnalysisError("unsupported_settings");
  return [...value];
}

export function planningOutputSchema(value: unknown) {
  const ids = parsePlanningCriterionIds(value);
  if (!ids) return goalPlanOutputSchema;
  const schema = structuredClone(goalPlanOutputSchema);
  // IDs are choices from the parent-owned Goal, not free text for the model to copy.
  Object.assign(schema.properties.tasks.items.properties.criterionIds.items, { enum: ids });
  return schema;
}
