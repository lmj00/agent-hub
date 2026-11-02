import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { loadExecutionConfig } from "./modules/execution/execution-config.js";

async function startServer() {
  const { databasePath, executionConfigPath, ...listenOptions } = loadConfig(process.env);
  const app = buildApp({
    databasePath, logger: true,
    ...(executionConfigPath ? { execution: { config: loadExecutionConfig(executionConfigPath) } } : {}),
  });
  let closing = false;

  async function shutdown(signal: NodeJS.Signals) {
    if (closing) return;
    closing = true;

    app.log.info({ signal }, "Closing server");
    // HTTP·DB가 닫혀도 SDK 자식이 프로세스를 붙잡을 수 있어 타이머를 유지합니다.
    // unref이므로 정상 종료를 늦추지 않으며, 남은 Run은 다음 시작에서 신규 실행을 막습니다.
    const deadline = setTimeout(() => {
      app.log.error("Shutdown deadline exceeded; execution records require inspection");
      process.exit(1);
    }, 10000);
    deadline.unref();

    try {
      await app.close();
    } catch (error) {
      app.log.error({ err: error }, "Failed to close server");
      process.exitCode = 1;
    }
  }

  try {
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    await app.listen(listenOptions);
  } catch (error) {
    app.log.error({ err: error }, "Failed to start server");
    await app.close();
    process.exitCode = 1;
  }
}

startServer().catch((error: unknown) => {
  console.error("Failed to initialize server", error);
  process.exitCode = 1;
});
