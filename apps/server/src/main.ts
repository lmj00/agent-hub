import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { loadExecutionConfig } from "./modules/execution/execution-config.js";
import { loadAuthConfig } from "./modules/auth/auth-config.js";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadServiceConfig } from "./modules/services/service-config.js";
import { loadNotificationConfig } from "./modules/operations/notification-config.js";

async function startServer() {
  const {
    databasePath,
    executionConfigPath,
    authConfigPath,
    serviceConfigPath,
    notificationConfigPath,
    localApiOnly,
    ...listenOptions
  } = loadConfig(process.env);
  if (!authConfigPath && !localApiOnly)
    throw new Error(
      "Set AUTH_CONFIG after pnpm auth:setup, or explicitly use LOCAL_API_ONLY=1 for local API development",
    );
  const auth = authConfigPath ? loadAuthConfig(authConfigPath) : undefined;
  const webDirectory = fileURLToPath(new URL("../../web/dist/", import.meta.url));
  const app = buildApp({
    databasePath,
    logger: true,
    ...(auth ? { auth, trustProxy: auth.origin.startsWith("https:") ? "loopback" : false } : {}),
    ...(auth && existsSync(join(webDirectory, "index.html")) ? { webDirectory } : {}),
    ...(executionConfigPath
      ? { execution: { config: loadExecutionConfig(executionConfigPath) } }
      : {}),
    ...(serviceConfigPath ? { services: loadServiceConfig(serviceConfigPath) } : {}),
    ...(notificationConfigPath
      ? { notifications: loadNotificationConfig(notificationConfigPath) }
      : {}),
  });
  if (localApiOnly)
    app.addHook("onRequest", async (request, reply) => {
      const host = request.headers.host ?? "";
      const origin = request.headers.origin;
      if (
        !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host) ||
        request.headers["sec-fetch-site"] === "cross-site" ||
        (origin !== undefined && origin !== `http://${host}`)
      ) {
        return reply.code(403).send({
          error: "ORIGIN_NOT_ALLOWED",
          message: "Local API requests must use a loopback host and matching origin",
        });
      }
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
