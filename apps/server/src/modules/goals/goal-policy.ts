import {
  goalDefinitionSchema,
  parseResponse,
  type GoalDefinition,
} from "@agent-hub/contracts";

export class GoalError extends Error {
  constructor(
    public readonly code:
      | "PROJECT_NOT_FOUND"
      | "GOAL_NOT_FOUND"
      | "REQUEST_KEY_CONFLICT"
      | "GOAL_VERSION_CHANGED"
      | "INVALID_GOAL"
      | "GOAL_COMPLETED",
  ) {
    super(code);
  }
}

export function normalizeGoalDefinition(value: GoalDefinition): GoalDefinition {
  try {
    parseResponse(goalDefinitionSchema, value);
  } catch {
    throw new GoalError("INVALID_GOAL");
  }
  const description = value.description.trim(),
    completionCriteria = value.completionCriteria.trim();
  if (
    !description ||
    !completionCriteria ||
    value.budget.maxRunMs > value.budget.windowMs
  )
    throw new GoalError("INVALID_GOAL");
  const normalizePaths = (paths: string[]) => {
    const normalized = paths.map((path) => path.trim());
    if (
      normalized.some(
        (path) =>
          !path ||
          path.startsWith("/") ||
          /[\\:*?\[\]\x00-\x1f]/.test(path) ||
          (path !== "." &&
            path
              .split("/")
              .some((part) => !part || part === "." || part === "..")),
      )
    )
      throw new GoalError("INVALID_GOAL");
    if (new Set(normalized).size !== normalized.length)
      throw new GoalError("INVALID_GOAL");
    return normalized.sort();
  };
  const allowedPaths = normalizePaths(value.allowedPaths),
    excludedPaths = normalizePaths(value.excludedPaths);
  if (
    excludedPaths.includes(".") ||
    allowedPaths.some((path) =>
      excludedPaths.some(
        (excluded) => path === excluded || path.startsWith(`${excluded}/`),
      ),
    )
  )
    throw new GoalError("INVALID_GOAL");
  return {
    description,
    completionCriteria,
    kind: value.kind,
    priority: value.priority,
    allowedPaths,
    excludedPaths,
    checkIntervalMs: value.checkIntervalMs,
    budget: {
      windowMs: value.budget.windowMs,
      maxCalls: value.budget.maxCalls,
      maxRunMs: value.budget.maxRunMs,
    },
  };
}
