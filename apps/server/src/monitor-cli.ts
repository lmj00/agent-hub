import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadAuthConfig } from "./modules/auth/auth-config.js";
import { readinessToken } from "./modules/auth/readiness-token.js";
import { checkHealth, loadHealthMonitorConfig } from "./modules/operations/health-monitor.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      "auth-config": { type: "string" },
      destination: { type: "string" },
      config: { type: "string" },
    },
  });
  if (positionals.length !== 1) throw new Error("Invalid monitor command");
  if (positionals[0] === "setup" && values["auth-config"] && values.destination && !values.config) {
    const auth = loadAuthConfig(resolve(root, values["auth-config"]));
    const destination = resolve(root, values.destination);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(
      destination,
      JSON.stringify(
        {
          version: 1,
          origin: auth.origin,
          bearerToken: readinessToken(auth),
          timeoutMs: 3000,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    console.log(
      "Private monitor config created. Copy only this file to the external monitor host.",
    );
    return;
  }
  if (positionals[0] !== "check" || !values.config || values["auth-config"] || values.destination)
    throw new Error("Invalid monitor command");
  const config = loadHealthMonitorConfig(resolve(root, values.config));
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const result = await checkHealth(config, controller.signal);
    console.log(JSON.stringify(result));
    if (result.status !== "available") process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
main().catch(() => {
  console.error(
    "Unable to run monitor command. Check private config, arguments and that setup destination does not already exist.",
  );
  process.exitCode = 2;
});
