import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../../package.json", import.meta.url));
const Database = require("better-sqlite3");

if (process.argv[2] === "writer") {
  const database = new Database(process.argv[3], { timeout: 0 });
  try {
    database.exec("BEGIN IMMEDIATE; ROLLBACK");
    console.log(JSON.stringify({ outcome: "acquired" }));
  } catch (error) {
    console.log(JSON.stringify({ outcome: error.code }));
  } finally {
    database.close();
  }
} else {
  const { preparePrivateDatabase } = await import(process.argv[2]);
  const path = process.argv[3];
  const database = new Database(path);
  const writer = () => {
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "writer", path],
      { encoding: "utf8", timeout: 5000, maxBuffer: 65536 },
    );
    if (child.error || child.status !== 0 || child.signal)
      throw new Error("Writer probe did not exit normally");
    return JSON.parse(child.stdout).outcome;
  };
  try {
    database.pragma(`journal_mode = ${process.argv[4]}`);
    database.exec("CREATE TABLE lock_fixture (value INTEGER); BEGIN IMMEDIATE");
    const before = writer();
    preparePrivateDatabase(path);
    const after = writer();
    console.log(JSON.stringify({ before, after }));
  } finally {
    if (database.inTransaction) database.exec("ROLLBACK");
    database.close();
  }
}
