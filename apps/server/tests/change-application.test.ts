import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
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
import { migrationsDirectory, openDatabase } from "../src/db/connection.js";
import {
  changeApplications,
  developmentRounds,
  executionOwner,
  goals,
  projects,
  runExecutions,
  runs,
  tasks,
} from "../src/db/schema.js";
import type {
  AnalysisExecutor,
  ExecutionIdentity,
} from "../src/modules/execution/analysis.js";
import { createDrizzleRunStore } from "../src/modules/execution/drizzle-run-store.js";
import { verificationConfigDigest } from "../src/modules/execution/verification-config.js";
import { createDevelopmentExecutor } from "../src/modules/goals/development-executor.js";
import {
  readDevelopmentRepository,
  readDevelopmentRounds,
} from "../src/modules/goals/development-journal.js";
import { developmentRoot } from "../src/modules/goals/development-workspace.js";
import { preparedInputRoot } from "../src/modules/goals/prepared-workspace.js";
import { createDrizzleGoalStore } from "../src/modules/goals/drizzle-goal-store.js";
import {
  applyChangeApplication,
  prepareChangeApplication,
  readChangeApplication,
} from "../src/modules/goals/change-application.js";
import { applicationCommit } from "../src/modules/goals/change-application-git.js";
import { prepareRecordedDevelopment } from "../src/modules/goals/recorded-development.js";
import { createDrizzleRecoveryStore } from "../src/modules/execution/drizzle-recovery-store.js";
import { createRecoveryProcessor } from "../src/modules/execution/recover-task.js";
import { createAutomaticRecovery } from "../src/modules/execution/automatic-recovery.js";
import { acquireExecutionOwner } from "../src/modules/execution/execution-owner.js";
import { defaultRetryPolicy } from "../src/modules/execution/retry-policy.js";

let directory: string,
  source: string,
  projectId: string,
  taskId: string,
  goalId: string;
let database: ReturnType<typeof openDatabase>,
  store: ReturnType<typeof createDrizzleRunStore>;
let run: ReturnType<typeof store.claim>;
const signal = () => new AbortController().signal;
const configuration = {
  image: "fixture:local",
  command: ["node", "tests/check.mjs"],
  timeoutMs: 10000,
};
const content = "export const answer = 42;\n";
function git(cwd: string, ...args: string[]) {
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
      cwd,
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
const repository = () =>
  readDevelopmentRepository(database.db, projectId)!.prepared!;
const head = () =>
  git(
    join(repository().directory, "git"),
    "rev-parse",
    "refs/heads/development",
  );
const prepared = () => prepareChangeApplication(database.db, run.id, signal());
const apply = () => applyChangeApplication(database.db, run.id, signal());
function reopen() {
  database.close();
  database = openDatabase(join(directory, "hub.sqlite"));
}

beforeEach(() => {
  directory = realpathSync(
    mkdtempSync(join(tmpdir(), "hub-change-application-")),
  );
  source = join(directory, "source");
  mkdirSync(join(source, "src"), { recursive: true });
  writeFileSync(join(source, "src/main.mjs"), "export const answer = 1;\n");
  git(source, "init", "--quiet", "--template=");
  git(source, "add", "--all");
  git(source, "commit", "--quiet", "-m", "fixture");
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
    completionCriteria: "Correct result",
    kind: "finite",
    priority: 50,
    allowedPaths: ["src", "tests"],
    excludedPaths: [],
    checkIntervalMs: 60000,
    budget: { windowMs: 3600000, maxCalls: 20, maxRunMs: 1800000 },
  }).goal;
  goalId = goal.id;
  database.db
    .insert(tasks)
    .values({
      id: taskId,
      projectId,
      goalId,
      goalVersion: goal.version,
      instruction: "Fix calculation",
      requestKey: taskId,
      createdAt: new Date(),
    })
    .run();
  store = createDrizzleRunStore(database.db);
  run = store.claim(taskId, "fixture");
  // Only the model and test-container boundary is synthetic here; Git, SQLite
  // and journals run. The fixture pauses after review to exercise each boundary.
  database.db
    .update(tasks)
    .set({
      plannedWork: {
        planningTaskId: randomUUID(),
        problemKey: "calculation",
        sourceRevision: git(source, "rev-parse", "HEAD"),
        sourceDigest: "a".repeat(64),
        title: "Fix calculation",
        paths: ["src"],
        acceptanceCriteria: "Answer is 42",
        evidence: ["src/main.mjs"],
      },
    })
    .where(eq(tasks.id, taskId))
    .run();
});
afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

async function approvedRound() {
  const executor: AnalysisExecutor = {
    async analyze(request, onEvent) {
      const identity: ExecutionIdentity = {
        kind: "docker",
        containerId: randomUUID().replaceAll("-", "").repeat(2),
        token: randomUUID(),
        engineId: "fixture",
      };
      await onEvent({ kind: "execution.prepared", execution: identity });
      await onEvent({
        kind: "execution.terminated",
        executionTermination: { identity, confirmedAt: new Date() },
      });
      if (request.verification)
        return {
          output: "",
          usage: null,
          verification: {
            candidateDigest: request.verification.candidateDigest,
            inputDigest: request.development!.inputDigest,
            configuration,
            configurationDigest: verificationConfigDigest(configuration),
            execution: identity,
            imageId: `sha256:${"c".repeat(64)}`,
            status: "passed",
            exitCode: 0,
            oomKilled: false,
            elapsedMs: 1,
            output: "synthetic evidence",
          },
        };
      const assessment = {
        report: "Candidate inspected",
        evidence: ["src/main.mjs"],
        unresolved: [],
        complete: true,
        next: null,
      };
      return {
        output: JSON.stringify(assessment),
        usage: null,
        ...(request.development
          ? {
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
            }
          : {}),
      };
    },
    async confirmTermination() {
      return new Date();
    },
  };
  const development = createDevelopmentExecutor({
    db: database.db,
    analysis: executor,
    development: executor,
    config: {
      containerImage: "fixture:local",
      workspaces: new Map([["fixture", source]]),
      verification: new Map([["fixture", configuration]]),
    },
    repositoryRoot: developmentRoot(join(directory, "hub.sqlite")),
    inputRoot: preparedInputRoot(join(directory, "hub.sqlite")),
  });
  const reviewSaved = new Error("fixture interruption after durable review");
  await expect(development.analyze(
    {
      runId: run.id,
      instruction: "Fix calculation",
      workspace: source,
      model: "fixture",
      signal: signal(),
    },
    (event) => {
      store.record(run.id, event);
      if (event.development?.type === "review.complete") throw reviewSaved;
    },
  )).rejects.toBe(reviewSaved);
}

test("records the exact future commit before Git writes, then applies once across reopen without modifying the source", async () => {
  await approvedRound();
  const original = git(source, "rev-parse", "HEAD");
  const application = await prepared();
  expect(application).toMatchObject({
    status: "pending",
    appliedAt: null,
    baseRevision: original,
  });
  expect(head()).toBe(original);
  expect(() =>
    git(
      join(repository().directory, "git"),
      "cat-file",
      "-e",
      application.resultCommit,
    ),
  ).toThrow();
  expect(await prepared()).toEqual(application);
  const result = await apply();
  expect(result).toMatchObject({
    status: "applied",
    appliedAt: expect.any(Date),
    resultCommit: application.resultCommit,
  });
  expect(repository()).toMatchObject({
    head: result.resultCommit,
    headTree: result.tree,
    sourceRevision: original,
  });
  expect(
    git(
      join(repository().directory, "git"),
      "show",
      `${result.resultCommit}:src/main.mjs`,
    ),
  ).toBe(content.trim());
  expect(
    git(
      join(repository().directory, "git"),
      "rev-parse",
      `${result.resultCommit}^`,
    ),
  ).toBe(original);
  expect(git(source, "rev-parse", "HEAD")).toBe(original);
  expect(git(source, "status", "--porcelain")).toBe("");
  expect(readFileSync(join(source, "src/main.mjs"), "utf8")).toContain(
    "answer = 1",
  );
  reopen();
  expect(await apply()).toEqual(result);
  expect(await prepared()).toEqual(result);
  expect(database.db.select().from(changeApplications).all()).toHaveLength(1);
  expect(
    git(
      join(repository().directory, "git"),
      "rev-list",
      "--count",
      "refs/heads/development",
    ),
  ).toBe("2");
  expect(database.client.pragma("foreign_key_check")).toEqual([]);
});

test("an intent write failure leaves the branch and commit objects untouched", async () => {
  await approvedRound();
  const original = head();
  database.client.exec(
    "CREATE TRIGGER fail_intent BEFORE INSERT ON change_applications BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END",
  );
  await expect(prepared()).rejects.toThrow("injected storage failure");
  expect(head()).toBe(original);
  expect(readChangeApplication(database.db, run.id)).toBeUndefined();
});

test("the next Task prepares from the applied development commit while the original source stays unchanged", async () => {
  await approvedRound();
  const application = await prepared();
  await apply();
  store.finish(run.id, {
    status: "blocked",
    result: null,
    errorCode: "development_incomplete",
    usage: null,
    terminationConfirmedAt: new Date(),
  });
  const priorTask = database.db
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get()!;
  const nextTask = randomUUID();
  database.db
    .insert(tasks)
    .values({
      id: nextTask,
      projectId,
      goalId,
      goalVersion: 1,
      instruction: "Next improvement",
      requestKey: nextTask,
      createdAt: new Date(),
    })
    .run();
  const nextRun = store.claim(nextTask, "fixture");
  database.db
    .update(tasks)
    .set({
      plannedWork: {
        ...priorTask.plannedWork!,
        problemKey: "next-improvement",
      },
    })
    .where(eq(tasks.id, nextTask))
    .run();
  const next = await prepareRecordedDevelopment(
    database.db,
    {
      repositoryRoot: developmentRoot(join(directory, "hub.sqlite")),
      inputRoot: preparedInputRoot(join(directory, "hub.sqlite")),
      projectId,
      runId: nextRun.id,
      source,
      sequence: 1,
      scope: nextRun.scope!,
      writePaths: ["src"],
      signal: signal(),
    },
    (event) => store.record(nextRun.id, event),
  );
  expect(next.input.revision).toBe(application.resultCommit);
  expect(readFileSync(join(next.input.directory, "src/main.mjs"), "utf8")).toBe(
    content,
  );
  expect(
    readDevelopmentRounds(database.db, nextRun.id)[0]?.planningRevision,
  ).toBe(application.baseRevision);
  expect(git(source, "rev-parse", "HEAD")).toBe(application.baseRevision);
  expect(await apply()).toMatchObject({
    resultCommit: application.resultCommit,
    status: "applied",
  });
});

test("database constraints reject duplicate Task applications and invalid application phases", async () => {
  await approvedRound();
  const application = await prepared();
  expect(() =>
    database.db
      .insert(changeApplications)
      .values({ ...application, id: randomUUID() })
      .run(),
  ).toThrow();
  expect(() =>
    database.db
      .update(changeApplications)
      .set({ status: "applied", appliedAt: null })
      .run(),
  ).toThrow();
  expect(() =>
    database.db
      .update(changeApplications)
      .set({ targetRef: "refs/heads/main" })
      .run(),
  ).toThrow();
  expect(database.db.select().from(changeApplications).all()).toEqual([
    application,
  ]);
});

test("recovers the same commit when Git advanced but DB finalization rolled back", async () => {
  await approvedRound();
  const application = await prepared();
  database.client.exec(
    "CREATE TRIGGER fail_finalize BEFORE UPDATE ON change_applications BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END",
  );
  await expect(apply()).rejects.toThrow("injected storage failure");
  expect(head()).toBe(application.resultCommit);
  expect(repository().head).toBe(application.baseRevision);
  expect(readChangeApplication(database.db, run.id)).toEqual(application);
  reopen();
  database.client.exec("DROP TRIGGER fail_finalize");
  expect(await apply()).toMatchObject({
    status: "applied",
    resultCommit: application.resultCommit,
  });
  expect(repository().head).toBe(application.resultCommit);
  expect(
    git(
      join(repository().directory, "git"),
      "rev-list",
      "--count",
      "refs/heads/development",
    ),
  ).toBe("2");
});

function stop(kind: string) {
  if (kind === "cancel")
    database.db
      .update(tasks)
      .set({ cancelRequestedAt: new Date() })
      .where(eq(tasks.id, taskId))
      .run();
  if (kind === "pause")
    database.db
      .update(goals)
      .set({ status: "paused" })
      .where(eq(goals.id, goalId))
      .run();
  if (kind === "version")
    database.db
      .update(goals)
      .set({ version: 2 })
      .where(eq(goals.id, goalId))
      .run();
  if (kind === "stop") store.requestStop(run.id, "server_shutdown");
}
test.each(["cancel", "pause", "version", "stop"])(
  "%s before reservation prevents any application",
  async (kind) => {
    await approvedRound();
    const original = head();
    stop(kind);
    await expect(prepared()).rejects.toThrow("goal_changed");
    expect(head()).toBe(original);
    expect(readChangeApplication(database.db, run.id)).toBeUndefined();
  },
);
test.each(["cancel", "pause", "version", "stop"])(
  "%s after reservation preserves the authorized effect for reconciliation",
  async (kind) => {
    await approvedRound();
    const application = await prepared();
    stop(kind);
    reopen();
    expect(await apply()).toMatchObject({
      status: "applied",
      resultCommit: application.resultCommit,
    });
    expect(
      database.db.select().from(tasks).where(eq(tasks.id, taskId)).get()
        ?.status,
    ).toBe("running");
  },
);

test.each(["review", "verification", "termination", "skill"])(
  "missing or altered %s proof prevents reservation",
  async (kind) => {
    await approvedRound();
    const round = readDevelopmentRounds(database.db, run.id)[0]!;
    if (kind === "review")
      database.db
        .update(developmentRounds)
        .set({
          review: {
            ...round.review!,
            assessment: { ...round.review!.assessment, complete: false },
          },
        })
        .run();
    if (kind === "verification")
      database.db
        .update(developmentRounds)
        .set({
          verificationResult: {
            ...round.verificationResult!,
            output: "changed evidence",
          },
        })
        .run();
    if (kind === "termination")
      database.db
        .update(runExecutions)
        .set({ terminationConfirmedAt: null })
        .where(eq(runExecutions.sequence, 3))
        .run();
    if (kind === "skill")
      database.db
        .update(runs)
        .set({ runtimeSkillVersion: 1 })
        .where(eq(runs.id, run.id))
        .run();
    await expect(prepared()).rejects.toThrow("input_unavailable");
    expect(readChangeApplication(database.db, run.id)).toBeUndefined();
  },
);

test("evidence changed after reservation cannot advance Git", async () => {
  await approvedRound();
  const application = await prepared();
  const round = readDevelopmentRounds(database.db, run.id)[0]!;
  database.db
    .update(developmentRounds)
    .set({ reviewedAt: new Date(round.reviewedAt!.getTime() + 1) })
    .run();
  await expect(apply()).rejects.toThrow("input_unavailable");
  expect(head()).toBe(application.baseRevision);
  expect(readChangeApplication(database.db, run.id)?.status).toBe("pending");
});

test("does not adopt a foreign commit even when its tree matches the approved candidate", async () => {
  await approvedRound();
  const application = await prepared();
  const storage = join(repository().directory, "git");
  const foreign = git(
    storage,
    "commit-tree",
    application.tree,
    "-p",
    application.baseRevision,
    "-m",
    "foreign application",
  );
  git(storage, "update-ref", "refs/heads/development", foreign);
  await expect(apply()).rejects.toThrow("outside the recorded application");
  expect(head()).toBe(foreign);
  expect(repository().head).toBe(application.baseRevision);
  expect(readChangeApplication(database.db, run.id)?.status).toBe("pending");
});

test("does not follow a symbolic development ref or overwrite its target", async () => {
  await approvedRound();
  const application = await prepared();
  const storage = join(repository().directory, "git");
  git(storage, "update-ref", "refs/heads/other", application.baseRevision);
  git(storage, "symbolic-ref", "refs/heads/development", "refs/heads/other");
  await expect(apply()).rejects.toThrow("outside the recorded application");
  expect(git(storage, "rev-parse", "refs/heads/other")).toBe(
    application.baseRevision,
  );
});

test("source changes and aborted requests leave the reservation pending", async () => {
  await approvedRound();
  const application = await prepared();
  await expect(
    applyChangeApplication(database.db, run.id, AbortSignal.abort()),
  ).rejects.toThrow();
  writeFileSync(join(source, "src/main.mjs"), "changed by owner\n");
  await expect(apply()).rejects.toThrow("committed changes");
  expect(head()).toBe(application.baseRevision);
  expect(readChangeApplication(database.db, run.id)?.status).toBe("pending");
});

test("an execution owner change rejects the old process before Git mutation", async () => {
  await approvedRound();
  const application = await prepared();
  database.db
    .insert(executionOwner)
    .values({ slot: 1, token: randomUUID(), hostname: "fixture", pid: 1 })
    .run();
  await expect(apply()).rejects.toThrow("ownership");
  expect(head()).toBe(application.baseRevision);
});

test("concurrent attempts converge on one recorded commit using compare-and-swap", async () => {
  await approvedRound();
  const application = await prepared();
  const results = await Promise.allSettled([apply(), apply()]);
  expect(results.some((result) => result.status === "fulfilled")).toBe(true);
  expect(await apply()).toMatchObject({
    status: "applied",
    resultCommit: application.resultCommit,
  });
  expect(
    git(
      join(repository().directory, "git"),
      "rev-list",
      "--count",
      "refs/heads/development",
    ),
  ).toBe("2");
});

test("a previous schema upgrades without inventing an application for existing Runs", () => {
  database.close();
  const old = join(directory, "old-migrations");
  cpSync(migrationsDirectory, old, { recursive: true });
  const journalPath = join(old, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.entries = journal.entries.filter(
    (entry: { idx: number }) => entry.idx < 28,
  );
  writeFileSync(journalPath, JSON.stringify(journal));
  const path = join(directory, "upgrade.sqlite");
  const before = openDatabase(path, old);
  before.db
    .insert(projects)
    .values({
      id: projectId,
      name: "Before upgrade",
      workspaceKey: "fixture",
      createdAt: new Date(),
    })
    .run();
  before.close();
  const after = openDatabase(path);
  try {
    expect(after.db.select().from(projects).get()?.name).toBe("Before upgrade");
    expect(after.db.select().from(changeApplications).all()).toEqual([]);
    after.checkReady();
  } finally {
    after.close();
  }
});

test("commit bytes encode the saved parent and tree without local identity or clock dependency", async () => {
  await approvedRound();
  const application = await prepared();
  const commit = applicationCommit(application);
  expect(commit.oid).toBe(application.resultCommit);
  expect(commit.body.toString()).toContain(
    `tree ${application.tree}\nparent ${application.baseRevision}\n`,
  );
  expect(commit.body.toString()).toContain("agent-hub <agent-hub@localhost>");
  expect(() =>
    applicationCommit({ ...application, tree: "invalid\nparent forged" }),
  ).toThrow();
});

function recoveryHarness(ownerToken?: string, reconcile = (id: string, bounded: AbortSignal) =>
  applyChangeApplication(database.db, id, bounded, ownerToken).then(() => undefined)) {
  const recovery = createDrizzleRecoveryStore(database.db, ownerToken);
  const processor = createRecoveryProcessor(recovery, {
    confirm: async () => { throw new Error("saved container proof should be reused"); },
    cleanup: async () => {},
  }, undefined, undefined, reconcile);
  const request = (key: string) => recovery.request({ taskId, runId: run.id, requestKey: key, action: "reconcile", providerGateVersion: null }, null, true).request;
  return { recovery, processor, request };
}

test.each(["intent", "git", "database"])("restart after %s resumes the recorded application and finalizes one Task without another AI attempt", async (boundary) => {
  await approvedRound();
  const application = await prepared();
  if (boundary === "git") {
    database.client.exec("CREATE TRIGGER fail_finalize BEFORE UPDATE ON change_applications BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END");
    await expect(apply()).rejects.toThrow("injected storage failure");
  }
  if (boundary === "database") await apply();
  reopen();
  if (boundary === "git") database.client.exec("DROP TRIGGER fail_finalize");
  const { recovery, processor, request } = recoveryHarness();
  const receipt = request("restart");
  await processor.process(receipt.id);
  expect(recovery.findById(receipt.id)).toMatchObject({ status: "completed", resultStatus: "succeeded", errorCode: null });
  expect(database.db.select().from(runs).all()).toHaveLength(1);
  expect(database.db.select().from(runs).get()).toMatchObject({ status: "succeeded", result: "Candidate inspected", terminationConfirmedAt: expect.any(Date) });
  expect(database.db.select().from(tasks).get()?.status).toBe("succeeded");
  expect(readChangeApplication(database.db, run.id)).toMatchObject({ status: "applied", resultCommit: application.resultCommit });
  await processor.process(receipt.id);
  expect(head()).toBe(application.resultCommit);
  expect(git(join(repository().directory, "git"), "rev-list", "--count", "refs/heads/development")).toBe("2");
  expect(readFileSync(join(source, "src/main.mjs"), "utf8")).toBe("export const answer = 1;\n");
});

test("pending application blocks new work in the same project even after all containers terminated", async () => {
  await approvedRound();
  await prepared();
  store.finish(run.id, { status: "interrupted", errorCode: "execution_error", result: null, usage: null, retryAt: null, terminationConfirmedAt: new Date() });
  const next = randomUUID();
  database.db.insert(tasks).values({ id: next, projectId, instruction: "Next analysis", requestKey: next, createdAt: new Date() }).run();
  expect(store.claimNext("fixture", ["fixture"])).toEqual({ kind: "held", runId: run.id, reason: "change_application_pending" });
  expect(() => store.claim(next, "fixture")).toThrow("CHANGE_APPLICATION_EXISTS");
  const { recovery, processor, request } = recoveryHarness();
  expect(() => recovery.request({ taskId, runId: run.id, requestKey: "resume", action: "resume", providerGateVersion: null }, null, true)).toThrow("CHANGE_APPLICATION_EXISTS");
  await processor.process(request("reconcile").id);
  expect(store.claimNext("fixture", ["fixture"])).toMatchObject({ kind: "claimed", run: { taskId: next } });
});

test.each(["cancel", "scope_changed", "timeout", "budget_limit", "server_shutdown"])("recovery preserves %s semantics while reconciling an already authorized change", async (reason) => {
  await approvedRound();
  const application = await prepared();
  if (reason === "cancel") {
    database.db.update(tasks).set({ status: "cancelled", cancelRequestedAt: new Date() }).where(eq(tasks.id, taskId)).run();
  } else store.requestStop(run.id, reason as "scope_changed" | "timeout" | "budget_limit" | "server_shutdown");
  const { recovery, processor, request } = recoveryHarness();
  const receipt = request("stopped");
  await processor.process(receipt.id);
  const expected = { cancel: "cancelled", scope_changed: "cancelled", timeout: "failed", budget_limit: "waiting_capacity", server_shutdown: "succeeded" }[reason];
  expect(recovery.findById(receipt.id)).toMatchObject({ status: "completed", resultStatus: expected });
  expect(database.db.select().from(tasks).get()?.status).toBe(expected);
  expect(head()).toBe(application.resultCommit);
  expect(readChangeApplication(database.db, run.id)?.status).toBe("applied");
  expect(() => recovery.request({ taskId, runId: run.id, requestKey: "no-second-run", action: "resume", providerGateVersion: null }, null, true)).toThrow();
  expect(database.db.select().from(runs).all()).toHaveLength(1);
});

test("automatic reconciliation retains a pending request across shutdown and completes it under the next owner", async () => {
  await approvedRound();
  await prepared();
  store.finish(run.id, { status: "interrupted", errorCode: "execution_error", result: null, usage: null, retryAt: null, terminationConfirmedAt: new Date() });
  const owner = acquireExecutionOwner(database.db);
  const stopped = new AbortController();
  const first = recoveryHarness(owner.token, async (_id, bounded) => { stopped.abort(); bounded.throwIfAborted(); });
  const automatic = createAutomaticRecovery({ db: database.db, ownerToken: owner.token, recovery: first.recovery, policy: defaultRetryPolicy, workspaceKeys: ["fixture"] });
  expect(automatic.tick()).toBe(true);
  const receipt = first.processor.next()!;
  expect(receipt.requestKey).toBe(`auto-application-${readChangeApplication(database.db, run.id)!.id}`);
  await first.processor.process(receipt.id, stopped.signal);
  expect(first.recovery.findById(receipt.id)?.status).toBe("pending");
  owner.release();
  reopen();
  const secondOwner = acquireExecutionOwner(database.db);
  try {
    const second = recoveryHarness(secondOwner.token);
    await second.processor.process(receipt.id);
    expect(second.recovery.findById(receipt.id)).toMatchObject({ status: "completed", resultStatus: "succeeded" });
    expect(database.db.select().from(runs).all()).toHaveLength(1);
  } finally { secondOwner.release(); }
});

test("unconfirmed application records one automatic failure and can be manually reconciled after the conflict is resolved", async () => {
  await approvedRound();
  const application = await prepared();
  store.finish(run.id, { status: "interrupted", errorCode: "execution_error", result: null, usage: null, retryAt: null, terminationConfirmedAt: new Date() });
  const owner = acquireExecutionOwner(database.db);
  try {
    const { recovery, processor, request } = recoveryHarness(owner.token);
    const automatic = createAutomaticRecovery({ db: database.db, ownerToken: owner.token, recovery, policy: defaultRetryPolicy, workspaceKeys: ["fixture"] });
    writeFileSync(join(source, "src/main.mjs"), "uncommitted source conflict\n");
    expect(automatic.tick()).toBe(true);
    const receipt = processor.next()!;
    await processor.process(receipt.id);
    expect(recovery.findById(receipt.id)).toMatchObject({ status: "rejected", errorCode: "CHANGE_APPLICATION_UNCONFIRMED" });
    expect(head()).toBe(application.baseRevision);
    expect(automatic.tick()).toBe(true);
    expect(automatic.tick()).toBe(false);
    expect(database.db.select().from(tasks).get()?.retryState?.reason).toBe("change_application_unconfirmed");
    expect(processor.next()).toBeUndefined();
    writeFileSync(join(source, "src/main.mjs"), "export const answer = 1;\n");
    await processor.process(request("manual-after-conflict").id);
    expect(database.db.select().from(tasks).get()?.status).toBe("succeeded");
    expect(database.db.select().from(tasks).get()?.retryState?.reason).toBeNull();
    expect(head()).toBe(application.resultCommit);
  } finally { owner.release(); }
});

test("a lost reconciliation response after a durable application still completes from saved evidence", async () => {
  await approvedRound();
  await prepared();
  const { recovery, processor, request } = recoveryHarness(undefined, async (id, bounded) => {
    await applyChangeApplication(database.db, id, bounded);
    throw new Error("lost response");
  });
  const receipt = request("lost-response");
  await processor.process(receipt.id);
  expect(recovery.findById(receipt.id)).toMatchObject({ status: "completed", resultStatus: "succeeded" });
});

test.each(["timeout", "budget_limit"] as const)("preserves %s when normal completion is saved before application recovery", async (reason) => {
  await approvedRound();
  await prepared();
  store.requestStop(run.id, reason);
  const expected = reason === "timeout" ? "failed" : "waiting_capacity";
  const result = store.finish(run.id, { status: "interrupted", errorCode: reason, result: null, usage: null, retryAt: null, terminationConfirmedAt: new Date() });
  expect(result).toMatchObject({ status: expected, errorCode: reason });
  reopen();
  const { recovery, processor, request } = recoveryHarness();
  const receipt = request("finish-then-recover");
  await processor.process(receipt.id);
  expect(recovery.findById(receipt.id)).toMatchObject({ status: "completed", resultStatus: expected });
  expect(database.db.select().from(runs).get()).toMatchObject({ status: expected, errorCode: reason });
  expect(readChangeApplication(database.db, run.id)?.status).toBe("applied");
});
