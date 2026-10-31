import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// src/와 dist/에서 모두 같은 저장소 루트를 기준으로 경로를 해석합니다.
const repositoryDirectory = fileURLToPath(new URL("../../../", import.meta.url));

export function loadConfig(env: NodeJS.ProcessEnv) {
  const portText = env.PORT ?? "3000";
  const port = Number(portText);

  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  const databasePath = env.DATABASE_PATH ?? "data/agent-hub.sqlite";
  if (databasePath.trim() === "" || databasePath === ":memory:" || databasePath.includes("\0")) {
    throw new Error("DATABASE_PATH must be a non-empty file path.");
  }

  return { host: "127.0.0.1", port, databasePath: resolve(repositoryDirectory, databasePath) };
}
