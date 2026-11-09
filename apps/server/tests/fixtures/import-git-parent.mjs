import { openDatabase } from "../../src/db/connection.ts";
import { acquireExecutionOwner } from "../../src/modules/execution/execution-owner.ts";
import { createImportStore } from "../../src/modules/github/import-store.ts";
import { createImportGit } from "../../src/modules/github/import-git.ts";
const [databasePath, workspace] = process.argv.slice(2);
const database = openDatabase(databasePath);
const owner = acquireExecutionOwner(database.db);
const store = createImportStore(database.db, owner.token);
const job = store.claim();
if (!job) throw new Error("Expected queued fixture import");
await createImportGit({
  started: (pid) => store.trackGit(job, pid),
  closed: (pid) => store.releaseGit(job, pid),
})(workspace, ["init", "--template="], new AbortController().signal);
owner.release();
database.close();
