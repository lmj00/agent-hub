import { and, asc, desc, eq } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { tasks } from "../../db/schema.js";
import type { TaskStore } from "./create-task.js";

export function createDrizzleTaskStore(db: ReturnType<typeof openDatabase>["db"]): TaskStore {
  return {
    register(task) {
      return db.transaction((tx) => {
        const inserted = tx.insert(tasks).values(task)
          .onConflictDoNothing({ target: [tasks.projectId, tasks.requestKey] })
          .returning().get();
        if (inserted) return { task: inserted, created: true };

        const existing = tx.select().from(tasks).where(and(
          eq(tasks.projectId, task.projectId), eq(tasks.requestKey, task.requestKey),
        )).get();
        if (!existing) throw new Error("Task registration returned no record");
        return { task: existing, created: false };
      }, { behavior: "immediate" });
    },
    listByProject(projectId) {
      return db.select().from(tasks).where(eq(tasks.projectId, projectId))
        .orderBy(desc(tasks.createdAt), asc(tasks.id)).all();
    },
    findById(id) {
      return db.select().from(tasks).where(eq(tasks.id, id)).get();
    },
  };
}
