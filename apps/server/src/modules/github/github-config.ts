import { createPrivateKey, type KeyObject } from "node:crypto";
import { readPrivateJson } from "../../private-config.js";

export type GitHubConfig = {
  sourcePath: string;
  appId: number;
  installationId: number;
  ownerId: number;
  privateKey: KeyObject;
  allowRepositoryCreation?: boolean;
};

export function loadGitHubConfig(path: string): GitHubConfig {
  const { value, sourcePath } = readPrivateJson(path, "GitHub config", 16384);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid GitHub config");
  const config = value as Record<string, unknown>;
  if (
    config.version !== 1 ||
    Object.keys(config).some(
      (key) =>
        ![
          "version",
          "appId",
          "installationId",
          "ownerId",
          "privateKey",
          "allowRepositoryCreation",
        ].includes(key),
    )
  )
    throw new Error("Unsupported GitHub config");
  if (
    config.allowRepositoryCreation !== undefined &&
    typeof config.allowRepositoryCreation !== "boolean"
  )
    throw new Error("GitHub allowRepositoryCreation must be a boolean");
  for (const key of ["appId", "installationId", "ownerId"]) {
    if (!Number.isSafeInteger(config[key]) || (config[key] as number) < 1)
      throw new Error(`GitHub ${key} must be a positive integer`);
  }
  let privateKey: KeyObject;
  try {
    if (typeof config.privateKey !== "string") throw new Error();
    privateKey = createPrivateKey(config.privateKey);
    if (
      privateKey.asymmetricKeyType !== "rsa" ||
      (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    )
      throw new Error();
  } catch {
    throw new Error("GitHub config requires an RSA private key of at least 2048 bits");
  }
  return {
    sourcePath,
    appId: config.appId as number,
    installationId: config.installationId as number,
    ownerId: config.ownerId as number,
    privateKey,
    allowRepositoryCreation: config.allowRepositoryCreation === true,
  };
}
