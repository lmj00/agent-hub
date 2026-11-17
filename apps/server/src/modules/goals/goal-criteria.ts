import { createHash } from "node:crypto";
import type { AnalysisAssessment, GoalCriterion, GoalDefinition } from "@agent-hub/contracts";

export function goalCriteria(goalId: string, definition: GoalDefinition): GoalCriterion[] {
  const lines = definition.completionCriteria
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const texts = lines.length > 32 ? [...lines.slice(0, 31), lines.slice(31).join("\n")] : lines;
  return texts.map((text, index) => ({
    id: createHash("sha256")
      .update(JSON.stringify([goalId, definition, index, text]))
      .digest("hex"),
    text,
  }));
}

// Missing, duplicate or foreign IDs cannot be used as item-level proof.
export function validCriterionChecks(criteria: GoalCriterion[], assessment: AnalysisAssessment) {
  const checks = assessment.criterionChecks;
  return checks &&
    checks.length === criteria.length &&
    new Set(checks.map((check) => check.id)).size === checks.length &&
    checks.every(
      (check) =>
        criteria.some((item) => item.id === check.id) &&
        check.evidence.length > 0 &&
        check.evidence.every((text) => text.trim()),
    )
    ? checks
    : null;
}
