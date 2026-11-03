import { randomUUID } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  parseResponse,
  projectBudgetSchema,
  type GoalDefinition,
  type PeriodBudgetPolicy,
} from "@agent-hub/contracts";
import { buildApp } from "../src/app.js";
import { migrationsDirectory, openDatabase } from "../src/db/connection.js";
import {
  budgetPeriods,
  budgetReservations,
  projects,
  runs,
  tasks,
} from "../src/db/schema.js";
import { createProjectBudgetStore } from "../src/modules/budgets/project-budget-store.js";
import { createDrizzleGoalStore } from "../src/modules/goals/drizzle-goal-store.js";
import { createDrizzleRunStore } from "../src/modules/execution/drizzle-run-store.js";
import { createDrizzleRecoveryStore } from "../src/modules/execution/drizzle-recovery-store.js";
import {
  createAnalysisWorkflow,
  parseAnalysisWorkflow,
} from "../src/modules/execution/analysis-workflow.js";
import { runClaimedTask, runTask } from "../src/modules/execution/run-task.js";
import { defaultRetryPolicy } from "../src/modules/execution/retry-policy.js";
import { defaultCapacityPolicy } from "../src/modules/execution/capacity-policy.js";
import { createCapacityRecovery } from "../src/modules/execution/capacity-recovery.js";
import { acquireExecutionOwner } from "../src/modules/execution/execution-owner.js";

let directory: string,
  path: string,
  database: ReturnType<typeof openDatabase>,
  projectId: string;
let store: ReturnType<typeof createDrizzleRunStore>;
const policy: PeriodBudgetPolicy = {
  windowMs: 600000,
  maxCalls: 2,
  maxRunMs: 60000,
};
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
  directory = mkdtempSync(join(tmpdir(), "hub-budgets-"));
  path = join(directory, "hub.sqlite");
  database = openDatabase(path);
  store = createDrizzleRunStore(database.db, undefined, {
    automaticRecovery: defaultRetryPolicy,
  });
  projectId = project();
});
afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});
function project() {
  const id = randomUUID();
  database.db
    .insert(projects)
    .values({
      id,
      name: "Example",
      workspaceKey: "example",
      createdAt: new Date(),
    })
    .run();
  return id;
}
function configure(value = policy, id = projectId) {
  const budgets = createProjectBudgetStore(database.db);
  budgets.change(id, budgets.view(id).version, value);
}
function goal(budget = policy, id = projectId) {
  const definition: GoalDefinition = {
    description: "Improve example",
    completionCriteria: "Verified",
    kind: "finite",
    priority: 50,
    allowedPaths: ["."],
    excludedPaths: [".git"],
    checkIntervalMs: 60000,
    budget,
  };
  return createDrizzleGoalStore(database.db).register(
    id,
    randomUUID(),
    definition,
  ).goal;
}
function task(linked?: { id: string; version: number }, project = projectId) {
  const id = randomUUID();
  database.db
    .insert(tasks)
    .values({
      id,
      projectId: project,
      goalId: linked?.id ?? null,
      goalVersion: linked?.version ?? null,
      requestKey: id,
      instruction: "Read example",
      createdAt: new Date(),
    })
    .run();
  vi.setSystemTime(Date.now() + 1);
  return id;
}
const taskRow = (id: string) =>
  database.db.select().from(tasks).where(eq(tasks.id, id)).get()!;
const summary = () => createProjectBudgetStore(database.db).view(projectId);
function finish(
  id: string,
  errorCode: string | null = null,
  proof = true,
  elapsed = 100,
) {
  vi.setSystemTime(Date.now() + elapsed);
  return store.finish(id, {
    status:
      errorCode === "capacity"
        ? "waiting_capacity"
        : errorCode
          ? "interrupted"
          : "succeeded",
    errorCode,
    result: errorCode ? null : "Done",
    usage: null,
    terminationConfirmedAt: proof ? new Date() : null,
  });
}

test("goal and project limits both apply across tasks, while another project can progress", () => {
  configure();
  const firstGoal = goal({ ...policy, maxCalls: 1 }),
    secondGoal = goal();
  finish(store.claim(task(firstGoal), "fixture").id);
  const blockedGoalTask = task(firstGoal),
    second = task(secondGoal);
  expect(store.claimNext("fixture", ["example"])).toMatchObject({
    kind: "claimed",
    run: { taskId: second },
  });
  finish(store.listByTask(second)[0]!.id);
  expect(taskRow(blockedGoalTask)).toMatchObject({
    status: "waiting_capacity",
    budgetWait: { scope: "goal", reason: "call_limit" },
    retryState: { retries: 0 },
  });
  expect(store.listByTask(blockedGoalTask)).toEqual([]);
  const blockedManual = task(),
    other = task(undefined, project());
  expect(store.claimNext("fixture", ["example"])).toMatchObject({
    kind: "claimed",
    run: { taskId: other },
  });
  expect(taskRow(blockedManual)).toMatchObject({
    status: "waiting_capacity",
    budgetWait: { scope: "project", reason: "call_limit" },
  });
  expect(summary().accounts[0]!.period).toMatchObject({
    calls: 2,
    chargedRunMs: 200,
    reservedRunMs: 0,
  });
  expect(store.getProviderGate().blocked).toBe(false);
});

test("restart and policy edits preserve the old period, and each scope rolls over independently", () => {
  configure({ ...policy, maxCalls: 1 });
  const linked = goal({ ...policy, windowMs: 1200000, maxCalls: 1 });
  finish(store.claim(task(linked), "fixture").id);
  const projectEnd = summary().accounts[0]!.period!.endsAt,
    goalEnd = summary().accounts[1]!.period!.endsAt;
  configure({ ...policy, maxCalls: 3 });
  const updated = createDrizzleGoalStore(database.db).change(
    linked.id,
    "raise-policy",
    linked.version,
    {
      definition: { ...linked.definition, budget: { ...policy, maxCalls: 3 } },
    },
  );
  database.close();
  database = openDatabase(path);
  store = createDrizzleRunStore(database.db);
  const next = task(updated);
  expect(store.claimNext("fixture", ["example"])).toMatchObject({
    kind: "idle",
  });
  expect(taskRow(next).budgetWait).toMatchObject({
    scope: "goal",
    retryAt: goalEnd,
  });
  expect(summary().accounts[0]!.period!.policy.maxCalls).toBe(1);
  vi.setSystemTime(Date.parse(projectEnd) + 1);
  expect(store.claimNext("fixture", ["example"])).toEqual({
    kind: "idle",
    reason: "period_budget",
  });
  vi.setSystemTime(Date.parse(goalEnd) + 1);
  expect(store.claimNext("fixture", ["example"])).toMatchObject({
    kind: "claimed",
    run: { taskId: next },
  });
  expect(summary().accounts.map((a) => a.period!.policy.maxCalls)).toEqual([
    3, 3,
  ]);
  expect(database.db.select().from(budgetPeriods).all()).toHaveLength(4);
});

test("a failed claim transaction leaves no call reservation, run, retry consumption or partial period", () => {
  const id = task();
  database.client.exec(
    "CREATE TRIGGER reject_step BEFORE INSERT ON steps BEGIN SELECT RAISE(ABORT, 'injected'); END",
  );
  expect(() => store.claim(id, "fixture")).toThrow();
  expect(database.db.select().from(budgetPeriods).all()).toEqual([]);
  expect(database.db.select().from(budgetReservations).all()).toEqual([]);
  expect(store.listByTask(id)).toEqual([]);
  expect(taskRow(id)).toMatchObject({ status: "queued", retryState: null });
  database.client.exec("DROP TRIGGER reject_step");
  store.claim(id, "fixture");
  expect(summary().accounts[0]!.period?.calls).toBe(1);
});

test("the next AI call is refused after the previous report commits, without consuming another Step", async () => {
  configure({ ...policy, maxCalls: 1 });
  store = createDrizzleRunStore(database.db, undefined, {
    analysisWorkflow: parseAnalysisWorkflow({}),
    automaticRecovery: defaultRetryPolicy,
  });
  const id = task(),
    analyze = vi.fn(async () => ({
      output: JSON.stringify({
        report: "Partial finding",
        evidence: ["example.ts"],
        unresolved: ["Need verification"],
        complete: false,
        next: { purpose: "Verify", effort: "high", reason: "Compare" },
      }),
      usage: null,
    }));
  const result = await runTask(
    {
      taskId: id,
      workspace: directory,
      model: "fixture",
      timeoutMs: 10000,
      signal: new AbortController().signal,
    },
    store,
    createAnalysisWorkflow({
      analyze,
      confirmTermination: async () => new Date(),
    }),
  );
  expect(analyze).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    status: "waiting_capacity",
    errorCode: "budget_limit",
  });
  expect(store.findById(result.runId)?.steps).toMatchObject([
    {
      sequence: 1,
      status: "succeeded",
      assessment: { report: "Partial finding" },
    },
  ]);
  expect(summary().accounts[0]!.period?.calls).toBe(1);
  expect(store.getProviderGate().blocked).toBe(false);
  vi.setSystemTime(new Date(taskRow(id).budgetWait!.retryAt));
  const resumed = store.claimNext("fixture", ["example"]);
  expect(resumed).toMatchObject({ kind: "claimed", run: { taskId: id } });
  if (resumed.kind !== "claimed") throw new Error("Expected resumed run");
  expect(resumed.run.instruction).toContain("Partial finding");
  expect(resumed.run.instruction).toContain(result.runId);
  expect(resumed.run.instruction).toContain("untrusted recorded analysis");
  expect(store.listByTask(id)).toHaveLength(2);
  expect(taskRow(id).retryState?.retries).toBe(1);
});

test("next Step reservation and Step storage roll back together on a database failure", async () => {
  configure({ ...policy, maxCalls: 2 });
  store = createDrizzleRunStore(database.db, undefined, {
    analysisWorkflow: parseAnalysisWorkflow({}),
  });
  database.client.exec(
    "CREATE TRIGGER reject_second BEFORE INSERT ON steps WHEN NEW.sequence = 2 BEGIN SELECT RAISE(ABORT, 'injected'); END",
  );
  const analyze = vi.fn(async () => ({
    output: JSON.stringify({
      report: "Partial",
      evidence: [],
      unresolved: ["More"],
      complete: false,
      next: { purpose: "Check", effort: "medium", reason: "More" },
    }),
    usage: null,
  }));
  const result = await runTask(
    {
      taskId: task(),
      workspace: directory,
      model: "fixture",
      timeoutMs: 10000,
      signal: new AbortController().signal,
    },
    store,
    createAnalysisWorkflow({
      analyze,
      confirmTermination: async () => new Date(),
    }),
  );
  expect(result.status).toBe("interrupted");
  expect(analyze).toHaveBeenCalledTimes(1);
  expect(summary().accounts[0]!.period?.calls).toBe(1);
});

test("an absolute budget deadline includes time between claim and execution and prevents an expired start", async () => {
  configure({ ...policy, maxRunMs: 1000 });
  const id = task(),
    claimed = store.claim(id, "fixture");
  vi.setSystemTime(Date.now() + 1001);
  const analyze = vi.fn();
  const result = await runClaimedTask(
    claimed,
    {
      workspace: directory,
      model: "fixture",
      timeoutMs: 10000,
      signal: new AbortController().signal,
    },
    store,
    { analyze, confirmTermination: async () => new Date() },
  );
  expect(analyze).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    status: "waiting_capacity",
    errorCode: "budget_limit",
  });
  expect(store.findById(claimed.id)?.stopReason).toBe("budget_limit");
  expect(taskRow(id).budgetWait).toMatchObject({
    scope: "project",
    reason: "time_limit",
  });
});

test("the budget timer stops a running call and keeps its reservation until termination is confirmed", async () => {
  vi.useFakeTimers();
  configure({ ...policy, maxRunMs: 1000 });
  const id = task();
  const pending = runTask(
    {
      taskId: id,
      workspace: directory,
      model: "fixture",
      timeoutMs: 10000,
      signal: new AbortController().signal,
    },
    store,
    {
      analyze: async () => new Promise(() => {}),
      confirmTermination: async () => null,
    },
  );
  await vi.advanceTimersByTimeAsync(1000);
  const result = await pending;
  expect(result).toMatchObject({
    status: "interrupted",
    errorCode: "budget_limit",
    terminationConfirmedAt: null,
  });
  expect(summary().accounts[0]!.period).toMatchObject({
    chargedRunMs: 0,
    reservedRunMs: 1000,
  });
  vi.setSystemTime(Date.now() + policy.windowMs);
  expect(store.claimNext("fixture", ["example"])).toMatchObject({
    kind: "held",
    runId: result.runId,
  });
  const recovery = createDrizzleRecoveryStore(database.db);
  const request = recovery.request(
    {
      taskId: id,
      runId: result.runId,
      action: "reconcile",
      requestKey: "proof",
      providerGateVersion: null,
    },
    null,
    true,
  ).request;
  recovery.complete(request.id, new Date());
  expect(taskRow(id).status).toBe("waiting_capacity");
  expect(summary().accounts[0]!.period!.reservedRunMs).toBe(0);
  const charged = summary().accounts[0]!.period!.chargedRunMs;
  recovery.complete(request.id, new Date());
  expect(summary().accounts[0]!.period!.chargedRunMs).toBe(charged);
});

test("period end bounds execution even when call and time allowances remain", async () => {
  configure({ ...policy, maxRunMs: 600000 });
  finish(store.claim(task(), "fixture").id);
  const end = Date.parse(summary().accounts[0]!.period!.endsAt);
  vi.setSystemTime(end - 50);
  const claimed = store.claim(task(), "fixture");
  expect(claimed.budgetDeadlineAt).toBe(end);
  vi.setSystemTime(end + 1);
  const result = await runClaimedTask(
    claimed,
    {
      workspace: directory,
      model: "fixture",
      timeoutMs: 10000,
      signal: new AbortController().signal,
    },
    store,
    { analyze: vi.fn(), confirmTermination: async () => new Date() },
  );
  expect(result).toMatchObject({
    status: "waiting_capacity",
    errorCode: "budget_limit",
  });
  expect(taskRow(claimed.taskId).budgetWait?.reason).toBe("period_end");
});

test("confirmed termination refunds unused reserved time exactly once", () => {
  configure();
  const id = task(),
    run = store.claim(id, "fixture");
  expect(summary().accounts[0]!.period).toMatchObject({
    chargedRunMs: 0,
    reservedRunMs: 60000,
  });
  finish(run.id, "transient", false, 200);
  expect(summary().accounts[0]!.period!.reservedRunMs).toBe(60000);
  const recovery = createDrizzleRecoveryStore(database.db),
    proof = new Date();
  for (const key of ["first", "second"]) {
    const request = recovery.request(
      {
        taskId: id,
        runId: run.id,
        action: "reconcile",
        requestKey: key,
        providerGateVersion: null,
      },
      null,
      true,
    ).request;
    recovery.complete(request.id, proof);
  }
  expect(summary().accounts[0]!.period).toMatchObject({
    chargedRunMs: 200,
    reservedRunMs: 0,
    calls: 1,
  });
});

test("a manual resume cannot bypass quota, while a never-started waiting task remains cancellable", () => {
  configure({ ...policy, maxCalls: 1 });
  finish(store.claim(task(), "fixture").id);
  const id = task();
  store.claimNext("fixture", ["example"]);
  const recovery = createDrizzleRecoveryStore(database.db);
  expect(() =>
    recovery.request(
      {
        taskId: id,
        runId: null,
        action: "resume",
        requestKey: "resume",
        providerGateVersion: null,
      },
      null,
      true,
    ),
  ).toThrow("PERIOD_BUDGET_EXHAUSTED");
  expect(
    recovery.request(
      {
        taskId: id,
        runId: null,
        action: "cancel",
        requestKey: "cancel",
        providerGateVersion: null,
      },
      null,
      true,
    ).request.status,
  ).toBe("completed");
  expect(taskRow(id)).toMatchObject({ status: "cancelled", budgetWait: null });
  vi.setSystemTime(Date.now() + policy.windowMs);
  expect(store.claimNext("fixture", ["example"])).toEqual({ kind: "idle" });
});

test("a backwards wall clock cannot refund an unmeasurable run or extend its budget timer", async () => {
  vi.useFakeTimers();
  configure({ ...policy, maxRunMs: 1000 });
  const id = task(),
    claimed = store.claim(id, "fixture");
  vi.setSystemTime(Date.now() - 60000);
  const pending = runClaimedTask(
    claimed,
    {
      workspace: directory,
      model: "fixture",
      timeoutMs: 10000,
      signal: new AbortController().signal,
    },
    store,
    {
      analyze: async () => new Promise(() => {}),
      confirmTermination: async () => new Date(),
    },
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toMatchObject({
    status: "waiting_capacity",
    errorCode: "budget_limit",
  });
  expect(summary().accounts[0]!.period).toMatchObject({
    chargedRunMs: 1000,
    reservedRunMs: 0,
  });
});

test("a new period does not clear a paused goal or a provider block", () => {
  configure({ ...policy, maxCalls: 1 });
  const linked = goal(),
    id = task(linked);
  finish(store.claim(id, "fixture").id);
  const waiting = task(linked);
  store.claimNext("fixture", ["example"]);
  createDrizzleGoalStore(database.db).change(linked.id, "pause", 1, {
    action: "pause",
  });
  vi.setSystemTime(Date.now() + policy.windowMs);
  expect(store.claimNext("fixture", ["example"])).toEqual({ kind: "idle" });
  expect(store.listByTask(waiting)).toEqual([]);
  finish(store.claim(task(), "fixture").id, "capacity");
  vi.setSystemTime(Date.now() + policy.windowMs);
  expect(store.claimNext("fixture", ["example"])).toMatchObject({
    kind: "held",
    reason: "provider_capacity",
  });
});

test("a refreshed period cannot erase the Task retry and total-time limits", () => {
  configure({ ...policy, maxRunMs: 1000 });
  store = createDrizzleRunStore(database.db, undefined, {
    automaticRecovery: { ...defaultRetryPolicy, maxTotalRunMs: 1000 },
  });
  const id = task(),
    run = store.claim(id, "fixture");
  store.requestStop(run.id, "budget_limit");
  finish(run.id, "budget_limit", true, 1000);
  vi.setSystemTime(Date.now() + policy.windowMs);
  expect(store.claimNext("fixture", ["example"])).toEqual({ kind: "idle" });
  expect(taskRow(id)).toMatchObject({
    status: "blocked",
    budgetWait: null,
    retryState: { totalRunMs: 1000, reason: "task_time_limit" },
  });
  expect(store.listByTask(id)).toHaveLength(1);
});

test("a reserved provider probe cannot spend another call before the project period renews", () => {
  configure({ ...policy, maxCalls: 1 });
  const owner = acquireExecutionOwner(database.db);
  try {
    store = createDrizzleRunStore(database.db, owner.token, {
      automaticRecovery: defaultRetryPolicy,
      capacityRecovery: {
        ...defaultCapacityPolicy,
        initialDelayMs: 1000,
        maxDelayMs: 1000,
        jitterRatio: 0,
      },
    });
    const id = task();
    finish(store.claim(id, "fixture").id, "capacity");
    const recovery = createDrizzleRecoveryStore(database.db, owner.token);
    const capacity = createCapacityRecovery({
      db: database.db,
      ownerToken: owner.token,
      workspaceKeys: ["example"],
      policy: {
        ...defaultCapacityPolicy,
        initialDelayMs: 1000,
        maxDelayMs: 1000,
        jitterRatio: 0,
      },
      retryPolicy: defaultRetryPolicy,
      random: () => 0,
    });
    capacity.tick();
    vi.setSystemTime(Date.now() + 1000);
    capacity.tick();
    expect(store.getProviderGate().probeTaskId).toBe(id);
    expect(store.claimNext("fixture", ["example"])).toMatchObject({
      kind: "idle",
      reason: "period_budget",
    });
    expect(store.getProviderGate().capacityState!.checks).toBe(0);
    expect(store.listByTask(id)).toHaveLength(1);
    expect(() =>
      recovery.request(
        {
          taskId: id,
          runId: store.listByTask(id)[0]!.id,
          action: "resume",
          requestKey: "force",
          providerGateVersion: store.getProviderGate().version,
        },
        null,
        true,
      ),
    ).toThrow("PERIOD_BUDGET_EXHAUSTED");
    vi.setSystemTime(new Date(taskRow(id).budgetWait!.retryAt));
    expect(store.claimNext("fixture", ["example"])).toMatchObject({
      kind: "claimed",
      run: { taskId: id, providerCheck: true },
    });
    expect(store.getProviderGate().capacityState!.checks).toBe(1);
  } finally {
    owner.release();
  }
});

test("budget HTTP reads do not start a period and edits validate policy and version without resetting usage", async () => {
  const app = buildApp({ databasePath: path }),
    url = `/projects/${projectId}/budget`;
  try {
    const first = await app.inject({ method: "GET", url });
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(parseResponse(projectBudgetSchema, first.json())).toMatchObject({
      version: 0,
      accounts: [{ period: null }],
    });
    expect(
      (
        await app.inject({
          method: "PUT",
          url,
          payload: {
            expectedVersion: 0,
            policy: { ...policy, maxRunMs: 600001 },
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url,
          payload: { expectedVersion: 0, policy: { ...policy, maxCalls: 1 } },
        })
      ).statusCode,
    ).toBe(200);
    finish(store.claim(task(), "fixture").id);
    const changed = await app.inject({
      method: "PUT",
      url,
      payload: { expectedVersion: 1, policy },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({
      version: 2,
      policy,
      accounts: [{ period: { calls: 1, policy: { maxCalls: 1 } } }],
    });
    expect(
      (
        await app.inject({
          method: "PUT",
          url,
          payload: { expectedVersion: 1, policy },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/projects/${randomUUID()}/budget`,
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await app.close();
  }
});

test("upgrading preserves existing tasks and execution history without inventing past budget usage", () => {
  const folder = join(directory, "old-migrations");
  cpSync(migrationsDirectory, folder, { recursive: true });
  const file = join(folder, "meta/_journal.json"),
    journal = JSON.parse(readFileSync(file, "utf8"));
  journal.entries = journal.entries.filter(
    (entry: { idx: number }) => entry.idx < 17,
  );
  writeFileSync(file, JSON.stringify(journal));
  const oldPath = join(directory, "old.sqlite"),
    old = openDatabase(oldPath, folder);
  old.client.exec(
    "INSERT INTO projects VALUES ('p','Existing','example',1); INSERT INTO tasks (id,project_id,instruction,request_key,created_at) VALUES ('t','p','Keep','key',1); INSERT INTO runs (id,task_id,instance_id,status,model,effort,started_at,last_activity_at) VALUES ('r','t','i','failed','fixture','medium',1,1)",
  );
  old.close();
  const upgraded = openDatabase(oldPath);
  try {
    expect(upgraded.db.select().from(tasks).get()).toMatchObject({
      id: "t",
      budgetWait: null,
    });
    expect(upgraded.db.select().from(runs).get()?.id).toBe("r");
    expect(upgraded.db.select().from(budgetPeriods).all()).toEqual([]);
    expect(upgraded.client.pragma("foreign_key_check")).toEqual([]);
    expect(() => upgraded.checkReady()).not.toThrow();
  } finally {
    upgraded.close();
  }
});
