import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { openDatabase } from "../src/db/connection.js";
import { projects, runs, tasks } from "../src/db/schema.js";
import { createDrizzleRunStore } from "../src/modules/execution/drizzle-run-store.js";
import { createContainerExecutor } from "../src/modules/execution/execution-process.js";
import { runTask } from "../src/modules/execution/run-task.js";
import { readExecutions } from "../src/modules/execution/execution-record-store.js";
import {
  removeFinishedContainer,
  stopAndConfirmContainer,
} from "../src/modules/execution/container-runtime.js";
import { parseAnalysisWorkflow } from "../src/modules/execution/analysis-workflow.js";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const image = "agent-hub-legacy-runner-test:local";
describe.skipIf(process.env.RUN_CONTAINER_TESTS !== "1")("legacy runner startup boundary", () => {
  let directory: string, home: string, workspace: string, taskId: string;
  let database: ReturnType<typeof openDatabase>, store: ReturnType<typeof createDrizzleRunStore>;
  beforeAll(async () => {
    for (const [dockerfile, tag] of [
      ["docker/analysis-runner.Dockerfile", "agent-hub-sandbox-test:local"],
      ["apps/server/tests/fixtures/legacy-runner.Dockerfile", image],
    ]) {
      await exec("docker", ["build", "-f", dockerfile!, "-t", tag!, "."], {
        cwd: root,
        timeout: 90000,
      });
    }
  }, 180000);
  beforeEach(() => {
    directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-legacy-runner-")));
    home = join(directory, "home");
    workspace = join(directory, "workspace");
    mkdirSync(home);
    mkdirSync(workspace);
    database = openDatabase(join(directory, "hub.sqlite"));
    store = createDrizzleRunStore(database.db);
    const projectId = randomUUID();
    taskId = randomUUID();
    database.db
      .insert(projects)
      .values({
        id: projectId,
        name: "Fixture",
        workspaceKey: "fixture",
        createdAt: new Date(),
      })
      .run();
    database.db
      .insert(tasks)
      .values({
        id: taskId,
        projectId,
        instruction: "Inspect",
        requestKey: taskId,
        createdAt: new Date(),
      })
      .run();
  });
  afterEach(async () => {
    for (const row of database.db.select().from(runs).all())
      for (const record of readExecutions(database.db, row.id)) {
        await stopAndConfirmContainer(record.identity);
        await removeFinishedContainer(record.identity);
      }
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  test("the unchanged old entrypoint really reaches the SDK counter for a legacy request", async () => {
    const run = store.claim(taskId, "fixture");
    const executor = createContainerExecutor(image, home);
    const result = await executor.analyze(
      {
        runId: run.id,
        workspace,
        instruction: run.instruction,
        model: "fixture",
        signal: new AbortController().signal,
      },
      (event) => store.record(run.id, event),
    );
    expect(result.output).toBe("Legacy SDK boundary reached");
    expect(readFileSync(join(home, "sdk-calls"), "utf8")).toBe("called\n");
  }, 15000);
  test.each([false, true])(
    "never sends runnable work to an old image: workflow=%s",
    async (workflow) => {
      if (workflow)
        store = createDrizzleRunStore(database.db, undefined, {
          analysisWorkflow: parseAnalysisWorkflow({}),
        });
      const result = await runTask(
        {
          taskId,
          workspace,
          model: "fixture",
          timeoutMs: 10000,
          signal: new AbortController().signal,
        },
        store,
        createContainerExecutor(image, home),
      );
      expect(existsSync(join(home, "sdk-calls"))).toBe(false);
      expect(result).toMatchObject({
        status: "blocked",
        errorCode: "unsupported_settings",
        terminationConfirmedAt: expect.any(Date),
      });
      expect(store.findById(result.runId)?.steps).toHaveLength(1);
    },
    15000,
  );
});
