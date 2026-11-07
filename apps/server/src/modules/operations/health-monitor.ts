import { readPrivateJson } from "../../private-config.js";
import { validateOrigin } from "../auth/auth-config.js";

export type HealthMonitorConfig = {
  origin: string;
  bearerToken: string;
  timeoutMs: number;
};
export type HealthMonitorResult = {
  status: "available" | "unavailable";
  reason:
    | "ready"
    | "authentication_required"
    | "database_unavailable"
    | "http_error"
    | "redirect_refused"
    | "invalid_response"
    | "response_too_large"
    | "timeout"
    | "stopped"
    | "request_failed";
  checkedAt: string;
};

export function loadHealthMonitorConfig(path: string): HealthMonitorConfig {
  const { value } = readPrivateJson(path, "Health monitor config");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid health monitor config");
  const config = value as Record<string, unknown>;
  if (
    config.version !== 1 ||
    Object.keys(config).some(
      (key) => !["version", "origin", "bearerToken", "timeoutMs"].includes(key),
    ) ||
    typeof config.bearerToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(config.bearerToken)
  ) {
    throw new Error("Invalid health monitor config");
  }
  const timeoutMs = config.timeoutMs ?? 3000;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 10000
  ) {
    throw new Error("Invalid health monitor timeout");
  }
  return {
    origin: validateOrigin(config.origin),
    bearerToken: config.bearerToken,
    timeoutMs,
  };
}

class MonitorError extends Error {
  constructor(readonly reason: HealthMonitorResult["reason"]) {
    super(reason);
  }
}

// This checks HTTP and DB availability, never work progress or queue activity.
// URL, credential and remote response text are not part of the public result.
export async function checkHealth(
  config: HealthMonitorConfig,
  signal: AbortSignal,
): Promise<HealthMonitorResult> {
  const deadline = AbortSignal.timeout(config.timeoutMs);
  const requestSignal = AbortSignal.any([signal, deadline]);
  try {
    const response = await fetch(`${config.origin}/health/ready`, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: requestSignal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.bearerToken}`,
      },
    });
    const reject = async (reason: HealthMonitorResult["reason"]): Promise<never> => {
      await response.body?.cancel();
      throw new MonitorError(reason);
    };
    if (response.status >= 300 && response.status < 400) await reject("redirect_refused");
    if (response.status === 401 || response.status === 403) await reject("authentication_required");
    if (response.status !== 200 && response.status !== 503) await reject("http_error");
    if (
      response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json"
    )
      await reject("invalid_response");
    if (Number(response.headers.get("content-length")) > 4096) await reject("response_too_large");
    if (!response.body) throw new MonitorError("invalid_response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 4096) {
          await reader.cancel();
          throw new MonitorError("response_too_large");
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      throw new MonitorError("invalid_response");
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new MonitorError("invalid_response");
    const value = body as Record<string, unknown>;
    const state = response.status === 200 ? "ok" : "unavailable";
    if (
      Object.keys(value).length !== 3 ||
      value.status !== state ||
      value.database !== state ||
      typeof value.checkedAt !== "string" ||
      !Number.isFinite(Date.parse(value.checkedAt)) ||
      new Date(value.checkedAt).toISOString() !== value.checkedAt
    )
      throw new MonitorError("invalid_response");
    if (response.status === 503) throw new MonitorError("database_unavailable");
    return {
      status: "available",
      reason: "ready",
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      status: "unavailable",
      reason: signal.aborted
        ? "stopped"
        : deadline.aborted
          ? "timeout"
          : error instanceof MonitorError
            ? error.reason
            : "request_failed",
      checkedAt: new Date().toISOString(),
    };
  }
}
