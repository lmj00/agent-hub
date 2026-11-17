import { expect, test } from "vitest";
import { goalCriteria, validCriterionChecks } from "../../src/modules/goals/goal-criteria.js";
import type { GoalDefinition, AnalysisAssessment } from "@agent-hub/contracts";
const definition: GoalDefinition = {
  description: "Goal",
  completionCriteria: "one\ntwo",
  kind: "finite",
  priority: 50,
  allowedPaths: ["src"],
  excludedPaths: [],
  checkIntervalMs: 60000,
  budget: { windowMs: 3600000, maxCalls: 20, maxRunMs: 1800000 },
};
test("criteria identity binds the full definition and never truncates excess lines", () => {
  const criteria = goalCriteria("goal", definition);
  expect(criteria).toHaveLength(2);
  expect(goalCriteria("goal", structuredClone(definition))).toEqual(criteria);
  expect(goalCriteria("other", definition)[0]!.id).not.toBe(criteria[0]!.id);
  expect(goalCriteria("goal", { ...definition, description: "Changed goal" })[0]!.id).not.toBe(
    criteria[0]!.id,
  );
  const lines = Array.from({ length: 40 }, (_, i) => `condition ${i}`);
  const grouped = goalCriteria("goal", { ...definition, completionCriteria: lines.join("\n") });
  expect(grouped).toHaveLength(32);
  expect(grouped.map((item) => item.text).join("\n")).toBe(lines.join("\n"));
});
test("complete item proof requires exact coverage and nonblank evidence", () => {
  const criteria = goalCriteria("goal", definition);
  const assessment: AnalysisAssessment = {
    complete: true,
    next: null,
    report: "review",
    evidence: [],
    unresolved: [],
    criterionChecks: criteria.map((item) => ({
      id: item.id,
      status: "verified",
      evidence: ["test and code"],
    })),
  };
  expect(validCriterionChecks(criteria, assessment)).toHaveLength(2);
  expect(
    validCriterionChecks(criteria, {
      ...assessment,
      criterionChecks: assessment.criterionChecks!.slice(0, 1),
    }),
  ).toBeNull();
  expect(
    validCriterionChecks(criteria, {
      ...assessment,
      criterionChecks: assessment.criterionChecks!.map((item) => ({ ...item, evidence: [" "] })),
    }),
  ).toBeNull();
});
