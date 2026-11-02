import { createHash } from "node:crypto";
import { readPrivateJson } from "../../private-config.js";

export type ServiceTargetConfig = {
  key: string;
  projectId: string;
  name: string;
  url: string;
  bearerToken?: string;
  intervalMs: number;
  timeoutMs: number;
  staleAfterMs: number;
  allowWaiting: boolean;
  activityTimeoutMs: number | null;
  fingerprint: string;
};
export type ServiceConfig = {
  sourcePath: string;
  targets: ServiceTargetConfig[];
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid service observation config");
  return value as Record<string, unknown>;
}
function integer(value: unknown, fallback: number, min: number, max: number) {
  const result = value ?? fallback;
  if (
    typeof result !== "number" ||
    !Number.isInteger(result) ||
    result < min ||
    result > max
  )
    throw new Error("Invalid service observation interval or limit");
  return result;
}
export function loadServiceConfig(path: string): ServiceConfig {
  const { value, sourcePath } = readPrivateJson(
    path,
    "Service observation config",
    65536,
  );
  const config = record(value);
  if (
    config.version !== 1 ||
    Object.keys(config).some((key) => !["version", "targets"].includes(key)) ||
    !Array.isArray(config.targets) ||
    config.targets.length > 10
  )
    throw new Error(
      "Service observation config requires version 1 and at most 10 targets",
    );
  const keys = new Set<string>();
  const targets = config.targets.map((raw) => {
    const target = record(raw);
    const fields = [
      "key",
      "projectId",
      "name",
      "url",
      "bearerToken",
      "intervalMs",
      "timeoutMs",
      "staleAfterMs",
      "allowWaiting",
      "activityTimeoutMs",
    ];
    if (Object.keys(target).some((key) => !fields.includes(key)))
      throw new Error("Unknown service observation config field");
    if (
      typeof target.key !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(target.key) ||
      keys.has(target.key)
    )
      throw new Error("Service target keys must be valid and unique");
    keys.add(target.key);
    if (
      typeof target.projectId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        target.projectId,
      )
    )
      throw new Error("Service target projectId must be a project UUID");
    if (
      typeof target.name !== "string" ||
      !target.name.trim() ||
      target.name.length > 100
    )
      throw new Error(
        "Service target name is required (at most 100 characters)",
      );
    let url: URL;
    try {
      if (typeof target.url !== "string" || target.url.length > 2048)
        throw new Error();
      url = new URL(target.url);
    } catch {
      throw new Error("Invalid service observation URL");
    }
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new Error(
        "Service observation requires an HTTP(S) URL without credentials, query or fragment",
      );
    if (
      url.protocol === "http:" &&
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
      throw new Error(
        "Unencrypted service observation is allowed only on loopback hosts",
      );
    if (
      target.bearerToken !== undefined &&
      (typeof target.bearerToken !== "string" ||
        !/^[A-Za-z0-9._~+/-]{1,4096}={0,2}$/.test(target.bearerToken))
    )
      throw new Error("Invalid service observation bearer token");
    const intervalMs = integer(target.intervalMs, 15000, 1000, 3600000);
    const timeoutMs = integer(target.timeoutMs, 3000, 100, 5000);
    const staleAfterMs = integer(
      target.staleAfterMs,
      Math.max(60000, intervalMs * 2),
      intervalMs * 2,
      86400000,
    );
    if (
      target.allowWaiting !== undefined &&
      typeof target.allowWaiting !== "boolean"
    )
      throw new Error("Service allowWaiting must be a boolean");
    const activityTimeoutMs =
      target.activityTimeoutMs === undefined ||
      target.activityTimeoutMs === null
        ? null
        : integer(target.activityTimeoutMs, 0, 1000, 604800000);
    const normalized = {
      key: target.key,
      projectId: target.projectId,
      name: target.name.trim(),
      url: url.href,
      intervalMs,
      timeoutMs,
      staleAfterMs,
      allowWaiting: target.allowWaiting ?? true,
      activityTimeoutMs,
    };
    // 연결 대상·판단 정책을 바꾸면 이전 성공을 새 설정의 정상 근거로 사용하지 않습니다.
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          ...normalized,
          bearerToken: target.bearerToken ?? null,
        }),
      )
      .digest("hex");
    return {
      ...normalized,
      fingerprint,
      ...(typeof target.bearerToken === "string"
        ? { bearerToken: target.bearerToken }
        : {}),
    };
  });
  return { sourcePath, targets };
}
