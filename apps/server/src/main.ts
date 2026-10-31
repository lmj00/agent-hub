import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

async function startServer() {
  const { databasePath, ...listenOptions } = loadConfig(process.env);
  const app = buildApp({ databasePath, logger: true });
  let closing = false;

  async function shutdown(signal: NodeJS.Signals) {
    if (closing) return;
    closing = true;

    app.log.info({ signal }, "Closing server");

    try {
      await app.close();
    } catch (error) {
      app.log.error({ err: error }, "Failed to close server");
      process.exitCode = 1;
    }
  }

  try {
    await app.listen(listenOptions);

    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
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
