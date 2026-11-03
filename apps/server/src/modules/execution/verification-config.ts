import { createHash } from "node:crypto";
import type { ExecutionIdentity } from "./analysis.js";

export type VerificationConfig = {
  image: string;
  command: string[];
  timeoutMs: number;
};
export type VerificationRequest = {
  candidateDigest: string;
  config: VerificationConfig;
};
export type VerificationResult = {
  candidateDigest: string;
  inputDigest: string;
  configurationDigest: string;
  configuration: VerificationConfig;
  execution: ExecutionIdentity;
  imageId: string;
  status: "passed" | "failed" | "timed_out" | "output_limit";
  exitCode: number;
  oomKilled: boolean;
  elapsedMs: number;
  output: string;
};

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const validContainerImage = (image: unknown): image is string =>
  typeof image === "string" &&
  /^[a-zA-Z0-9][a-zA-Z0-9./_:@-]{0,199}$/.test(image);

export function parseVerificationConfig(value: unknown): VerificationConfig {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) => !["image", "command", "timeoutMs"].includes(key),
    ) ||
    !validContainerImage(value.image) ||
    !Array.isArray(value.command) ||
    !value.command.length ||
    value.command.length > 32 ||
    value.command.some(
      (part) =>
        typeof part !== "string" ||
        !part ||
        part.includes("\0") ||
        Buffer.byteLength(part) > 2048,
    )
  )
    throw new Error(
      "Verification requires a local image and a bounded command argument array",
    );
  const timeoutMs = value.timeoutMs ?? 60000;
  if (
    !Number.isInteger(timeoutMs) ||
    Number(timeoutMs) < 1000 ||
    Number(timeoutMs) > 300000
  )
    throw new Error("Verification timeoutMs must be between 1000 and 300000");
  return {
    image: value.image,
    command: [...value.command] as string[],
    timeoutMs: Number(timeoutMs),
  };
}

export function parseVerificationRequest(value: unknown): VerificationRequest {
  if (
    !object(value) ||
    Object.keys(value).length !== 2 ||
    typeof value.candidateDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.candidateDigest)
  )
    throw new Error("Verification requires the exact candidate digest");
  return {
    candidateDigest: value.candidateDigest,
    config: parseVerificationConfig(value.config),
  };
}

export function verificationConfigDigest(config: VerificationConfig) {
  return createHash("sha256")
    .update(JSON.stringify(parseVerificationConfig(config)))
    .digest("hex");
}

export function parseVerificationWorkspaces(
  value: unknown,
  keys: Iterable<string>,
) {
  if (!object(value))
    throw new Error("verification must map workspace keys to test settings");
  const allowed = new Set(keys),
    result = new Map<string, VerificationConfig>();
  for (const [key, config] of Object.entries(value)) {
    if (!allowed.has(key))
      throw new Error("Verification workspace is not configured");
    result.set(key, parseVerificationConfig(config));
  }
  if (!result.size)
    throw new Error("verification must contain at least one workspace");
  return result;
}
