import { Type, type Static } from "@sinclair/typebox";

const count = Type.Integer({ minimum: 0 });
const totals = {
  inputTokens: count,
  cachedInputTokens: count,
  outputTokens: count,
  reportedSteps: count,
  unreportedSteps: count,
  pendingSteps: count,
};
export const projectUsageSchema = Type.Object({
  projectId: Type.String({ format: "uuid" }),
  ...totals,
  referenceCostUsd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  unpricedSteps: count,
  pricing: Type.Object({
    date: Type.String(),
    source: Type.String(),
    basis: Type.Literal("api-standard-short-context"),
  }),
  models: Type.Array(
    Type.Object({
      model: Type.String(),
      ...totals,
      referenceCostUsd: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    }),
  ),
});
export type ProjectUsage = Static<typeof projectUsageSchema>;
