import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { parseResponse, runDetailsSchema } from "@agent-hub/contracts";
import { buildApp } from "../../src/app.js";
import { openDatabase } from "../../src/db/connection.js";
import { projects, tasks } from "../../src/db/schema.js";
import {
  defaultEffortPolicy,
  parseEffortPolicy,
  selectInitialEffort,
} from "../../src/modules/execution/effort-policy.js";
import { createDrizzleRunStore } from "../../src/modules/execution/drizzle-run-store.js";
import { runTask } from "../../src/modules/execution/run-task.js";
import { AnalysisError, type AnalysisExecutor } from "../../src/modules/execution/analysis.js";

let directory: string;
let database: ReturnType<typeof openDatabase>;
let projectId: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "hub-effort-"));
  database = openDatabase(join(directory, "hub.sqlite"));
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
});
afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

test("initial task signals select medium, high or xhigh before any failure", () => {
  const policy = parseEffortPolicy({ mode: "adaptive" });
  expect(selectInitialEffort("README를 요약해 줘", policy).effort).toBe("medium");
  expect(selectInitialEffort("동시성 경합의 원인을 분석해 줘", policy)).toMatchObject({
    effort: "high",
    reason: expect.stringContaining("동시성"),
  });
  expect(
    selectInitialEffort("여러 시스템의 복잡한 인과 관계와 교착 원인을 분석해 줘", policy).effort,
  ).toBe("xhigh");
  expect(selectInitialEffort("보안·트랜잭션·동시성 경합을 함께 검토", policy).effort).toBe("xhigh");
  expect(
    selectInitialEffort("분산 시스템의 복잡한 원인", {
      ...policy,
      maxEffort: "high",
    }),
  ).toMatchObject({
    effort: "high",
    reason: expect.stringContaining("허용 상한"),
  });
  expect(selectInitialEffort("보안 분석", defaultEffortPolicy).effort).toBe("medium");
});

test("only medium through xhigh are allowed and invalid policy is rejected before execution", () => {
  for (const value of [
    true,
    null,
    { mode: "invalid" },
    { maxEffort: "low" },
    { maxEffort: "ultra" },
    { maxEffort: "max" },
    { mode: "fixed", maxEffort: "high" },
    { unknown: true },
  ])
    expect(() => parseEffortPolicy(value)).toThrow();
  expect(parseEffortPolicy({})).toEqual({
    version: 1,
    mode: "adaptive",
    maxEffort: "xhigh",
  });
});

test.each([
  ["README 요약", "medium"],
  ["동시성 검토", "high"],
  ["여러 시스템의 복잡한 원인 분석", "xhigh"],
])(
  "%s persists exactly the effort passed to the executor and exposes the selection reason",
  async (instruction, effort) => {
    const id = randomUUID();
    database.db
      .insert(tasks)
      .values({
        id,
        projectId,
        instruction,
        requestKey: id,
        createdAt: new Date(),
      })
      .run();
    const store = createDrizzleRunStore(database.db, undefined, {
      effortPolicy: parseEffortPolicy({}),
    });
    const analyze = vi.fn<AnalysisExecutor["analyze"]>(async () => ({
      output: "Report",
      usage: null,
    }));
    const result = await runTask(
      {
        taskId: id,
        model: "fixture",
        workspace: directory,
        timeoutMs: 1000,
        signal: new AbortController().signal,
      },
      store,
      { analyze },
    );
    expect(analyze.mock.calls[0]![0]).toMatchObject({ effort });
    expect(store.findById(result.runId)).toMatchObject({
      effort,
      steps: [{ effort, effortPolicyVersion: 1, effortReason: expect.any(String) }],
    });
    const app = buildApp({ databasePath: join(directory, "hub.sqlite") });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/runs/${result.runId}`,
      });
      const detail = parseResponse(runDetailsSchema, response.json());
      expect(detail.steps[0]!.effort).toBe(effort);
    } finally {
      await app.close();
    }
  },
);

test("unsupported model settings block execution without fabricating a supported effort", async () => {
  const id = randomUUID();
  database.db
    .insert(tasks)
    .values({
      id,
      projectId,
      instruction: "README 요약",
      requestKey: id,
      createdAt: new Date(),
    })
    .run();
  const store = createDrizzleRunStore(database.db, undefined, {
    effortPolicy: parseEffortPolicy({}),
  });
  const analyze = vi.fn(async () => {
    throw new AnalysisError("unsupported_settings");
  });
  const result = await runTask(
    {
      taskId: id,
      model: "fixture",
      workspace: directory,
      timeoutMs: 1000,
      signal: new AbortController().signal,
    },
    store,
    { analyze, confirmTermination: async () => new Date() },
  );
  expect(result.status).toBe("blocked");
  expect(store.getProviderGate().reason).toBe("configuration");
  expect(store.findById(result.runId)?.effort).toBe("medium");
  expect(analyze).toHaveBeenCalledOnce();
});
