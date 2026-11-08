import { Type, type Static } from "@sinclair/typebox";
import { projectSchema } from "./projects.js";
import { date, enumeration, id, nullable, object, text } from "./schema.js";
import { status } from "./states.js";

const summaryTask = object({
  id,
  instruction: text,
  status,
  kind: enumeration(["planning", "work"] as const),
  createdAt: date,
});
export const projectOverviewQuerySchema = object({
  offset: Type.Optional(Type.String({ pattern: "^(0|[1-9][0-9]{0,5}|1000000)$" })),
});
export const projectOverviewSchema = object({
  projects: Type.Array(
    object({
      project: projectSchema,
      activeGoals: Type.Integer({ minimum: 0 }),
      nextCheckAt: nullable(date),
      terminationPending: Type.Boolean(),
      runningTask: nullable(summaryTask),
      latestTask: nullable(summaryTask),
    }),
    { maxItems: 24 },
  ),
  nextOffset: nullable(Type.Integer({ minimum: 0 })),
});
export type ProjectOverview = Static<typeof projectOverviewSchema>;
