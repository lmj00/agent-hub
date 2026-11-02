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
import { AnalysisError } from "../../server/dist/modules/execution/analysis.js";
import { createServer } from "node:http";
import { openDatabase } from "../../server/dist/db/connection.js";
import { createDrizzleProjectStore } from "../../server/dist/modules/projects/drizzle-project-store.js";
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
    return {
      output:
        "테스트 분석 결과입니다. <script>window.unwanted=true</script>는 텍스트로 표시합니다.",
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
    executor,
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
