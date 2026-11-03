import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, test } from "vitest";
import { parseResponse, runDetailsSchema } from "@agent-hub/contracts";
import { buildApp } from "../src/app.js";
import { openDatabase } from "../src/db/connection.js";
import {
  developmentRepositories,
  developmentRounds,
  projects,
  runs,
  tasks,
} from "../src/db/schema.js";
import type { DevelopmentInput } from "../src/modules/goals/development-workspace.js";

// Read-side fixtures only. The journal and executor suites verify the writes,
// process identities and Git trees that make these records authoritative.
let directory: string,
  database: ReturnType<typeof openDatabase>,
  app: ReturnType<typeof buildApp>;
let runId: string, taskId: string, round: typeof developmentRounds.$inferInsert;
const now = new Date("2026-01-01T00:00:00Z");
const secret = "sk-fixtureSensitiveOutput12345678901234567890";
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "hub-development-evidence-"));
  const databasePath = join(directory, "hub.sqlite");
  database = openDatabase(databasePath);
  const projectId = randomUUID(),
    repositoryId = randomUUID();
  taskId = randomUUID();
  runId = randomUUID();
  database.db
    .insert(projects)
    .values({
      id: projectId,
      name: "Example",
      workspaceKey: "example",
      createdAt: now,
    })
    .run();
  database.db
    .insert(tasks)
    .values({
      id: taskId,
      projectId,
      instruction: "Fix calculation",
      requestKey: taskId,
      status: "blocked",
      createdAt: now,
    })
    .run();
  database.db
    .insert(runs)
    .values({
      id: runId,
      taskId,
      instanceId: "fixture",
      status: "blocked",
      model: "fixture",
      effort: "medium",
      developmentVersion: 1,
      startedAt: now,
      lastActivityAt: now,
      finishedAt: now,
      terminationConfirmedAt: now,
      errorCode: "development_incomplete",
    })
    .run();
  database.db
    .insert(developmentRepositories)
    .values({
      id: repositoryId,
      projectId,
      createdByRunId: runId,
      intent: {
        id: repositoryId,
        projectId,
        directory: "/private/repository-sentinel",
        source: "/private/source-sentinel",
      },
      createdAt: now,
    })
    .run();
  const input: DevelopmentInput = {
    id: randomUUID(),
    runId,
    repositoryId,
    directory: "/private/input-sentinel",
    revision: "a".repeat(40),
    tree: "b".repeat(40),
    previousCandidate: null,
    scope: {
      goalId: randomUUID(),
      goalVersion: 1,
      allowedPaths: ["src"],
      excludedPaths: [],
    },
    writePaths: ["src"],
    files: [{ path: "src/main.ts", blob: "c".repeat(40), bytes: 20, mode: "100644" }],
    digest: "d".repeat(64),
  };
  const { files: _files, digest: _digest, ...intent } = input;
  const candidate = {
    repositoryId,
    runId,
    baseRevision: input.revision,
    inputDigest: input.digest,
    tree: "e".repeat(40),
    digest: "f".repeat(64),
    changes: [
      {
        path: "src/main.ts",
        before: "c".repeat(40),
        after: "b".repeat(40),
        mode: "100644",
        bytes: 25,
      },
    ],
  };
  const verificationInput = {
    ...input,
    id: randomUUID(),
    directory: "/private/test-input-sentinel",
    tree: candidate.tree,
    previousCandidate: candidate.digest,
  };
  const {
    files: _testFiles,
    digest: _testDigest,
    ...testIntent
  } = verificationInput;
  const configuration = {
    image: "private-image-sentinel:local",
    command: ["node", "private-command-sentinel"],
    timeoutMs: 1000,
  };
  const execution = {
    kind: "docker" as const,
    containerId: "1".repeat(64),
    engineId: "private-engine-sentinel",
    token: "private-token-sentinel",
  };
  round = {
    runId,
    sequence: 1,
    repositoryId,
    inputId: input.id,
    planningRevision: input.revision,
    intent,
    input,
    candidate,
    executionOffset: 0,
    createdAt: now,
    preparedAt: now,
    capturedAt: now,
    verificationIntent: {
      candidateDigest: candidate.digest,
      input: testIntent,
      configuration,
    },
    verificationInput,
    verificationPreparedAt: now,
    verificationResult: {
      candidateDigest: candidate.digest,
      inputDigest: input.digest,
      configurationDigest: "2".repeat(64),
      configuration,
      execution,
      imageId: `sha256:${"3".repeat(64)}`,
      status: "passed",
      exitCode: 0,
      oomKilled: false,
      elapsedMs: 28,
      output: `test passed ${secret}`,
    },
    verifiedAt: now,
    review: {
      candidateDigest: candidate.digest,
      verificationDigest: "4".repeat(64),
      execution,
      stepSequence: 2,
      assessment: {
        report: `Approved ${secret}`,
        evidence: ["src/main.ts"],
        unresolved: [],
        complete: true,
        next: null,
      },
    },
    reviewedAt: now,
  };
  app = buildApp({ databasePath });
});
afterEach(async () => {
  await app.close();
  database.close();
  rmSync(directory, { recursive: true, force: true });
});
async function detail(id = runId) {
  const response = await app.inject(`/runs/${id}`);
  expect(response.statusCode).toBe(200);
  return { response, body: parseResponse(runDetailsSchema, response.json()) };
}
test("projects durable test and review evidence without private execution metadata or changing completion", async () => {
  database.db.insert(developmentRounds).values(round).run();
  const before = database.db.select().from(developmentRounds).all();
  const { response, body } = await detail();
  expect(body).toMatchObject({
    status: "blocked",
    errorCode: "development_incomplete",
    result: null,
    developmentEvidence: {
      phase: "verified",
      maxRounds: 3,
      rounds: [
        {
          sequence: 1,
          changes: [{ path: "src/main.ts", action: "modify", bytes: 25 }],
          test: {
            status: "passed",
            exitCode: 0,
            elapsedMs: 28,
            recordedAt: now.toISOString(),
          },
          review: { assessment: { complete: true } },
        },
      ],
    },
  });
  for (const privateValue of [
    "/private/",
    "private-image-sentinel",
    "private-command-sentinel",
    "private-engine-sentinel",
    "private-token-sentinel",
    "1".repeat(64),
    secret,
  ])
    expect(response.body).not.toContain(privateValue);
  expect(body.developmentEvidence!.rounds[0]!.test!.output).toContain(
    "[REDACTED]",
  );
  expect(
    body.developmentEvidence!.rounds[0]!.review!.assessment.report,
  ).toContain("[REDACTED]");
  expect(database.db.select().from(developmentRounds).all()).toEqual(before);
  expect(database.db.select().from(tasks).get()!.status).toBe("blocked");
});
test("reports persisted phase boundaries without treating absent test or review results as success", async () => {
  expect((await detail()).body.developmentEvidence).toEqual({
    phase: "preparing",
    maxRounds: 3,
    rounds: [],
  });
  database.db
    .insert(developmentRounds)
    .values({
      ...round,
      input: null,
      preparedAt: null,
      candidate: null,
      capturedAt: null,
      verificationIntent: null,
      verificationInput: null,
      verificationPreparedAt: null,
      verificationResult: null,
      verifiedAt: null,
      review: null,
      reviewedAt: null,
    })
    .run();
  const stages: [string, Partial<typeof developmentRounds.$inferInsert>][] = [
    ["preparing", {}],
    ["developing", { input: round.input, preparedAt: now }],
    [
      "preparing_test",
      {
        candidate: round.candidate,
        capturedAt: now,
        verificationIntent: round.verificationIntent,
      },
    ],
    [
      "testing",
      {
        verificationInput: round.verificationInput,
        verificationPreparedAt: now,
      },
    ],
    [
      "reviewing",
      { verificationResult: round.verificationResult, verifiedAt: now },
    ],
    ["verified", { review: round.review, reviewedAt: now }],
  ];
  for (const [phase, update] of stages) {
    if (Object.keys(update).length)
      database.db
        .update(developmentRounds)
        .set(update)
        .where(eq(developmentRounds.runId, runId))
        .run();
    expect((await detail()).body.developmentEvidence!.phase).toBe(phase);
  }
});
test("keeps failed rounds ordered and isolated from other Runs, including a contradictory old approval", async () => {
  database.db
    .insert(developmentRounds)
    .values([
      {
        ...round,
        verificationResult: {
          ...round.verificationResult!,
          status: "failed",
          exitCode: 1,
        },
      },
      { ...round, sequence: 2, inputId: randomUUID(), executionOffset: 3 },
    ])
    .run();
  const history = (await detail()).body.developmentEvidence!;
  expect(history.phase).toBe("verified");
  expect(history.rounds.map((r) => [r.sequence, r.phase])).toEqual([
    [1, "needs_changes"],
    [2, "verified"],
  ]);
  database.db
    .update(developmentRounds)
    .set({
      review: {
        ...round.review!,
        assessment: {
          report: "Need more evidence",
          evidence: [],
          unresolved: ["Unverified edge case"],
          complete: false,
          next: null,
        },
      },
    })
    .where(eq(developmentRounds.sequence, 2))
    .run();
  expect((await detail()).body.developmentEvidence!.phase).toBe(
    "needs_changes",
  );
  const otherId = randomUUID();
  database.db
    .insert(runs)
    .values({
      id: otherId,
      taskId,
      attempt: 2,
      instanceId: "fixture",
      status: "blocked",
      model: "fixture",
      effort: "medium",
      startedAt: now,
      lastActivityAt: now,
      finishedAt: now,
      terminationConfirmedAt: now,
    })
    .run();
  expect((await detail(otherId)).body.developmentEvidence).toBeNull();
});
