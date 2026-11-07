import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { GoalDefinition } from "@agent-hub/contracts";
import { openDatabase } from "../src/db/connection.js";
import {
  budgetPeriods,
  goals,
  projects,
  runs,
  runExecutions,
  steps,
} from "../src/db/schema.js";
import { createDrizzleGoalStore } from "../src/modules/goals/drizzle-goal-store.js";
import { createPlanningStore } from "../src/modules/goals/planning-store.js";
import { createPreparedExecutor } from "../src/modules/goals/prepared-executor.js";
import { preparedInputRoot } from "../src/modules/goals/prepared-workspace.js";
import { goalVerificationPassed } from "../src/modules/goals/goal-verification.js";
import { createDrizzleRunStore } from "../src/modules/execution/drizzle-run-store.js";
import { runTask } from "../src/modules/execution/run-task.js";
import { loadRuntimeSkill } from "../src/modules/execution/runtime-skills.js";
import {
  verificationConfigDigest,
  type VerificationConfig,
} from "../src/modules/execution/verification-config.js";
import type {
  AnalysisEvent,
  AnalysisExecutor,
  AnalysisRequest,
} from "../src/modules/execution/analysis.js";

let directory: string, source: string, goalId: string, taskId: string;
let database: ReturnType<typeof openDatabase>,
  store: ReturnType<typeof createDrizzleRunStore>;
const definition: GoalDefinition = {
  description: "완성된 예제 계산기 확인",
  completionCriteria: "정답 42와 실행 가능한 검사 스크립트가 있어야 한다",
  kind: "finite",
  priority: 50,
  allowedPaths: ["src", "tests"],
  excludedPaths: [],
  checkIntervalMs: 60000,
  budget: { windowMs: 3600000, maxCalls: 20, maxRunMs: 1800000 },
};
const configuration: VerificationConfig = {
  image: "fixture:local",
  command: ["node", "tests/verify.mjs"],
  timeoutMs: 1000,
};
const usage = { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 };
const approval = {
  report: "현재 코드의 전체 목표를 확인했습니다.",
  evidence: ["src/main.mjs는 42를 반환합니다."],
  unresolved: [],
  complete: true,
  next: null,
};
const row = () => database.db.select().from(runs).get()!;
beforeEach(() => {
  directory = realpathSync(
    mkdtempSync(join(tmpdir(), "hub-goal-verification-")),
  );
  source = join(directory, "source");
  mkdirSync(join(source, "src"), { recursive: true });
  mkdirSync(join(source, "tests"));
  writeFileSync(join(source, "src/main.mjs"), "export const answer = 42;\n");
  writeFileSync(
    join(source, "tests/verify.mjs"),
    "#!/usr/bin/env node\nimport assert from 'node:assert/strict'; import { answer } from '../src/main.mjs'; assert.equal(answer, 42);\n",
  );
  chmodSync(join(source, "tests/verify.mjs"), 0o700);
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
        stdio: "ignore",
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      },
    );
  git("init", "--quiet", "--template=");
  git("add", "--all");
  git("commit", "--quiet", "-m", "fixture");
  database = openDatabase(join(directory, "hub.sqlite"));
  const projectId = randomUUID();
  database.db
    .insert(projects)
    .values({
      id: projectId,
      name: "Fixture",
      workspaceKey: "fixture",
      createdAt: new Date(),
    })
    .run();
  goalId = createDrizzleGoalStore(database.db).register(
    projectId,
    "goal",
    definition,
  ).goal.id;
  taskId = createPlanningStore(database.db).reserveNext(["fixture"])!.taskId;
  store = createDrizzleRunStore(database.db);
});
afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

function fixture(
  options: {
    evidenceCount?: number;
    outcome?: "complete" | "wait";
    failed?: boolean;
    reject?: boolean;
    noLoad?: boolean;
    beforeCall?: (
      request: AnalysisRequest,
      call: number,
    ) => void | Promise<void>;
    afterEvent?: (event: AnalysisEvent) => void | Promise<void>;
  } = {},
) {
  const calls: AnalysisRequest[] = [];
  const executor: AnalysisExecutor = {
    runtimeSkillVersion: 1,
    async analyze(request, emit) {
      calls.push(request);
      await options.beforeCall?.(request, calls.length);
      const identity = {
        kind: "docker" as const,
        containerId: calls.length.toString(16).repeat(64),
        token: randomUUID(),
        engineId: "fixture-engine",
      };
      const event = async (value: AnalysisEvent) => {
        await emit(value);
        await options.afterEvent?.(value);
      };
      if (!request.verification) {
        const role =
          request.responseMode === "goal-plan" ? "planner" : "reviewer";
        const context = {
          sequence: request.stepSequence!,
          selection: loadRuntimeSkill(role).selection,
        };
        await event({
          kind: "skill.selected",
          runtimeSkill: { type: "selected", ...context },
        });
        if (!options.noLoad || calls.length === 1)
          await event({
            kind: "skill.loaded",
            runtimeSkill: { type: "loaded", ...context },
          });
      }
      await event({ kind: "execution.prepared", execution: identity });
      await event({
        kind: "execution.terminated",
        executionTermination: { identity, confirmedAt: new Date() },
      });
      if (request.verification)
        return {
          output: "actual test fixture",
          usage: null,
          verification: {
            candidateDigest: request.verification.candidateDigest,
            inputDigest: request.development!.inputDigest,
            configurationDigest: verificationConfigDigest(
              request.verification.config,
            ),
            configuration: request.verification.config,
            execution: identity,
            imageId: `sha256:${"a".repeat(64)}`,
            status: options.failed ? ("failed" as const) : ("passed" as const),
            exitCode: options.failed ? 1 : 0,
            oomKilled: false,
            elapsedMs: 10,
            output: "fixture verification output",
          },
        };
      if (request.responseMode === "goal-plan") {
        const input = JSON.parse(request.instruction.split("\n").at(-1)!);
        return {
          output: JSON.stringify({
            version: 1,
            goalVersion: input.goalVersion,
            inputDigest: input.inputDigest,
            outcome: options.outcome ?? "complete",
            summary: "목표 완료 제안",
            evidence: Array.from(
              { length: options.evidenceCount ?? 1 },
              (_, index) => `현재 코드 확인 ${index + 1}`,
            ),
            tasks: [],
          }),
          usage,
        };
      }
      return {
        output: JSON.stringify(
          options.reject
            ? { ...approval, complete: false, unresolved: ["목표 기준 부족"] }
            : approval,
        ),
        usage,
      };
    },
    confirmTermination: async () => new Date(),
  };
  return { executor, calls };
}
const wrapped = (executor: AnalysisExecutor) =>
  createPreparedExecutor(
    executor,
    preparedInputRoot(join(directory, "hub.sqlite")),
    database.db,
    { verification: new Map([["fixture", configuration]]) },
  );
const execute = (executor: AnalysisExecutor, selectedStore = store) =>
  runTask(
    {
      taskId,
      model: "fixture",
      workspace: source,
      timeoutMs: 5000,
      signal: new AbortController().signal,
    },
    selectedStore,
    wrapped(executor),
  );

test("complete proposal stores fresh tests and an independently budgeted goal-wide reviewer with role evidence", async () => {
  const { executor, calls } = fixture();
  await execute(executor);
  const stored = row();
  expect(calls).toHaveLength(3);
  expect(calls.map((call) => call.responseMode ?? "test")).toEqual([
    "goal-plan",
    "test",
    "assessment",
  ]);
  expect(calls[1]!.development!.writePaths).toEqual([]);
  expect(
    calls[1]!.development!.files.find(
      (file) => file.path === "tests/verify.mjs",
    )?.mode,
  ).toBe("100755");
  const reviewInput = JSON.parse(calls[2]!.instruction.split("\n").at(-1)!);
  expect(reviewInput.definition).toEqual(definition);
  expect(reviewInput).toMatchObject({
    inputDigest: stored.preparedInput!.digest,
    sourceRevision: stored.preparedInput!.revision,
    actualTest: { status: "passed" },
  });
  expect(stored.planResult?.verification).toMatchObject({
    version: 1,
    test: { result: { status: "passed" } },
    review: { assessment: approval },
  });
  expect(goalVerificationPassed(database.db, stored)).toBe(true);
  expect(
    database.db
      .select()
      .from(steps)
      .all()
      .map((step) => [
        step.sequence,
        step.runtimeSkill?.role,
        !!step.runtimeSkillLoadedAt,
      ]),
  ).toEqual([
    [1, "planner", true],
    [2, "reviewer", true],
  ]);
  expect(
    database.db
      .select()
      .from(budgetPeriods)
      .all()
      .map((item) => item.calls),
  ).toEqual([2, 2]);
  expect(readFileSync(join(source, "src/main.mjs"), "utf8")).toContain("42");
  database.close();
  database = openDatabase(join(directory, "hub.sqlite"));
  expect(goalVerificationPassed(database.db, row())).toBe(true);
});

test("schema-valid twelve evidence items preserve the full proposal and still reach independent verification", async () => {
  const { executor, calls } = fixture({ evidenceCount: 12 });
  await execute(executor);
  expect(calls).toHaveLength(3);
  expect(JSON.parse(row().planResult!.proposal).evidence).toHaveLength(12);
  expect(goalVerificationPassed(database.db, row())).toBe(true);
});

test.each(["test failure", "review rejection"])(
  "%s cannot supply goal-completion proof",
  async (reason) => {
    const { executor } = fixture({
      failed: reason === "test failure",
      reject: reason === "review rejection",
    });
    await execute(executor);
    expect(goalVerificationPassed(database.db, row())).toBe(false);
    expect(row().planResult?.verification?.review?.assessment.complete).toBe(
      false,
    );
    expect(database.db.select().from(goals).get()!.status).toBe("active");
  },
);

test.each(["intent", "test", "review"])(
  "failed %s persistence prevents later execution",
  async (stage) => {
    const { executor, calls } = fixture();
    const kind =
      stage === "intent" ? "started" : stage === "test" ? "tested" : "reviewed";
    await execute(executor, {
      ...store,
      record(id, event) {
        if (event.kind === `goal-verification.${kind}`)
          throw new Error("fixture persistence failure");
        return store.record(id, event);
      },
    });
    expect(calls).toHaveLength(
      stage === "intent" ? 1 : stage === "test" ? 2 : 3,
    );
    expect(goalVerificationPassed(database.db, row())).toBe(false);
    expect(database.db.select().from(goals).get()!.status).toBe("active");
  },
);

test("second AI call obeys Goal call budget after tests have finished", async () => {
  const goal = database.db.select().from(goals).get()!;
  database.db
    .update(goals)
    .set({
      definition: {
        ...goal.definition,
        budget: { ...goal.definition.budget, maxCalls: 1 },
      },
    })
    .where(eq(goals.id, goalId))
    .run();
  const { executor, calls } = fixture();
  await execute(executor);
  expect(calls).toHaveLength(2);
  expect(row().planResult?.verification?.test?.result.status).toBe("passed");
  expect(row().planResult?.verification?.review).toBeNull();
  expect(goalVerificationPassed(database.db, row())).toBe(false);
});

test("reviewer load acknowledgement is required before its assessment is durable", async () => {
  const { executor } = fixture({ noLoad: true });
  await execute(executor);
  expect(row().planResult?.verification?.review).toBeNull();
  expect(goalVerificationPassed(database.db, row())).toBe(false);
});

test.each(["test identity", "test configuration", "termination"])(
  "invalid %s is rejected at the journal boundary before review",
  async (field) => {
    const { executor, calls } = fixture();
    await execute(executor, {
      ...store,
      record(id, event) {
        if (event.goalVerification?.type === "tested") {
          if (field === "test identity")
            event.goalVerification.result.execution.token = "forged";
          if (field === "test configuration") {
            event.goalVerification.result.configuration.command = ["different"];
            event.goalVerification.result.configurationDigest =
              verificationConfigDigest(
                event.goalVerification.result.configuration,
              );
          }
          if (field === "termination")
            database.db
              .update(runExecutions)
              .set({ terminationConfirmedAt: null })
              .where(eq(runExecutions.sequence, 2))
              .run();
        }
        store.record(id, event);
      },
    });
    expect(calls).toHaveLength(2);
    expect(row().planResult?.verification?.test).toBeNull();
    expect(row().planResult?.verification?.review).toBeNull();
  },
);

test("Goal changes while tests run prevent the independent review", async () => {
  const { executor, calls } = fixture({
    beforeCall(_request, call) {
      if (call === 2)
        createDrizzleGoalStore(database.db).change(goalId, "pause", 1, {
          action: "pause",
        });
    },
  });
  await execute(executor);
  expect(calls).toHaveLength(2);
  expect(row().planResult?.verification?.review).toBeNull();
  expect(database.db.select().from(goals).get()!.status).toBe("paused");
});

test.each(["wait", "continuous"])(
  "%s proposals do not execute goal verification",
  async (mode) => {
    if (mode === "continuous")
      database.db
        .update(goals)
        .set({ definition: { ...definition, kind: "continuous" } })
        .where(eq(goals.id, goalId))
        .run();
    const { executor, calls } = fixture({
      outcome: mode === "wait" ? "wait" : "complete",
    });
    await execute(executor);
    expect(calls).toHaveLength(1);
    expect(row().planResult?.verification).toBeUndefined();
  },
);

test.each([
  "digest",
  "test identity",
  "test configuration",
  "review step",
  "termination",
  "skill",
])("altered %s invalidates stored proof", async (field) => {
  await execute(fixture().executor);
  const stored = row(),
    proof = structuredClone(stored.planResult!.verification!);
  if (field === "digest") proof.inputDigest = "0".repeat(64);
  if (field === "test identity") proof.test!.result.execution.token = "changed";
  if (field === "test configuration") proof.configuration.command = ["changed"];
  if (field === "review step")
    database.db
      .update(steps)
      .set({ assessment: { ...approval, report: "different report" } })
      .where(eq(steps.sequence, 2))
      .run();
  if (field === "termination")
    database.db
      .update(runExecutions)
      .set({ terminationConfirmedAt: null })
      .where(eq(runExecutions.sequence, 3))
      .run();
  if (field === "skill")
    database.db
      .update(steps)
      .set({ runtimeSkillLoadedAt: null })
      .where(eq(steps.sequence, 2))
      .run();
  expect(
    goalVerificationPassed(database.db, {
      ...stored,
      planResult: { ...stored.planResult!, verification: proof },
    }),
  ).toBe(false);
});

test("termination during fixed tests prevents the reviewer from starting", async () => {
  const reached = Promise.withResolvers<void>();
  const { executor, calls } = fixture({
    beforeCall: async (request, call) => {
      if (call !== 2) return;
      reached.resolve();
      await new Promise<void>((resolve) =>
        request.signal.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
      request.signal.throwIfAborted();
    },
  });
  const prepared = wrapped(executor);
  const pending = runTask(
    {
      taskId,
      model: "fixture",
      workspace: source,
      timeoutMs: 5000,
      signal: new AbortController().signal,
    },
    store,
    prepared,
  );
  await reached.promise;
  const proof = prepared.confirmTermination!(row().id);
  await pending;
  await proof;
  expect(calls).toHaveLength(2);
  expect(row().planResult?.verification?.review).toBeNull();
});
