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

export function parsePlanningIdentity(value: unknown) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new AnalysisError("unsupported_settings");
  const identity = value as Record<string, unknown>;
  if (
    Object.keys(identity).length !== 2 ||
    typeof identity.goalVersion !== "number" ||
    !Number.isSafeInteger(identity.goalVersion) ||
    identity.goalVersion < 1 ||
    typeof identity.inputDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(identity.inputDigest)
  )
    throw new AnalysisError("unsupported_settings");
  return { goalVersion: identity.goalVersion, inputDigest: identity.inputDigest };
}

export function planningOutputSchema(value: unknown, identityValue?: unknown) {
  const ids = parsePlanningCriterionIds(value);
  const identity = parsePlanningIdentity(identityValue);
  if (!ids && !identity) return goalPlanOutputSchema;
  const schema = structuredClone(goalPlanOutputSchema);
  // IDs are choices from the parent-owned Goal, not free text for the model to copy.
  if (ids)
    Object.assign(schema.properties.tasks.items.properties.criterionIds.items, { enum: ids });
  if (identity) {
    Object.assign(schema.properties.goalVersion, { enum: [identity.goalVersion] });
    Object.assign(schema.properties.inputDigest, { enum: [identity.inputDigest] });
  }
  return schema;
}
