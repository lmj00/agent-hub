import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { tasks, taskReleases } from "../../db/schema.js";
import type { TaskStore } from "./create-task.js";

export function createDrizzleTaskStore(
  db: ReturnType<typeof openDatabase>["db"],
): TaskStore {
  function withLinks(rows: (typeof tasks.$inferSelect)[]) {
    if (!rows.length) return [];
    const ids = rows.map((row) => row.id);
    const links = db
      .select()
      .from(taskReleases)
      .where(
        or(
          inArray(taskReleases.sourceTaskId, ids),
          inArray(taskReleases.newTaskId, ids),
        ),
      )
      .all();
    const previous = new Map(
      links.map((link) => [link.newTaskId, link.sourceTaskId]),
    );
    const next = new Map(
      links.map((link) => [link.sourceTaskId, link.newTaskId]),
    );
    return rows.map((row) => ({
      ...row,
      planningTaskId: row.plannedWork?.planningTaskId ?? null,
      previousTaskId: previous.get(row.id) ?? null,
      nextTaskId: next.get(row.id) ?? null,
    }));
  }
  return {
    register(task) {
      return db.transaction(
        (tx) => {
          const inserted = tx
            .insert(tasks)
            .values(task)
            .onConflictDoNothing({
              target: [tasks.projectId, tasks.requestKey],
            })
            .returning()
            .get();
          if (inserted)
            return { task: withLinks([inserted])[0]!, created: true };

          const existing = tx
            .select()
            .from(tasks)
            .where(
              and(
                eq(tasks.projectId, task.projectId),
                eq(tasks.requestKey, task.requestKey),
              ),
            )
            .get();
          if (!existing)
            throw new Error("Task registration returned no record");
          return { task: withLinks([existing])[0]!, created: false };
        },
        { behavior: "immediate" },
      );
    },
    listByProject(projectId) {
      return withLinks(
        db
          .select()
          .from(tasks)
          .where(eq(tasks.projectId, projectId))
          .orderBy(desc(tasks.createdAt), asc(tasks.id))
          .all(),
      );
    },
    findById(id) {
      const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
      return row ? withLinks([row])[0] : undefined;
    },
  };
}
