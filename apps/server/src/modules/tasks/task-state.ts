export const taskStatuses = [
  "queued", "running", "succeeded", "failed", "interrupted", "blocked", "waiting_capacity", "waiting_retry",
] as const;

export type TaskStatus = typeof taskStatuses[number];
