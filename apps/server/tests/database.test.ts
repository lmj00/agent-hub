import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { migrationsDirectory, openDatabase } from "../src/db/connection.js";
import { projects, tasks } from "../src/db/schema.js";

const migrationCount = JSON.parse(readFileSync(join(migrationsDirectory, "meta", "_journal.json"), "utf8")).entries.length;

let directory: string;
let databasePath: string;
let connections: ReturnType<typeof openDatabase>[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "agent-hub-db-"));
  databasePath = join(directory, "data", "hub.sqlite");
  connections = [];
});

afterEach(() => {
  for (const connection of connections) connection.close();
  rmSync(directory, { recursive: true, force: true });
});

function connect(folder?: string) {
  const connection = openDatabase(databasePath, folder);
  connections.push(connection);
  return connection;
}

const project = {
  id: "example-project",
  name: "Example project",
  workspaceKey: "example-workspace",
  createdAt: new Date("2026-10-29T00:00:00.000Z"),
};

// 실제 이력의 복사본에 다음 변경을 추가해 업그레이드와 실패를 재현합니다.
function withNextMigration(sql: string) {
  const folder = join(directory, "migrations");
  cpSync(migrationsDirectory, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const last = journal.entries.at(-1);
  const tag = `${String(last.idx + 1).padStart(4, "0")}_test_change`;
  journal.entries.push({ idx: last.idx + 1, version: last.version, when: last.when + 1, tag, breakpoints: true });
  writeFileSync(journalPath, JSON.stringify(journal));
  writeFileSync(join(folder, `${tag}.sql`), sql);
  return folder;
}

test("creates an empty database with the project schema and configured SQLite settings", () => {
  const { db, client, checkReady } = connect();
  db.insert(projects).values(project).run();

  expect(db.select().from(projects).get()).toEqual(project);
  expect(client.pragma("journal_mode", { simple: true })).toBe("wal");
  expect(client.pragma("foreign_keys", { simple: true })).toBe(1);
  expect(client.pragma("synchronous", { simple: true })).toBe(2);
  expect(() => checkReady()).not.toThrow();
});

test("keeps data after reopening and does not apply the initial migration twice", () => {
  const first = connect();
  first.db.insert(projects).values(project).run();
  first.close();
  expect(first.client.open).toBe(false);

  const second = connect();
  expect(second.db.select().from(projects).all()).toEqual([project]);
  expect(second.client.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get()).toEqual({ count: migrationCount });
});

test("rolls back all writes in a transaction when a duplicate project id is inserted", () => {
  const { db } = connect();

  expect(() => db.transaction((tx) => {
    tx.insert(projects).values(project).run();
    tx.insert(projects).values(project).run();
  })).toThrow();
  expect(db.select().from(projects).all()).toEqual([]);
});

test("upgrades an existing database without losing records or repeating the upgrade", () => {
  const first = connect();
  first.db.insert(projects).values(project).run();
  first.close();

  const folder = withNextMigration("ALTER TABLE projects ADD COLUMN note TEXT;");
  const upgraded = connect(folder);
  expect(upgraded.db.select().from(projects).all()).toEqual([project]);
  expect(upgraded.client.prepare("SELECT note FROM projects").get()).toEqual({ note: null });
  upgraded.close();

  const reopened = connect(folder);
  expect(reopened.client.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get()).toEqual({ count: migrationCount + 1 });
});

test("rolls back a failed migration and leaves the existing data and migration history intact", () => {
  const first = connect();
  first.db.insert(projects).values(project).run();
  first.close();

  const folder = withNextMigration(
    "ALTER TABLE projects ADD COLUMN note TEXT;\n--> statement-breakpoint\nTHIS IS INVALID SQL;",
  );
  expect(() => connect(folder)).toThrow();

  const client = new Database(databasePath);
  try {
    expect(client.prepare("SELECT name FROM projects").get()).toEqual({ name: project.name });
    expect(() => client.prepare("SELECT note FROM projects")).toThrow();
    expect(client.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get()).toEqual({ count: migrationCount });
  } finally {
    client.close();
  }
});

test("rejects a migration folder with missing history", () => {
  expect(() => connect(directory)).toThrow();
});

test("adds tasks to a projects-only database and preserves existing projects", () => {
  const folder = join(directory, "legacy-migrations");
  cpSync(migrationsDirectory, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.slice(0, 1);
  writeFileSync(journalPath, JSON.stringify(journal));

  const legacy = connect(folder);
  legacy.db.insert(projects).values(project).run();
  expect(() => legacy.client.prepare("SELECT * FROM tasks").all()).toThrow();
  legacy.close();

  const upgraded = connect();
  expect(upgraded.db.select().from(projects).all()).toEqual([project]);
  expect(upgraded.db.select().from(tasks).all()).toEqual([]);
  const task = {
    id: "example-task", projectId: project.id, instruction: "Inspect the project", requestKey: "first-request",
    status: "queued" as const, createdAt: new Date("2026-11-01T00:00:00Z"),
  };
  upgraded.db.insert(tasks).values(task).run();
  upgraded.close();

  const reopened = connect();
  expect(reopened.db.select().from(tasks).all()).toEqual([task]);
  expect(reopened.client.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get()).toEqual({ count: migrationCount });
});

test("enforces task foreign keys, request uniqueness, and status in SQLite", () => {
  const { db, client } = connect();
  const task = {
    id: "example-task", projectId: project.id, instruction: "Inspect the project", requestKey: "first-request",
    createdAt: new Date("2026-11-01T00:00:00Z"),
  };
  expect(() => db.insert(tasks).values(task).run()).toThrow();
  db.insert(projects).values(project).run();
  db.insert(tasks).values(task).run();
  expect(() => db.insert(tasks).values({ ...task, id: "duplicate-task" }).run()).toThrow();
  expect(() => client.prepare("UPDATE tasks SET status = ?").run("invalid")).toThrow();
  expect(() => client.prepare("DELETE FROM projects WHERE id = ?").run(project.id)).toThrow();
  expect(db.select().from(tasks).all()).toEqual([{ ...task, status: "queued" }]);
});
