import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { parseResponse, runDetailsSchema, type AnalysisAssessment } from "@agent-hub/contracts";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db/connection.js";
import { projects, runs, tasks } from "../src/db/schema.js";
import {
  createAnalysisWorkflow,
  parseAnalysisWorkflow,
  parseAssessment,
  parseStepUpdate,
  selectNextEffort,
} from "../src/modules/execution/analysis-workflow.js";
import { parseEffortPolicy } from "../src/modules/execution/effort-policy.js";
import { createDrizzleRunStore } from "../src/modules/execution/drizzle-run-store.js";
import { runTask } from "../src/modules/execution/run-task.js";
import type { AnalysisExecutor } from "../src/modules/execution/analysis.js";

const policy = parseAnalysisWorkflow({});
const effortPolicy = parseEffortPolicy({});
const report = (next: AnalysisAssessment["next"] = null): AnalysisAssessment => ({
  report: next ? "Partial finding" : "Final report",
  evidence: ["example.ts:1"],
  unresolved: next ? ["Need further comparison"] : [],
  complete: !next,
  next,
});
let directory: string, database: ReturnType<typeof openDatabase>, taskId: string;
let store: ReturnType<typeof createDrizzleRunStore>;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "hub-workflow-"));
  database = openDatabase(join(directory, "hub.sqlite"));
  const projectId = randomUUID();
  taskId = randomUUID();
  database.db
    .insert(projects)
    .values({
      id: projectId,
      name: "Example",
      workspaceKey: "example",
      createdAt: new Date(),
    })
    .run();
  database.db
    .insert(tasks)
    .values({
      id: taskId,
      projectId,
      instruction: "보안 검토",
      requestKey: taskId,
      createdAt: new Date(),
    })
    .run();
  store = createDrizzleRunStore(database.db, undefined, {
    effortPolicy,
    analysisWorkflow: policy,
  });
});
afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

function execute(
  executor: AnalysisExecutor,
  timeoutMs = 1000,
  signal = new AbortController().signal,
) {
  return runTask(
    { taskId, model: "fixture", workspace: directory, timeoutMs, signal },
    store,
    createAnalysisWorkflow({
      ...executor,
      confirmTermination: async () => new Date(),
    }),
  );
}
function scripted(reports: AnalysisAssessment[]) {
  let counter = 0;
  const analyze = vi.fn<AnalysisExecutor["analyze"]>(async (_, event) => {
    const index = counter++;
    await event({ kind: "thread.started", sessionId: `session-${index + 1}` });
    return {
      output: JSON.stringify(reports[index]),
      usage: {
        inputTokens: 10 + index,
        cachedInputTokens: index,
        outputTokens: 3 + index,
      },
    };
  });
  return { analyze };
}

test("validates limits, reports and wire messages before granting a next call", () => {
  for (const invalid of [
    false,
    null,
    { maxSteps: 0 },
    { maxSteps: 7 },
    { maxSteps: 2, maxEffortChanges: 2 },
    { maxEffortChanges: -1 },
    { extra: true },
  ])
    expect(() => parseAnalysisWorkflow(invalid)).toThrow();
  expect(parseAnalysisWorkflow({ maxSteps: 1 })).toEqual({
    version: 1,
    maxSteps: 1,
    maxEffortChanges: 0,
  });
  for (const invalid of [
    { ...report(), complete: true, unresolved: ["unknown"] },
    { ...report(), report: " " },
    { ...report(), extra: "untrusted" },
  ])
    expect(() => parseAssessment(invalid)).toThrow("invalid_plan");
  expect(() => parseStepUpdate({ type: "start", sequence: 0 })).toThrow("invalid_plan");
  expect(() =>
    parseStepUpdate({
      type: "complete",
      sequence: 1,
      assessment: report(),
      usage: { inputTokens: 1, cachedInputTokens: 2, outputTokens: 0 },
    }),
  ).toThrow("invalid_plan");
  expect(parseAssessment({ ...report(), report: "sk-synthetic_secret" }).report).toBe("[REDACTED]");
});

test("applies the maximum, invalid-proposal fallback and change-count cap independently", () => {
  expect(
    selectNextEffort("xhigh", "medium", 0, { ...effortPolicy, maxEffort: "high" }, policy).effort,
  ).toBe("high");
  expect(selectNextEffort("ultra", "high", 0, effortPolicy, policy).effort).toBe("medium");
  expect(selectNextEffort("medium", "high", 2, effortPolicy, policy)).toMatchObject({
    effort: "high",
    reason: expect.stringContaining("변경 횟수"),
  });
  expect(
    selectNextEffort("xhigh", "medium", 0, parseEffortPolicy({ mode: "fixed" }), policy).effort,
  ).toBe("medium");
});

test("persists three sequential sessions in one Run, raises and lowers effort, and transfers findings", async () => {
  const executor = scripted([
    report({
      purpose: "복잡한 원인 비교",
      effort: "xhigh",
      reason: "Several hypotheses",
    }),
    report({
      purpose: "결과 요약",
      effort: "medium",
      reason: "Evidence is sufficient",
    }),
    report(),
  ]);
  const result = await execute(executor);
  expect(result).toMatchObject({
    status: "succeeded",
    result: "Final report",
    usage: { inputTokens: 33, cachedInputTokens: 3, outputTokens: 12 },
  });
  expect(database.db.select().from(runs).all()).toHaveLength(1);
  expect(executor.analyze.mock.calls.map((call) => call[0].effort)).toEqual([
    "high",
    "xhigh",
    "medium",
  ]);
  expect(executor.analyze.mock.calls[1]![0].instruction).toContain("Partial finding");
  expect(executor.analyze.mock.calls[1]![0].instruction).toContain("보안 검토");
  expect(executor.analyze.mock.calls.every((call) => call[0].outputSchema)).toBe(true);
  const detail = store.findById(result.runId)!;
  expect(detail.steps.map((step) => step.sessionId)).toEqual([
    "session-1",
    "session-2",
    "session-3",
  ]);
  expect(detail.steps.map((step) => step.usage?.inputTokens)).toEqual([10, 11, 12]);
  expect(detail.steps.map((step) => step.effort)).toEqual(["high", "xhigh", "medium"]);
  expect(detail.steps.every((step) => step.status === "succeeded" && step.finishedAt)).toBe(true);
  expect(detail.steps[1]).toMatchObject({
    proposedEffort: "xhigh",
    purpose: "복잡한 원인 비교",
    model: "fixture",
  });
  const app = buildApp({ databasePath: join(directory, "hub.sqlite") });
  try {
    const response = await app.inject({
      method: "GET",
      url: `/runs/${result.runId}`,
    });
    expect(parseResponse(runDetailsSchema, response.json()).steps[0]!.assessment?.report).toBe(
      "Partial finding",
    );
  } finally {
    await app.close();
  }
});

test("the call limit holds incomplete work and preserves completed Step reports", async () => {
  store = createDrizzleRunStore(database.db, undefined, {
    effortPolicy,
    analysisWorkflow: parseAnalysisWorkflow({ maxSteps: 2 }),
  });
  const executor = scripted(
    Array.from({ length: 3 }, () =>
      report({
        purpose: "More analysis",
        effort: "high",
        reason: "Unanswered",
      }),
    ),
  );
  const result = await execute(executor);
  expect(result).toMatchObject({
    status: "blocked",
    errorCode: "workflow_limit",
    result: null,
  });
  expect(executor.analyze).toHaveBeenCalledTimes(2);
  expect(
    store
      .findById(result.runId)!
      .steps.every(
        (step) => step.status === "succeeded" && step.assessment?.report === "Partial finding",
      ),
  ).toBe(true);
  expect(store.getProviderGate().blocked).toBe(false);
});

test("missing input and malformed reports do not create further calls", async () => {
  const executor = scripted([
    { ...report(), complete: false, unresolved: ["Missing specification"] },
  ]);
  expect(await execute(executor)).toMatchObject({
    status: "blocked",
    errorCode: "analysis_incomplete",
  });
  expect(executor.analyze).toHaveBeenCalledOnce();
});

test("malformed structured output is held without turning the message into success", async () => {
  const executor = {
    analyze: vi.fn(async () => ({ output: "not JSON", usage: null })),
  };
  expect(await execute(executor)).toMatchObject({
    status: "blocked",
    errorCode: "invalid_plan",
    result: null,
  });
  expect(executor.analyze).toHaveBeenCalledOnce();
});

test("cancellation between reports prevents the next call and preserves the prior Step", async () => {
  const controller = new AbortController(),
    original = store.record;
  store.record = (id, event) => {
    original(id, event);
    if (event.step?.type === "complete") controller.abort();
  };
  const executor = scripted([
    report({ purpose: "Next", effort: "xhigh", reason: "Needed" }),
    report(),
  ]);
  const result = await execute(executor, 1000, controller.signal);
  expect(result.status).toBe("cancelled");
  expect(executor.analyze).toHaveBeenCalledOnce();
  expect(store.findById(result.runId)!.steps[0]).toMatchObject({
    status: "succeeded",
    assessment: { report: "Partial finding" },
  });
});

test("the original Run deadline is not reset at a step boundary", async () => {
  const executor = {
    analyze: vi.fn<AnalysisExecutor["analyze"]>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return {
        output: JSON.stringify(report({ purpose: "Next", effort: "medium", reason: "Needed" })),
        usage: null,
      };
    }),
  };
  vi.useFakeTimers();
  try {
    const pending = execute(executor, 65);
    await vi.advanceTimersByTimeAsync(65);
    const result = await pending;
    expect(result).toMatchObject({ status: "failed", errorCode: "timeout" });
    expect(executor.analyze).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60);
    const detail = store.findById(result.runId)!;
    expect(detail.steps.map((step) => step.status)).toEqual(["succeeded", "failed"]);
    expect(detail.steps[1]!.assessment).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("a storage failure while opening the next Step prevents the next SDK invocation", async () => {
  database.client.exec(
    "CREATE TRIGGER fail_second_step BEFORE INSERT ON steps WHEN NEW.sequence = 2 BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
  );
  const executor = scripted([
    report({ purpose: "Next", effort: "medium", reason: "Needed" }),
    report(),
  ]);
  const result = await execute(executor);
  expect(result.status).toBe("interrupted");
  expect(executor.analyze).toHaveBeenCalledOnce();
  expect(store.findById(result.runId)!.steps).toHaveLength(1);
});

test("duplicate and out-of-order step events cannot grant another invocation", () => {
  const run = store.claim(taskId, "fixture");
  expect(() =>
    store.record(run.id, {
      kind: "step.started",
      step: { type: "start", sequence: 2 },
    }),
  ).toThrow("invalid_plan");
  store.record(run.id, {
    kind: "step.started",
    step: { type: "start", sequence: 1 },
  });
  expect(() =>
    store.record(run.id, {
      kind: "step.started",
      step: { type: "start", sequence: 1 },
    }),
  ).toThrow("invalid_plan");
  expect(() =>
    store.record(run.id, {
      kind: "step.completed",
      step: {
        type: "complete",
        sequence: 2,
        assessment: report(),
        usage: null,
      },
    }),
  ).toThrow("invalid_plan");
});

test("a runner cannot bypass persisted step completion by returning a success message", async () => {
  const result = await runTask(
    {
      taskId,
      model: "fixture",
      workspace: directory,
      timeoutMs: 1000,
      signal: new AbortController().signal,
    },
    store,
    {
      analyze: async () => ({ output: "Unsupported success", usage: null }),
      confirmTermination: async () => new Date(),
    },
  );
  expect(result).toMatchObject({
    status: "blocked",
    errorCode: "invalid_plan",
    result: null,
  });
});

test.each([
  ["ultra", 2, ["high", "medium", "medium"]],
  ["xhigh", 1, ["high", "xhigh", "xhigh"]],
])(
  "persisted and invoked efforts agree for proposal %s with %i changes",
  async (proposed, maxEffortChanges, expected) => {
    store = createDrizzleRunStore(database.db, undefined, {
      effortPolicy,
      analysisWorkflow: parseAnalysisWorkflow({ maxEffortChanges }),
    });
    const executor = scripted([
      report({ purpose: "Second", effort: proposed, reason: "New evidence" }),
      report({ purpose: "Summary", effort: "medium", reason: "Sufficient evidence" }),
      report(),
    ]);
    const result = await execute(executor);
    expect(result.status).toBe("succeeded");
    expect(executor.analyze.mock.calls.map((call) => call[0].effort)).toEqual(expected);
    expect(store.findById(result.runId)!.steps.map((step) => step.effort)).toEqual(expected);
  },
);

test("caps accumulated context without discarding the reports already saved", async () => {
  store = createDrizzleRunStore(database.db, undefined, {
    effortPolicy,
    analysisWorkflow: parseAnalysisWorkflow({ maxSteps: 6 }),
  });
  const executor = scripted(
    Array.from({ length: 6 }, () => ({
      ...report({ purpose: "Continue", effort: "medium", reason: "Need more" }),
      report: "x".repeat(16000),
    })),
  );
  const result = await execute(executor);
  expect(result).toMatchObject({ status: "blocked", errorCode: "workflow_limit" });
  expect(executor.analyze.mock.calls.length).toBeLessThan(6);
  expect(store.findById(result.runId)!.steps.filter((step) => step.assessment).length).toBe(
    executor.analyze.mock.calls.length,
  );
});
