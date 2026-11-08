import { asc, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { ProjectOverview } from "@agent-hub/contracts";
import type { openDatabase } from "../../db/connection.js";
import { goals, projects, runs, tasks } from "../../db/schema.js";

const pageSize = 24;
const latest = alias(tasks, "latest");
const running = alias(tasks, "running");
function taskColumns(table: typeof latest | typeof running) {
  return {
    id: table.id,
    instruction: sql<string>`substr(${table.instruction}, 1, 240)`,
    status: table.status,
    kind: table.kind,
    createdAt: table.createdAt,
  };
}

// Summaries deliberately omit AI output, goal definitions and full task history.
// One bounded query observes running work separately from the newest task.
export function readProjectOverview(
  db: ReturnType<typeof openDatabase>["db"],
  offset: number,
): ProjectOverview {
  const rows = db
    .select({
      project: projects,
      activeGoals: sql<number>`(select count(*) from ${goals} where ${goals.projectId} = ${projects.id} and ${goals.status} = 'active')`,
      terminationPending: sql<number>`exists(select 1 from ${runs} join ${tasks} on ${tasks.id} = ${runs.taskId} where ${tasks.projectId} = ${projects.id} and ${runs.status} in ('interrupted', 'blocked', 'waiting_capacity') and ${runs.terminationConfirmedAt} is null)`,
      nextCheckAt: sql<
        number | null
      >`(select min(${goals.nextCheckAt}) from ${goals} where ${goals.projectId} = ${projects.id} and ${goals.status} = 'active')`,
      runningTask: taskColumns(running),
      latestTask: taskColumns(latest),
    })
    .from(projects)
    .leftJoin(
      running,
      eq(
        running.id,
        sql`(select ${tasks.id} from ${tasks} where ${tasks.projectId} = ${projects.id} and ${tasks.status} = 'running' order by ${tasks.createdAt} desc, ${tasks.id} asc limit 1)`,
      ),
    )
    .leftJoin(
      latest,
      eq(
        latest.id,
        sql`(select ${tasks.id} from ${tasks} where ${tasks.projectId} = ${projects.id} order by ${tasks.createdAt} desc, ${tasks.id} asc limit 1)`,
      ),
    )
    .orderBy(desc(projects.createdAt), asc(projects.id))
    .limit(pageSize + 1)
    .offset(offset)
    .all();
  function task(value: (typeof rows)[number]["latestTask"]) {
    if (!value?.id) return null;
    if (!value.createdAt || !value.status || !value.kind)
      throw new Error("Incomplete task summary");
    return {
      id: value.id,
      instruction: value.instruction,
      status: value.status,
      kind: value.kind,
      createdAt: value.createdAt.toISOString(),
    };
  }
  return {
    projects: rows.slice(0, pageSize).map((row) => ({
      project: { ...row.project, createdAt: row.project.createdAt.toISOString() },
      activeGoals: row.activeGoals,
      terminationPending: Boolean(row.terminationPending),
      nextCheckAt: row.nextCheckAt === null ? null : new Date(row.nextCheckAt).toISOString(),
      runningTask: task(row.runningTask),
      latestTask: task(row.latestTask),
    })),
    nextOffset: rows.length > pageSize ? offset + pageSize : null,
  };
}
