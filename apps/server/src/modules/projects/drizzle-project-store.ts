import { asc, desc, eq } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { projects } from "../../db/schema.js";
import type { ProjectStore } from "./create-project.js";

export function createDrizzleProjectStore(db: ReturnType<typeof openDatabase>["db"]): ProjectStore {
  return {
    save(project) {
      db.insert(projects).values(project).run();
    },
    list() {
      return db.select().from(projects).orderBy(desc(projects.createdAt), asc(projects.id)).all();
    },
    findById(id) {
      return db.select().from(projects).where(eq(projects.id, id)).get();
    },
  };
}
