import { enumeration } from "./schema.js";

export const taskStatuses = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "blocked",
  "waiting_capacity",
  "waiting_retry",
] as const;
export type TaskStatus = (typeof taskStatuses)[number];
export const efforts = ["medium", "high", "xhigh"] as const;
export type Effort = (typeof efforts)[number];
export const stopReasons = [
  "user_cancel",
  "scope_changed",
  "server_shutdown",
  "timeout",
  "budget_limit",
  "unknown",
] as const;
export type StopReason = (typeof stopReasons)[number];
export const recoveryActions = ["resume", "reconcile", "cancel"] as const;
export type RecoveryAction = (typeof recoveryActions)[number];
export const status = enumeration(taskStatuses);
