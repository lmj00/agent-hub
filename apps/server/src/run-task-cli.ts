import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/connection.js";
import { createDrizzleProjectStore } from "./modules/projects/drizzle-project-store.js";
import { createDrizzleTaskStore } from "./modules/tasks/drizzle-task-store.js";
import { createDrizzleRunStore } from "./modules/execution/drizzle-run-store.js";
import { createCodexExecutor } from "./modules/execution/codex-executor.js";
import { loadExecutionConfig, validateExecutionEnvironment } from "./modules/execution/execution-config.js";
import { acquireExecutionOwner } from "./modules/execution/execution-owner.js";
import { runTask } from "./modules/execution/run-task.js";

async function main() {
  const { values } = parseArgs({ options: { task: { type: "string" }, config: { type: "string" } } });
  if (!values.task || !values.config) throw new Error("Usage: pnpm task:run --task TASK_ID --config /path/to/execution.json");
  const config = loadExecutionConfig(values.config);
  const { databasePath } = loadConfig(process.env);
  const database = openDatabase(databasePath);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let owner: ReturnType<typeof acquireExecutionOwner> | undefined;
  try {
    validateExecutionEnvironment(config, databasePath);
    owner = acquireExecutionOwner(database.db);
    const task = createDrizzleTaskStore(database.db).findById(values.task);
    if (!task) throw new Error("Task not found");
    const project = createDrizzleProjectStore(database.db).findById(task.projectId);
    const workspace = project && config.workspaces.get(project.workspaceKey);
    if (!workspace) throw new Error("No prepared workspace configured for this project");
    const store = createDrizzleRunStore(database.db, owner.token);
    const outcome = await runTask({
      taskId: task.id, workspace, model: config.model, timeoutMs: config.timeoutMs, signal: controller.signal,
    }, store, createCodexExecutor(config.codexHome));
    // 분석 원문은 DB에만 저장하고 CLI에는 조회용 ID와 상태를 표시합니다.
    console.log(JSON.stringify({ runId: outcome.runId, taskId: task.id, status: outcome.status, errorCode: outcome.errorCode }));
    if (outcome.status !== "succeeded") process.exitCode = 1;
  } finally {
    // 결과 저장 실패로 빠져나온 경우에도 SDK가 CLI를 무기한 붙잡지 못하게 합니다.
    // 정상 종료라면 unref 타이머를 기다리지 않습니다.
    setTimeout(() => {
      console.error("CLI shutdown deadline exceeded; inspect execution records");
      process.exit(1);
    }, 10000).unref();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    try { owner?.release(); } finally { database.close(); }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Execution failed");
  process.exitCode = 1;
});
