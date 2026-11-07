import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { executionOwner } from "../src/db/schema.js";
import { acquireExecutionOwner } from "../src/modules/execution/execution-owner.js";

let directory: string;
let database: ReturnType<typeof openDatabase>;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "hub-owner-"));
  database = openDatabase(join(directory, "hub.sqlite"));
});
afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

test("only one execution process can own a database across connections", () => {
  const owner = acquireExecutionOwner(database.db);
  const other = openDatabase(join(directory, "hub.sqlite"));
  try {
    expect(() => acquireExecutionOwner(other.db)).toThrow("already owns");
    owner.release();
    acquireExecutionOwner(other.db).release();
    expect(database.db.select().from(executionOwner).all()).toEqual([]);
  } finally {
    other.close();
  }
});

test("only a known absent process on the same host permits replacement; old release cannot remove it", () => {
  const original = acquireExecutionOwner(database.db, {
    hostname: "fixture",
    pid: 100,
    mayExist: () => false,
  });
  expect(() =>
    acquireExecutionOwner(database.db, {
      hostname: "another-host",
      pid: 200,
      mayExist: () => false,
    }),
  ).toThrow();
  expect(() =>
    acquireExecutionOwner(database.db, { hostname: "fixture", pid: 200, mayExist: () => true }),
  ).toThrow();
  const replacement = acquireExecutionOwner(database.db, {
    hostname: "fixture",
    pid: 200,
    mayExist: () => false,
  });
  original.release();
  expect(database.db.select().from(executionOwner).get()?.token).toBe(replacement.token);
  replacement.release();
});

test("invalid singleton and process IDs are rejected by SQLite", () => {
  expect(() =>
    database.db
      .insert(executionOwner)
      .values({ slot: 2, token: "test", hostname: "fixture", pid: 1 })
      .run(),
  ).toThrow();
  expect(() =>
    database.db
      .insert(executionOwner)
      .values({ slot: 1, token: "test", hostname: "fixture", pid: 0 })
      .run(),
  ).toThrow();
});
