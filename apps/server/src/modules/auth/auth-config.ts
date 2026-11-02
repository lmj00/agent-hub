import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
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
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let value: unknown;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 8192 || (stat.mode & 0o077) !== 0) throw new Error("Authentication config must be a private regular file (chmod 600)");
    try { value = JSON.parse(readFileSync(descriptor, "utf8")); }
    catch { throw new Error("Authentication config must contain valid JSON"); }
  } finally { closeSync(descriptor); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid authentication config");
  const config = value as Record<string, unknown>;
  if (Object.keys(config).some(key => !["version", "origin", "sessionSecret", "password"].includes(key)) || config.version !== 1) throw new Error("Unsupported authentication config");
  const origin = validateOrigin(config.origin);
  if (typeof config.sessionSecret !== "string" || !/^[a-f0-9]{64}$/.test(config.sessionSecret)) throw new Error("Session secret must be 32 random bytes encoded as hex");
  const password = config.password as Partial<PasswordHash> | undefined;
  if (!password || typeof password.salt !== "string" || !/^[a-f0-9]{32}$/.test(password.salt)
    || typeof password.hash !== "string" || !/^[a-f0-9]{128}$/.test(password.hash)) throw new Error("Invalid scrypt password hash");
  return { sourcePath: realpathSync(path), origin, sessionSecret: config.sessionSecret, password: { salt: password.salt, hash: password.hash } };
}
