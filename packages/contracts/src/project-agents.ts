import { Type, type Static } from "@sinclair/typebox";
import { taskStatuses } from "./states.js";
export const agentRoleSchema = Type.Object(
  {
    key: Type.String({ pattern: "^[a-z][a-z0-9-]{0,47}$" }),
    name: Type.String({ minLength: 1, maxLength: 80, pattern: "\\S" }),
    mission: Type.String({ minLength: 1, maxLength: 800, pattern: "\\S" }),
  },
  { additionalProperties: false },
);
export type AgentRole = Static<typeof agentRoleSchema>;
export const assignedAgentSchema = Type.Object(
  {
    ...agentRoleSchema.properties,
    id: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  },
  { additionalProperties: false },
);
export type AssignedAgent = Static<typeof assignedAgentSchema>;
export const projectAgentsSchema = Type.Object({
  agents: Type.Array(
    Type.Object({
      ...assignedAgentSchema.properties,
      goalId: Type.String({ format: "uuid" }),
      taskCount: Type.Integer({ minimum: 1 }),
      completedTasks: Type.Integer({ minimum: 0 }),
      runningTasks: Type.Integer({ minimum: 0 }),
      latestTask: Type.Object({
        id: Type.String({ format: "uuid" }),
        title: Type.String(),
        status: Type.Union(taskStatuses.map((value) => Type.Literal(value))),
      }),
    }),
  ),
  nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
});
export type ProjectAgents = Static<typeof projectAgentsSchema>;
