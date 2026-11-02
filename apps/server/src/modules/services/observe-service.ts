import {
  parseResponse,
  serviceSnapshotSchema,
  type ServiceObservation,
  type ServiceSnapshot,
  type ServiceState,
} from "@agent-hub/contracts";
import { redactOutput } from "../execution/analysis.js";
import type { ServiceTargetConfig } from "./service-config.js";

export type ObservationResult = {
  receivedAt: Date;
  success: boolean;
  errorCode: string | null;
  snapshot: ServiceSnapshot | null;
};
class ObservationError extends Error {}

// 대상의 응답 원문이나 URL을 예외에 넣지 않고 정해진 오류 분류만 저장합니다.
export async function observeService(
  target: ServiceTargetConfig,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ObservationResult> {
  const deadline = AbortSignal.timeout(target.timeoutMs);
  try {
    const response = await fetcher(target.url, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.any([signal, deadline]),
      headers: {
        Accept: "application/json",
        ...(target.bearerToken
          ? { Authorization: `Bearer ${target.bearerToken}` }
          : {}),
      },
    });
    const rejectResponse = async (code: string) => {
      await response.body?.cancel();
      throw new ObservationError(code);
    };
    if (response.status >= 300 && response.status < 400)
      await rejectResponse("redirect_refused");
    if (!response.ok) await rejectResponse("http_error");
    if (
      response.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    )
      await rejectResponse("invalid_payload");
    if (Number(response.headers.get("content-length")) > 16384)
      await rejectResponse("response_too_large");
    if (!response.body) throw new ObservationError("invalid_payload");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 16384) {
          await reader.cancel();
          throw new ObservationError("response_too_large");
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    let snapshot: ServiceSnapshot;
    try {
      snapshot = parseResponse(
        serviceSnapshotSchema,
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        ),
      );
    } catch {
      throw new ObservationError("invalid_payload");
    }
    const receivedAt = new Date();
    if (
      Date.parse(snapshot.observedAt) > receivedAt.getTime() + 5000 ||
      (snapshot.lastSuccessAt &&
        Date.parse(snapshot.lastSuccessAt) > Date.parse(snapshot.observedAt))
    )
      throw new ObservationError("invalid_payload");
    const withoutUrl = snapshot.summary.replaceAll(target.url, "[SERVICE_URL]");
    const summary = target.bearerToken
      ? withoutUrl.replaceAll(target.bearerToken, "[REDACTED]")
      : withoutUrl;
    return {
      receivedAt,
      success: true,
      errorCode: null,
      snapshot: { ...snapshot, summary: redactOutput(summary).slice(0, 500) },
    };
  } catch (error) {
    return {
      receivedAt: new Date(),
      success: false,
      snapshot: null,
      errorCode:
        error instanceof ObservationError
          ? error.message
          : deadline.aborted
            ? "timeout"
            : signal.aborted
              ? "observer_stopped"
              : "request_failed",
    };
  }
}

export type ObservationPolicy = Pick<
  ServiceTargetConfig,
  "staleAfterMs" | "allowWaiting" | "activityTimeoutMs"
>;
export function interpretObservation(
  policy: ObservationPolicy,
  latest: ServiceObservation | null,
  now: Date,
): { state: ServiceState; reason: string } {
  if (!latest) return { state: "unknown", reason: "not_observed" };
  if (!latest.success || !latest.snapshot)
    return {
      state: "unavailable",
      reason: latest.errorCode ?? "request_failed",
    };
  const snapshot = latest.snapshot;
  const time = now.getTime();
  if (
    Date.parse(latest.receivedAt) > time + 5000 ||
    Date.parse(snapshot.observedAt) > time + 5000
  )
    return { state: "unknown", reason: "clock_skew" };
  if (
    time - Date.parse(latest.receivedAt) > policy.staleAfterMs ||
    time - Date.parse(snapshot.observedAt) > policy.staleAfterMs
  )
    return { state: "stale", reason: "observation_stale" };
  if (snapshot.processState === "stopped")
    return { state: "stopped", reason: "process_stopped" };
  if (
    snapshot.processState === "unknown" ||
    snapshot.activityState === "unknown"
  )
    return { state: "unknown", reason: "signals_missing" };
  if (snapshot.activityState === "degraded")
    return { state: "degraded", reason: "reported_degraded" };
  if (
    snapshot.nextExpectedAt &&
    time > Date.parse(snapshot.nextExpectedAt) + policy.staleAfterMs
  )
    return { state: "degraded", reason: "scheduled_work_overdue" };
  if (snapshot.activityState === "waiting")
    return policy.allowWaiting
      ? { state: "waiting", reason: "reported_waiting" }
      : { state: "degraded", reason: "waiting_not_allowed" };
  if (policy.activityTimeoutMs !== null) {
    if (!snapshot.lastSuccessAt)
      return { state: "unknown", reason: "progress_time_missing" };
    if (time - Date.parse(snapshot.lastSuccessAt) > policy.activityTimeoutMs)
      return { state: "degraded", reason: "progress_overdue" };
  }
  return { state: "healthy", reason: "reported_working" };
}
