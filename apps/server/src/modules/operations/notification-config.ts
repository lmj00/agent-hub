import { createHash } from "node:crypto";
import { readPrivateJson } from "../../private-config.js";

export type NotificationConfig = {
  sourcePath: string;
  url: string;
  bearerToken?: string;
  destinationHash: string;
  pollIntervalMs: number;
  timeoutMs: number;
  graceMs: number;
  initialDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
};

export function loadNotificationConfig(path: string): NotificationConfig {
  // Filesystem errors may include a private path. Startup exposes only a fixed error.
  try {
    const { value, sourcePath } = readPrivateJson(path, "Notification config");
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    const input = value as Record<string, unknown>;
    const fields = [
      "version",
      "url",
      "bearerToken",
      "pollIntervalMs",
      "timeoutMs",
      "graceMs",
      "initialDelayMs",
      "maxDelayMs",
      "maxAttempts",
    ];
    if (
      input.version !== 1 ||
      Object.keys(input).some((key) => !fields.includes(key)) ||
      typeof input.url !== "string" ||
      input.url.length > 2048
    )
      throw new Error();
    const url = new URL(input.url);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error();
    if (
      input.bearerToken !== undefined &&
      (typeof input.bearerToken !== "string" ||
        !/^[\x21-\x7e]{1,2048}$/.test(input.bearerToken))
    )
      throw new Error();
    const integer = (
      key: string,
      fallback: number,
      min: number,
      max: number,
    ) => {
      const v = input[key] ?? fallback;
      if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
        throw new Error();
      return v;
    };
    const config = {
      sourcePath,
      url: url.href,
      ...(input.bearerToken === undefined
        ? {}
        : { bearerToken: input.bearerToken as string }),
      destinationHash: createHash("sha256")
        .update(JSON.stringify([url.href, input.bearerToken ?? null]))
        .digest("hex"),
      pollIntervalMs: integer("pollIntervalMs", 5000, 1000, 60000),
      timeoutMs: integer("timeoutMs", 3000, 100, 10000),
      graceMs: integer("graceMs", 30000, 1000, 300000),
      initialDelayMs: integer("initialDelayMs", 10000, 1000, 3600000),
      maxDelayMs: integer("maxDelayMs", 300000, 1000, 86400000),
      maxAttempts: integer("maxAttempts", 5, 1, 20),
    };
    if (config.maxDelayMs < config.initialDelayMs) throw new Error();
    return config;
  } catch {
    throw new Error(
      "Invalid notification config; check private file, endpoint and limits",
    );
  }
}
