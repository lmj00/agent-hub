import { createHash } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  assignedAgentSchema,
  parseResponse,
  type AgentRole,
  type AssignedAgent,
} from "@agent-hub/contracts";
import type { openDatabase } from "../../db/connection.js";
import { tasks } from "../../db/schema.js";

export const maxGoalAgents = 8;
export function assignedAgent(goalId: string, role: AgentRole): AssignedAgent {
  return {
    ...role,
    id: createHash("sha256")
      .update(JSON.stringify([goalId, role.key]))
      .digest("hex"),
  };
}
export function readGoalAgents(
  db: Pick<ReturnType<typeof openDatabase>["db"], "select">,
  goalId: string,
): AssignedAgent[] {
  const agent = sql<string>`json_extract(${tasks.plannedWork}, '$.agent')`;
  return db
    .select({ agent })
    .from(tasks)
    .where(and(eq(tasks.goalId, goalId), isNotNull(agent)))
    .groupBy(agent)
    .orderBy(agent)
    .limit(maxGoalAgents + 1)
    .all()
    .map((row) => parseResponse(assignedAgentSchema, JSON.parse(row.agent)));
}
