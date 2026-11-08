import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  containerSecurityOptions,
  prepareContainer,
} from "../src/modules/execution/container-runtime.js";
import { openDatabase } from "../src/db/connection.js";
import { createDrizzleRunStore } from "../src/modules/execution/drizzle-run-store.js";
import { createContainerExecutor } from "../src/modules/execution/execution-process.js";
import { runTask } from "../src/modules/execution/run-task.js";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "hub-docker-deadline-"));
  vi.stubEnv("PATH", `${directory}${delimiter}${process.env.PATH ?? ""}`);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

// A real child process with deterministic slow replies tests the command deadline
// without depending on Docker load, an actual image or private credentials.
function fixture(delayed: string) {
  const trace = join(directory, "trace.jsonl");
  writeFileSync(
    join(directory, "docker"),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const operation = args[0] === 'info' ? (args[2].includes('SecurityOptions') ? 'security' : 'engine') : args[0];
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(operation) + '\\n');
const respond = () => {
  const value = operation === 'engine' ? 'fixture-engine' : operation === 'security' ? '[]' : 'a'.repeat(64);
  process.stdout.write(value + '\\n');
};
if (operation === ${JSON.stringify(delayed)}) setTimeout(respond, 3000); else respond();
`,
    { mode: 0o700 },
  );
  return () => {
    try {
      return readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string);
    } catch {
      return [];
    }
  };
}

function prepare(signal: AbortSignal) {
  return prepareContainer("fixture:local", join(directory, "home"), {
    runId: "fixture-run",
    instruction: "Inspect",
    model: "fixture",
    workspace: join(directory, "workspace"),
    signal,
  });
}

test.each(["engine", "security", "create"])(
  "allows slow %s preparation within the Run deadline",
  async (operation) => {
    const trace = fixture(operation);
    const identity = await prepare(AbortSignal.timeout(6000));
    expect(identity).toMatchObject({
      kind: "docker",
      engineId: "fixture-engine",
      containerId: "a".repeat(64),
    });
    expect(trace()).toEqual(["engine", "security", "create"]);
  },
  8000,
);

test.each(["engine", "security", "create"])(
  "cancels a pending %s command without starting subsequent operations",
  async (operation) => {
    const trace = fixture(operation);
    const controller = new AbortController();
    const result = prepare(controller.signal).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await expect.poll(() => trace().includes(operation)).toBe(true);
    controller.abort("user_cancel");
    expect(await result).toMatchObject({ error: expect.any(Error) });
    const operations = ["engine", "security", "create"];
    expect(trace()).toEqual(operations.slice(0, operations.indexOf(operation) + 1));
  },
);

test("keeps the short timeout for commands without a Run signal", async () => {
  fixture("security");
  await expect(containerSecurityOptions()).rejects.toThrow("Container runtime command failed");
}, 5000);

test("records the Run timeout during slow preparation and never starts a container", async () => {
  const trace = fixture("engine");
  const database = openDatabase(join(directory, "hub.sqlite"));
  try {
    database.client
      .prepare("INSERT INTO projects (id, name, workspace_key, created_at) VALUES (?, ?, ?, ?)")
      .run("project", "Fixture", "fixture", Date.now());
    database.client
      .prepare(
        "INSERT INTO tasks (id, project_id, instruction, request_key, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("task", "project", "Inspect", "fixture", Date.now());
    const result = await runTask(
      {
        taskId: "task",
        model: "fixture",
        workspace: directory,
        timeoutMs: 100,
        signal: new AbortController().signal,
      },
      createDrizzleRunStore(database.db),
      createContainerExecutor("fixture:local", join(directory, "home")),
    );
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "timeout",
      terminationConfirmedAt: expect.any(Date),
    });
    expect(trace()).not.toContain("create");
    expect(trace()).not.toContain("start");
    expect(database.client.prepare("SELECT count(*) AS count FROM run_executions").get()).toEqual({
      count: 0,
    });
    expect(database.client.prepare("SELECT stop_reason FROM runs").get()).toEqual({
      stop_reason: "timeout",
    });
  } finally {
    database.close();
  }
});
