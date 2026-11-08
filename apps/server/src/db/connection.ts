import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";
import { preparePrivateDatabase } from "./private-storage.js";

export const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));

export function openDatabase(databasePath: string, migrationsFolder = migrationsDirectory) {
  const client = new Database(preparePrivateDatabase(databasePath), { timeout: 1000 });

  try {
    client.pragma("journal_mode = WAL");
    client.pragma("foreign_keys = ON");
    client.pragma("synchronous = FULL");

    const db = drizzle(client, { schema });
    migrate(db, { migrationsFolder });

    return {
      db,
      client,
      checkReady() {
        db.select().from(schema.projects).limit(1).all();
        db.select().from(schema.repositoryImports).limit(1).all();
        db.select().from(schema.tasks).limit(1).all();
        db.select().from(schema.runs).limit(1).all();
        db.select().from(schema.runExecutions).limit(1).all();
        db.select().from(schema.developmentRepositories).limit(1).all();
        db.select().from(schema.developmentRounds).limit(1).all();
        db.select().from(schema.changeApplications).limit(1).all();
        db.select().from(schema.steps).limit(1).all();
        db.select().from(schema.events).limit(1).all();
        db.select().from(schema.executionOwner).limit(1).all();
        db.select().from(schema.providerGates).limit(1).all();
        db.select().from(schema.recoveryRequests).limit(1).all();
        db.select().from(schema.authSessions).limit(1).all();
        db.select().from(schema.serviceTargets).limit(1).all();
        db.select().from(schema.serviceObservations).limit(1).all();
        db.select().from(schema.goals).limit(1).all();
        db.select().from(schema.goalRevisions).limit(1).all();
        db.select().from(schema.projectBudgets).limit(1).all();
        db.select().from(schema.budgetPeriods).limit(1).all();
        db.select().from(schema.budgetReservations).limit(1).all();
        db.select().from(schema.planningCycles).limit(1).all();
        db.select().from(schema.taskReleases).limit(1).all();
        db.select().from(schema.notifications).limit(1).all();
      },
      close() {
        if (client.open) client.close();
      },
    };
  } catch (error) {
    client.close();
    throw error;
  }
}
