import { developmentInstruction } from "../../src/modules/execution/development-workflow.js";
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
import {
  budgetPeriods,
  developmentRounds,
  goals,
  projects,
  runs,
  steps,
  tasks,
} from "../../src/db/schema.js";
import type { AnalysisAssessment } from "@agent-hub/contracts";
import type {
  AnalysisExecutor,
  AnalysisRequest,
  ExecutionIdentity,
} from "../../src/modules/execution/analysis.js";
import { AnalysisError } from "../../src/modules/execution/analysis.js";
import { createDrizzleRunStore } from "../../src/modules/execution/drizzle-run-store.js";
import { runClaimedTask, type ClaimedRun } from "../../src/modules/execution/run-task.js";
import { readExecutions } from "../../src/modules/execution/execution-record-store.js";
import {
  verificationConfigDigest,
  type VerificationConfig,
} from "../../src/modules/execution/verification-config.js";
import { createProjectBudgetStore } from "../../src/modules/budgets/project-budget-store.js";
import { createDrizzleGoalStore } from "../../src/modules/goals/drizzle-goal-store.js";
import { createWorkReleaseStore } from "../../src/modules/goals/work-release-store.js";
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
    progress?: boolean;
    progressUntil?: number;
    blocker?: AnalysisAssessment["blocker"];
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
        let passed = true;
        try {
          execFileSync(process.execPath, ["tests/check.mjs"], {
            cwd: request.workspace,
            stdio: "pipe",
          });
        } catch {
          passed = false;
        }
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
        const base = !options.alwaysFail && (options.firstPass || count > 1) ? correct : wrong;
        const content = options.progress
          ? `${base}// correction ${Math.min(count, options.progressUntil ?? count)}\n`
          : base;
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
          options.blocker
            ? {
                ...approved(),
                complete: false,
                blocker: options.blocker,
                unresolved: [options.blocker.reason],
                next: {
                  purpose: options.blocker.nextAction,
                  effort: "high",
                  reason: options.blocker.reason,
                },
              }
            : options.missingInput
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

test("catalog routes visual work to a specialist and independent review to the pinned generalist", async () => {
  const model = (slug: string, description: string) => ({
    slug,
    description,
    priority: 1,
    visibility: "list",
    input_modalities: ["text", "image"],
    supported_reasoning_levels: [{ effort: "medium" }],
  });
  const cache = join(directory, "models_cache.json");
  writeFileSync(
    cache,
    JSON.stringify({
      models: [
        model("future-general", "Everyday coding"),
        model("future-visual", "Visual understanding"),
      ],
    }),
  );
  store = createDrizzleRunStore(
    database.db,
    undefined,
    {
      accountModelCatalog: true,
      codexHome: directory,
    },
    { developmentWorkspaceKeys: ["fixture"] },
  );
  database.db.update(tasks).set({ instruction: "스크린샷 검토" }).where(eq(tasks.id, taskId)).run();
  claim();
  expect(run.model).toBe("future-visual");
  writeFileSync(cache, JSON.stringify({ models: [model("new-general", "Everyday coding")] }));
  const seen: string[] = [];
  const result = await runWith(
    wrap(
      fake({
        firstPass: true,
        onCall: (request) => {
          if (!request.verification) seen.push(request.model);
        },
      }),
    ),
  );
  expect(result.status).toBe("succeeded");
  expect(seen).toEqual(["future-visual", "future-general"]);
  expect(store.findById(run.id)?.steps.map((step) => step.model)).toEqual(seen);
});

test("project-selected developer and independently selected reviewer use the persisted Step models", async () => {
  store = createDrizzleRunStore(
    database.db,
    undefined,
    {
      modelRouting: {
        models: { luna: "fixture-luna", sol: "fixture-sol", astra: "fixture-astra" },
      },
    },
    { developmentWorkspaceKeys: ["fixture"] },
  );
  work.model = { tier: "luna", reason: "One mechanical arithmetic correction with fixed tests" };
  claim();
  const base = fake({ firstPass: true });
  const observed: string[] = [];
  const result = await runWith(
    wrap({
      ...base,
      async analyze(request, onEvent) {
        if (!request.verification) {
          observed.push(request.model);
          expect(store.findById(run.id)?.steps.at(-1)?.model).toBe(request.model);
        }
        const response = await base.analyze(request, onEvent);
        if (response.development) {
          const report = JSON.parse(response.output);
          report.next.model = "astra";
          report.next.reason = "Review interacting arithmetic edge cases";
          return { ...response, output: JSON.stringify(report) };
        }
        return response;
      },
    }),
  );
  expect(result.status).toBe("succeeded");
  expect(observed).toEqual(["fixture-luna", "fixture-astra"]);
  expect(store.findById(run.id)?.steps[1]?.modelReason).toContain("Review interacting arithmetic");
});

test.each([false, true])(
  "sensitive scope added before a developer Step raises the floor (before first=%s)",
  async (beforeFirst) => {
    writeFileSync(join(source, "tests/auth-check.mjs"), "// authentication regression fixture\n");
    git("add", "--all");
    git("commit", "--quiet", "-m", "add auth fixture");
    work.sourceRevision = git("rev-parse", "HEAD");
    work.model = { tier: "luna", reason: "Small arithmetic change" };
    store = createDrizzleRunStore(
      database.db,
      undefined,
      {
        modelRouting: {
          models: { luna: "fixture-luna", sol: "fixture-sol", astra: "fixture-astra" },
        },
      },
      { developmentWorkspaceKeys: ["fixture"] },
    );
    claim();
    if (beforeFirst) {
      // The recovered scope-expansion path updates the Task after claim, before Step1.
      database.db
        .update(tasks)
        .set({ plannedWork: { ...work, paths: [...work.paths, "tests/auth-check.mjs"] } })
        .where(eq(tasks.id, taskId))
        .run();
    }
    const base = fake({ firstPass: true });
    let reviews = 0;
    const developerModels: string[] = [];
    const result = await runWith(
      wrap({
        ...base,
        async analyze(request, onEvent) {
          if (request.development && !request.verification) developerModels.push(request.model);
          const response = await base.analyze(request, onEvent);
          if (!request.development && ++reviews === 1 && !beforeFirst) {
            return {
              ...response,
              output: JSON.stringify({
                ...approved(),
                complete: false,
                unresolved: ["Include auth regression"],
                scopeExpansion: {
                  paths: ["tests/auth-check.mjs"],
                  reason: "Required regression for this task",
                },
                next: {
                  purpose: "Inspect auth regression",
                  effort: "medium",
                  model: "luna",
                  reason: "Small change",
                },
              }),
            };
          }
          return response;
        },
      }),
    );
    expect(result.status).toBe("succeeded");
    expect(developerModels).toEqual(
      beforeFirst ? ["fixture-sol"] : ["fixture-luna", "fixture-sol"],
    );
    expect(
      database.db.select().from(runs).where(eq(runs.id, run.id)).get()?.modelPolicy?.minimumTier,
    ).toBe("sol");
    expect(
      store.findById(run.id)?.steps.find((step) => step.sequence === (beforeFirst ? 1 : 3))
        ?.modelReason,
    ).toContain("최소 등급");
  },
);

function scopeRepair(paths = ["tests/check.mjs"], beforeReview?: () => void): AnalysisExecutor {
  const base = fake({ firstPass: true });
  return {
    ...base,
    async analyze(request, onEvent) {
      const result = await base.analyze(request, onEvent);
      const test = readFileSync(join(request.workspace, "tests/check.mjs"), "utf8");
      const expanded = request.development?.writePaths.includes("tests/check.mjs");
      if (result.development && expanded)
        result.development.changes.push({
          path: "tests/check.mjs",
          mode: "100644",
          content: Buffer.from(`${test}\nassert.equal(total(0, 2), 0); // new contract\n`).toString(
            "base64",
          ),
        });
      if (result.verification && !test.includes("new contract")) {
        result.verification.status = "failed";
        result.verification.exitCode = 1;
        result.verification.output = "Integration contract is missing tests/check.mjs coverage";
      }
      if (!request.development && !test.includes("new contract")) {
        beforeReview?.();
        result.output = JSON.stringify({
          ...developerReport(),
          scopeExpansion: { paths, reason: "Update the integration contract for this same change" },
          unresolved: ["The required integration test is outside Task writePaths"],
        });
      }
      return result;
    },
  };
}

test("repairs an omitted test path from the independent review and verifies the same candidate", async () => {
  claim();
  expect((await runWith(wrap(scopeRepair()))).status).toBe("succeeded");
  const rounds = readDevelopmentRounds(database.db, run.id);
  expect(rounds).toHaveLength(2);
  expect(rounds[0]!.input!.writePaths).toEqual(["src"]);
  expect(rounds[0]!.verificationResult!.status).toBe("failed");
  expect(rounds[0]!.review!.assessment.scopeExpansion!.paths).toEqual(["tests/check.mjs"]);
  expect(rounds[1]!.input!.writePaths).toEqual(["src", "tests/check.mjs"]);
  expect(rounds[1]!.intent.previousCandidate).toBe(rounds[0]!.candidate!.digest);
  expect(rounds[1]!.verificationResult!.status).toBe("passed");
  expect(rounds[1]!.candidate!.changes.map((change) => change.path)).toContain("tests/check.mjs");
  const task = database.db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
  expect(task.plannedWork).toEqual({ ...work, paths: ["src", "tests/check.mjs"] });
  expect(task.retryState).toBeNull();
  expect(database.db.select().from(runs).all()).toHaveLength(1);
  expect(calls).toHaveLength(6);
  expect(
    calls.filter((call) => call.verification).map((call) => call.verification!.config),
  ).toEqual([configuration, configuration]);
}, 20000);

test.each(["tests", ".", "../check.mjs", ".env", "tests/missing.mjs"])(
  "holds an unsafe or unprepared scope request (%s) without repeating the failed round",
  async (path) => {
    claim();
    const result = await runWith(wrap(scopeRepair([path])));
    expect(result).toMatchObject({ status: "blocked", errorCode: "analysis_incomplete" });
    expect(calls).toHaveLength(3);
    expect(readDevelopmentRounds(database.db, run.id)).toHaveLength(1);
    expect(database.db.select().from(tasks).where(eq(tasks.id, taskId)).get()!.plannedWork).toEqual(
      work,
    );
  },
);

test("does not expand over another unfinished task or broaden the Goal permission", async () => {
  database.db
    .insert(tasks)
    .values({
      id: randomUUID(),
      projectId,
      instruction: "Separate integration work",
      requestKey: "other",
      plannedWork: { ...work, paths: ["tests/check.mjs"] },
      createdAt: new Date(),
    })
    .run();
  claim();
  expect(await runWith(wrap(scopeRepair()))).toMatchObject({
    status: "blocked",
    errorCode: "analysis_incomplete",
  });
  expect(calls).toHaveLength(3);
  expect(database.db.select().from(tasks).where(eq(tasks.id, taskId)).get()!.plannedWork).toEqual(
    work,
  );
});

test.each(["released", "excluded"])(
  "does not treat a %s historical Task as a path reservation",
  async (kind) => {
    const goal = database.db.select().from(goals).get()!;
    const oldId = randomUUID();
    database.db
      .insert(tasks)
      .values({
        id: oldId,
        projectId,
        goalId: goal.id,
        goalVersion: goal.version,
        instruction: "Historical work",
        requestKey: oldId,
        status: "cancelled",
        plannedWork: { ...work, paths: ["tests/check.mjs"] },
        createdAt: new Date(),
        ...(kind === "released"
          ? { cancelRequestedAt: new Date() }
          : {
              goalReview: {
                fromVersion: goal.version,
                toVersion: goal.version,
                decision: "excluded" as const,
                checkedAt: new Date().toISOString(),
                paths: ["tests/check.mjs"],
              },
            }),
      })
      .run();
    if (kind === "released") {
      const release = createWorkReleaseStore(database.db).release(oldId, {
        requestKey: "release-history",
        expectedGoalVersion: goal.version,
      }).release;
      database.db
        .update(tasks)
        .set({ status: "succeeded" })
        .where(eq(tasks.id, release.newTaskId))
        .run();
    }
    claim();
    expect((await runWith(wrap(scopeRepair()))).status).toBe("succeeded");
    expect(readDevelopmentRounds(database.db, run.id)).toHaveLength(2);
    expect(database.db.select().from(tasks).where(eq(tasks.id, oldId)).get()!.status).toBe(
      "cancelled",
    );
  },
  20000,
);

test("keeps review evidence but refuses scope expansion after the owner pauses the Goal", async () => {
  claim();
  const beforeReview = () => {
    const goal = database.db.select().from(goals).get()!;
    createDrizzleGoalStore(database.db).change(goal.id, "pause-during-review", goal.version, {
      action: "pause",
    });
  };
  expect(await runWith(wrap(scopeRepair(["tests/check.mjs"], beforeReview)))).toMatchObject({
    status: "blocked",
    errorCode: "goal_changed",
  });
  expect(calls).toHaveLength(3);
  expect(readDevelopmentRounds(database.db, run.id)[0]!.review).not.toBeNull();
  expect(database.db.select().from(tasks).where(eq(tasks.id, taskId)).get()!.plannedWork).toEqual(
    work,
  );
});

test.each(["before", "after", "goal-update"])(
  "recovers a crash %s the scope acknowledgement without replacing the Task or its candidate",
  async (timing) => {
    claim();
    const firstRun = run.id;
    const record = store.record;
    const interruption = vi.spyOn(store, "record").mockImplementation((id, event) => {
      if (event.kind !== "development.scope.expanded") return record(id, event);
      if (timing !== "before") record(id, event);
      throw new AnalysisError("transient");
    });
    expect(await runWith(wrap(scopeRepair()))).toMatchObject({
      status: "failed",
      errorCode: "transient",
    });
    interruption.mockRestore();
    const prior = readDevelopmentRounds(database.db, firstRun);
    expect(prior[0]!.review!.assessment.scopeExpansion).not.toBeNull();
    if (timing === "goal-update") {
      const goal = database.db.select().from(goals).get()!;
      createDrizzleGoalStore(database.db).change(goal.id, "same-scope-new-version", goal.version, {
        definition: { ...goal.definition, priority: goal.definition.priority + 1 },
      });
    }
    const recovery = createDrizzleRecoveryStore(database.db);
    const receipt = recovery.request(
      {
        taskId,
        runId: firstRun,
        requestKey: `resume-scope-${timing}`,
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
    run = store.claim(taskId, "fixture");
    expect((await runWith(wrap(scopeRepair()))).status).toBe("succeeded");
    expect(calls).toHaveLength(3);
    const current = readDevelopmentRounds(database.db, run.id)[0]!;
    expect(current.input!.writePaths).toEqual(["src", "tests/check.mjs"]);
    expect(current.intent.previousCandidate).toBe(prior[0]!.candidate!.digest);
    expect(readDevelopmentRounds(database.db, firstRun)).toEqual(prior);
    expect(database.db.select().from(tasks).all()).toHaveLength(1);
    expect(database.db.select().from(tasks).get()!.plannedWork).toEqual({
      ...work,
      paths: ["src", "tests/check.mjs"],
    });
    expect(
      database.db
        .select()
        .from(budgetPeriods)
        .all()
        .every((period) => period.calls === 4),
    ).toBe(true);
  },
  20000,
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
  const result = await runWith(wrap(fake({ alwaysFail: true, progress: true })));
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
    const first = await runWith(
      wrap(fake({ firstPass: true, rework: true, progress: true }), true, owner.token),
    );
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
  expect(
    (await runWith(wrap(fake({ firstPass: true, rework: true, progress: true })))).status,
  ).toBe("waiting_retry");
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
  const result = await runWith(wrap(fake({ alwaysFail: true, rework: true, progress: true })));
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

test("specialist mission reaches development but not the independent reviewer instruction", () => {
  const agent = {
    id: "a".repeat(64),
    key: "backend",
    name: "Backend specialist",
    mission: "Focus on reconciliation edge cases",
  };
  const assigned = { ...work, agent };
  const developer = developmentInstruction({
    instruction: "Fix behavior",
    work: assigned,
    round: 1,
    role: "developer",
    verificationConfig: configuration,
  });
  const reviewer = developmentInstruction({
    instruction: "Fix behavior",
    work: assigned,
    round: 1,
    role: "reviewer",
    verificationConfig: configuration,
  });
  expect(JSON.parse(developer.split("\n").at(-1)!).assignedAgent).toEqual(agent);
  expect(developer).toContain(
    "existing permissions, writePaths, fixed tests and independent review still take precedence",
  );
  expect(reviewer).not.toContain(agent.mission);
  expect(reviewer).toContain("You cannot modify files");
});

test.each(["environment", "permission", "decision", "unknown"] as const)(
  "holds a %s blocker even when the reviewer proposes an automatic next step",
  async (kind) => {
    const { goalCriteria } = await import("../../src/modules/goals/goal-criteria.js");
    const goal = database.db.select().from(goals).get()!;
    work.goalCriteria = goalCriteria(goal.id, goal.definition);
    work.criterionIds = work.goalCriteria.map((item) => item.id);
    claim();
    const blocker = {
      kind,
      reason: "Required evidence is unavailable",
      nextAction: "Operator must provide the missing prerequisite",
    };
    const result = await runWith(wrap(fake({ firstPass: true, blocker })));
    expect(result).toMatchObject({
      status: "blocked",
      errorCode: kind === "unknown" ? "analysis_incomplete" : `${kind}_required`,
      terminationConfirmedAt: expect.any(Date),
    });
    const rounds = readDevelopmentRounds(database.db, run.id);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.review!.assessment.blocker).toEqual(blocker);
    expect(rounds[0]!.review!.assessment.complete).toBe(false);
    const { readGoalProgress } = await import("../../src/modules/goals/goal-progress.js");
    const progress = readGoalProgress(database.db, goal.id);
    expect(progress.criteria[0]).toMatchObject({
      status: "blocked",
      reason: expect.stringContaining(blocker.nextAction),
    });
    expect(progress.verifiedCount).toBe(0);
    const { createPlanningStore, readPlanningContext } = await import(
      "../../src/modules/goals/planning-store.js"
    );
    const plan = createPlanningStore(database.db).reserveNext(["fixture"]);
    expect(plan).not.toBeNull();
    expect(
      readPlanningContext(database.db, plan!.taskId)!.history.find((item) => item.id === taskId)!
        .lastRun!.blocker,
    ).toEqual(blocker);
    expect(readDevelopmentRepository(database.db, projectId)!.prepared!.head).toBe(
      work.sourceRevision,
    );
  },
  15000,
);

test("holds unchanged candidates after three incomplete reviews without scheduling unlimited retries", async () => {
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
    { developmentWorkspaceKeys: ["fixture"] },
  );
  try {
    claim();
    const result = await runWith(wrap(fake({ alwaysFail: true, rework: true }), true, owner.token));
    expect(result).toMatchObject({
      status: "blocked",
      errorCode: "development_stalled",
      terminationConfirmedAt: expect.any(Date),
    });
    expect(readDevelopmentRounds(database.db, run.id)).toHaveLength(3);
    const automatic = createAutomaticRecovery({
      db: database.db,
      ownerToken: owner.token,
      policy,
      workspaceKeys: ["fixture"],
      recovery: createDrizzleRecoveryStore(database.db, owner.token),
    });
    expect(automatic.tick()).toBe(true);
    expect(automatic.tick()).toBe(false);
    expect(
      database.db.select().from(tasks).where(eq(tasks.id, taskId)).get()!.retryState,
    ).toMatchObject({ reason: "not_retryable", nextAttemptAt: null, policy: { maxRetries: null } });
    expect(store.claimNext("fixture", ["fixture"]).kind).toBe("idle");
    expect(readDevelopmentRepository(database.db, projectId)!.prepared!.head).toBe(
      work.sourceRevision,
    );
  } finally {
    owner.release();
  }
}, 15000);

test("investigates available information before correcting and independently approving the same Task", async () => {
  claim();
  const base = fake({ firstPass: true });
  let reviews = 0;
  const executor: AnalysisExecutor = {
    ...base,
    async analyze(request, emit) {
      const result = await base.analyze(request, emit);
      if (!request.development && ++reviews === 1)
        result.output = JSON.stringify({
          ...approved(),
          complete: false,
          unresolved: ["Check the zero quantity case"],
          blocker: {
            kind: "information",
            reason: "Zero quantity evidence is missing",
            nextAction: "Inspect tests/check.mjs and check zero quantity in the allowed workspace",
          },
          next: {
            purpose: "Inspect the zero quantity behavior",
            effort: "high",
            reason: "Available source can establish the missing evidence",
          },
        });
      return result;
    },
  };
  expect((await runWith(wrap(executor))).status).toBe("succeeded");
  expect(readDevelopmentRounds(database.db, run.id)).toHaveLength(2);
  expect(calls[3]!.instruction).toContain("Zero quantity evidence is missing");
  expect(database.db.select().from(tasks).all()).toHaveLength(1);
}, 15000);

test.each([false, true])(
  "unchanged review evidence survives restart; partial round=%s",
  async (partial) => {
    let owner = acquireExecutionOwner(database.db);
    const policy = parseRetryPolicy({
      maxRetries: null,
      maxConsecutiveErrors: null,
      maxTotalRunMs: null,
    });
    store = createDrizzleRunStore(
      database.db,
      owner.token,
      { automaticRecovery: policy },
      { developmentWorkspaceKeys: ["fixture"] },
    );
    try {
      claim();
      expect(
        (
          await runWith(
            wrap(
              fake({ alwaysFail: true, rework: true, progress: true, progressUntil: 2 }),
              true,
              owner.token,
            ),
          )
        ).errorCode,
      ).toBe("development_continue");
      const previousRunId = run.id;
      const before = readDevelopmentRounds(database.db, run.id);
      if (partial) {
        const interruptedId = randomUUID(),
          inputId = randomUUID();
        const previousRun = database.db.select().from(runs).where(eq(runs.id, run.id)).get()!;
        database.db
          .insert(runs)
          .values({
            ...previousRun,
            id: interruptedId,
            attempt: 2,
            status: "interrupted",
            errorCode: "server_shutdown",
            stopReason: "server_shutdown",
            terminationConfirmedAt: new Date(),
            finishedAt: new Date(),
            accountedDurationMs: 0,
          })
          .run();
        const priorRound = before.at(-1)!;
        database.db
          .insert(developmentRounds)
          .values({
            runId: interruptedId,
            sequence: 1,
            repositoryId: priorRound.repositoryId,
            inputId,
            planningRevision: priorRound.planningRevision,
            intent: { ...priorRound.intent, id: inputId, runId: interruptedId },
            executionOffset: 0,
            createdAt: new Date(),
          })
          .run();
        database.db.update(tasks).set({ status: "interrupted" }).where(eq(tasks.id, taskId)).run();
      }
      owner.release();
      database.close();
      database = openDatabase(join(directory, "hub.sqlite"));
      owner = acquireExecutionOwner(database.db);
      store = createDrizzleRunStore(
        database.db,
        owner.token,
        { automaticRecovery: policy },
        { developmentWorkspaceKeys: ["fixture"] },
      );
      const automatic = createAutomaticRecovery({
        db: database.db,
        ownerToken: owner.token,
        policy,
        workspaceKeys: ["fixture"],
        recovery: createDrizzleRecoveryStore(database.db, owner.token),
        random: () => 0,
      });
      expect(automatic.tick()).toBe(true);
      const waiting = database.db.select().from(tasks).where(eq(tasks.id, taskId)).get()!;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(waiting.retryState!.nextAttemptAt!));
      expect(automatic.tick()).toBe(true);
      const next = store.claimNext("fixture", ["fixture"]);
      expect(next.kind).toBe("claimed");
      if (next.kind !== "claimed") throw new Error("Expected continuation");
      run = next.run;
      calls = [];
      const base = fake({ alwaysFail: true, rework: true });
      const same: AnalysisExecutor = {
        ...base,
        async analyze(request, emit) {
          const result = await base.analyze(request, emit);
          if (result.development)
            result.development.changes[0]!.content = Buffer.from(
              `${wrong}// correction 2\n`,
            ).toString("base64");
          return result;
        },
      };
      expect(await runWith(wrap(same, true, owner.token))).toMatchObject({
        status: "blocked",
        errorCode: "development_stalled",
      });
      expect(readDevelopmentRounds(database.db, run.id)).toHaveLength(1);
      expect(readDevelopmentRounds(database.db, previousRunId)).toEqual(before);
      expect(database.db.select().from(tasks).all()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      owner.release();
    }
  },
  20000,
);
