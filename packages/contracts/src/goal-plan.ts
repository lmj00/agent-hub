import { Type, type Static } from "@sinclair/typebox";

const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
export const goalPlanSchema = Type.Object(
  {
    version: Type.Literal(1),
    goalVersion: Type.Integer({ minimum: 1 }),
    inputDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    outcome: Type.Union([Type.Literal("work"), Type.Literal("wait"), Type.Literal("complete")]),
    summary: text(2000),
    evidence: Type.Array(text(500), { maxItems: 12 }),
    tasks: Type.Array(
      Type.Object(
        {
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
