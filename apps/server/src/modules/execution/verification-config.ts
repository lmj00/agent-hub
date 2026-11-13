import { createHash } from "node:crypto";
import { redactOutput, type ExecutionIdentity } from "./analysis.js";

export type VerificationConfig = {
  image: string;
  command: string[];
  timeoutMs: number | null;
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
  typeof image === "string" && /^[a-zA-Z0-9][a-zA-Z0-9./_:@-]{0,199}$/.test(image);

export function parseVerificationConfig(value: unknown): VerificationConfig {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !["image", "command", "timeoutMs"].includes(key)) ||
    !validContainerImage(value.image) ||
    !Array.isArray(value.command) ||
    !value.command.length ||
    value.command.length > 32 ||
    value.command.some(
      (part) =>
        typeof part !== "string" || !part || part.includes("\0") || Buffer.byteLength(part) > 2048,
    )
  )
    throw new Error("Verification requires a local image and a bounded command argument array");
  const timeoutMs = value.timeoutMs === undefined ? 60000 : value.timeoutMs;
  if (
    timeoutMs !== null &&
    (!Number.isInteger(timeoutMs) || Number(timeoutMs) < 1000 || Number(timeoutMs) > 300000)
  )
    throw new Error("Verification timeoutMs must be null or between 1000 and 300000");
  return {
    image: value.image,
    command: [...value.command] as string[],
    timeoutMs: timeoutMs === null ? null : Number(timeoutMs),
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

// Only the parent executor supplies this record. Validate again at the durable
// boundary so a malformed/contradictory result never becomes review evidence.
export function parseVerificationResult(value: unknown): VerificationResult {
  if (!object(value)) throw new Error("Invalid verification result");
  const configuration = parseVerificationConfig(value.configuration);
  const execution = value.execution;
  if (
    Object.keys(value).length !== 11 ||
    ![value.candidateDigest, value.inputDigest, value.configurationDigest].every(
      (part) => typeof part === "string" && /^[a-f0-9]{64}$/.test(part),
    ) ||
    value.configurationDigest !== verificationConfigDigest(configuration) ||
    !object(execution) ||
    Object.keys(execution).length !== 4 ||
    execution.kind !== "docker" ||
    typeof execution.containerId !== "string" ||
    !/^[a-f0-9]{64}$/.test(execution.containerId) ||
    [execution.token, execution.engineId].some(
      (part) => typeof part !== "string" || !part || part.length > 200,
    ) ||
    typeof value.imageId !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.imageId) ||
    typeof value.status !== "string" ||
    !["passed", "failed", "timed_out", "output_limit"].includes(value.status) ||
    !Number.isInteger(value.exitCode) ||
    Number(value.exitCode) < 0 ||
    Number(value.exitCode) > 255 ||
    typeof value.oomKilled !== "boolean" ||
    !Number.isSafeInteger(value.elapsedMs) ||
    Number(value.elapsedMs) < 0 ||
    typeof value.output !== "string" ||
    Buffer.byteLength(value.output) > 65536 ||
    (value.status === "passed" && (value.exitCode !== 0 || value.oomKilled)) ||
    (value.status === "failed" && value.exitCode === 0 && !value.oomKilled)
  )
    throw new Error("Invalid verification result");
  return {
    candidateDigest: value.candidateDigest as string,
    inputDigest: value.inputDigest as string,
    configurationDigest: value.configurationDigest as string,
    configuration,
    execution: {
      kind: "docker",
      containerId: execution.containerId,
      token: execution.token as string,
      engineId: execution.engineId as string,
    },
    imageId: value.imageId,
    status: value.status as VerificationResult["status"],
    exitCode: Number(value.exitCode),
    oomKilled: value.oomKilled,
    elapsedMs: Number(value.elapsedMs),
    output: redactOutput(value.output),
  };
}

export function verificationResultDigest(result: VerificationResult) {
  return createHash("sha256")
    .update(JSON.stringify(parseVerificationResult(result)))
    .digest("hex");
}

export function parseVerificationWorkspaces(value: unknown, keys: Iterable<string>) {
  if (!object(value)) throw new Error("verification must map workspace keys to test settings");
  const allowed = new Set(keys),
    result = new Map<string, VerificationConfig>();
  for (const [key, config] of Object.entries(value)) {
    if (!allowed.has(key)) throw new Error("Verification workspace is not configured");
    result.set(key, parseVerificationConfig(config));
  }
  if (!result.size) throw new Error("verification must contain at least one workspace");
  return result;
}
