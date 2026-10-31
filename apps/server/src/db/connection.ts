import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));

export function openDatabase(databasePath: string, migrationsFolder = migrationsDirectory) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const client = new Database(databasePath, { timeout: 1000 });

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
