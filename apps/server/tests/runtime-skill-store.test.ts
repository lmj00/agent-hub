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
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { migrationsDirectory, openDatabase } from "../src/db/connection.js";
import { projects, runs, steps, tasks } from "../src/db/schema.js";
import { createDrizzleRunStore } from "../src/modules/execution/drizzle-run-store.js";
import { createDrizzleRecoveryStore } from "../src/modules/execution/drizzle-recovery-store.js";
import { createRecoveryProcessor } from "../src/modules/execution/recover-task.js";
import { acquireExecutionOwner } from "../src/modules/execution/execution-owner.js";
import {
  loadRuntimeSkill,
  type RuntimeSkillContext,
  type RuntimeSkillRole,
} from "../src/modules/execution/runtime-skills.js";
import { runTask } from "../src/modules/execution/run-task.js";
import { parseAnalysisWorkflow } from "../src/modules/execution/analysis-workflow.js";
import { createProjectBudgetStore } from "../src/modules/budgets/project-budget-store.js";

let directory: string, path: string, taskId: string, projectId: string;
let database: ReturnType<typeof openDatabase>,
  store: ReturnType<typeof createDrizzleRunStore>;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "hub-skill-store-"));
  path = join(directory, "hub.sqlite");
  database = openDatabase(path);
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
  database.db
    .insert(tasks)
    .values({
      id: taskId,
      projectId,
      instruction: "Inspect fixture",
      requestKey: taskId,
      createdAt: new Date(),
    })
    .run();
  store = createDrizzleRunStore(database.db);
});
afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});
const context = (
  role: RuntimeSkillRole = "analyst",
  sequence = 1,
): RuntimeSkillContext => ({
  sequence,
  selection: loadRuntimeSkill(role).selection,
});
function record(
  runId: string,
  type: "selected" | "loaded",
  selected = context(),
) {
  store.record(runId, {
    kind: `skill.${type}`,
    runtimeSkill: { type, ...selected },
  });
}
const success = () => ({
  status: "succeeded" as const,
  result: "Report",
  errorCode: null,
  usage: null,
  terminationConfirmedAt: new Date(),
});

test("claim snapshots the adapter capability and persists selected and loaded separately across reopen", async () => {
  const outcome = await runTask(
    {
      taskId,
      model: "fixture",
      workspace: directory,
      timeoutMs: 1000,
      signal: new AbortController().signal,
    },
    store,
    {
      runtimeSkillVersion: 1,
      async analyze(request, onEvent) {
        expect(request).toMatchObject({
          runtimeSkillVersion: 1,
          stepSequence: 1,
        });
        const selected = context();
        await onEvent({
          kind: "skill.selected",
          runtimeSkill: { type: "selected", ...selected },
        });
        expect(database.db.select().from(steps).get()).toMatchObject({
          runtimeSkill: selected.selection,
          runtimeSkillSelectedAt: expect.any(Date),
          runtimeSkillLoadedAt: null,
        });
        await onEvent({
          kind: "skill.loaded",
          runtimeSkill: { type: "loaded", ...selected },
        });
        return { output: "Report", usage: null };
      },
      confirmTermination: async () => new Date(),
    },
  );
  expect(outcome.status).toBe("succeeded");
  database.close();
  database = openDatabase(path);
  expect(database.db.select().from(runs).get()?.runtimeSkillVersion).toBe(1);
  expect(database.db.select().from(steps).get()).toMatchObject({
    runtimeSkill: context().selection,
    runtimeSkillSelectedAt: expect.any(Date),
    runtimeSkillLoadedAt: expect.any(Date),
  });
});

test("queue claims pin the new policy; legacy claims retain null metadata", () => {
  expect(store.claimNext("fixture", ["fixture"], 1)).toMatchObject({
    kind: "claimed",
    run: { runtimeSkillVersion: 1 },
  });
  const run = database.db.select().from(runs).get()!;
  store.finish(run.id, {
    ...success(),
    status: "failed",
    result: null,
    errorCode: "provider_error",
  });
  const next = randomUUID();
  database.db
    .insert(tasks)
    .values({
      id: next,
      projectId,
      instruction: "Legacy",
      requestKey: next,
      createdAt: new Date(),
    })
    .run();
  const legacy = store.claim(next, "fixture");
  expect(legacy.runtimeSkillVersion).toBeUndefined();
  expect(
    database.db.select().from(runs).where(eq(runs.id, legacy.id)).get()
      ?.runtimeSkillVersion,
  ).toBeNull();
  expect(() => record(legacy.id, "selected")).toThrow("unsupported_settings");
});

test.each(["unselected", "digest", "sequence", "role", "bytes", "duplicate"])(
  "refuses %s load evidence without altering the current selection",
  (mode) => {
    const run = store.claim(taskId, "fixture", 1);
    if (mode !== "unselected") record(run.id, "selected");
    const selected = context();
    if (mode === "digest") selected.selection.digest = "a".repeat(64);
    if (mode === "sequence") selected.sequence = 2;
    if (mode === "role") selected.selection = context("reviewer").selection;
    if (mode === "bytes") selected.selection.bytes++;
    if (mode === "duplicate") record(run.id, "loaded");
    const before = database.db.select().from(steps).get();
    expect(() => record(run.id, "loaded", selected)).toThrow(
      "unsupported_settings",
    );
    expect(database.db.select().from(steps).get()).toEqual(before);
  },
);

test.each(["cancel", "stopped", "other-run", "other-owner"])(
  "refuses load evidence after %s",
  (mode) => {
    const run = store.claim(taskId, "fixture", 1);
    record(run.id, "selected");
    if (mode === "cancel")
      database.db
        .update(tasks)
        .set({ cancelRequestedAt: new Date() })
        .where(eq(tasks.id, taskId))
        .run();
    if (mode === "stopped") store.requestStop(run.id, "server_shutdown");
    if (mode === "other-owner") acquireExecutionOwner(database.db);
    expect(() =>
      record(mode === "other-run" ? randomUUID() : run.id, "loaded"),
    ).toThrow();
    expect(
      database.db.select().from(steps).get()?.runtimeSkillLoadedAt,
    ).toBeNull();
  },
);

test("plain skill log lines cannot satisfy the success requirement", () => {
  const run = store.claim(taskId, "fixture", 1);
  store.record(run.id, { kind: "skill.selected" });
  store.record(run.id, { kind: "skill.loaded" });
  expect(store.finish(run.id, success())).toMatchObject({
    status: "blocked",
    result: null,
    errorCode: "unsupported_settings",
  });
  expect(
    database.db.select().from(steps).get()?.runtimeSkillLoadedAt,
  ).toBeNull();
});

test("each next Step requires a new load and its budget reservation before selection", () => {
  createProjectBudgetStore(database.db).change(projectId, 0, {
    windowMs: 3600000,
    maxCalls: 1,
    maxRunMs: 60000,
  });
  store = createDrizzleRunStore(database.db, undefined, {
    analysisWorkflow: parseAnalysisWorkflow({}),
  });
  const run = store.claim(taskId, "fixture", 1);
  store.record(run.id, {
    kind: "step.started",
    step: { type: "start", sequence: 1 },
  });
  const complete = {
    type: "complete" as const,
    sequence: 1,
    assessment: {
      report: "Partial",
      evidence: ["fixture"],
      unresolved: ["Next"],
      complete: false,
      next: {
        purpose: "Next",
        effort: "medium" as const,
        reason: "More evidence",
      },
    },
    usage: null,
  };
  expect(() =>
    store.record(run.id, { kind: "step.completed", step: complete }),
  ).toThrow("invalid_plan");
  record(run.id, "selected");
  record(run.id, "loaded");
  store.record(run.id, { kind: "step.completed", step: complete });
  expect(() =>
    store.record(run.id, {
      kind: "step.started",
      step: { type: "start", sequence: 2 },
    }),
  ).toThrow("budget_limit");
  expect(() => record(run.id, "selected", context("analyst", 2))).toThrow(
    "unsupported_settings",
  );
  expect(database.db.select().from(steps).all()).toHaveLength(1);
});

test.each([false, true])(
  "recovery permits no-call proof only before a durable load: loaded=%s",
  async (loaded) => {
    const run = store.claim(taskId, "fixture", 1);
    record(run.id, "selected");
    if (loaded) record(run.id, "loaded");
    store.finish(run.id, {
      status: "interrupted",
      result: null,
      errorCode: "server_shutdown",
      usage: null,
    });
    const recovery = createDrizzleRecoveryStore(database.db);
    const accepted = recovery.request(
      {
        taskId,
        runId: run.id,
        action: "resume",
        requestKey: randomUUID(),
        providerGateVersion: null,
      },
      null,
      true,
    );
    const confirm = vi.fn(async () => new Date());
    await createRecoveryProcessor(recovery, {
      confirm,
      cleanup: async () => {},
    }).process(accepted.request.id);
    expect(confirm).not.toHaveBeenCalled();
    expect(recovery.findById(accepted.request.id)).toMatchObject(
      loaded
        ? { status: "rejected", errorCode: "TERMINATION_UNCONFIRMED" }
        : { status: "completed", resultStatus: "queued" },
    );
  },
);

test("migration preserves populated Run/Step/event history with unknown legacy skill metadata", () => {
  database.close();
  const folder = join(directory, "old-migrations");
  cpSync(migrationsDirectory, folder, { recursive: true });
  const journalPath = join(folder, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter(
    (entry: { idx: number }) => entry.idx < 27,
  );
  writeFileSync(journalPath, JSON.stringify(journal));
  const legacyPath = join(directory, "legacy.sqlite");
  const legacy = openDatabase(legacyPath, folder);
  legacy.client.exec(
    "INSERT INTO projects VALUES ('p','Fixture','fixture',1); INSERT INTO tasks(id,project_id,instruction,request_key,created_at) VALUES ('t','p','Inspect','t',1); INSERT INTO runs(id,task_id,instance_id,status,model,effort,started_at,last_activity_at) VALUES ('r','t','old','running','fixture','medium',1,1); INSERT INTO steps(id,run_id,sequence,status,started_at) VALUES ('s','r',1,'running',1); INSERT INTO events(id,run_id,sequence,kind,created_at) VALUES ('e','r',1,'run.started',1);",
  );
  legacy.close();
  database = openDatabase(legacyPath);
  expect(database.db.select().from(runs).get()).toMatchObject({
    id: "r",
    runtimeSkillVersion: null,
  });
  expect(database.db.select().from(steps).get()).toMatchObject({
    id: "s",
    runtimeSkill: null,
    runtimeSkillSelectedAt: null,
    runtimeSkillLoadedAt: null,
  });
  expect(database.client.prepare("SELECT id FROM events").all()).toEqual([
    { id: "e" },
  ]);
  expect(database.client.pragma("foreign_key_check")).toEqual([]);
  expect(() =>
    database.client.exec("UPDATE runs SET runtime_skill_version=2"),
  ).toThrow();
});

test("recovery rechecks a no-call observation before committing termination proof", () => {
  const run = store.claim(taskId, "fixture", 1);
  record(run.id, "selected");
  const recovery = createDrizzleRecoveryStore(database.db);
  const accepted = recovery.request(
    {
      taskId,
      runId: run.id,
      action: "reconcile",
      requestKey: randomUUID(),
      providerGateVersion: null,
    },
    null,
    true,
  );
  expect(
    recovery.candidate(accepted.request.id)?.run?.runtimeSkillNotStarted,
  ).toBe(true);
  record(run.id, "loaded");
  recovery.complete(accepted.request.id, new Date(), false, []);
  expect(recovery.findById(accepted.request.id)).toMatchObject({
    status: "rejected",
    errorCode: "TERMINATION_UNCONFIRMED",
  });
  expect(
    database.db.select().from(runs).get()?.terminationConfirmedAt,
  ).toBeNull();
});
