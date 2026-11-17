import { Type, type Static } from "@sinclair/typebox";

import { agentRoleSchema } from "./project-agents.js";
import { criterionSchema } from "./goal-progress.js";
import { modelRecommendationSchema } from "./model-selection.js";

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
export const goalPlanSchema = Type.Object(
  {
    version: Type.Literal(1),
    goalVersion: Type.Integer({ minimum: 1 }),
    inputDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    outcome: Type.Union([Type.Literal("work"), Type.Literal("wait"), Type.Literal("complete")]),
    summary: text(2000),
    inspectionKeys: Type.Optional(
      Type.Array(Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$" }), { maxItems: 3 }),
    ),
    evidence: Type.Array(text(500), { maxItems: 12 }),
    tasks: Type.Array(
      Type.Object(
        {
          agent: Type.Optional(agentRoleSchema),
          model: Type.Optional(modelRecommendationSchema),
          criterionIds: Type.Optional(
            Type.Array(criterionSchema.properties.id, { minItems: 1, maxItems: 32 }),
          ),
          title: text(160),
          instruction: text(4000),
          acceptanceCriteria: text(2000),
          // Codex structured output rejects uniqueItems. The server checks duplicate
          // and overlapping paths in parseGoalPlan before accepting a proposal.
          paths: Type.Array(text(300), { minItems: 1, maxItems: 20 }),
          evidence: Type.Array(text(500), { minItems: 1, maxItems: 8 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 3 },
    ),
  },
  { additionalProperties: false },
);
export type GoalPlan = Static<typeof goalPlanSchema>;

// Saved plans from older executors remain readable. New Codex calls must assign a role.
export const goalPlanOutputSchema = Type.Object(
  {
    ...goalPlanSchema.properties,
    inspectionKeys: Type.Array(goalPlanSchema.properties.inspectionKeys.items, { maxItems: 3 }),
    tasks: Type.Array(Type.Required(goalPlanSchema.properties.tasks.items), { maxItems: 3 }),
  },
  { additionalProperties: false },
);
