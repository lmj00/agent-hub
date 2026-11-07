// 임시 DB·가짜 AI 실행만 사용합니다. 실제 Codex 인증이나 사용자 설정은 읽지 않습니다.
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "../../server/dist/app.js";
import { hashPassword } from "../../server/dist/modules/auth/password.js";
import { loadExecutionConfig } from "../../server/dist/modules/execution/execution-config.js";
import { createAnalysisWorkflow } from "../../server/dist/modules/execution/analysis-workflow.js";
import { AnalysisError } from "../../server/dist/modules/execution/analysis.js";
import { createServer } from "node:http";
import { openDatabase } from "../../server/dist/db/connection.js";
import { createDrizzleProjectStore } from "../../server/dist/modules/projects/drizzle-project-store.js";
import { createDrizzleGoalStore } from "../../server/dist/modules/goals/drizzle-goal-store.js";
import { tasks, runs, steps, developmentRepositories, developmentRounds, changeApplications } from "../../server/dist/db/schema.js";
import { loadRuntimeSkill } from "../../server/dist/modules/execution/runtime-skills.js";
import { preparedInputRoot } from "../../server/dist/modules/goals/prepared-workspace.js";
import { buildPlanningInput } from "../../server/dist/modules/goals/goal-plan-policy.js";
import { loadServiceConfig } from "../../server/dist/modules/services/service-config.js";

const directory = realpathSync(mkdtempSync(join(tmpdir(), "hub-browser-")));
mkdirSync(join(directory, "workspace"));
mkdirSync(join(directory, "codex"));
writeFileSync(
  join(directory, "codex/auth.json"),
  JSON.stringify({ auth_mode: "chatgpt" }),
);
writeFileSync(
  join(directory, "execution.json"),
  JSON.stringify({
    model: "fixture-model",
    codexHome: "codex",
    timeoutMs: 60000,
    effortPolicy: { mode: "adaptive", maxEffort: "xhigh" },
    analysisWorkflow: {},
    automaticRecovery: {
      initialDelayMs: 5000,
      jitterRatio: 0,
      capacity: { initialDelayMs: 5000, maxDelayMs: 10000, jitterRatio: 0 },
    },
    workspaces: { example: "workspace" },
  }),
);
const auth = {
  version: 1,
  sourcePath: join(directory, "auth.json"),
  origin: "http://127.0.0.1:4320",
  sessionSecret: randomBytes(32).toString("hex"),
  password: await hashPassword("browser-fixture-password"),
};
writeFileSync(auth.sourcePath, JSON.stringify(auth), { mode: 0o600 });
const seen = new Set();
const executor = {
  async analyze(request, onEvent) {
    onEvent({ kind: "thread.started", sessionId: randomUUID() });
    onEvent({ kind: "item.started:reasoning" });
    await new Promise((resolve, reject) => {
      const finish = () => {
        request.signal.removeEventListener("abort", abort);
        resolve();
      };
      const timer = setTimeout(
        finish,
        request.instruction.includes("오래") ? 30000 : 200,
      );
      const abort = () => {
        clearTimeout(timer);
        reject(new Error("Fixture cancelled"));
      };
      request.signal.addEventListener("abort", abort, { once: true });
    });
    if (
      !seen.has(request.instruction) &&
      /재개|한도|자동재시도/.test(request.instruction)
    ) {
      seen.add(request.instruction);
      throw new AnalysisError(
        request.instruction.includes("한도")
          ? "capacity"
          : request.instruction.includes("자동재시도")
            ? "transient"
            : "provider_error",
      );
    }
    onEvent({ kind: "item.completed:agent_message" });
    onEvent({ kind: "turn.completed" });
    const sequence = Number(
      /Analysis step (\d+)/.exec(request.instruction)?.[1] ?? 1,
    );
    const continuing =
      request.instruction.includes("다단계 보안 검토") && sequence < 3;
    return {
      output: JSON.stringify({
        report: continuing
          ? `단계 ${sequence}의 부분 분석입니다.`
          : "테스트 분석 결과입니다. <script>window.unwanted=true</script>는 텍스트로 표시합니다.",
        evidence: ["example.ts:1"],
        unresolved: continuing ? ["추가 원인 확인"] : [],
        complete: !continuing,
        next: continuing
          ? {
              purpose: sequence === 1 ? "복잡한 원인 분석" : "최종 요약",
              effort: sequence === 1 ? "xhigh" : "medium",
              reason: "앞 단계의 분석 근거",
            }
          : null,
      }),
      usage: { inputTokens: 120, cachedInputTokens: 0, outputTokens: 80 },
    };
  },
  async confirmTermination() {
    return new Date();
  },
};
const projectId = "00000000-0000-4000-8000-000000000001";
const database = openDatabase(join(directory, "hub.sqlite"));
createDrizzleProjectStore(database.db).save({
  id: projectId,
  name: "관측 예제",
  workspaceKey: "example",
  createdAt: new Date(),
});
const reviewProjectId = randomUUID();
createDrizzleProjectStore(database.db).save({ id: reviewProjectId, name: "범위 재검사 예제", workspaceKey: "example", createdAt: new Date() });
const reviewGoal = createDrizzleGoalStore(database.db).register(reviewProjectId, "scope-review", {
  description: "예제 코드와 테스트 개선", completionCriteria: "테스트로 결과 확인", kind: "finite", priority: 50,
  allowedPaths: ["src", "tests"], excludedPaths: [], checkIntervalMs: 60000, budget: { windowMs: 3600000, maxCalls: 20, maxRunMs: 1800000 },
}).goal;
for (const [title, path] of [["예제 코드 개선 작업", "src/main.ts"], ["예제 테스트 추가 작업", "tests/main.ts"]]) {
  const id = randomUUID();
  database.db.insert(tasks).values({ id, projectId: reviewProjectId, goalId: reviewGoal.id, goalVersion: 1, instruction: title, requestKey: id, createdAt: new Date(),
    plannedWork: { planningTaskId: randomUUID(), problemKey: path, sourceRevision: "a".repeat(40), sourceDigest: "b".repeat(64), title, paths: [path], acceptanceCriteria: "테스트 통과", evidence: ["예제 파일"] },
  }).run();
}
const releaseProjectId = randomUUID();
createDrizzleProjectStore(database.db).save({ id: releaseProjectId, name: "취소 재허용 예제", workspaceKey: "example", createdAt: new Date() });
const releaseGoal = createDrizzleGoalStore(database.db).register(releaseProjectId, "release", {
  ...reviewGoal.definition, description: "취소한 개선 작업 관리",
}).goal;
const releaseTaskId = randomUUID();
database.db.insert(tasks).values({ id: releaseTaskId, projectId: releaseProjectId, goalId: releaseGoal.id, goalVersion: 1,
  instruction: "취소 기록을 이어받을 개선 작업", requestKey: releaseTaskId, status: "cancelled", cancelRequestedAt: new Date(), createdAt: new Date(),
  plannedWork: { planningTaskId: randomUUID(), problemKey: "release", sourceRevision: "a".repeat(40), sourceDigest: "b".repeat(64), title: "개선", paths: ["src/main.ts"], acceptanceCriteria: "테스트 통과", evidence: ["예제 파일"] },
}).run();
const evidenceProjectId = randomUUID();
createDrizzleProjectStore(database.db).save({ id: evidenceProjectId, name: "관측 계획 예제", workspaceKey: "example", createdAt: new Date() });
const evidenceGoal = createDrizzleGoalStore(database.db).register(evidenceProjectId, "evidence", { ...reviewGoal.definition, description: "관측을 참고한 다음 작업 계획" }).goal;
const evidenceTaskId = randomUUID(), evidenceRunId = randomUUID(), capturedAt = new Date().toISOString();
const planningInput = buildPlanningInput({ goalId: evidenceGoal.id, goalVersion: 1, definition: evidenceGoal.definition, capturedAt, history: [], historyCount: 0, suppressedWork: [], suppressedWorkCount: 0,
  services: [{ key: "sample", name: "기록 처리 서비스", enabled: true, state: "unavailable", reason: "http_error",
    latest: { id: randomUUID(), receivedAt: capturedAt, success: false, errorCode: "http_error", snapshot: null },
    lastSuccessful: { id: randomUUID(), receivedAt: new Date(Date.now() - 60000).toISOString(), success: true, errorCode: null,
      snapshot: { observedAt: new Date(Date.now() - 60000).toISOString(), processState: "running", activityState: "waiting", lastSuccessAt: null, nextExpectedAt: null, errorCount: 0, summary: "과거 입력 대기 <script>window.planningUnwanted=true</script>" } },
  }],
}, { id: randomUUID(), runId: evidenceRunId, directory: "/fixture-only/prepared", source: "/fixture-only/source", scope: { goalId: evidenceGoal.id, goalVersion: 1, allowedPaths: ["src"], excludedPaths: [] }, phase: "ready", revision: "a".repeat(40), digest: "b".repeat(64), files: [{ path: "src/main.ts", blob: "c".repeat(40), bytes: 10 }] });
database.db.insert(tasks).values({ id: evidenceTaskId, projectId: evidenceProjectId, kind: "planning", goalId: evidenceGoal.id, goalVersion: 1, instruction: "관측을 확인한 계획 기록", requestKey: evidenceTaskId, status: "succeeded", createdAt: new Date() }).run();
database.db.insert(runs).values({ id: evidenceRunId, taskId: evidenceTaskId, instanceId: "fixture", status: "succeeded", goalVersion: 1, model: "fixture", effort: "medium", startedAt: new Date(), lastActivityAt: new Date(), finishedAt: new Date(), terminationConfirmedAt: new Date(), result: "최신 관측을 다시 수집한 뒤 판단합니다.", planningInput }).run();
// Historical read-side fixture: no real model, Git write or test execution is
// represented by these rows. Runtime suites cover their authoritative writers.
const developmentProjectId = randomUUID(), developmentTaskId = randomUUID(), developmentRunId = randomUUID(), repositoryId = randomUUID();
// Persisted read-side examples only; this fixture never invokes a model.
const skillProjectId = randomUUID(), skillTime = new Date();
createDrizzleProjectStore(database.db).save({ id: skillProjectId, name: "지침 기록 예제", workspaceKey: "example", createdAt: skillTime });
for (const [title, role, loaded] of [["읽기 확인 기록", "analyst", true], ["선택만 된 기록", "planner", false], ["선택 전 중단 기록", null, false]]) {
  const taskId = randomUUID();
  database.db.insert(tasks).values({ id: taskId, projectId: skillProjectId, instruction: title, requestKey: taskId, status: "blocked", createdAt: skillTime }).run();
  for (const attempt of [1, 2]) {
    const runId = randomUUID();
    const selection = attempt === 2 && role ? loadRuntimeSkill(role).selection : null;
    database.db.insert(runs).values({ id: runId, taskId, attempt, instanceId: "fixture", status: "blocked", runtimeSkillVersion: attempt === 2 ? 1 : null, model: "fixture", effort: "medium", startedAt: skillTime, lastActivityAt: skillTime, finishedAt: skillTime, terminationConfirmedAt: skillTime, errorCode: "unsupported_settings" }).run();
    database.db.insert(steps).values({ id: randomUUID(), runId, sequence: 1, status: "blocked", startedAt: skillTime, finishedAt: skillTime, runtimeSkill: selection, runtimeSkillSelectedAt: selection ? skillTime : null, runtimeSkillLoadedAt: selection && loaded ? skillTime : null }).run();
  }
}
const timestamp = new Date();
createDrizzleProjectStore(database.db).save({ id: developmentProjectId, name: "개발 검증 예제", workspaceKey: "example", createdAt: timestamp });
database.db.insert(tasks).values({ id: developmentTaskId, projectId: developmentProjectId, instruction: "계산 오류 수정 기록", requestKey: developmentTaskId, status: "blocked", createdAt: timestamp }).run();
database.db.insert(runs).values({ id: developmentRunId, taskId: developmentTaskId, instanceId: "fixture", status: "blocked", developmentVersion: 1, model: "fixture", effort: "medium", startedAt: timestamp, lastActivityAt: timestamp, finishedAt: timestamp, terminationConfirmedAt: timestamp, errorCode: "development_incomplete" }).run();
database.db.insert(developmentRepositories).values({ id: repositoryId, projectId: developmentProjectId, createdByRunId: developmentRunId, intent: { id: repositoryId, projectId: developmentProjectId, directory: join(directory, "private-repository"), source: join(directory, "workspace") }, createdAt: timestamp }).run();
const developmentInputRoot = preparedInputRoot(join(directory, "hub.sqlite"));
const stoppedTaskId = randomUUID();
database.db.insert(tasks).values({ id: stoppedTaskId, projectId: developmentProjectId, instruction: "준비 중단 기록", requestKey: stoppedTaskId, status: "cancelled", createdAt: timestamp }).run();
database.db.insert(runs).values({ id: randomUUID(), taskId: stoppedTaskId, instanceId: "fixture", status: "cancelled", developmentVersion: 1, model: "fixture", effort: "medium", startedAt: timestamp, lastActivityAt: timestamp, finishedAt: timestamp, terminationConfirmedAt: timestamp, stopReason: "user_cancel" }).run();
for (const sequence of [1, 2]) {
  const inputId = randomUUID(), testInputId = randomUUID();
  const intent = { id: inputId, runId: developmentRunId, repositoryId, directory: join(developmentInputRoot, `${developmentRunId}-${inputId}`, "workspace"), revision: "a".repeat(40), tree: "b".repeat(40), previousCandidate: null, scope: { goalId: randomUUID(), goalVersion: 1, allowedPaths: ["src"], excludedPaths: [] }, writePaths: ["src"] };
  const input = { ...intent, files: [{ path: "src/calculate.ts", blob: "c".repeat(40), bytes: 24 }], digest: "d".repeat(64) };
  const candidate = { repositoryId, runId: developmentRunId, baseRevision: input.revision, inputDigest: input.digest, tree: "e".repeat(40), digest: String(sequence).repeat(64), changes: [{ path: "src/calculate.ts", before: "c".repeat(40), after: "b".repeat(40), mode: "100644", bytes: 32 }] };
  const testIntent = { ...intent, id: testInputId, directory: join(developmentInputRoot, `${developmentRunId}-${testInputId}`, "workspace"), previousCandidate: candidate.digest, tree: candidate.tree };
  const configuration = { image: "fixture:local", command: ["node", "tests/calculate.js"], timeoutMs: 1000 };
  const execution = { kind: "docker", containerId: "1".repeat(64), engineId: "fixture", token: randomUUID() };
  database.db.insert(developmentRounds).values({ runId: developmentRunId, sequence, repositoryId, inputId, planningRevision: input.revision, intent, input, candidate, executionOffset: (sequence - 1) * 3, createdAt: timestamp, preparedAt: timestamp, capturedAt: timestamp,
    verificationIntent: { candidateDigest: candidate.digest, input: testIntent, configuration }, verificationInput: { ...testIntent, files: input.files, digest: "f".repeat(64) }, verificationPreparedAt: timestamp,
    verificationResult: { candidateDigest: candidate.digest, inputDigest: "f".repeat(64), configurationDigest: "2".repeat(64), configuration, execution, imageId: `sha256:${"3".repeat(64)}`, status: sequence === 1 ? "failed" : "passed", exitCode: sequence === 1 ? 1 : 0, oomKilled: false, elapsedMs: 280, output: sequence === 1 ? "AssertionError: expected 6, received -1\n<script>window.developmentUnwanted=true</script>" : "1 test passed" }, verifiedAt: timestamp,
    review: { candidateDigest: candidate.digest, verificationDigest: "4".repeat(64), execution, stepSequence: sequence * 2, assessment: { report: sequence === 1 ? "계산식이 기대 결과와 다릅니다." : "수정된 계산식과 실제 테스트 결과를 확인했습니다.", evidence: ["src/calculate.ts"], unresolved: sequence === 1 ? ["곱셈 결과 확인 필요"] : [], complete: sequence === 2, next: sequence === 1 ? { purpose: "곱셈으로 계산식을 수정하세요.", effort: "medium", reason: "테스트 실패" } : null } }, reviewedAt: timestamp,
  }).run();
}
// Separate read-side examples distinguish applied code from the Task outcome.
for (const [title, status, outcome] of [["반영 완료 기록", "applied", "succeeded"], ["반영 확인 대기 기록", "pending", "blocked"], ["반영 후 취소 기록", "applied", "cancelled"]]) {
  const taskId = randomUUID(), runId = randomUUID();
  database.db.insert(tasks).values({ id: taskId, projectId: developmentProjectId, instruction: title, requestKey: taskId, status: outcome, cancelRequestedAt: outcome === "cancelled" ? timestamp : null, createdAt: timestamp }).run();
  database.db.insert(runs).values({ id: runId, taskId, instanceId: "fixture", status: outcome, developmentVersion: 1, model: "fixture", effort: "medium", startedAt: timestamp, lastActivityAt: timestamp, finishedAt: timestamp, terminationConfirmedAt: timestamp, stopReason: outcome === "cancelled" ? "user_cancel" : null, errorCode: outcome === "blocked" ? "development_incomplete" : null }).run();
  database.db.insert(changeApplications).values({ id: randomUUID(), taskId, runId, repositoryId, roundSequence: 2, goalVersion: 1, baseRevision: "a".repeat(40), tree: "b".repeat(40), candidateDigest: "c".repeat(64), evidenceDigest: "d".repeat(64), resultCommit: "e".repeat(40), targetRef: "refs/heads/development", status, createdAt: timestamp, appliedAt: status === "applied" ? timestamp : null }).run();
}
database.close();
let serviceMode = "waiting";
const service = createServer((request, response) => {
  if (
    request.method === "POST" &&
    /^\/fixture\/(waiting|failure|stale)$/.test(request.url ?? "")
  ) {
    serviceMode = request.url.split("/").at(-1);
    response.end("fixture updated");
    return;
  }
  if (request.method !== "GET" || request.url !== "/status") {
    response.writeHead(404);
    response.end();
    return;
  }
  if (serviceMode === "failure") {
    response.writeHead(503);
    response.end();
    return;
  }
  const now = Date.now();
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({
      observedAt: new Date(
        now - (serviceMode === "stale" ? 60000 : 0),
      ).toISOString(),
      processState: "running",
      activityState: "waiting",
      lastSuccessAt: new Date(now - 3600000).toISOString(),
      nextExpectedAt: null,
      errorCount: 0,
      summary: "새 학습 기록이 들어오기를 기다립니다.",
    }),
  );
});
await new Promise((resolve, reject) => {
  service.once("error", reject);
  service.listen(4321, "127.0.0.1", resolve);
});
const serviceFile = join(directory, "services.json");
writeFileSync(
  serviceFile,
  JSON.stringify({
    version: 1,
    targets: [
      {
        key: "study-service",
        projectId,
        name: "학습 기록 처리",
        url: "http://127.0.0.1:4321/status",
        intervalMs: 1000,
        staleAfterMs: 10000,
      },
    ],
  }),
  { mode: 0o600 },
);
const app = buildApp({
  databasePath: join(directory, "hub.sqlite"),
  auth,
  services: loadServiceConfig(serviceFile),
  webDirectory: fileURLToPath(new URL("../dist/", import.meta.url)),
  execution: {
    config: loadExecutionConfig(join(directory, "execution.json")),
    executor: createAnalysisWorkflow(executor),
    pollIntervalMs: 100,
  },
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    await app.close();
    service.closeAllConnections();
    await new Promise((resolve) => service.close(resolve));
    rmSync(directory, { recursive: true, force: true });
    process.exit(0);
  });
await app.listen({ host: "127.0.0.1", port: 4320 });
