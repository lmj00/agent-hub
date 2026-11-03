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
import { tasks, runs } from "../../server/dist/db/schema.js";
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
