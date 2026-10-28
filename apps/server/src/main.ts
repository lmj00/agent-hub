import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const app = buildApp({ logger: true });
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
  await app.listen(loadConfig(process.env));

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
} catch (error) {
  app.log.error({ err: error }, "Failed to start server");
  await app.close();
  process.exitCode = 1;
}
