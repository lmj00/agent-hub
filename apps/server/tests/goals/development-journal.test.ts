import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import { migrationsDirectory, openDatabase } from "../../src/db/connection.js";
import {
  developmentRepositories,
  developmentRounds,
  executionOwner,
  goals,
  projects,
  runs,
  steps,
  tasks,
} from "../../src/db/schema.js";
import { createDrizzleRunStore } from "../../src/modules/execution/drizzle-run-store.js";
import { createContainerExecutor } from "../../src/modules/execution/execution-process.js";
import { readExecutions } from "../../src/modules/execution/execution-record-store.js";
import type { AnalysisEvent, ExecutionIdentity } from "../../src/modules/execution/analysis.js";
import { createDrizzleGoalStore } from "../../src/modules/goals/drizzle-goal-store.js";
import {
  readDevelopmentRepository,
  readDevelopmentRounds,
  type DevelopmentUpdate,
} from "../../src/modules/goals/development-journal.js";
import {
  developmentInputIntent,
  developmentRoot,
  type DevelopmentCandidate,
} from "../../src/modules/workspace/development-workspace.js";
import {
  captureRecordedDevelopment,
  cleanupRecordedDevelopment,
  prepareRecordedDevelopment,
  prepareRecordedVerification,
} from "../../src/modules/execution/workflows/recorded-development.js";
import {
  verificationConfigDigest,
  verificationResultDigest,
  type VerificationResult,
} from "../../src/modules/execution/verification-config.js";
import type { AnalysisAssessment } from "@agent-hub/contracts";
import {
  preparedInputRoot,
  type GoalScope,
} from "../../src/modules/workspace/prepared-workspace.js";
import type { PlannedWork } from "../../src/modules/goals/goal-plan-policy.js";

let directory: string,
  source: string,
  projectId: string,
  taskId: string,
  inputRoot: string,
  repositoryRoot: string;
let scope: GoalScope, plannedWork: PlannedWork;
let database: ReturnType<typeof openDatabase>,
  store: ReturnType<typeof createDrizzleRunStore>,
  run: ReturnType<typeof store.claim>;
const signal = () => new AbortController().signal;
function git(...args: string[]) {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd: source,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    },
  ).trim();
}
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-development-journal-")));
  source = join(directory, "source");
  mkdirSync(join(source, "src"), { recursive: true });
  writeFileSync(join(source, "src/main.ts"), "export const answer = 1;\n");
  git("init", "--quiet", "--template=");
  git("add", "--all");
  git("commit", "--quiet", "-m", "fixture");
  database = openDatabase(join(directory, "hub.sqlite"));
  projectId = randomUUID();
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
  const goal = createDrizzleGoalStore(database.db).register(projectId, "goal", {
    description: "Fix the example",
    completionCriteria: "Verified calculation",
    kind: "finite",
    priority: 50,
    allowedPaths: ["src", "tests"],
    excludedPaths: ["src/private"],
    checkIntervalMs: 60000,
    budget: { windowMs: 3600000, maxCalls: 20, maxRunMs: 1800000 },
  }).goal;
  scope = {
    goalId: goal.id,
    goalVersion: goal.version,
    allowedPaths: ["src", "tests"],
    excludedPaths: ["src/private"],
  };
  plannedWork = {
    planningTaskId: randomUUID(),
    problemKey: "calculation",
    sourceRevision: git("rev-parse", "HEAD"),
    sourceDigest: "a".repeat(64),
    title: "Fix calculation",
    paths: ["src"],
    acceptanceCriteria: "Answer is 42",
    evidence: ["src/main.ts returns 1"],
  };
  database.db
    .insert(tasks)
    .values({
      id: taskId,
      projectId,
      goalId: goal.id,
      goalVersion: goal.version,
      instruction: "Fix calculation",
      requestKey: taskId,
      createdAt: new Date(),
    })
    .run();
  store = createDrizzleRunStore(database.db, undefined, {
    analysisWorkflow: { version: 1, maxSteps: 6, maxEffortChanges: 2 },
  });
  // Public dispatch remains disabled until tests, review and ChangeApplication
  // are connected. Simulate only the internal development Run in this fixture.
  run = store.claim(taskId, "fixture");
  database.db.update(tasks).set({ plannedWork }).where(eq(tasks.id, taskId)).run();
  inputRoot = preparedInputRoot(join(directory, "hub.sqlite"));
  repositoryRoot = developmentRoot(join(directory, "hub.sqlite"));
});
afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});
const record = (event: AnalysisEvent) => store.record(run.id, event);
const save = (development: DevelopmentUpdate) =>
  record({ kind: `development.${development.type}`, development });
const request = (sequence = 1, previous?: DevelopmentCandidate) => ({
  projectId,
  runId: run.id,
  source,
  repositoryRoot,
  inputRoot,
  scope,
  writePaths: plannedWork.paths,
  sequence,
  ...(previous ? { previous } : {}),
  signal: signal(),
});
const prepare = (sequence = 1, previous?: DevelopmentCandidate) =>
  prepareRecordedDevelopment(database.db, request(sequence, previous), record);
function execute(terminate = true): ExecutionIdentity {
  const execution: ExecutionIdentity = {
    kind: "docker",
    containerId: randomUUID().replaceAll("-", "").repeat(2),
    engineId: "fixture",
    token: randomUUID(),
  };
  record({ kind: "execution.prepared", execution });
  if (terminate) finishExecution(execution);
  return execution;
}
function finishExecution(identity: ExecutionIdentity) {
  record({
    kind: "execution.terminated",
    executionTermination: { identity, confirmedAt: new Date() },
  });
}
async function capture(
  prepared: Awaited<ReturnType<typeof prepare>>,
  sequence = 1,
  content = "export const answer = 42;\n",
) {
  return captureRecordedDevelopment(
    prepared.repository,
    prepared.input,
    sequence,
    {
      baseRevision: prepared.input.revision,
      inputDigest: prepared.input.digest,
      changes: [
        {
          path: "src/main.ts",
          mode: "100644",
          content: Buffer.from(content).toString("base64"),
        },
      ],
    },
    signal(),
    record,
  );
}

const configuration = {
  image: "agent-hub-verification-node:local",
  command: [
    "node",
    "-e",
    "require('node:assert/strict').match(require('node:fs').readFileSync('src/main.ts','utf8'), /answer = 42;/)",
  ],
  timeoutMs: 10000,
};
const verifyInput = (sequence = 1, onEvent = record) =>
  prepareRecordedVerification(
    database.db,
    {
      runId: run.id,
      sequence,
      inputRoot,
      configuration,
      signal: signal(),
    },
    onEvent,
  );
function verificationResult(sequence = 1, exitCode = 1): VerificationResult {
  const current = readDevelopmentRounds(database.db, run.id)[sequence - 1]!;
  return {
    candidateDigest: current.candidate!.digest,
    inputDigest: current.verificationInput!.digest,
    configurationDigest: verificationConfigDigest(configuration),
    configuration,
    execution: readExecutions(database.db, run.id).at(-1)!.identity,
    imageId: `sha256:${"c".repeat(64)}`,
    status: exitCode === 0 ? "passed" : "failed",
    exitCode,
    oomKilled: false,
    elapsedMs: 25,
    output: "fixture test output",
  };
}
const assessment = (complete = false): AnalysisAssessment => ({
  report: complete ? "Approved" : "Fix the failing calculation",
  evidence: ["src/main.ts"],
  unresolved: complete ? [] : ["calculation differs"],
  complete,
  next: complete
    ? null
    : {
        purpose: "Fix calculation",
        effort: "medium",
        reason: "Observed test failure",
      },
});
function completeStep(sequence: number, value = assessment()) {
  record({ kind: "step.started", step: { type: "start", sequence } });
  record({
    kind: "step.completed",
    step: { type: "complete", sequence, assessment: value, usage: null },
  });
}
async function finishReview(sequence = 1) {
  await verifyInput(sequence);
  execute();
  const result = verificationResult(sequence);
  save({ type: "verification.complete", sequence, result });
  completeStep(sequence * 2 - 1);
  completeStep(sequence * 2);
  const execution = execute();
  save({
    type: "review.complete",
    sequence,
    review: {
      candidateDigest: result.candidateDigest,
      verificationDigest: verificationResultDigest(result),
      execution,
      stepSequence: sequence * 2,
      assessment: assessment(),
    },
  });
}

test("saves intent before I/O, preserves input and candidate across reopen and separates planning from execution bases", async () => {
  database.db
    .update(tasks)
    .set({ plannedWork: { ...plannedWork, sourceRevision: "b".repeat(40) } })
    .where(eq(tasks.id, taskId))
    .run();
  const prepared = await prepareRecordedDevelopment(database.db, request(), (event) => {
    if (event.development?.type === "repository.intent")
      expect(existsSync(event.development.repository.directory)).toBe(false);
    if (event.development?.type === "input.intent")
      expect(existsSync(event.development.input.directory)).toBe(false);
    record(event);
  });
  execute();
  const candidate = await capture(prepared);
  const before = readDevelopmentRounds(database.db, run.id);
  expect(before[0]).toMatchObject({
    planningRevision: "b".repeat(40),
    input: { revision: plannedWork.sourceRevision },
    candidate,
    executionOffset: 0,
    preparedAt: expect.any(Date),
    capturedAt: expect.any(Date),
  });
  database.close();
  database = openDatabase(join(directory, "hub.sqlite"));
  expect(readDevelopmentRounds(database.db, run.id)).toEqual(before);
  expect(readDevelopmentRepository(database.db, projectId)?.prepared).toEqual(prepared.repository);
  expect(database.client.pragma("foreign_key_check")).toEqual([]);
});

test.each(["repository.intent", "input.intent"] as const)(
  "a failed %s acknowledgement prevents the associated file creation",
  async (type) => {
    let target = "";
    await expect(
      prepareRecordedDevelopment(database.db, request(), (event) => {
        if (event.development?.type === type) {
          target =
            "repository" in event.development
              ? event.development.repository.directory
              : event.development.input.directory;
          throw new Error("save failed");
        }
        record(event);
      }),
    ).rejects.toThrow("save failed");
    expect(target).not.toBe("");
    expect(existsSync(target)).toBe(false);
  },
);

test.each(["repository.ready", "input.ready"] as const)(
  "adopts fully published files after a failed %s acknowledgement",
  async (type) => {
    await expect(
      prepareRecordedDevelopment(database.db, request(), (event) => {
        if (event.development?.type === type) throw new Error("ready save failed");
        record(event);
      }),
    ).rejects.toThrow("ready save failed");
    const repositoryId = readDevelopmentRepository(database.db, projectId)!.id;
    const inputId = readDevelopmentRounds(database.db, run.id)[0]?.inputId;
    // A new SQLite connection represents reloading durable records, not an in-memory cache.
    const connection = openDatabase(join(directory, "hub.sqlite"));
    try {
      const prepared = await prepareRecordedDevelopment(connection.db, request(), record);
      expect(prepared.repository.id).toBe(repositoryId);
      if (inputId) expect(prepared.input.id).toBe(inputId);
      expect(connection.db.select().from(developmentRepositories).all()).toHaveLength(1);
      expect(connection.db.select().from(developmentRounds).all()).toHaveLength(1);
    } finally {
      connection.close();
    }
  },
);

test("partial input files without a final publication are held and not overwritten", async () => {
  await expect(
    prepareRecordedDevelopment(database.db, request(), (event) => {
      record(event);
      if (event.development?.type === "input.intent") {
        const parent = dirname(event.development.input.directory);
        mkdirSync(parent, { mode: 0o700 });
        writeFileSync(join(parent, "partial"), "preserve");
        throw new Error("parent stopped");
      }
    }),
  ).rejects.toThrow("parent stopped");
  await expect(prepare()).rejects.toThrow();
  const round = readDevelopmentRounds(database.db, run.id)[0]!;
  expect(round.input).toBeNull();
  expect(readFileSync(join(dirname(round.intent.directory), "partial"), "utf8")).toBe("preserve");
});

test("requires ready input before starting and saved termination before capturing or starting the next phase", async () => {
  expect(() => execute()).toThrow("input_unavailable");
  const prepared = await prepare();
  const execution = execute(false);
  await expect(capture(prepared)).rejects.toThrow("input_unavailable");
  finishExecution(execution);
  expect(() => execute()).toThrow("input_unavailable");
  const candidate = await capture(prepared);
  await verifyInput();
  expect(() => execute()).not.toThrow();
  expect(readDevelopmentRounds(database.db, run.id)[0]?.candidate).toEqual(candidate);
});

test("a failed candidate write rolls back and keeps the following phase blocked", async () => {
  const prepared = await prepare();
  execute();
  database.client.exec(
    "CREATE TRIGGER reject_candidate BEFORE UPDATE OF candidate ON development_rounds BEGIN SELECT RAISE(ABORT, 'candidate failed'); END",
  );
  await expect(capture(prepared)).rejects.toThrow("candidate failed");
  expect(readDevelopmentRounds(database.db, run.id)[0]?.candidate).toBeNull();
  expect(() => execute()).toThrow("input_unavailable");
  database.client.exec("DROP TRIGGER reject_candidate");
  await capture(prepared);
  await verifyInput();
  expect(() => execute()).not.toThrow();
});

test("duplicate ready delivery preserves the first record and a conflicting candidate cannot replace it", async () => {
  const prepared = await prepare();
  await prepare();
  execute();
  const candidate = await capture(prepared);
  const first = readDevelopmentRounds(database.db, run.id)[0]!;
  save({ type: "candidate.ready", sequence: 1, candidate });
  expect(readDevelopmentRounds(database.db, run.id)[0]).toEqual(first);
  await expect(capture(prepared, 1, "different\n")).rejects.toThrow("input_unavailable");
  expect(readDevelopmentRounds(database.db, run.id)[0]?.candidate).toEqual(candidate);
});

test("rework has a bounded ordered sequence and must continue the preceding candidate", async () => {
  const first = await prepare();
  execute();
  const candidate = await capture(first);
  await finishReview();
  await expect(prepare(3, candidate)).rejects.toThrow("input_unavailable");
  const wrong = developmentInputIntent(
    inputRoot,
    first.repository,
    run.id,
    scope,
    plannedWork.paths,
  );
  expect(() => save({ type: "input.intent", sequence: 2, input: wrong })).toThrow(
    "input_unavailable",
  );
  const second = await prepare(2, candidate);
  expect(second.input.tree).toBe(candidate.tree);
  expect(readFileSync(join(second.input.directory, "src/main.ts"), "utf8")).toContain("42");
  execute();
  const secondCandidate = await capture(second, 2, "export const answer = 43;\n");
  await finishReview(2);
  const third = await prepare(3, secondCandidate);
  execute();
  const thirdCandidate = await capture(third, 3);
  await expect(prepare(4, thirdCandidate)).rejects.toThrow("input_unavailable");
  expect(readDevelopmentRounds(database.db, run.id).map((value) => value.executionOffset)).toEqual([
    0, 3, 6,
  ]);
}, 20000);

test.skipIf(process.env.RUN_CONTAINER_TESTS !== "1")(
  "persists a real container's candidate only after its termination proof and prepares that candidate for verification",
  async () => {
    const exec = promisify(execFile),
      cwd = fileURLToPath(new URL("../../../../", import.meta.url));
    await exec(
      "docker",
      [
        "build",
        "-f",
        "docker/analysis-runner.Dockerfile",
        "-t",
        "agent-hub-sandbox-test:local",
        ".",
      ],
      { cwd, timeout: 90000 },
    );
    await exec(
      "docker",
      [
        "build",
        "-f",
        "apps/server/tests/fixtures/development-runner.Dockerfile",
        "-t",
        "agent-hub-development-test:local",
        ".",
      ],
      { cwd, timeout: 30000 },
    );
    await exec(
      "docker",
      ["build", "-f", "docker/verification-node.Dockerfile", "-t", configuration.image, "."],
      { cwd, timeout: 90000 },
    );
    const home = join(directory, "synthetic-home");
    mkdirSync(home);
    writeFileSync(join(home, "auth.json"), "synthetic credential");
    const executor = createContainerExecutor("agent-hub-development-test:local", home);
    const prepared = await prepare();
    try {
      const result = await executor.analyze(
        {
          runId: run.id,
          model: "fixture",
          instruction: "large",
          workspace: prepared.input.directory,
          signal: signal(),
          development: {
            baseRevision: prepared.input.revision,
            inputDigest: prepared.input.digest,
            scope,
            writePaths: prepared.input.writePaths,
            files: prepared.input.files,
          },
        },
        record,
      );
      expect(readExecutions(database.db, run.id)[0]?.terminationConfirmedAt).toBeInstanceOf(Date);
      const candidate = await captureRecordedDevelopment(
        prepared.repository,
        prepared.input,
        1,
        result.development,
        signal(),
        record,
      );
      expect(readDevelopmentRounds(database.db, run.id)[0]?.candidate?.digest).toBe(
        candidate.digest,
      );
      const second = await verifyInput();
      expect(readFileSync(join(second.input.directory, "src/large-0.txt"))).toHaveLength(700000);
      const verified = await executor.analyze(
        {
          runId: run.id,
          model: "fixture",
          instruction: "fixed test",
          workspace: second.input.directory,
          signal: signal(),
          development: {
            baseRevision: second.input.revision,
            inputDigest: second.input.digest,
            scope,
            writePaths: second.input.writePaths,
            files: second.input.files,
          },
          verification: {
            candidateDigest: candidate.digest,
            config: configuration,
          },
        },
        record,
      );
      expect(verified.verification).toMatchObject({
        status: "failed",
        exitCode: 1,
        candidateDigest: candidate.digest,
        inputDigest: second.input.digest,
      });
      save({
        type: "verification.complete",
        sequence: 1,
        result: verified.verification!,
      });
      expect(readDevelopmentRounds(database.db, run.id)[0]!.verificationResult!.output).toContain(
        "AssertionError",
      );
      expect(readExecutions(database.db, run.id)).toHaveLength(2);
      expect(git("status", "--porcelain")).toBe("");
      const proof = await executor.confirmTermination!(run.id);
      expect(proof).toBeInstanceOf(Date);
      store.finish(run.id, {
        status: "succeeded",
        result: result.output,
        errorCode: null,
        usage: null,
        terminationConfirmedAt: proof,
      });
      expect(store.findById(run.id)?.errorCode).toBe("development_incomplete");
      cleanupRecordedDevelopment(database.db, inputRoot, run.id);
      expect(existsSync(second.input.directory)).toBe(false);
    } finally {
      expect(await executor.confirmTermination!(run.id)).toBeInstanceOf(Date);
      await executor.cleanup!(run.id);
    }
  },
  130000,
);

test("Goal pause allows saving completed evidence but forbids another phase or rework", async () => {
  const prepared = await prepare();
  execute();
  database.db.update(goals).set({ status: "paused" }).where(eq(goals.id, scope.goalId)).run();
  const candidate = await capture(prepared);
  expect(() => execute()).toThrow("input_unavailable");
  await expect(prepare(2, candidate)).rejects.toThrow("goal_changed");
  expect(readDevelopmentRounds(database.db, run.id)[0]?.candidate).toEqual(candidate);
});

test("a changed owner cannot publish readiness or start execution", async () => {
  const prepared = await prepare();
  database.db
    .insert(executionOwner)
    .values({ slot: 1, token: randomUUID(), hostname: "fixture", pid: 99999 })
    .run();
  expect(() => save({ type: "input.ready", sequence: 1, input: prepared.input })).toThrow(
    "ownership",
  );
  expect(() => execute()).toThrow("ownership");
});

test("a captured candidate cannot mark the Task successful and input cleanup requires the final Run proof", async () => {
  const prepared = await prepare();
  execute();
  await capture(prepared);
  cleanupRecordedDevelopment(database.db, inputRoot, run.id);
  expect(existsSync(prepared.input.directory)).toBe(true);
  store.finish(run.id, {
    status: "succeeded",
    result: "I fixed it",
    errorCode: null,
    usage: null,
    terminationConfirmedAt: new Date(),
  });
  expect(store.findById(run.id)).toMatchObject({
    status: "blocked",
    result: null,
    errorCode: "development_incomplete",
    terminationConfirmedAt: expect.any(Date),
  });
  cleanupRecordedDevelopment(database.db, inputRoot, run.id);
  cleanupRecordedDevelopment(database.db, inputRoot, run.id);
  expect(existsSync(prepared.input.directory)).toBe(false);
  expect(existsSync(prepared.repository.directory)).toBe(true);
  expect(readDevelopmentRounds(database.db, run.id)[0]?.candidate).not.toBeNull();
});

test("a retry may reuse only this Task's latest candidate after the previous Run termination proof", async () => {
  const prepared = await prepare();
  execute();
  const candidate = await capture(prepared);
  store.finish(run.id, {
    status: "failed",
    result: null,
    errorCode: "executor_failed",
    usage: null,
    terminationConfirmedAt: new Date(),
  });
  database.db
    .update(tasks)
    .set({ status: "queued", plannedWork: null })
    .where(eq(tasks.id, taskId))
    .run();
  const priorId = run.id;
  run = store.claim(taskId, "fixture");
  database.db.update(tasks).set({ plannedWork }).where(eq(tasks.id, taskId)).run();
  database.db.update(runs).set({ terminationConfirmedAt: null }).where(eq(runs.id, priorId)).run();
  await expect(prepare(1, candidate)).rejects.toThrow("input_unavailable");
  database.db
    .update(runs)
    .set({ terminationConfirmedAt: new Date() })
    .where(eq(runs.id, priorId))
    .run();
  const retried = await prepare(1, candidate);
  expect(retried.input).toMatchObject({
    tree: candidate.tree,
    previousCandidate: candidate.digest,
    runId: run.id,
  });
});

test("a different Task cannot use another Task's unaccepted candidate", async () => {
  const prepared = await prepare();
  execute();
  const candidate = await capture(prepared);
  store.finish(run.id, {
    status: "failed",
    result: null,
    errorCode: "executor_failed",
    usage: null,
    terminationConfirmedAt: new Date(),
  });
  taskId = randomUUID();
  database.db
    .insert(tasks)
    .values({
      id: taskId,
      projectId,
      goalId: scope.goalId,
      goalVersion: scope.goalVersion,
      instruction: "Different task",
      requestKey: taskId,
      createdAt: new Date(),
    })
    .run();
  run = store.claim(taskId, "fixture");
  database.db.update(tasks).set({ plannedWork }).where(eq(tasks.id, taskId)).run();
  await expect(prepare(1, candidate)).rejects.toThrow("input_unavailable");
  const fresh = await prepare();
  expect(fresh.input.tree).toBe(prepared.repository.headTree);
});

test.each(["cancel", "scope"])(
  "a %s change prevents another input or execution",
  async (action) => {
    const prepared = await prepare();
    execute();
    const candidate = await capture(prepared);
    if (action === "cancel") store.requestStop(run.id, "user_cancel");
    else
      database.db
        .update(goals)
        .set({ version: scope.goalVersion + 1 })
        .where(eq(goals.id, scope.goalId))
        .run();
    await expect(prepare(2, candidate)).rejects.toThrow("goal_changed");
    expect(() => execute()).toThrow("input_unavailable");
  },
);

test("schema migration retains old Runs, adds empty journals and enforces preparation consistency", async () => {
  const before = database.db.select().from(runs).all();
  database.close();
  rmSync(join(directory, "hub.sqlite"));
  const folder = join(directory, "before-development");
  cpSync(migrationsDirectory, folder, { recursive: true });
  const path = join(folder, "meta/_journal.json"),
    journal = JSON.parse(readFileSync(path, "utf8"));
  journal.entries = journal.entries.slice(0, 24);
  writeFileSync(path, JSON.stringify(journal));
  const legacy = openDatabase(join(directory, "hub.sqlite"), folder);
  legacy.client.exec(
    "INSERT INTO projects VALUES ('retained-project', 'Fixture', 'fixture', 1000); INSERT INTO tasks (id, project_id, instruction, request_key, created_at) VALUES ('retained-task', 'retained-project', 'Inspect', 'retained', 1000); INSERT INTO runs (id, task_id, instance_id, status, model, effort, started_at, last_activity_at) VALUES ('retained-run', 'retained-task', 'old-owner', 'succeeded', 'fixture', 'medium', 1000, 1000)",
  );
  legacy.close();
  database = openDatabase(join(directory, "hub.sqlite"));
  expect(database.db.select().from(runs).get()).toMatchObject({
    id: "retained-run",
    status: "succeeded",
    startedAt: new Date(1000),
  });
  expect(before).toHaveLength(1);
  expect(database.db.select().from(developmentRepositories).all()).toEqual([]);
  expect(() =>
    database.client.exec(
      "INSERT INTO development_repositories VALUES ('repo', 'retained-project', 'retained-run', '{}', '{}', 1000, NULL)",
    ),
  ).toThrow("CHECK");
  expect(() => database.checkReady()).not.toThrow();
  expect(database.client.pragma("foreign_key_check")).toEqual([]);
  database.close();
  database = openDatabase(join(directory, "hub.sqlite"));
  expect(database.db.select().from(runs).all()).toHaveLength(1);
});

test.each(["verification.intent", "verification.ready"] as const)(
  "recovers verification preparation after a failed %s acknowledgement",
  async (type) => {
    const prepared = await prepare();
    execute();
    await capture(prepared);
    let target = "";
    await expect(
      verifyInput(1, (event) => {
        if (event.development?.type === type) {
          target =
            event.development.type === "verification.intent"
              ? event.development.verification.input.directory
              : event.development.input.directory;
          throw new Error("verification write failed");
        }
        record(event);
      }),
    ).rejects.toThrow("verification write failed");
    expect(existsSync(target)).toBe(type === "verification.ready");
    expect(() => execute()).toThrow("input_unavailable");
    const stored = readDevelopmentRounds(database.db, run.id)[0]!.verificationIntent;
    const connection = openDatabase(join(directory, "hub.sqlite"));
    try {
      const restored = await prepareRecordedVerification(
        connection.db,
        {
          runId: run.id,
          sequence: 1,
          inputRoot,
          configuration,
          signal: signal(),
        },
        record,
      );
      if (stored) expect(restored.input.id).toBe(stored.input.id);
      expect(restored.input.id).not.toBe(prepared.input.id);
      expect(readFileSync(join(restored.input.directory, "src/main.ts"), "utf8")).toContain("42");
      expect(readDevelopmentRounds(database.db, run.id)).toHaveLength(1);
    } finally {
      connection.close();
    }
  },
);

test("verification configuration is immutable after preparation and a cancellation acknowledgement creates no input", async () => {
  const prepared = await prepare();
  execute();
  await capture(prepared);
  const controller = new AbortController();
  await expect(
    prepareRecordedVerification(
      database.db,
      {
        runId: run.id,
        sequence: 1,
        inputRoot,
        configuration,
        signal: controller.signal,
      },
      (event) => {
        record(event);
        if (event.development?.type === "verification.intent") controller.abort();
      },
    ),
  ).rejects.toThrow();
  const intent = readDevelopmentRounds(database.db, run.id)[0]!.verificationIntent!;
  expect(existsSync(intent.input.directory)).toBe(false);
  await expect(
    prepareRecordedVerification(
      database.db,
      {
        runId: run.id,
        sequence: 1,
        inputRoot,
        configuration: {
          ...configuration,
          command: ["node", "-e", "process.exit(0)"],
        },
        signal: signal(),
      },
      record,
    ),
  ).rejects.toThrow("configuration changed");
  await verifyInput();
});

test("verification needs the exact candidate input, configuration and test execution with a saved termination proof", async () => {
  const prepared = await prepare();
  execute();
  const candidate = await capture(prepared);
  await expect(prepare(2, candidate)).rejects.toThrow("input_unavailable");
  await verifyInput();
  const identity = execute(false);
  const result = verificationResult();
  expect(() => save({ type: "verification.complete", sequence: 1, result })).toThrow(
    "input_unavailable",
  );
  finishExecution(identity);
  expect(() => execute()).toThrow("input_unavailable");
  const mutations: Partial<VerificationResult>[] = [
    { candidateDigest: "a".repeat(64) },
    { inputDigest: prepared.input.digest },
    { execution: readExecutions(database.db, run.id)[0]!.identity },
    {
      configuration: { ...configuration, command: ["true"] },
      configurationDigest: verificationConfigDigest({
        ...configuration,
        command: ["true"],
      }),
    },
    { status: "passed" },
    { exitCode: 0 },
    { oomKilled: true, status: "passed", exitCode: 0 },
    { imageId: "mutable:tag" },
    { output: "x".repeat(65537) },
  ];
  for (const mutation of mutations)
    expect(() =>
      save({
        type: "verification.complete",
        sequence: 1,
        result: { ...result, ...mutation },
      }),
    ).toThrow();
  database.client.exec(
    "CREATE TRIGGER reject_verification BEFORE UPDATE OF verification_result ON development_rounds BEGIN SELECT RAISE(ABORT, 'test result write failed'); END",
  );
  expect(() => save({ type: "verification.complete", sequence: 1, result })).toThrow(
    "test result write failed",
  );
  expect(() => execute()).toThrow("input_unavailable");
  database.client.exec("DROP TRIGGER reject_verification");
  save({ type: "verification.complete", sequence: 1, result });
  const before = readDevelopmentRounds(database.db, run.id)[0]!;
  save({ type: "verification.complete", sequence: 1, result });
  expect(readDevelopmentRounds(database.db, run.id)[0]).toEqual(before);
  expect(() =>
    save({
      type: "verification.complete",
      sequence: 1,
      result: { ...result, output: "replacement" },
    }),
  ).toThrow();
  await expect(prepare(2, candidate)).rejects.toThrow("input_unavailable");
  expect(() => execute()).not.toThrow();
});

test.each([false, true])(
  "review is bound to the persisted Step and test result, including test success=%s",
  async (passed) => {
    const prepared = await prepare();
    execute();
    const candidate = await capture(prepared);
    await verifyInput();
    execute();
    const result = verificationResult(1, passed ? 0 : 1);
    save({ type: "verification.complete", sequence: 1, result });
    const execution = execute(false);
    completeStep(1);
    completeStep(2, assessment(passed));
    const review = {
      candidateDigest: candidate.digest,
      verificationDigest: verificationResultDigest(result),
      execution,
      stepSequence: 2,
      assessment: assessment(passed),
    };
    expect(() => save({ type: "review.complete", sequence: 1, review })).toThrow(
      "input_unavailable",
    );
    finishExecution(execution);
    for (const mutation of [
      { candidateDigest: "b".repeat(64) },
      { verificationDigest: "b".repeat(64) },
      { stepSequence: 1 },
      { execution: result.execution },
      { assessment: assessment(!passed) },
    ]) {
      expect(() =>
        save({
          type: "review.complete",
          sequence: 1,
          review: { ...review, ...mutation },
        }),
      ).toThrow("input_unavailable");
    }
    if (!passed) {
      // Even a persisted AI approval cannot override a failed host test.
      database.db
        .update(steps)
        .set({ assessment: assessment(true) })
        .where(eq(steps.sequence, 2))
        .run();
      expect(() =>
        save({
          type: "review.complete",
          sequence: 1,
          review: { ...review, assessment: assessment(true) },
        }),
      ).toThrow("input_unavailable");
      database.db
        .update(steps)
        .set({ assessment: assessment(false) })
        .where(eq(steps.sequence, 2))
        .run();
    }
    save({ type: "review.complete", sequence: 1, review });
    const before = readDevelopmentRounds(database.db, run.id)[0]!;
    save({ type: "review.complete", sequence: 1, review });
    expect(readDevelopmentRounds(database.db, run.id)[0]).toEqual(before);
    expect(() => execute()).toThrow("input_unavailable");
    if (passed) await expect(prepare(2, candidate)).rejects.toThrow("input_unavailable");
    else {
      await prepare(2, candidate);
      expect(() => save({ type: "review.complete", sequence: 1, review })).toThrow(
        "input_unavailable",
      );
    }
  },
);

test("completed verification survives a Goal pause and reopen; both inputs need final Run proof before cleanup", async () => {
  const prepared = await prepare();
  execute();
  await capture(prepared);
  const verification = await verifyInput();
  execute();
  const result = verificationResult();
  database.db.update(goals).set({ status: "paused" }).where(eq(goals.id, scope.goalId)).run();
  save({ type: "verification.complete", sequence: 1, result });
  expect(() => execute()).toThrow("input_unavailable");
  const before = readDevelopmentRounds(database.db, run.id);
  const reloaded = openDatabase(join(directory, "hub.sqlite"));
  try {
    expect(readDevelopmentRounds(reloaded.db, run.id)).toEqual(before);
  } finally {
    reloaded.close();
  }
  cleanupRecordedDevelopment(database.db, inputRoot, run.id);
  expect(existsSync(verification.input.directory)).toBe(true);
  store.finish(run.id, {
    status: "blocked",
    result: null,
    errorCode: "goal_changed",
    usage: null,
    terminationConfirmedAt: new Date(),
  });
  cleanupRecordedDevelopment(database.db, inputRoot, run.id);
  cleanupRecordedDevelopment(database.db, inputRoot, run.id);
  expect(existsSync(verification.input.directory)).toBe(false);
  expect(existsSync(prepared.input.directory)).toBe(false);
  expect(readDevelopmentRounds(database.db, run.id)[0]!.verificationResult).toEqual(result);
});

test("verification migration preserves populated development records without inventing successful evidence", async () => {
  const prepared = await prepare();
  execute();
  await capture(prepared);
  const repository = database.db.select().from(developmentRepositories).get()!;
  const round = readDevelopmentRounds(database.db, run.id)[0]!;
  const retained = {
    project: database.db.select().from(projects).get()!,
    task: database.db.select().from(tasks).get()!,
    run: database.db.select().from(runs).get()!,
  };
  const folder = join(directory, "before-verification");
  cpSync(migrationsDirectory, folder, { recursive: true });
  const path = join(folder, "meta/_journal.json"),
    journal = JSON.parse(readFileSync(path, "utf8"));
  journal.entries = journal.entries.slice(0, 25);
  writeFileSync(path, JSON.stringify(journal));
  const legacyPath = join(directory, "legacy.sqlite");
  const legacy = openDatabase(legacyPath, folder);
  try {
    legacy.db.insert(projects).values(retained.project).run();
    legacy.db
      .insert(tasks)
      .values({ ...retained.task, goalId: null, goalVersion: null })
      .run();
    // Select/insert only columns available in the old migration.
    legacy.client
      .prepare(
        "INSERT INTO runs (id,task_id,instance_id,status,model,effort,started_at,last_activity_at) VALUES (?,?,?,'running','fixture','medium',?,?)",
      )
      .run(run.id, taskId, "legacy", Date.now(), Date.now());
    legacy.db.insert(developmentRepositories).values(repository).run();
    legacy.client
      .prepare(
        "INSERT INTO development_rounds (run_id,sequence,repository_id,input_id,planning_revision,intent,input,candidate,execution_offset,created_at,prepared_at,captured_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        run.id,
        1,
        repository.id,
        round.inputId,
        round.planningRevision,
        JSON.stringify(round.intent),
        JSON.stringify(round.input),
        JSON.stringify(round.candidate),
        0,
        round.createdAt.getTime(),
        round.preparedAt!.getTime(),
        round.capturedAt!.getTime(),
      );
  } finally {
    legacy.close();
  }
  const migrated = openDatabase(legacyPath);
  try {
    const restored = readDevelopmentRounds(migrated.db, run.id)[0]!;
    expect(restored).toEqual(round);
    expect(restored.verificationResult).toBeNull();
    expect(() =>
      migrated.client
        .prepare("UPDATE development_rounds SET verification_result='{}',verified_at=1")
        .run(),
    ).toThrow("CHECK");
    expect(migrated.client.pragma("foreign_key_check")).toEqual([]);
  } finally {
    migrated.close();
  }
});
