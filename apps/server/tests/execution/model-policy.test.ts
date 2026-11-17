import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import type { AnalysisAssessment } from "@agent-hub/contracts";
import { openDatabase } from "../../src/db/connection.js";
import { projects, runs, tasks } from "../../src/db/schema.js";
import { createAnalysisWorkflow } from "../../src/modules/execution/analysis-workflow.js";
import { createDrizzleRunStore } from "../../src/modules/execution/drizzle-run-store.js";
import { runClaimedTask } from "../../src/modules/execution/run-task.js";
import { acquireExecutionOwner } from "../../src/modules/execution/execution-owner.js";
import { readProjectUsage } from "../../src/modules/projects/project-usage.js";
import { createContainerExecutor } from "../../src/modules/execution/execution-process.js";
import {
  parseModelPolicy,
  parseModelRouting,
  selectModel,
  sensitiveModelScope,
} from "../../src/modules/execution/model-policy.js";

const routing = { models: { luna: "fixture-luna", sol: "fixture-sol", astra: "fixture-astra" } };

test("routing cannot use a legacy container request without capability negotiation", async () => {
  await expect(
    createContainerExecutor("unused-image", "/unused-auth").analyze(
      {
        runId: randomUUID(),
        instruction: "Inspect",
        workspace: "/unused",
        model: "fixture-sol",
        modelPolicy: { ...routing, version: 1, minimumTier: "luna" },
        signal: new AbortController().signal,
      },
      () => {},
    ),
  ).rejects.toMatchObject({ code: "unsupported_settings" });
});

test("routing validates the operator mapping and keeps old fixed-model behavior", () => {
  expect(parseModelRouting(routing)).toEqual(routing);
  for (const bad of [
    null,
    [],
    {},
    { ...routing, model: "override" },
    { models: { ...routing.models, sol: "unsafe model" } },
    { models: { ...routing.models, extra: "fixture" } },
  ])
    expect(() => parseModelRouting(bad)).toThrow();
  expect(selectModel("existing", null, { tier: "astra", reason: "complex" }).model).toBe(
    "existing",
  );
  const policy = parseModelPolicy({ ...routing, version: 1, minimumTier: "luna" });
  expect(selectModel("existing", policy).model).toBe("fixture-sol");
  expect(selectModel("existing", policy, { tier: "luna", reason: "simple" }).model).toBe(
    "fixture-luna",
  );
  expect(selectModel("existing", policy, { tier: "luna", reason: "simple" }, true)).toMatchObject({
    model: "fixture-sol",
    reason: expect.stringContaining("최소 등급"),
  });
  expect(
    selectModel("existing", { ...policy, minimumTier: "sol" }, { tier: "luna", reason: "simple" })
      .model,
  ).toBe("fixture-sol");
  expect(sensitiveModelScope("src/auth/session.ts")).toBe(true);
  expect(sensitiveModelScope("docs/guide.md")).toBe(false);
  expect(() => parseModelPolicy({ ...policy, minimumTier: "none" })).toThrow();
});

test("persisted project runs select models before calls and retain their policy across a settings change", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hub-model-routing-"));
  const file = join(directory, "hub.sqlite");
  let database = openDatabase(file);
  try {
    const owner = acquireExecutionOwner(database.db);
    const ids = [randomUUID(), randomUUID()];
    for (const [index, id] of ids.entries()) {
      const projectId = randomUUID();
      database.db
        .insert(projects)
        .values({
          id: projectId,
          name: `Project ${index}`,
          workspaceKey: `project-${index}`,
          createdAt: new Date(),
        })
        .run();
      database.db
        .insert(tasks)
        .values({
          id,
          projectId,
          instruction: index ? "인증과 권한 분석" : "Compare implementation then summarize",
          requestKey: id,
          createdAt: new Date(),
        })
        .run();
    }
    const store = createDrizzleRunStore(database.db, owner.token, {
      modelRouting: routing,
      analysisWorkflow: { version: 1, maxSteps: 3, maxEffortChanges: 2 },
    });
    const claimed = store.claim(ids[0]!, "old-config-model");
    expect(claimed.model).toBe("fixture-sol");
    database.close();
    database = openDatabase(file);
    const changedSettings = createDrizzleRunStore(database.db, owner.token, {
      modelRouting: { models: { luna: "new-luna", sol: "new-sol", astra: "new-astra" } },
    });
    const stored = database.db.select().from(runs).where(eq(runs.id, claimed.id)).get()!;
    expect(stored.modelPolicy?.models).toEqual(routing.models);
    const seen: string[] = [];
    const reports: AnalysisAssessment[] = [
      {
        report: "Need deeper design",
        evidence: ["code.ts"],
        unresolved: ["cause"],
        complete: false,
        next: {
          purpose: "Compare causes",
          effort: "high",
          model: "astra",
          reason: "Uncertain interactions",
        },
      },
      {
        report: "Cause verified",
        evidence: ["code.ts"],
        unresolved: ["summary"],
        complete: false,
        next: { purpose: "Summarize", effort: "medium", model: "luna", reason: "Bounded summary" },
      },
      { report: "Complete", evidence: ["code.ts"], unresolved: [], complete: true, next: null },
    ];
    const result = await runClaimedTask(
      claimed,
      {
        model: "new-sol",
        workspace: directory,
        timeoutMs: 5000,
        signal: new AbortController().signal,
      },
      changedSettings,
      createAnalysisWorkflow({
        async analyze(request) {
          seen.push(request.model);
          const persisted = changedSettings.findById(claimed.id)!;
          expect(persisted.steps.at(-1)?.model).toBe(request.model);
          return {
            output: JSON.stringify(reports[seen.length - 1]),
            usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 3 },
          };
        },
        confirmTermination: async () => new Date(),
      }),
    );
    expect(result.status).toBe("succeeded");
    expect(seen).toEqual(["fixture-sol", "fixture-astra", "fixture-luna"]);
    const firstTask = database.db.select().from(tasks).where(eq(tasks.id, ids[0]!)).get()!;
    expect(
      readProjectUsage(database.db, firstTask.projectId).models.map((entry) => ({
        model: entry.model,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
      })),
    ).toEqual(
      ["fixture-astra", "fixture-luna", "fixture-sol"].map((model) => ({
        model,
        inputTokens: 10,
        outputTokens: 3,
      })),
    );
    expect(changedSettings.findById(claimed.id)!.steps.map((step) => step.model)).toEqual(seen);
    expect(changedSettings.findById(claimed.id)!.steps[1]?.modelReason).toContain(
      "Uncertain interactions",
    );
    const second = changedSettings.claim(ids[1]!, "fallback");
    expect(second.model).toBe("new-sol");
    expect(second.modelPolicy?.minimumTier).toBe("sol");
    expect(second.modelPolicy?.models).not.toEqual(claimed.modelPolicy?.models);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
