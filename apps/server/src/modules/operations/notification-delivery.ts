import type { NotificationConfig } from "./notification-config.js";

export const notificationReasons = [
  "authentication_required",
  "configuration_required",
  "storage_error",
  "capacity_recovery_exhausted",
  "termination_unconfirmed",
  "execution_recovery_required",
  "change_application_unconfirmed",
  "retry_limit",
  "repeated_error_limit",
  "task_time_limit",
  "task_failed",
  "task_blocked",
] as const;
export type NotificationReason = (typeof notificationReasons)[number];
export type NotificationPayload = {
  version: 1;
  id: string;
  type: "action_required";
  reason: NotificationReason;
  projectId: string | null;
  taskId: string | null;
  runId: string | null;
  detectedAt: string;
};
export const deliveryResults = [
  "delivered",
  "http_error",
  "redirect_refused",
  "timeout",
  "stopped",
  "request_failed",
] as const;
export type DeliveryResult = (typeof deliveryResults)[number];

export async function deliverNotification(
  config: NotificationConfig,
  payload: NotificationPayload,
  signal: AbortSignal,
): Promise<DeliveryResult> {
  const deadline = AbortSignal.timeout(config.timeoutMs);
  try {
    const response = await fetch(config.url, {
      method: "POST",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.any([signal, deadline]),
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": payload.id,
        ...(config.bearerToken ? { Authorization: `Bearer ${config.bearerToken}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    // The receiver's body is neither needed nor trusted, including on errors.
    await response.body?.cancel();
    if (response.status >= 300 && response.status < 400) return "redirect_refused";
    return response.ok ? "delivered" : "http_error";
  } catch {
    return signal.aborted ? "stopped" : deadline.aborted ? "timeout" : "request_failed";
  }
}
