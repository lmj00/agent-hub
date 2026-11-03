import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { GoalDefinition, GoalPlan } from "@agent-hub/contracts";
import { openDatabase } from "../src/db/connection.js";
import {
  goals,
  planningCycles,
  projects,
  runs,
  tasks,
} from "../src/db/schema.js";
import { createDrizzleGoalStore } from "../src/modules/goals/drizzle-goal-store.js";
import {
  createPlanningStore,
  readPlanningContext,
} from "../src/modules/goals/planning-store.js";
import {
  createPreparedExecutor,
  cleanupPreparedRun,
  verifyPreparedResult,
} from "../src/modules/goals/prepared-executor.js";
import { preparedInputRoot } from "../src/modules/goals/prepared-workspace.js";
import { createDrizzleRunStore } from "../src/modules/execution/drizzle-run-store.js";
import { createDrizzleRecoveryStore } from "../src/modules/execution/drizzle-recovery-store.js";
import { createRecoveryProcessor } from "../src/modules/execution/recover-task.js";
import { runTask } from "../src/modules/execution/run-task.js";
import { parseAnalysisWorkflow } from "../src/modules/execution/analysis-workflow.js";
import { createProjectBudgetStore } from "../src/modules/budgets/project-budget-store.js";
import type {
  AnalysisExecutor,
  AnalysisRequest,
} from "../src/modules/execution/analysis.js";

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
let directory: string,
  source: string,
  root: string,
  projectId: string,
  goalId: string;
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
function proposal(
  request: AnalysisRequest,
  overrides: Partial<GoalPlan> = {},
): GoalPlan {
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
  expect(() => store.claim(work[0]!.id, "fixture")).toThrow(
    "DEVELOPMENT_EXECUTOR_UNAVAILABLE",
  );
  expect(database.db.select().from(runs).all()).toHaveLength(1);
  expect(reserve()).toBeNull();
});

test.each([
  "outside",
  "private",
  "overlap",
  "duplicate",
  "version",
  "digest",
  "contradiction",
])(
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
  expect(
    await execute(plan.taskId, { outcome: "complete", tasks: [] }),
  ).toMatchObject({ status: "blocked", errorCode: "verification_required" });
  expect(goalStore.findById(goalId).status).toBe("active");
  expect(workRows()).toEqual([]);
});

test("a wait decision reserves the next check and does not trigger an immediate planning loop", async () => {
  const plan = reserve();
  expect(
    (await execute(plan.taskId, { outcome: "wait", tasks: [] })).status,
  ).toBe("succeeded");
  const due = new Date(goalStore.findById(goalId).nextCheckAt!);
  expect(
    planner.reserveNext(["example"], new Date(due.getTime() - 1)),
  ).toBeNull();
  expect(planner.reserveNext(["example"], due)?.taskId).not.toBe(plan.taskId);
  expect(database.db.select().from(planningCycles).all()).toHaveLength(2);
});

test.each(["goal", "source"])(
  "a changed %s rejects a completed proposal without generating work",
  async (kind) => {
    const plan = reserve();
    const result = await execute(plan.taskId, {}, () => {
      if (kind === "goal")
        goalStore.change(goalId, "pause", 1, { action: "pause" });
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
    if (change === "cancel")
      expect(goalStore.findById(goalId).status).toBe("paused");
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
      .update(runs)
      .set({ execution: identity })
      .where(eq(runs.id, run.id))
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
    database.db.select().from(runs).where(eq(runs.id, invalid.runId)).get()
      ?.planResult?.status,
  ).toBe("rejected");
  expect(
    database.db.select().from(runs).where(eq(runs.id, result.runId)).get(),
  ).toMatchObject({ attempt: 2, planResult: { status: "applied" } });
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
  expect(reserve()).toBeNull();
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

test("planning respects project budgets without allocating a Run or resetting a failed cycle", async () => {
  createProjectBudgetStore(database.db).change(projectId, 0, {
    windowMs: 600000,
    maxCalls: 1,
    maxRunMs: 60000,
  });
  const plan = reserve();
  await execute(plan.taskId, { outcome: "wait", tasks: [] });
  expect(
    planner.reserveNext(["example"], new Date(Date.now() + 60001)),
  ).toBeNull();
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
    database.db
      .update(goals)
      .set({ nextCheckAt: null })
      .where(eq(goals.id, goalId))
      .run();
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
