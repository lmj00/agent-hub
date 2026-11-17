import { and, count, desc, eq, isNotNull, sql } from "drizzle-orm";
import { assignedAgentSchema, parseResponse, type ProjectAgents } from "@agent-hub/contracts";
import type { openDatabase } from "../../db/connection.js";
import { tasks } from "../../db/schema.js";

type Db = Pick<ReturnType<typeof openDatabase>["db"], "select">;
export function readProjectAgents(db: Db, projectId: string, offset = 0): ProjectAgents {
  const agent = sql<string>`json_extract(${tasks.plannedWork}, '$.agent')`;
  const agentId = sql<string>`json_extract(${tasks.plannedWork}, '$.agent.id')`;
  const rows = db
    .select({
      agent,
      goalId: tasks.goalId,
      taskCount: count(),
      completedTasks: sql<number>`sum(case when ${tasks.status} = 'succeeded' then 1 else 0 end)`,
      runningTasks: sql<number>`sum(case when ${tasks.status} in ('running', 'cancel_requested') then 1 else 0 end)`,
      latest: sql<number>`max(${tasks.createdAt})`,
    })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), isNotNull(agentId)))
    .groupBy(agentId)
    .orderBy(desc(sql`max(${tasks.createdAt})`), agentId)
    .limit(21)
    .offset(offset)
    .all();
  return {
    agents: rows.slice(0, 20).map((row) => {
      const role = parseResponse(assignedAgentSchema, JSON.parse(row.agent));
      const latest = db
        .select({
          id: tasks.id,
          instruction: tasks.instruction,
          plannedWork: tasks.plannedWork,
          status: tasks.status,
        })
        .from(tasks)
        .where(and(eq(tasks.projectId, projectId), eq(agentId, role.id)))
        .orderBy(desc(tasks.createdAt), desc(tasks.id))
        .limit(1)
        .get()!;
      return {
        ...role,
        goalId: row.goalId!,
        taskCount: row.taskCount,
        completedTasks: row.completedTasks,
        runningTasks: row.runningTasks,
        latestTask: {
          id: latest.id,
          title: latest.plannedWork?.title ?? latest.instruction.slice(0, 160),
          status: latest.status,
        },
      };
    }),
    nextOffset: rows.length > 20 ? offset + 20 : null,
  };
}
