import { runExecutions } from "../../src/db/schema.js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { GoalDefinition, GoalPlan } from "@agent-hub/contracts";
import { openDatabase } from "../../src/db/connection.js";
import {
  goals,
  planningCycles,
  projects,
  runs,
  tasks,
  developmentRepositories,
  serviceTargets,
  serviceObservations,
} from "../../src/db/schema.js";
import { createDrizzleGoalStore } from "../../src/modules/goals/drizzle-goal-store.js";
import {
  createPlanningStore,
  readPlanningContext,
} from "../../src/modules/goals/planning-store.js";
import {
  createPreparedExecutor,
  cleanupPreparedRun,
  verifyPreparedResult,
} from "../../src/modules/execution/workflows/prepared-executor.js";
import { preparedInputRoot } from "../../src/modules/workspace/prepared-workspace.js";
import { createDrizzleRunStore } from "../../src/modules/execution/drizzle-run-store.js";
import { createDrizzleRecoveryStore } from "../../src/modules/execution/drizzle-recovery-store.js";
import { createRecoveryProcessor } from "../../src/modules/execution/recover-task.js";
import { runTask } from "../../src/modules/execution/run-task.js";
import { parseAnalysisWorkflow } from "../../src/modules/execution/analysis-workflow.js";
import { createProjectBudgetStore } from "../../src/modules/budgets/project-budget-store.js";
import { readPlanningWork } from "../../src/modules/goals/planning-work-state.js";
import { initialRetryState, defaultRetryPolicy } from "../../src/modules/execution/retry-policy.js";
import type { AnalysisExecutor, AnalysisRequest } from "../../src/modules/execution/analysis.js";

const definition: GoalDefinition = {
  description: "Complete an example app",
  completionCriteria: "Tests prove the changes",
  kind: "finite",
  priority: 50,
  allowedPaths: ["src", "tests"],
  excludedPaths: ["src/private"],
  checkIntervalMs: 60000,
  budget: { windowMs: 3600000, maxCalls: 20, maxRunMs: 1800000 },
};
let directory: string, source: string, root: string, projectId: string, goalId: string;
let database: ReturnType<typeof openDatabase>,
  store: ReturnType<typeof createDrizzleRunStore>,
  planner: ReturnType<typeof createPlanningStore>,
  goalStore: ReturnType<typeof createDrizzleGoalStore>;
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
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-goal-plan-")));
  source = join(directory, "source");
  mkdirSync(source);
  mkdirSync(join(source, "src"));
  mkdirSync(join(source, "tests"));
  writeFileSync(join(source, "src/main.ts"), "export const answer = 41;\n");
  writeFileSync(join(source, "tests/main.test.ts"), "// fixture\n");
  git("init", "--quiet", "--template=");
  git("add", "--all");
  git("commit", "--quiet", "-m", "fixture");
  database = openDatabase(join(directory, "hub.sqlite"));
  root = preparedInputRoot(join(directory, "hub.sqlite"));
  store = createDrizzleRunStore(database.db, undefined, {
    analysisWorkflow: parseAnalysisWorkflow({}),
  });
  planner = createPlanningStore(database.db);
  goalStore = createDrizzleGoalStore(database.db);
  projectId = randomUUID();
  database.db
    .insert(projects)
    .values({
      id: projectId,
      name: "Example",
      workspaceKey: "example",
      createdAt: new Date(),
    })
    .run();
  goalId = goalStore.register(projectId, "goal", definition).goal.id;
});
afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});
const reserve = () => planner.reserveNext(["example"])!;
const runRow = (taskId: string) =>
  database.db.select().from(runs).where(eq(runs.taskId, taskId)).get()!;
const workRows = () =>
  database.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.goalId, goalId), eq(tasks.kind, "work")))
    .all();
function proposal(request: AnalysisRequest, overrides: Partial<GoalPlan> = {}): GoalPlan {
  const context = JSON.parse(request.instruction.split("\n").at(-1)!);
  return {
    version: 1,
    goalVersion: context.goalVersion,
    inputDigest: context.inputDigest,
    outcome: "work",
    summary: "Improve the calculation",
    evidence: ["src/main.ts returns 41"],
    tasks: [
      {
        title: "Fix calculation",
        instruction: "Return the expected value",
        acceptanceCriteria: "The result is 42 and a test verifies it",
        paths: ["src/main.ts"],
        evidence: ["Existing code returns 41"],
      },
    ],
    ...overrides,
  };
}
async function execute(
  taskId: string,
  overrides: Partial<GoalPlan> = {},
  beforeResult?: () => void,
  confirm: AnalysisExecutor["confirmTermination"] = async () => new Date(),
) {
  const executor: AnalysisExecutor = {
    async analyze(request) {
      expect(request.responseMode).toBe("goal-plan");
      expect(request.workflow).toBeUndefined();
      const output = JSON.stringify(proposal(request, overrides));
      beforeResult?.();
      return {
        output,
        usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 },
      };
    },
    ...(confirm ? { confirmTermination: confirm } : {}),
  };
  return runTask(
    {
      taskId,
      model: "fixture",
      workspace: source,
      timeoutMs: 5000,
      signal: new AbortController().signal,
    },
    store,
    createPreparedExecutor(executor, root),
  );
}

test.each([false, true])(
  "new-policy planning cannot create work without load evidence, recovery=%s",
  async (recover) => {
    const plan = reserve();
    const executor: AnalysisExecutor = {
      runtimeSkillVersion: 1,
      async analyze(request) {
        return { output: JSON.stringify(proposal(request)), usage: null };
      },
      confirmTermination: async () => new Date(),
    };
    const selected = recover
      ? {
          ...store,
          finish() {
            throw new Error("Simulated completion crash");
          },
        }
      : store;
    const pending = runTask(
      {
        taskId: plan.taskId,
        model: "fixture",
        workspace: source,
        timeoutMs: 5000,
        signal: new AbortController().signal,
      },
      selected,
      createPreparedExecutor(executor, root),
    );
    if (recover) {
      await expect(pending).rejects.toThrow("Simulated completion crash");
      const row = runRow(plan.taskId);
      expect(row.planResult?.status).toBe("proposed");
      const recovery = createDrizzleRecoveryStore(database.db);
      const accepted = recovery.request(
        {
          taskId: plan.taskId,
          runId: row.id,
          action: "reconcile",
          requestKey: randomUUID(),
          providerGateVersion: null,
        },
        null,
        true,
      );
      await createRecoveryProcessor(
        recovery,
        { confirm: async () => new Date(), cleanup: async () => {} },
        undefined,
        (id) => verifyPreparedResult(database.db, id),
      ).process(accepted.request.id);
    } else
      expect(await pending).toMatchObject({ status: "blocked", errorCode: "unsupported_settings" });
    expect(runRow(plan.taskId)).toMatchObject({
      status: "blocked",
      errorCode: "unsupported_settings",
    });
    expect(workRows()).toHaveLength(0);
  },
);

test("independent SQLite connections reserve one plan and no AI Run", () => {
  const second = openDatabase(join(directory, "hub.sqlite"));
  try {
    const first = reserve();
    expect(first.goalId).toBe(goalId);
    expect(createPlanningStore(second.db).reserveNext(["example"])).toBeNull();
    expect(database.db.select().from(planningCycles).all()).toHaveLength(1);
    expect(database.db.select().from(runs).all()).toEqual([]);
    expect(() =>
      database.db
        .insert(planningCycles)
        .values({
          taskId: randomUUID(),
          goalId,
          goalVersion: 1,
          status: "reserved",
          createdAt: new Date(),
        })
        .run(),
    ).toThrow();
    expect(goalStore.findById(goalId).nextCheckAt).toBeNull();
  } finally {
    second.close();
  }
});

test("a plan creates distinct development tasks once and cannot execute them as read-only analysis", async () => {
  const plan = reserve();
  const outcome = await execute(
    plan.taskId,
    {
      tasks: [
        {
          title: "Implementation",
          instruction: "Fix calculation",
          acceptanceCriteria: "Return 42",
          paths: ["src/main.ts"],
          evidence: ["Wrong value"],
        },
        {
          title: "Regression coverage",
          instruction: "Add verification",
          acceptanceCriteria: "Check 42",
          paths: ["tests/main.test.ts"],
          evidence: ["Test is missing"],
        },
      ],
    },
    undefined,
    async () => {
      expect(runRow(plan.taskId).planResult?.status).toBe("proposed");
      return new Date();
    },
  );
  expect(outcome.status).toBe("succeeded");
  const work = workRows();
  expect(work).toHaveLength(2);
  expect(work[0]).toMatchObject({
    kind: "work",
    goalId,
    goalVersion: 1,
    status: "queued",
    plannedWork: {
      planningTaskId: plan.taskId,
      sourceRevision: git("rev-parse", "HEAD"),
    },
  });
  expect(runRow(plan.taskId)).toMatchObject({
    planResult: {
      status: "applied",
      createdTaskIds: expect.arrayContaining(work.map((task) => task.id)),
    },
    workflowPolicy: null,
  });
  expect(() => store.finish(outcome.runId, outcome)).toThrow();
  expect(workRows()).toHaveLength(2);
  expect(store.claimNext("fixture", ["example"])).toEqual({
    kind: "idle",
    reason: "development_pending",
  });
  expect(() => store.claim(work[0]!.id, "fixture")).toThrow("DEVELOPMENT_EXECUTOR_UNAVAILABLE");
  expect(database.db.select().from(runs).all()).toHaveLength(1);
  expect(reserve()).toBeNull();
});

test.each(["outside", "private", "overlap", "duplicate", "version", "digest", "contradiction"])(
  "rejects a %s plan and retains the proposal for inspection",
  async (kind) => {
    const plan = reserve();
    const overrides: Partial<GoalPlan> =
      kind === "version"
        ? { goalVersion: 9 }
        : kind === "digest"
          ? { inputDigest: "0".repeat(64) }
          : kind === "contradiction"
            ? { outcome: "wait" }
            : {
                tasks: [
                  {
                    title: "Bad scope",
                    instruction: "Do it",
                    acceptanceCriteria: "Verified",
                    paths:
                      kind === "outside"
                        ? ["../outside"]
                        : kind === "private"
                          ? ["src/.npmrc"]
                          : kind === "duplicate"
                            ? ["src/main.ts", "src/main.ts"]
                            : ["src", "src/main.ts"],
                    evidence: ["fixture"],
                  },
                ],
              };
    const result = await execute(plan.taskId, overrides);
    expect(result).toMatchObject({
      status: "blocked",
      errorCode: "invalid_plan",
      result: null,
    });
    expect(runRow(plan.taskId).planResult).toMatchObject({
      status: "rejected",
      proposal: expect.any(String),
    });
    expect(workRows()).toEqual([]);
    expect(reserve()).toBeNull();
  },
);

test("a model completion claim cannot close a finite goal without independent verification", async () => {
  const plan = reserve();
  expect(await execute(plan.taskId, { outcome: "complete", tasks: [] })).toMatchObject({
    status: "blocked",
    errorCode: "verification_required",
  });
  expect(goalStore.findById(goalId).status).toBe("active");
  expect(workRows()).toEqual([]);
});

test("a wait decision does not call AI again when only the check time changes, including after restart", async () => {
  const plan = reserve();
  expect((await execute(plan.taskId, { outcome: "wait", tasks: [] })).status).toBe("succeeded");
  const due = new Date(goalStore.findById(goalId).nextCheckAt!);
  expect(planner.reserveNext(["example"], new Date(due.getTime() - 1))).toBeNull();
  for (let interval = 0; interval < 21; interval++) {
    expect(
      createPlanningStore(database.db).reserveNext(
        ["example"],
        new Date(due.getTime() + interval * 60000),
      ),
    ).toBeNull();
  }
  expect(database.db.select().from(planningCycles).all()).toHaveLength(1);
  expect(database.db.select().from(runs).all()).toHaveLength(1);
  database.close();
  database = openDatabase(join(directory, "hub.sqlite"));
  expect(
    createPlanningStore(database.db).reserveNext(["example"], new Date(due.getTime() + 86400000)),
  ).toBeNull();
});

test("a new accepted development revision wakes a waiting goal", async () => {
  const plan = reserve();
  await execute(plan.taskId, { outcome: "wait", tasks: [] });
  const due = new Date(goalStore.findById(goalId).nextCheckAt!);
  const id = randomUUID();
  const intent = { id, projectId, source, directory: join(directory, "development") };
  database.db
    .insert(developmentRepositories)
    .values({
      id,
      projectId,
      createdByRunId: runRow(plan.taskId).id,
      intent,
      prepared: {
        ...intent,
        sourceRevision: git("rev-parse", "HEAD"),
        head: "a".repeat(40),
        headTree: "b".repeat(40),
      },
      createdAt: new Date(),
      preparedAt: new Date(),
    })
    .run();
  expect(planner.reserveNext(["example"], due)?.taskId).not.toBe(plan.taskId);
  expect(database.db.select().from(planningCycles).all()).toHaveLength(2);
});

test("a legacy wait without a fingerprint establishes one new baseline, then stops repeated planning", async () => {
  const first = reserve();
  await execute(first.taskId, { outcome: "wait", tasks: [] });
  const row = runRow(first.taskId);
  const input = { ...row.planningInput! };
  delete input.stateFingerprint;
  database.db.update(runs).set({ planningInput: input }).where(eq(runs.id, row.id)).run();
  const second = planner.reserveNext(
    ["example"],
    new Date(goalStore.findById(goalId).nextCheckAt!),
  )!;
  expect(second).not.toBeNull();
  await execute(second.taskId, { outcome: "wait", tasks: [] });
  expect(
    planner.reserveNext(["example"], new Date(goalStore.findById(goalId).nextCheckAt!)),
  ).toBeNull();
  expect(database.db.select().from(runs).all()).toHaveLength(2);
});

test.each(["heartbeat", "state", "stale"])(
  "waiting planner distinguishes service %s from unchanged evidence",
  async (change) => {
    const observer = {
      enabledKeys: new Set(["fixture"]),
      errors: new Set<string>(),
      nextChecks: new Map<string, Date>(),
    };
    planner = createPlanningStore(database.db, undefined, () => observer);
    store = createDrizzleRunStore(
      database.db,
      undefined,
      {},
      { getObserverStatus: () => observer },
    );
    database.db
      .insert(serviceTargets)
      .values({
        key: "fixture",
        projectId,
        name: "Fixture",
        fingerprint: "fixture",
        configured: true,
        intervalMs: 60000,
        staleAfterMs: 600000,
        allowWaiting: true,
        activityTimeoutMs: null,
      })
      .run();
    const observe = (time: Date, stopped = false) =>
      database.db
        .insert(serviceObservations)
        .values({
          id: randomUUID(),
          targetKey: "fixture",
          fingerprint: "fixture",
          receivedAt: time,
          success: true,
          snapshot: {
            observedAt: time.toISOString(),
            processState: stopped ? "stopped" : "running",
            activityState: "working",
            lastSuccessAt: time.toISOString(),
            nextExpectedAt: null,
            errorCount: 0,
            summary: "Fixture",
          },
        })
        .run();
    observe(new Date());
    const plan = reserve();
    await execute(plan.taskId, { outcome: "wait", tasks: [] });
    const due = new Date(goalStore.findById(goalId).nextCheckAt!);
    if (change !== "stale") observe(due, change === "state");
    const next = planner.reserveNext(
      ["example"],
      change === "stale" ? new Date(due.getTime() + 600000) : due,
    );
    if (change === "heartbeat") expect(next).toBeNull();
    else expect(next).toMatchObject({ goalId });
  },
);

test.each(["goal", "source"])(
  "a changed %s rejects a completed proposal without generating work",
  async (kind) => {
    const plan = reserve();
    const result = await execute(plan.taskId, {}, () => {
      if (kind === "goal") goalStore.change(goalId, "pause", 1, { action: "pause" });
      else writeFileSync(join(source, "src/main.ts"), "user change");
    });
    expect(result).toMatchObject({
      status: "blocked",
      errorCode: kind === "goal" ? "goal_changed" : "input_changed",
    });
    expect(runRow(plan.taskId).planResult?.status).toBe("rejected");
    expect(workRows()).toEqual([]);
  },
);

test("a failed task insert rolls back application, while the saved proposal can recover exactly once", async () => {
  const plan = reserve();
  database.client.exec(
    "CREATE TRIGGER fail_work BEFORE INSERT ON tasks WHEN NEW.planned_work IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected failure'); END",
  );
  await expect(execute(plan.taskId)).rejects.toThrow("injected failure");
  const run = runRow(plan.taskId);
  expect(run).toMatchObject({
    status: "running",
    planResult: { status: "proposed" },
    terminationConfirmedAt: null,
  });
  expect(workRows()).toEqual([]);
  expect(planner.findByTask(plan.taskId)?.status).toBe("reserved");
  database.client.exec("DROP TRIGGER fail_work");
  const recovery = createDrizzleRecoveryStore(database.db);
  const request = recovery.request(
    {
      taskId: plan.taskId,
      runId: run.id,
      action: "reconcile",
      requestKey: "recover",
      providerGateVersion: null,
    },
    null,
    true,
  ).request;
  expect(await verifyPreparedResult(database.db, run.id)).toBe(true);
  recovery.complete(request.id, new Date(), true);
  recovery.complete(request.id, new Date(), true);
  expect(workRows()).toHaveLength(1);
  expect(runRow(plan.taskId).planResult?.status).toBe("applied");
});

test.each(["cancel", "goal-edit", "new-work"])(
  "rechecks %s after the proposal is saved and before applying it",
  async (change) => {
    const plan = reserve();
    const outcome = await execute(plan.taskId, {}, undefined, async () => {
      const run = runRow(plan.taskId);
      expect(run.planResult?.status).toBe("proposed");
      if (change === "cancel")
        createDrizzleRecoveryStore(database.db).request(
          {
            taskId: plan.taskId,
            runId: run.id,
            action: "cancel",
            requestKey: "cancel-at-finish",
            providerGateVersion: null,
          },
          run.id,
          true,
        );
      else if (change === "goal-edit")
        goalStore.change(goalId, "edit-at-finish", 1, {
          definition: {
            ...definition,
            description: "Changed during termination",
          },
        });
      else
        database.db
          .insert(tasks)
          .values({
            id: randomUUID(),
            projectId,
            goalId,
            goalVersion: 1,
            instruction: "Another task",
            requestKey: "concurrent-work",
            createdAt: new Date(),
          })
          .run();
      return new Date();
    });
    expect(outcome).toMatchObject({
      status: change === "cancel" ? "cancelled" : "blocked",
      errorCode:
        change === "cancel"
          ? "cancel_requested"
          : change === "goal-edit"
            ? "goal_changed"
            : "work_unresolved",
    });
    expect(workRows().filter((task) => task.plannedWork)).toEqual([]);
    expect(runRow(plan.taskId).planResult?.status).toBe("rejected");
    if (change === "cancel") expect(goalStore.findById(goalId).status).toBe("paused");
  },
);

test("the next plan receives bounded prior results without leaking authentication strings", async () => {
  const first = reserve();
  await execute(first.taskId, {
    outcome: "wait",
    tasks: [],
    summary: "Earlier evidence sk-fixture_secret",
  });
  const due = new Date(goalStore.findById(goalId).nextCheckAt!);
  goalStore.change(goalId, "recheck-with-new-criteria", 1, {
    definition: { ...definition, completionCriteria: "Check additional evidence" },
  });
  const next = planner.reserveNext(["example"], due)!;
  const context = readPlanningContext(database.db, next.taskId)!;
  expect(context.history).toHaveLength(1);
  expect(context.history[0]).toMatchObject({
    id: first.taskId,
    lastRun: {
      status: "succeeded",
      terminationConfirmed: true,
      result: expect.stringContaining("Earlier evidence [REDACTED]"),
    },
  });
  expect(JSON.stringify(context)).not.toContain("sk-fixture_secret");
});

test.each([false, true])(
  "recovery rechecks stored input before applying an unconfirmed plan; source changed=%s",
  async (changed) => {
    const plan = reserve(),
      outcome = await execute(plan.taskId, {}, undefined, async () => null),
      run = runRow(plan.taskId);
    expect(outcome.status).toBe("interrupted");
    expect(workRows()).toEqual([]);
    const identity = {
      kind: "docker" as const,
      engineId: "fixture",
      containerId: "a".repeat(64),
      token: "fixture",
    };
    database.db
      .insert(runExecutions)
      .values({
        runId: run.id,
        sequence: 1,
        containerId: identity.containerId,
        token: identity.token,
        engineId: identity.engineId,
        createdAt: new Date(),
      })
      .run();
    if (changed) writeFileSync(join(source, "src/main.ts"), "user change");
    const recovery = createDrizzleRecoveryStore(database.db);
    const request = recovery.request(
      {
        taskId: plan.taskId,
        runId: run.id,
        action: "reconcile",
        requestKey: "recover",
        providerGateVersion: null,
      },
      null,
      true,
    ).request;
    await createRecoveryProcessor(
      recovery,
      { confirm: async () => new Date(), cleanup: async () => {} },
      (id) => cleanupPreparedRun(database.db, root, id),
      (id) => verifyPreparedResult(database.db, id),
    ).process(request.id);
    expect(runRow(plan.taskId).status).toBe(changed ? "blocked" : "succeeded");
    expect(workRows()).toHaveLength(changed ? 0 : 1);
    expect(existsSync(run.preparedInput!.directory)).toBe(false);
  },
);

test("cancelling a planning task pauses its Goal atomically and repeated requests do not add versions", () => {
  const plan = reserve(),
    recovery = createDrizzleRecoveryStore(database.db);
  const request = {
    taskId: plan.taskId,
    runId: null,
    action: "cancel" as const,
    requestKey: "cancel",
    providerGateVersion: null,
  };
  recovery.request(request, null, true);
  recovery.request(request, null, true);
  expect(goalStore.findById(goalId)).toMatchObject({
    status: "paused",
    version: 2,
  });
  expect(reserve()).toBeNull();
  goalStore.change(goalId, "resume", 2, { action: "resume" });
  const next = reserve();
  expect(next.taskId).not.toBe(plan.taskId);
  expect(planner.findByTask(plan.taskId)).toMatchObject({
    status: "rejected",
    reason: "goal_changed",
  });
});

test("an older plan reservation is retired only after its execution is confirmed stopped", () => {
  const plan = reserve(),
    run = store.claim(plan.taskId, "fixture");
  goalStore.change(goalId, "edit", 1, {
    definition: { ...definition, description: "New goal" },
  });
  expect(reserve()).toBeNull();
  store.finish(run.id, {
    status: "failed",
    result: null,
    usage: null,
    errorCode: "transient",
    terminationConfirmedAt: new Date(),
  });
  expect(reserve()?.taskId).not.toBe(plan.taskId);
  expect(planner.findByTask(plan.taskId)?.status).toBe("rejected");
});

test("a CLI-style cancellation of an active planning Run also pauses its Goal", () => {
  const plan = reserve(),
    run = store.claim(plan.taskId, "fixture");
  expect(store.requestStop(run.id, "user_cancel")).toBe("user_cancel");
  store.requestStop(run.id, "user_cancel");
  expect(goalStore.findById(goalId)).toMatchObject({
    status: "paused",
    version: 2,
  });
  expect(reserve()).toBeNull();
});

test("explicit retry of a rejected proposal retains the earlier Run's evidence and the same Task budget", async () => {
  const plan = reserve();
  const invalid = await execute(plan.taskId, { inputDigest: "0".repeat(64) });
  const recovery = createDrizzleRecoveryStore(database.db);
  const request = recovery.request(
    {
      taskId: plan.taskId,
      runId: invalid.runId,
      action: "resume",
      requestKey: "retry",
      providerGateVersion: null,
    },
    null,
    true,
  ).request;
  recovery.complete(request.id, new Date());
  const result = await execute(plan.taskId);
  expect(result.status).toBe("succeeded");
  expect(
    database.db.select().from(runs).where(eq(runs.id, invalid.runId)).get()?.planResult?.status,
  ).toBe("rejected");
  expect(database.db.select().from(runs).where(eq(runs.id, result.runId)).get()).toMatchObject({
    attempt: 2,
    planResult: { status: "applied" },
  });
  expect(database.db.select().from(planningCycles).all()).toHaveLength(1);
  expect(workRows()).toHaveLength(1);
});

test("unresolved or cancelled work cannot be renamed through a new plan even after a Goal edit", async () => {
  const plan = reserve();
  await execute(plan.taskId);
  const work = workRows()[0]!;
  createDrizzleRecoveryStore(database.db).request(
    {
      taskId: work.id,
      runId: null,
      action: "cancel",
      requestKey: "cancel",
      providerGateVersion: null,
    },
    null,
    true,
  );
  goalStore.change(goalId, "edit", 1, {
    definition: { ...definition, description: "Rename everything" },
  });
  const next = reserve();
  expect(next.goalId).toBe(goalId);
  const outcome = await execute(next.taskId);
  expect(outcome.status).toBe("succeeded");
  expect(runRow(next.taskId).planResult).toMatchObject({
    reason: "suppressed_work",
    createdTaskIds: [],
    suppressed: [{ blockedByTaskIds: [work.id] }],
  });
  expect(workRows()).toHaveLength(1);
  const another = goalStore.register(projectId, "other", definition).goal;
  expect(reserve()?.goalId).toBe(another.id);
});

test("a manual pending task on the same Goal prevents a new plan from bypassing existing work", () => {
  database.db
    .insert(tasks)
    .values({
      id: randomUUID(),
      projectId,
      goalId,
      goalVersion: 1,
      instruction: "Existing",
      requestKey: "old",
      createdAt: new Date(),
    })
    .run();
  expect(reserve()).toBeNull();
  expect(database.db.select().from(planningCycles).all()).toEqual([]);
});

const proposedWork = (paths: string[], title = "A new title") => ({
  title,
  instruction: "Improve the selected behavior",
  paths,
  acceptanceCriteria: "A regression test proves the behavior",
  evidence: ["Observed in the example"],
});
async function terminalWork(
  status: "cancelled" | "failed" | "blocked" = "cancelled",
  paths = ["src/main.ts"],
) {
  await execute(reserve().taskId, { tasks: [proposedWork(paths)] });
  const work = workRows()[0]!;
  if (status === "cancelled")
    createDrizzleRecoveryStore(database.db).request(
      {
        taskId: work.id,
        runId: null,
        action: "cancel",
        requestKey: "cancel-work",
        providerGateVersion: null,
      },
      null,
      true,
    );
  else {
    database.db
      .update(tasks)
      .set({
        status,
        retryState: {
          ...initialRetryState(defaultRetryPolicy),
          retries: 2,
          totalRunMs: 12000,
          consecutiveErrors: 2,
          lastError: "transient",
        },
      })
      .where(eq(tasks.id, work.id))
      .run();
    database.db
      .insert(runs)
      .values({
        id: randomUUID(),
        taskId: work.id,
        attempt: 1,
        goalVersion: 1,
        instanceId: "fixture",
        status,
        model: "fixture",
        effort: "medium",
        startedAt: new Date(Date.now() - 12000),
        lastActivityAt: new Date(),
        finishedAt: new Date(),
        terminationConfirmedAt: new Date(),
        errorCode: "transient",
      })
      .run();
  }
  return database.db.select().from(tasks).where(eq(tasks.id, work.id)).get()!;
}

test.each(["cancelled", "failed", "blocked"] as const)(
  "%s work suppresses its paths while allowing an unrelated task without resetting its limits",
  async (status) => {
    const original = await terminalWork(status);
    const plan = reserve();
    expect(readPlanningContext(database.db, plan.taskId)).toMatchObject({
      suppressedWorkCount: 1,
      suppressedWork: [{ taskId: original.id, status, paths: ["src/main.ts"] }],
    });
    const result = await execute(plan.taskId, {
      tasks: [
        proposedWork(["src/main.ts"], "Same title"),
        proposedWork(["tests/main.test.ts"], "Same title"),
      ],
    });
    expect(result.status).toBe("succeeded");
    expect(result.result?.match(/기존 문제로 생성 제외/g)).toHaveLength(1);
    expect(workRows()).toHaveLength(2);
    expect(workRows().find((task) => task.id !== original.id)?.plannedWork?.paths).toEqual([
      "tests/main.test.ts",
    ]);
    expect(workRows().find((task) => task.id === original.id)).toEqual(original);
    expect(runRow(plan.taskId).planResult).toMatchObject({
      reason: "work_with_suppression",
      createdTaskIds: [expect.any(String)],
      suppressed: [
        {
          proposalIndex: 0,
          blockedByTaskIds: [original.id],
          totalBlockingTasks: 1,
        },
      ],
    });
  },
);

test.each(
  [
    ["src/main.ts"],
    ["src"],
    ["src/main.ts/child"],
    ["src/MAIN.ts"],
    ["src/main.ts", "tests/new.ts"],
  ].map((paths) => ({ paths })),
)("changing title or target shape cannot bypass a cancelled problem: %j", async ({ paths }) => {
  const original = await terminalWork();
  const plan = reserve(),
    result = await execute(plan.taskId, { tasks: [proposedWork(paths)] });
  expect(result.status).toBe("succeeded");
  expect(workRows()).toEqual([original]);
  expect(runRow(plan.taskId).planResult).toMatchObject({
    reason: "suppressed_work",
    createdTaskIds: [],
    suppressed: [{ blockedByTaskIds: [original.id] }],
  });
  expect(goalStore.findById(goalId).nextCheckAt).not.toBeNull();
  expect(reserve()).toBeNull();
});

test("Unicode-equivalent paths are suppressed but similar sibling names are allowed", async () => {
  const original = await terminalWork("cancelled", ["src/café"]);
  const plan = reserve();
  await execute(plan.taskId, {
    tasks: [proposedWork(["src/cafe\u0301/new.ts"]), proposedWork(["src/café-other/new.ts"])],
  });
  expect(workRows()).toHaveLength(2);
  expect(workRows().find((task) => task.id !== original.id)?.plannedWork?.paths).toEqual([
    "src/café-other/new.ts",
  ]);
});

test("source changes and goal edits do not release a cancelled problem", async () => {
  const original = await terminalWork();
  writeFileSync(join(source, "src/main.ts"), "export const answer = 43;\n");
  git("add", "--all");
  git("commit", "--quiet", "-m", "another change");
  goalStore.change(goalId, "edit-problem", 1, {
    definition: { ...definition, description: "A different description" },
  });
  const plan = reserve();
  await execute(plan.taskId);
  expect(workRows()).toEqual([original]);
  expect(runRow(plan.taskId).planResult?.reason).toBe("suppressed_work");
});

test("server suppression includes cancelled work older than the prompt's recent history", async () => {
  const original = await terminalWork();
  for (let index = 0; index < 25; index++)
    database.db
      .insert(tasks)
      .values({
        id: randomUUID(),
        projectId,
        goalId,
        goalVersion: 1,
        instruction: `Historical ${index}`,
        requestKey: `history-${index}`,
        status: "succeeded",
        createdAt: new Date(Date.now() + index + 1),
      })
      .run();
  const plan = reserve(),
    context = readPlanningContext(database.db, plan.taskId)!;
  expect(context.history.some((task) => task.id === original.id)).toBe(false);
  expect(context.suppressedWork).toEqual([expect.objectContaining({ taskId: original.id })]);
  await execute(plan.taskId);
  expect(runRow(plan.taskId).planResult?.createdTaskIds).toEqual([]);
  expect(workRows().filter((task) => task.status === "cancelled")).toHaveLength(1);
});

test("the prompt may omit held problems but the server still enforces every one", async () => {
  const original = await terminalWork();
  for (let index = 0; index < 20; index++) {
    const id = randomUUID();
    database.db
      .insert(tasks)
      .values({
        ...original,
        id,
        requestKey: id,
        createdAt: new Date(original.createdAt.getTime() - index - 1),
        plannedWork: {
          ...original.plannedWork!,
          paths: [`src/older-${index}.ts`],
        },
      })
      .run();
  }
  const plan = reserve(),
    context = readPlanningContext(database.db, plan.taskId)!;
  expect(context.suppressedWork).toHaveLength(20);
  expect(context.suppressedWorkCount).toBe(21);
  expect(context.suppressedWork.some((item) => item.taskId === original.id)).toBe(false);
  await execute(plan.taskId);
  expect(runRow(plan.taskId).planResult).toMatchObject({
    createdTaskIds: [],
    suppressed: [{ blockedByTaskIds: [original.id] }],
  });
});

test("a recovery accepted after planning began prevents creating otherwise unrelated work", async () => {
  const original = await terminalWork("failed"),
    prior = runRow(original.id),
    plan = reserve();
  const outcome = await execute(
    plan.taskId,
    { tasks: [proposedWork(["tests/main.test.ts"])] },
    () => {
      database.client
        .prepare(
          "INSERT INTO recovery_requests (id,task_id,run_id,request_key,action,status,created_at) VALUES ('late',?,?,'late','reconcile','pending',?)",
        )
        .run(original.id, prior.id, Date.now());
    },
  );
  expect(outcome).toMatchObject({
    status: "blocked",
    errorCode: "work_unresolved",
  });
  expect(workRows()).toEqual([original]);
  expect(runRow(plan.taskId).planResult?.status).toBe("rejected");
});

test("three consecutive suppressed proposals stop a pointless planning loop", async () => {
  await terminalWork();
  for (let index = 0; index < 3; index++) {
    database.db.update(goals).set({ nextCheckAt: null }).where(eq(goals.id, goalId)).run();
    const plan = reserve(),
      outcome = await execute(plan.taskId);
    expect(outcome.status).toBe(index === 2 ? "blocked" : "succeeded");
    if (index === 2)
      expect(runRow(plan.taskId).planResult).toMatchObject({
        reason: "planning_no_progress",
        suppressed: [{ totalBlockingTasks: 1 }],
      });
  }
  expect(reserve()).toBeNull();
  expect(workRows()).toHaveLength(1);
});

test("unconfirmed terminal work holds all planning instead of permitting unrelated calls", async () => {
  const original = await terminalWork("failed");
  database.db
    .update(runs)
    .set({ terminationConfirmedAt: null })
    .where(eq(runs.taskId, original.id))
    .run();
  expect(reserve()).toBeNull();
  expect(readPlanningWork(database.db, goalId).unresolved).toBe(true);
  expect(workRows()).toEqual([original]);
});

test("a pending recovery keeps planning held until the recovery is resolved", async () => {
  const original = await terminalWork("failed"),
    prior = runRow(original.id);
  database.client
    .prepare(
      "INSERT INTO recovery_requests (id,task_id,run_id,request_key,action,status,created_at) VALUES ('pending',?,?,'pending','reconcile','pending',?)",
    )
    .run(original.id, prior.id, Date.now());
  expect(reserve()).toBeNull();
  database.client.exec("UPDATE recovery_requests SET status = 'completed' WHERE id = 'pending'");
  expect(reserve().goalId).toBe(goalId);
});

test("scope exclusion without an attempt can be planned again after expansion while the old task remains cancelled", async () => {
  await execute(reserve().taskId);
  const original = workRows()[0]!;
  goalStore.change(goalId, "narrow", 1, {
    definition: { ...definition, allowedPaths: ["tests"] },
  });
  goalStore.change(goalId, "expand", 2, { definition });
  const plan = reserve();
  await execute(plan.taskId);
  expect(workRows()).toHaveLength(2);
  expect(workRows().find((task) => task.id === original.id)).toMatchObject({
    status: "cancelled",
    cancelRequestedAt: null,
    goalReview: { decision: "excluded" },
  });
  expect(runRow(plan.taskId).planResult?.createdTaskIds).toHaveLength(1);
});

test("scope exclusion after a failed attempt cannot reset task limits through a new plan", async () => {
  const original = await terminalWork("failed");
  goalStore.change(goalId, "narrow-failed", 1, {
    definition: { ...definition, allowedPaths: ["tests"] },
  });
  goalStore.change(goalId, "expand-failed", 2, { definition });
  const plan = reserve();
  await execute(plan.taskId);
  expect(workRows()).toHaveLength(1);
  expect(workRows()[0]).toMatchObject({
    status: "cancelled",
    retryState: original.retryState,
  });
  expect(runRow(plan.taskId).planResult?.reason).toBe("suppressed_work");
});

test("a successful source change cannot hide a malformed legacy work scope", async () => {
  const original = await terminalWork();
  database.db
    .update(tasks)
    .set({ plannedWork: { ...original.plannedWork!, paths: [] } })
    .where(eq(tasks.id, original.id))
    .run();
  expect(reserve()).toBeNull();
});

test("suppressed and unrelated proposals commit together, or leave the saved proposal recoverable", async () => {
  const original = await terminalWork();
  const plan = reserve();
  database.client.exec(
    "CREATE TRIGGER fail_unrelated_work BEFORE INSERT ON tasks WHEN NEW.planned_work IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected'); END",
  );
  await expect(
    execute(plan.taskId, {
      tasks: [proposedWork(["src/main.ts"]), proposedWork(["tests/main.test.ts"])],
    }),
  ).rejects.toThrow("injected");
  expect(workRows()).toEqual([original]);
  expect(runRow(plan.taskId).planResult?.status).toBe("proposed");
  database.client.exec("DROP TRIGGER fail_unrelated_work");
  const recovery = createDrizzleRecoveryStore(database.db);
  const request = recovery.request(
    {
      taskId: plan.taskId,
      runId: runRow(plan.taskId).id,
      requestKey: "recover-suppression",
      action: "reconcile",
      providerGateVersion: null,
    },
    null,
    true,
  ).request;
  expect(await verifyPreparedResult(database.db, runRow(plan.taskId).id)).toBe(true);
  recovery.complete(request.id, new Date(), true);
  recovery.complete(request.id, new Date(), true);
  expect(workRows()).toHaveLength(2);
  expect(runRow(plan.taskId).planResult).toMatchObject({
    status: "applied",
    reason: "work_with_suppression",
    suppressed: [{ blockedByTaskIds: [original.id] }],
  });
});

test("planning respects project budgets without allocating a Run or resetting a failed cycle", async () => {
  createProjectBudgetStore(database.db).change(projectId, 0, {
    windowMs: 600000,
    maxCalls: 1,
    maxRunMs: 60000,
  });
  const plan = reserve();
  await execute(plan.taskId, { outcome: "wait", tasks: [] });
  expect(planner.reserveNext(["example"], new Date(Date.now() + 60001))).toBeNull();
  expect(database.db.select().from(runs).all()).toHaveLength(1);
});

test("renamed proposals against the same unchanged code are suppressed and repeated non-progress is bounded", async () => {
  const first = reserve();
  await execute(first.taskId);
  // Stand in for the later development stage; this test checks planning identity, not code execution.
  database.db
    .update(tasks)
    .set({ status: "succeeded" })
    .where(eq(tasks.id, workRows()[0]!.id))
    .run();
  for (let n = 0; n < 3; n++) {
    database.db.update(goals).set({ nextCheckAt: null }).where(eq(goals.id, goalId)).run();
    const next = reserve();
    const outcome = await execute(next.taskId, {
      tasks: [
        {
          title: `Renamed ${n}`,
          instruction: "Different wording",
          acceptanceCriteria: "42",
          paths: ["src/main.ts"],
          evidence: ["Same code"],
        },
      ],
    });
    expect(outcome.status).toBe(n === 2 ? "blocked" : "succeeded");
    if (n === 2) expect(outcome.errorCode).toBe("planning_no_progress");
  }
  expect(workRows()).toHaveLength(1);
  expect(reserve()).toBeNull();
});
