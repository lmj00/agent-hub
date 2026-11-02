import { readPrivateJson } from "../../private-config.js";
import type { PasswordHash } from "./password.js";

export type AuthConfig = { sourcePath: string; origin: string; sessionSecret: string; password: PasswordHash };

export function validateOrigin(value: unknown): string {
  if (typeof value !== "string") throw new Error("An explicit application origin is required");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid application origin"); }
  if (url.origin !== value || url.username || url.password || !["http:", "https:"].includes(url.protocol)) throw new Error("Use an origin without a path, query or credentials");
  if (url.protocol === "http:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("HTTP authentication is allowed only on loopback hosts");
  return url.origin;
}

export function loadAuthConfig(path: string): AuthConfig {
  const { value, sourcePath } = readPrivateJson(path, "Authentication config");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid authentication config");
  const config = value as Record<string, unknown>;
  if (Object.keys(config).some(key => !["version", "origin", "sessionSecret", "password"].includes(key)) || config.version !== 1) throw new Error("Unsupported authentication config");
  const origin = validateOrigin(config.origin);
  if (typeof config.sessionSecret !== "string" || !/^[a-f0-9]{64}$/.test(config.sessionSecret)) throw new Error("Session secret must be 32 random bytes encoded as hex");
  const password = config.password as Partial<PasswordHash> | undefined;
  if (!password || typeof password.salt !== "string" || !/^[a-f0-9]{32}$/.test(password.salt)
    || typeof password.hash !== "string" || !/^[a-f0-9]{128}$/.test(password.hash)) throw new Error("Invalid scrypt password hash");
  return { sourcePath, origin, sessionSecret: config.sessionSecret, password: { salt: password.salt, hash: password.hash } };
}
