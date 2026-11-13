import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openDatabase } from "../../src/db/connection.js";
import { budgetPeriods, goals, projects, runs, steps, tasks } from "../../src/db/schema.js";
import type { AnalysisAssessment } from "@agent-hub/contracts";
import type {
  AnalysisExecutor,
  AnalysisRequest,
  ExecutionIdentity,
} from "../../src/modules/execution/analysis.js";
import { createDrizzleRunStore } from "../../src/modules/execution/drizzle-run-store.js";
import { runClaimedTask, type ClaimedRun } from "../../src/modules/execution/run-task.js";
import { readExecutions } from "../../src/modules/execution/execution-record-store.js";
import {
  verificationConfigDigest,
  type VerificationConfig,
} from "../../src/modules/execution/verification-config.js";
import { createProjectBudgetStore } from "../../src/modules/budgets/project-budget-store.js";
import { createDrizzleGoalStore } from "../../src/modules/goals/drizzle-goal-store.js";
import { createDevelopmentExecutor } from "../../src/modules/execution/workflows/development-executor.js";
import {
  readDevelopmentRepository,
  readDevelopmentRounds,
} from "../../src/modules/goals/development-journal.js";
import { developmentRoot } from "../../src/modules/workspace/development-workspace.js";
import { preparedInputRoot } from "../../src/modules/workspace/prepared-workspace.js";
import { cleanupConfirmedInputs } from "../../src/modules/execution/workflows/prepared-executor.js";
import { createDrizzleRecoveryStore } from "../../src/modules/execution/drizzle-recovery-store.js";
import { createRecoveryProcessor } from "../../src/modules/execution/recover-task.js";
import { createContainerExecutor } from "../../src/modules/execution/execution-process.js";
import type { PlannedWork } from "../../src/modules/goals/goal-plan-policy.js";
import { acquireExecutionOwner } from "../../src/modules/execution/execution-owner.js";
import { createAutomaticRecovery } from "../../src/modules/execution/automatic-recovery.js";
import { parseRetryPolicy } from "../../src/modules/execution/retry-policy.js";

let directory: string,
  source: string,
  projectId: string,
  taskId: string,
  inputRoot: string,
  repositoryRoot: string;
let database: ReturnType<typeof openDatabase>,
  store: ReturnType<typeof createDrizzleRunStore>,
  run: ClaimedRun,
  work: PlannedWork;
let calls: AnalysisRequest[];
const configuration: VerificationConfig = {
  image: "agent-hub-verification-node:local",
  command: ["node", "tests/check.mjs"],
  timeoutMs: 10000,
};
const approved = (): AnalysisAssessment => ({
  report: "Candidate inspected",
  evidence: ["src/main.mjs"],
  unresolved: [],
  complete: true,
  next: null,
});
const developerReport = (): AnalysisAssessment => ({
  ...approved(),
  complete: false,
  unresolved: ["Independent review pending"],
  next: {
    purpose: "Review candidate",
    effort: "xhigh",
    reason: "Review edge cases",
  },
});
const usage = { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 };
const correct = "export const total = (price, quantity) => price * quantity;\n";
const wrong = "export const total = (price, quantity) => price + quantity;\n";
const git = (...args: string[]) =>
  execFileSync(
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
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-development-loop-")));
  source = join(directory, "source");
  mkdirSync(join(source, "src"), { recursive: true });
  mkdirSync(join(source, "tests"));
  writeFileSync(join(source, "src/main.mjs"), wrong);
  writeFileSync(
    join(source, "tests/check.mjs"),
    "import assert from 'node:assert/strict'; import {total} from '../src/main.mjs'; assert.equal(total(100,2),200); assert.equal(total(150,3),450); console.log('fixed assertions passed');\n",
  );
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
    description: "Fix calculation",
    completionCriteria: "Correct totals",
    kind: "finite",
    priority: 50,
    allowedPaths: ["src", "tests"],
    excludedPaths: [],
    checkIntervalMs: 60000,
    budget: { windowMs: 3600000, maxCalls: 20, maxRunMs: 1800000 },
  }).goal;
  database.db
    .insert(tasks)
    .values({
      id: taskId,
      projectId,
      goalId: goal.id,
      goalVersion: goal.version,
      instruction: "Fix total calculation",
      requestKey: taskId,
      createdAt: new Date(),
    })
    .run();
  work = {
    planningTaskId: randomUUID(),
    sourceRevision: git("rev-parse", "HEAD"),
    sourceDigest: "a".repeat(64),
    problemKey: "calculation",
    title: "Fix total",
    paths: ["src"],
    acceptanceCriteria: "100 * 2 = 200; 150 * 3 = 450",
    evidence: ["src/main.mjs adds price and quantity"],
  };
  inputRoot = preparedInputRoot(join(directory, "hub.sqlite"));
  repositoryRoot = developmentRoot(join(directory, "hub.sqlite"));
  store = createDrizzleRunStore(
    database.db,
    undefined,
    {
      effortPolicy: { version: 1, mode: "adaptive", maxEffort: "xhigh" },
    },
    { developmentWorkspaceKeys: ["fixture"] },
  );
  calls = [];
});
afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});
function claim() {
  database.db.update(tasks).set({ plannedWork: work }).where(eq(tasks.id, taskId)).run();
  run = store.claim(taskId, "fixture");
}
function wrap(base: AnalysisExecutor, verification = true, ownerToken?: string) {
  return createDevelopmentExecutor({
    db: database.db,
    ...(ownerToken ? { ownerToken } : {}),
    analysis: base,
    development: base,
    config: {
      containerImage: "fixture",
      workspaces: new Map([["fixture", source]]),
      ...(verification ? { verification: new Map([["fixture", configuration]]) } : {}),
    },
    inputRoot,
    repositoryRoot,
  });
}
function fake(
  options: {
    alwaysFail?: boolean;
    firstPass?: boolean;
    missingInput?: boolean;
    rework?: boolean;
    waitAt?: number;
    onCall?: (request: AnalysisRequest) => void;
  } = {},
): AnalysisExecutor {
  return {
    async analyze(request, onEvent) {
      calls.push(request);
      const execution: ExecutionIdentity = {
        kind: "docker",
        containerId: randomUUID().replaceAll("-", "").repeat(2),
        token: randomUUID(),
        engineId: "fixture",
      };
      await onEvent({ kind: "execution.prepared", execution });
      options.onCall?.(request);
      if (options.waitAt === calls.length)
        await new Promise((_, reject) =>
          request.signal.addEventListener("abort", () => reject(request.signal.reason), {
            once: true,
          }),
        );
      request.signal.throwIfAborted();
      await onEvent({ kind: "thread.started", sessionId: randomUUID() });
      await onEvent({
        kind: "execution.terminated",
        executionTermination: { identity: execution, confirmedAt: new Date() },
      });
      if (request.verification) {
        const passed = readFileSync(join(request.workspace, "src/main.mjs"), "utf8") === correct;
        return {
          output: "actual fixture result",
          usage: null,
          verification: {
            candidateDigest: request.verification.candidateDigest,
            inputDigest: request.development!.inputDigest,
            configurationDigest: verificationConfigDigest(request.verification.config),
            configuration: request.verification.config,
            execution,
            imageId: `sha256:${"b".repeat(64)}`,
            status: passed ? "passed" : "failed",
            exitCode: passed ? 0 : 1,
            oomKilled: false,
            elapsedMs: 10,
            output: passed ? "fixed assertions passed" : "AssertionError: 102 !== 200",
          },
        };
      }
      expect(request.workflow).toBeUndefined();
      expect(request.responseMode).toBe("assessment");
      if (request.development) {
        const count = calls.filter((value) => value.development && !value.verification).length;
        const content = !options.alwaysFail && (options.firstPass || count > 1) ? correct : wrong;
        return {
          output: JSON.stringify(developerReport()),
          usage,
          development: {
            baseRevision: request.development.baseRevision,
            inputDigest: request.development.inputDigest,
            changes: [
              {
                path: "src/main.mjs",
                mode: "100644",
                content: Buffer.from(content).toString("base64"),
              },
            ],
          },
        };
      }
      return {
        output: JSON.stringify(
          options.missingInput
            ? {
                ...approved(),
                complete: false,
                unresolved: ["Missing product criteria"],
                next: null,
              }
            : options.rework
              ? {
                  ...approved(),
                  complete: false,
                  unresolved: ["Fix arithmetic"],
                  next: {
                    purpose: "Fix arithmetic",
                    effort: "medium",
                    reason: "Bounded correction",
                  },
                }
              : approved(),
        ),
        usage,
      };
    },
    async confirmTermination() {
      return new Date();
    },
    async cleanup() {},
  };
}
const runWith = (executor: AnalysisExecutor, signal = new AbortController().signal) =>
  runClaimedTask(
    run,
    { model: "fixture", workspace: source, timeoutMs: 120000, signal },
    store,
    executor,
  );

test("runs developer/test/reviewer and feeds the real failure into bounded rework on the same Task with saved budgets", async () => {
  claim();
  const callBudgets: number[] = [];
  const result = await runWith(
    wrap(
      fake({
        onCall: (request) => {
          callBudgets.push(
            database.db
              .select()
              .from(budgetPeriods)
              .all()
              .find((row) => row.projectId === projectId && !row.goalId)!.calls,
          );
          const latest = store.findById(run.id)!.steps.at(-1)!;
          expect(latest.status).toBe(request.verification ? "succeeded" : "running");
        },
      }),
    ),
  );
  expect(result).toMatchObject({
    status: "succeeded",
    errorCode: null,
    terminationConfirmedAt: expect.any(Date),
  });
  expect(
    calls.map((request) =>
      request.verification ? "test" : request.development ? "developer" : "reviewer",
    ),
  ).toEqual(["developer", "test", "reviewer", "developer", "test", "reviewer"]);
  expect(callBudgets).toEqual([1, 1, 2, 3, 3, 4]);
  expect(calls[3]!.instruction).toContain("102 !== 200");
  expect(calls[3]!.instruction).toContain("실제 테스트 실패");
  for (const call of calls.filter((call) => call.responseMode === "assessment")) {
    const context = JSON.parse(call.instruction.split("\n").at(-1)!);
    expect(context.configuredVerification).toEqual(configuration);
  }
  expect(calls[2]!.development).toBeUndefined();
  expect(calls.filter((value) => !value.verification).map((value) => value.effort)).toEqual([
    "medium",
    "xhigh",
    "xhigh",
    "xhigh",
  ]);
  const rounds = readDevelopmentRounds(database.db, run.id);
  expect(rounds).toHaveLength(2);
  expect(rounds[0]!.review!.assessment.complete).toBe(false);
  expect(rounds[1]!.review!.assessment.complete).toBe(true);
  expect(rounds[1]!.intent.previousCandidate).toBe(rounds[0]!.candidate!.digest);
  expect(store.findById(run.id)!.steps).toHaveLength(4);
  expect(store.findById(run.id)!.steps.every((step) => step.status === "succeeded")).toBe(true);
  expect(database.db.select().from(tasks).all()).toHaveLength(1);
  expect(readExecutions(database.db, run.id)).toHaveLength(6);
  expect(readFileSync(join(source, "src/main.mjs"), "utf8")).toBe(wrong);
  expect(git("status", "--porcelain")).toBe("");
  expect(
    rounds.every(
      (round) =>
        !existsSync(round.input!.directory) && !existsSync(round.verificationInput!.directory),
    ),
  ).toBe(true);
}, 20000);

test("yields after three correction rounds without resetting Task or budget limits", async () => {
  claim();
  const result = await runWith(wrap(fake({ alwaysFail: true })));
  expect(result).toMatchObject({
    status: "waiting_retry",
    errorCode: "development_continue",
  });
  expect(readDevelopmentRounds(database.db, run.id)).toHaveLength(3);
  expect(readExecutions(database.db, run.id)).toHaveLength(9);
  expect(store.findById(run.id)!.steps).toHaveLength(6);
  expect(
    database.db
      .select()
      .from(budgetPeriods)
      .all()
      .every((row) => row.calls === 6),
  ).toBe(true);
}, 15000);

test("automatically continues the saved candidate after three reviews and verifies it before applying", async () => {
  const owner = acquireExecutionOwner(database.db);
  const policy = parseRetryPolicy({
    maxRetries: null,
    maxConsecutiveErrors: null,
    maxTotalRunMs: null,
  });
  store = createDrizzleRunStore(
    database.db,
    owner.token,
    { automaticRecovery: policy },
    {
      developmentWorkspaceKeys: ["fixture"],
    },
  );
  try {
    claim();
    const firstRun = run.id;
    const first = await runWith(wrap(fake({ firstPass: true, rework: true }), true, owner.token));
    expect(first).toMatchObject({ status: "waiting_retry", errorCode: "development_continue" });
    const before = readDevelopmentRounds(database.db, firstRun);
    const candidate = before.at(-1)!.candidate!;
    expect(before).toHaveLength(3);
    expect(before.at(-1)!.verificationResult!.status).toBe("passed");
    expect(before.at(-1)!.review!.assessment.complete).toBe(false);
    const saved = database.db.select().from(tasks).where(eq(tasks.id, taskId)).get()!.retryState!;
    const recovery = createDrizzleRecoveryStore(database.db, owner.token);
    const automatic = createAutomaticRecovery({
      db: database.db,
      ownerToken: owner.token,
      policy,
      workspaceKeys: ["fixture"],
      recovery,
      random: () => 0,
    });
    expect(automatic.tick()).toBe(true);
    const waiting = database.db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
    expect(waiting.retryState!.reason).toBe("retry_scheduled");
    expect(waiting.retryState!.totalRunMs).toBe(saved.totalRunMs);
    expect(store.claimNext("fixture", ["fixture"]).kind).toBe("idle");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(waiting.retryState!.nextAttemptAt!));
    expect(automatic.tick()).toBe(true);
    const next = store.claimNext("fixture", ["fixture"]);
    expect(next.kind).toBe("claimed");
    if (next.kind !== "claimed") throw new Error("Expected automatic continuation");
    run = next.run;
    expect(run.id).not.toBe(firstRun);
    expect(run.taskId).toBe(taskId);
    calls = [];
    expect((await runWith(wrap(fake({ firstPass: true }), true, owner.token))).status).toBe(
      "succeeded",
    );
    expect(calls).toHaveLength(3);
    expect(calls[0]!.instruction).toContain("Fix arithmetic");
    expect(calls[0]!.instruction).toContain(candidate.digest);
    const continued = readDevelopmentRounds(database.db, run.id)[0]!;
    expect(continued.intent.previousCandidate).toBe(candidate.digest);
    expect(continued.verificationResult!.status).toBe("passed");
    expect(continued.review!.assessment.complete).toBe(true);
    expect(readDevelopmentRounds(database.db, firstRun)).toEqual(before);
    expect(database.db.select().from(tasks).all()).toHaveLength(1);
    expect(
      database.db.select().from(tasks).where(eq(tasks.id, taskId)).get()!.retryState,
    ).toMatchObject({
      retries: saved.retries + 1,
      policy: { maxRetries: null, maxConsecutiveErrors: null, maxTotalRunMs: null },
    });
    expect(
      database.db
        .select()
        .from(budgetPeriods)
        .all()
        .every((period) => period.calls === 8),
    ).toBe(true);
  } finally {
    vi.useRealTimers();
    owner.release();
  }
}, 20000);

test("resumes the same task from the latest accepted tree after another task lands", async () => {
  claim();
  const firstRun = run.id;
  const firstTask = taskId;
  expect((await runWith(wrap(fake({ firstPass: true, rework: true })))).status).toBe(
    "waiting_retry",
  );
  const oldRounds = readDevelopmentRounds(database.db, firstRun);
  const oldCandidate = oldRounds.at(-1)!.candidate!;
  const task = database.db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
  const retryState = task.retryState;

  taskId = randomUUID();
  database.db
    .insert(tasks)
    .values({
      id: taskId,
      projectId,
      goalId: task.goalId,
      goalVersion: task.goalVersion,
      instruction: "Add accepted marker",
      requestKey: taskId,
      createdAt: new Date(),
    })
    .run();
  claim();
  const changed = fake({ firstPass: true });
  const addFile = (name: string): AnalysisExecutor => ({
    ...changed,
    async analyze(request, onEvent) {
      const result = await changed.analyze(request, onEvent);
      result.development?.changes.push({
        path: `src/${name}.mjs`,
        mode: "100644",
        content: Buffer.from(`export const ${name} = true;\n`).toString("base64"),
      });
      return result;
    },
  });
  expect((await runWith(wrap(addFile("accepted")))).status).toBe("succeeded");
  const accepted = readDevelopmentRepository(database.db, projectId)!.prepared!;
  expect(accepted.head).not.toBe(oldCandidate.baseRevision);

  taskId = firstTask;
  const executor = wrap(addFile("resumed"));
  const recovery = createDrizzleRecoveryStore(database.db);
  const receipt = recovery.request(
    {
      taskId,
      runId: firstRun,
      requestKey: "resume-current",
      action: "resume",
      providerGateVersion: null,
    },
    null,
    true,
  ).request;
  await createRecoveryProcessor(recovery, {
    confirm: async () => new Date(),
    cleanup: async () => {},
  }).process(receipt.id);
  expect(recovery.findById(receipt.id)!.status).toBe("completed");
  calls = [];
  claim();
  expect((await runWith(executor)).status).toBe("succeeded");
  const restarted = readDevelopmentRounds(database.db, run.id)[0]!;
  expect(restarted.intent).toMatchObject({
    revision: accepted.head,
    tree: accepted.headTree,
    previousCandidate: null,
  });
  expect(
    calls.map((value) =>
      value.verification ? "test" : value.development ? "developer" : "reviewer",
    ),
  ).toEqual(["developer", "test", "reviewer"]);
  expect(calls[0]!.instruction).toContain("repository advanced");
  expect(calls[0]!.instruction).not.toContain('"actualTest"');
  expect(readDevelopmentRounds(database.db, firstRun)).toEqual(oldRounds);
  expect(database.db.select().from(tasks).all()).toHaveLength(2);
  expect(database.db.select().from(tasks).where(eq(tasks.id, firstTask)).get()!.retryState).toEqual(
    retryState,
  );
  const latest = readDevelopmentRepository(database.db, projectId)!.prepared!;
  const storage = join(latest.directory, "git");
  for (const name of ["accepted", "resumed"]) {
    expect(git("--git-dir", storage, "show", `${latest.head}:src/${name}.mjs`)).toBe(
      `export const ${name} = true;`,
    );
  }
}, 20000);

test("a reviewer with no actionable next step holds the Task instead of inventing another attempt", async () => {
  claim();
  const result = await runWith(wrap(fake({ firstPass: true, missingInput: true })));
  expect(result).toMatchObject({
    status: "blocked",
    errorCode: "analysis_incomplete",
  });
  expect(calls).toHaveLength(3);
});

test("a period call limit prevents review from starting after a completed developer and actual test", async () => {
  createProjectBudgetStore(database.db).change(projectId, 0, {
    windowMs: 600000,
    maxCalls: 1,
    maxRunMs: 60000,
  });
  claim();
  const result = await runWith(wrap(fake()));
  expect(result).toMatchObject({
    status: "waiting_capacity",
    errorCode: "budget_limit",
    terminationConfirmedAt: expect.any(Date),
  });
  expect(calls).toHaveLength(2);
  expect(store.findById(run.id)!.steps).toHaveLength(1);
  expect(readDevelopmentRounds(database.db, run.id)[0]!.verificationResult).not.toBeNull();
  expect(store.getProviderGate().blocked).toBe(false);
});

test.each(["step", "verification", "review"])(
  "a failed %s acknowledgement cannot advance the workflow",
  async (phase) => {
    claim();
    if (phase === "step")
      database.client.exec(
        "CREATE TRIGGER fail_step BEFORE INSERT ON steps WHEN NEW.sequence=2 BEGIN SELECT RAISE(ABORT,'injected'); END",
      );
    else
      database.client.exec(
        `CREATE TRIGGER fail_record BEFORE UPDATE OF ${phase === "verification" ? "verification_result" : "review"} ON development_rounds BEGIN SELECT RAISE(ABORT,'injected'); END`,
      );
    const result = await runWith(wrap(fake()));
    expect(result.status).toBe("interrupted");
    expect(calls).toHaveLength(phase === "review" ? 3 : 2);
    expect(readDevelopmentRounds(database.db, run.id)).toHaveLength(1);
  },
);

test.each([1, 2, 3, 4])(
  "cancelling in phase %s confirms termination and cannot start a later phase",
  async (phase) => {
    claim();
    const controller = new AbortController();
    const executor = wrap(
      fake({
        waitAt: phase,
        onCall: () => {
          if (calls.length === phase) setTimeout(() => controller.abort("user_cancel"), 1);
        },
      }),
    );
    const result = await runWith(executor, controller.signal);
    expect(result).toMatchObject({
      status: "cancelled",
      errorCode: "cancel_requested",
      terminationConfirmedAt: expect.any(Date),
    });
    expect(calls).toHaveLength(phase);
    expect(database.db.select().from(tasks).get()!.retryState?.nextAttemptAt ?? null).toBeNull();
    expect(readExecutions(database.db, run.id).every((value) => value.terminationConfirmedAt)).toBe(
      true,
    );
  },
);

test("missing test configuration is held before files or model calls", async () => {
  claim();
  const result = await runWith(wrap(fake(), false));
  expect(result).toMatchObject({
    status: "blocked",
    errorCode: "unsupported_settings",
    terminationConfirmedAt: expect.any(Date),
  });
  expect(calls).toEqual([]);
  expect(readdirSync(repositoryRoot)).toEqual([]);
});

test("managed no-start recovery is versioned and cannot be inferred for legacy unidentified Runs", async () => {
  claim();
  expect(database.db.select().from(runs).get()!.developmentVersion).toBe(1);
  // Public claiming now saves the marker before entering the executor. Remove
  // it explicitly to represent an older unidentified Run, not a new claim.
  database.db.update(runs).set({ developmentVersion: null }).where(eq(runs.id, run.id)).run();
  const recovery = createDrizzleRecoveryStore(database.db);
  let observed = 0;
  const processor = createRecoveryProcessor(recovery, {
    confirm: async () => {
      observed++;
      return null;
    },
    cleanup: async () => {},
  });
  const first = recovery.request(
    {
      taskId,
      runId: run.id,
      requestKey: "old",
      action: "reconcile",
      providerGateVersion: null,
    },
    null,
    true,
  ).request;
  await processor.process(first.id);
  expect(recovery.findById(first.id)!.errorCode).toBe("TERMINATION_UNCONFIRMED");
  // Simulate the new owner reading the durable protocol marker saved before I/O.
  database.db.update(runs).set({ developmentVersion: 1 }).where(eq(runs.id, run.id)).run();
  const second = recovery.request(
    {
      taskId,
      runId: run.id,
      requestKey: "managed",
      action: "reconcile",
      providerGateVersion: null,
    },
    null,
    true,
  ).request;
  await processor.process(second.id);
  expect(recovery.findById(second.id)!.status).toBe("completed");
  expect(database.db.select().from(runs).get()!.terminationConfirmedAt).toBeInstanceOf(Date);
  expect(observed).toBe(0);
});

test("startup cleanup resumes removal only for development inputs with final Run proof", async () => {
  claim();
  const base = fake({ firstPass: true });
  const executor = wrap(base);
  // Simulate a crash between committing proof and cleanup.
  await runWith({ ...executor, cleanup: async () => {} });
  const round = readDevelopmentRounds(database.db, run.id)[0]!;
  expect(existsSync(round.verificationInput!.directory)).toBe(true);
  cleanupConfirmedInputs(database.db, inputRoot);
  expect(existsSync(round.input!.directory)).toBe(false);
  expect(existsSync(round.verificationInput!.directory)).toBe(false);
  expect(round.review!.assessment.complete).toBe(true);
});

test.skipIf(process.env.RUN_CONTAINER_TESTS !== "1")(
  "connects real developer, authless test and read-only reviewer containers across two rounds",
  async () => {
    const exec = promisify(execFile),
      cwd = fileURLToPath(new URL("../../../../", import.meta.url));
    for (const [dockerfile, image] of [
      ["docker/analysis-runner.Dockerfile", "agent-hub-sandbox-test:local"],
      ["docker/verification-node.Dockerfile", configuration.image],
      ["apps/server/tests/fixtures/workflow-runner.Dockerfile", "agent-hub-workflow-test:local"],
    ]) {
      await exec("docker", ["build", "-f", dockerfile!, "-t", image!, "."], {
        cwd,
        timeout: 90000,
      });
    }
    const home = join(directory, "synthetic-auth");
    mkdirSync(home);
    writeFileSync(join(home, "auth.json"), "synthetic credential");
    claim();
    database.db.update(runs).set({ runtimeSkillVersion: 1 }).where(eq(runs.id, run.id)).run();
    run.runtimeSkillVersion = 1;
    const base = createContainerExecutor("agent-hub-workflow-test:local", home);
    const result = await runWith(wrap(base));
    expect(result).toMatchObject({
      status: "succeeded",
      errorCode: null,
      terminationConfirmedAt: expect.any(Date),
    });
    const rounds = readDevelopmentRounds(database.db, run.id);
    expect(rounds.map((round) => round.verificationResult!.status)).toEqual(["failed", "passed"]);
    expect(rounds[1]!.review!.assessment.complete).toBe(true);
    expect(readExecutions(database.db, run.id)).toHaveLength(6);
    const skillHistory = database.db.select().from(steps).where(eq(steps.runId, run.id)).all();
    expect(skillHistory.map((step) => step.runtimeSkill?.role)).toEqual([
      "developer",
      "reviewer",
      "developer",
      "reviewer",
    ]);
    expect(
      skillHistory.every((step) => step.runtimeSkillSelectedAt && step.runtimeSkillLoadedAt),
    ).toBe(true);
    expect(new Set(store.findById(run.id)!.steps.map((step) => step.sessionId)).size).toBe(4);
    expect(readFileSync(join(source, "src/main.mjs"), "utf8")).toBe(wrong);
  },
  150000,
);

test("caps effort changes across development and review while preserving proposed effort", async () => {
  claim();
  const result = await runWith(wrap(fake({ alwaysFail: true, rework: true })));
  expect(result.errorCode).toBe("development_continue");
  const history = store.findById(run.id)!.steps;
  expect(history.map((step) => step.effort)).toEqual([
    "medium",
    "xhigh",
    "medium",
    "medium",
    "medium",
    "medium",
  ]);
  expect(history[3]).toMatchObject({
    proposedEffort: "xhigh",
    effort: "medium",
  });
}, 15000);

test.each(["development.input.intent", "development.review.complete"])(
  "termination during a pending %s acknowledgement seals future phases",
  async (kind) => {
    claim();
    const gate = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>();
    const executor = wrap(fake());
    const result = executor
      .analyze(
        {
          runId: run.id,
          model: "fixture",
          instruction: run.instruction,
          workspace: source,
          signal: new AbortController().signal,
        },
        async (event) => {
          store.record(run.id, event);
          if (event.kind === kind) {
            entered.resolve();
            await gate.promise;
          }
        },
      )
      .then(
        () => false,
        () => true,
      );
    await entered.promise;
    let confirmed = false;
    const stopping = executor.confirmTermination!(run.id).then((value) => {
      confirmed = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(confirmed).toBe(false);
    gate.resolve();
    expect(await result).toBe(true);
    expect(await stopping).toBeInstanceOf(Date);
    expect(calls).toHaveLength(kind === "development.input.intent" ? 0 : 3);
  },
);

test("a missing Step acknowledgement cannot be mistaken for permission to call the model", async () => {
  claim();
  const executor = wrap(fake());
  await expect(
    executor.analyze(
      {
        runId: run.id,
        model: "fixture",
        instruction: run.instruction,
        workspace: source,
        signal: new AbortController().signal,
      },
      (event) => {
        if (!event.step) store.record(run.id, event);
      },
    ),
  ).rejects.toThrow("input_unavailable");
  expect(calls).toEqual([]);
  expect(await executor.confirmTermination!(run.id)).toBeInstanceOf(Date);
});

test("managed execution allocation checks the persisted AI Step before even acknowledging a container", async () => {
  claim();
  const executor = wrap(fake());
  await expect(
    executor.analyze(
      {
        runId: run.id,
        model: "fixture",
        instruction: run.instruction,
        workspace: source,
        signal: new AbortController().signal,
      },
      (event) => {
        store.record(run.id, event);
        if (event.development?.type === "input.ready") {
          const execution: ExecutionIdentity = {
            kind: "docker",
            containerId: "a".repeat(64),
            token: "fixture",
            engineId: "fixture",
          };
          expect(() => store.record(run.id, { kind: "execution.prepared", execution })).toThrow(
            "input_unavailable",
          );
          throw new Error("fixture stop before Step");
        }
      },
    ),
  ).rejects.toThrow("fixture stop");
  expect(readExecutions(database.db, run.id)).toEqual([]);
  expect(await executor.confirmTermination!(run.id)).toBeInstanceOf(Date);
});

test("recovery cannot promote an unapplied development result to Task success", async () => {
  claim();
  store.record(run.id, {
    kind: "development.workflow.started",
    development: { type: "workflow.started" },
  });
  store.finish(run.id, {
    status: "interrupted",
    result: "Unapplied candidate",
    errorCode: "termination_unconfirmed",
    usage: null,
  });
  const recovery = createDrizzleRecoveryStore(database.db);
  const request = recovery.request(
    {
      taskId,
      runId: run.id,
      requestKey: "reconcile",
      action: "reconcile",
      providerGateVersion: null,
    },
    null,
    true,
  ).request;
  await createRecoveryProcessor(recovery, {
    confirm: async () => null,
    cleanup: async () => {},
  }).process(request.id);
  expect(store.findById(run.id)).toMatchObject({
    status: "blocked",
    result: null,
    errorCode: "development_incomplete",
    terminationConfirmedAt: expect.any(Date),
  });
});

test("snapshots operator verification settings before the first developer call", async () => {
  claim();
  const snapshot = { ...configuration, command: [...configuration.command] };
  const base = fake({
    firstPass: true,
    onCall: (request) => {
      if (calls.length === 1) snapshot.command = ["node", "-e", "process.exit(0)"];
      if (request.verification)
        expect(request.verification.config.command).toEqual(configuration.command);
    },
  });
  const executor = createDevelopmentExecutor({
    db: database.db,
    analysis: base,
    development: base,
    inputRoot,
    repositoryRoot,
    config: {
      containerImage: "fixture",
      workspaces: new Map([["fixture", source]]),
      verification: new Map([["fixture", snapshot]]),
    },
  });
  await runWith(executor);
  expect(
    readDevelopmentRounds(database.db, run.id)[0]!.verificationResult!.configuration.command,
  ).toEqual(configuration.command);
});

test("a managed preflight failure before container allocation still proves no workload started", async () => {
  claim();
  const base: AnalysisExecutor = {
    analyze: async () => {
      throw new Error("preflight failed");
    },
    confirmTermination: async () => null,
  };
  const result = await runWith(wrap(base));
  expect(result.terminationConfirmedAt).toBeInstanceOf(Date);
  expect(readExecutions(database.db, run.id)).toEqual([]);
});

test("a rejected termination observation after allocation remains unconfirmed", async () => {
  claim();
  const base = fake({ firstPass: true });
  base.confirmTermination = async () => {
    throw new Error("observer failed");
  };
  const result = await runWith(wrap(base));
  expect(result.status).toBe("interrupted");
  expect(result.terminationConfirmedAt).toBeNull();
  expect(readExecutions(database.db, run.id)).toHaveLength(3);
  expect(existsSync(readDevelopmentRounds(database.db, run.id)[0]!.input!.directory)).toBe(true);
});
