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

  const executionPath = env.EXECUTION_CONFIG;
  if (
    executionPath !== undefined &&
    (executionPath.trim() === "" || executionPath.includes("\0"))
  ) {
    throw new Error("EXECUTION_CONFIG must be a non-empty file path when set.");
  }
  const authPath = env.AUTH_CONFIG;
  const githubPath = env.GITHUB_CONFIG;
  if (githubPath !== undefined && (!githubPath.trim() || githubPath.includes("\0")))
    throw new Error("GITHUB_CONFIG must be a non-empty file path when set.");
  if (authPath !== undefined && (!authPath.trim() || authPath.includes("\0")))
    throw new Error("AUTH_CONFIG must be a non-empty file path when set.");
  if (env.LOCAL_API_ONLY !== undefined && env.LOCAL_API_ONLY !== "1")
    throw new Error("LOCAL_API_ONLY must be 1 when set.");
  if (authPath && env.LOCAL_API_ONLY)
    throw new Error("AUTH_CONFIG and LOCAL_API_ONLY cannot be used together.");
  const servicePath = env.SERVICE_CONFIG;
  if (servicePath !== undefined && (!servicePath.trim() || servicePath.includes("\0")))
    throw new Error("SERVICE_CONFIG must be a non-empty file path when set.");
  const notificationPath = env.NOTIFICATION_CONFIG;
  if (
    notificationPath !== undefined &&
    (!notificationPath.trim() || notificationPath.includes("\0"))
  )
    throw new Error("NOTIFICATION_CONFIG must be a non-empty file path when set.");
  return {
    host: "127.0.0.1",
    port,
    databasePath: resolve(repositoryDirectory, databasePath),
    localApiOnly: env.LOCAL_API_ONLY === "1",
    ...(authPath === undefined ? {} : { authConfigPath: resolve(repositoryDirectory, authPath) }),
    ...(githubPath === undefined
      ? {}
      : { githubConfigPath: resolve(repositoryDirectory, githubPath) }),
    ...(executionPath === undefined
      ? {}
      : { executionConfigPath: resolve(repositoryDirectory, executionPath) }),
    ...(servicePath === undefined
      ? {}
      : { serviceConfigPath: resolve(repositoryDirectory, servicePath) }),
    ...(notificationPath === undefined
      ? {}
      : { notificationConfigPath: resolve(repositoryDirectory, notificationPath) }),
  };
}
