import { sql } from "drizzle-orm";
import type { ServiceSnapshot } from "@agent-hub/contracts";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { taskStatuses } from "../modules/tasks/task-state.js";
import { stopReasons, type ExecutionIdentity } from "../modules/execution/analysis.js";
import { recoveryActions } from "../modules/execution/recover-task.js";

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey().notNull(),
    name: text("name").notNull(),
    workspaceKey: text("workspace_key").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    check("projects_name_not_blank", sql`length(trim(${table.name})) > 0`),
    check("projects_workspace_key_not_blank", sql`length(trim(${table.workspaceKey})) > 0`),
  ],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey().notNull(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
    instruction: text("instruction").notNull(),
    requestKey: text("request_key").notNull(),
    status: text("status", { enum: taskStatuses }).notNull().default("queued"),
    cancelRequestedAt: integer("cancel_requested_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("tasks_project_request_key_unique").on(table.projectId, table.requestKey),
    index("tasks_project_created_at_idx").on(table.projectId, table.createdAt, table.id),
    index("tasks_status_created_at_idx").on(table.status, table.createdAt, table.id),
    check("tasks_instruction_not_blank", sql`length(trim(${table.instruction})) > 0`),
    check("tasks_request_key_not_blank", sql`length(trim(${table.requestKey})) > 0`),
    check("tasks_status_valid", sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'blocked', 'waiting_capacity', 'waiting_retry')`),
  ],
);

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey().notNull(),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "restrict" }),
  attempt: integer("attempt").notNull().default(1),
  instanceId: text("instance_id").notNull(),
  slot: integer("slot").notNull().default(1),
  status: text("status", { enum: taskStatuses }).notNull(),
  model: text("model").notNull(),
  effort: text("effort").notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  lastActivityAt: integer("last_activity_at", { mode: "timestamp_ms" }).notNull(),
  result: text("result"),
  errorCode: text("error_code"),
  stopReason: text("stop_reason", { enum: stopReasons }),
  stopRequestedAt: integer("stop_requested_at", { mode: "timestamp_ms" }),
  // SDK 응답 완료와 실제 자식 실행의 종료 확인은 별개의 사실입니다.
  terminationConfirmedAt: integer("termination_confirmed_at", { mode: "timestamp_ms" }),
  execution: text("execution", { mode: "json" }).$type<ExecutionIdentity>(),
  retryAt: integer("retry_at", { mode: "timestamp_ms" }),
  providerGateVersion: integer("provider_gate_version"),
}, (table) => [
  check("runs_slot_valid", sql`${table.slot} = 1`),
  uniqueIndex("runs_one_active").on(table.slot).where(sql`${table.status} = 'running' OR (${table.status} IN ('interrupted', 'blocked', 'waiting_capacity') AND ${table.terminationConfirmedAt} IS NULL)`),
  index("runs_task_started_at_idx").on(table.taskId, table.startedAt),
  uniqueIndex("runs_task_attempt_unique").on(table.taskId, table.attempt),
]);

// 초기 단일 계정에서는 로그인 폴더를 바꿔도 같은 제공자 범위를 사용합니다.
export const providerGates = sqliteTable("provider_gates", {
  scope: text("scope").primaryKey().notNull(),
  version: integer("version").notNull(),
  blocked: integer("blocked", { mode: "boolean" }).notNull(),
  reason: text("reason", { enum: ["authentication", "capacity", "configuration"] }),
  blockedAt: integer("blocked_at", { mode: "timestamp_ms" }),
  retryAt: integer("retry_at", { mode: "timestamp_ms" }),
  sourceRunId: text("source_run_id").references(() => runs.id, { onDelete: "restrict" }),
  probeTaskId: text("probe_task_id").references(() => tasks.id, { onDelete: "restrict" }),
  probeRunId: text("probe_run_id").references(() => runs.id, { onDelete: "restrict" }),
}, table => [check("provider_gate_version_positive", sql`${table.version} > 0`)]);

export const steps = sqliteTable("steps", {
  id: text("id").primaryKey().notNull(),
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "restrict" }),
  sequence: integer("sequence").notNull(),
  status: text("status", { enum: taskStatuses }).notNull(),
  sessionId: text("session_id"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  usage: text("usage", { mode: "json" }).$type<{ inputTokens: number; cachedInputTokens: number; outputTokens: number }>(),
}, (table) => [uniqueIndex("steps_run_sequence_unique").on(table.runId, table.sequence)]);

export const recoveryRequests = sqliteTable("recovery_requests", {
  id: text("id").primaryKey().notNull(),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "restrict" }),
  runId: text("run_id").references(() => runs.id, { onDelete: "restrict" }),
  requestKey: text("request_key").notNull(),
  action: text("action", { enum: recoveryActions }).notNull(),
  providerGateVersion: integer("provider_gate_version"),
  status: text("status", { enum: ["pending", "completed", "rejected"] }).notNull(),
  resultStatus: text("result_status", { enum: taskStatuses }),
  errorCode: text("error_code"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
}, table => [
  uniqueIndex("recovery_task_request_key_unique").on(table.taskId, table.requestKey),
  uniqueIndex("recovery_one_pending_per_task").on(table.taskId).where(sql`${table.status} = 'pending'`),
  index("recovery_pending_order_idx").on(table.status, table.createdAt, table.id),
]);

export const events = sqliteTable("events", {
  id: text("id").primaryKey().notNull(),
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "restrict" }),
  sequence: integer("sequence").notNull(),
  kind: text("kind").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("events_run_sequence_unique").on(table.runId, table.sequence)]);

export const authSessions = sqliteTable("auth_sessions", {
  id: text("id").primaryKey().notNull(),
  generation: text("generation").notNull(),
  data: text("data").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
}, table => [index("auth_sessions_expiry_idx").on(table.expiresAt)]);

export const serviceTargets = sqliteTable("service_targets", {
  key: text("key").primaryKey().notNull(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  fingerprint: text("fingerprint").notNull(),
  configured: integer("configured", { mode: "boolean" }).notNull(),
  intervalMs: integer("interval_ms").notNull(),
  staleAfterMs: integer("stale_after_ms").notNull(),
  allowWaiting: integer("allow_waiting", { mode: "boolean" }).notNull(),
  activityTimeoutMs: integer("activity_timeout_ms"),
}, table => [index("service_targets_project_idx").on(table.projectId)]);

export const serviceObservations = sqliteTable("service_observations", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  id: text("id").notNull().unique(),
  targetKey: text("target_key").notNull().references(() => serviceTargets.key, { onDelete: "restrict" }),
  fingerprint: text("fingerprint").notNull(),
  receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
  success: integer("success", { mode: "boolean" }).notNull(),
  errorCode: text("error_code"),
  snapshot: text("snapshot", { mode: "json" }).$type<ServiceSnapshot>(),
}, table => [
  index("service_observations_target_sequence_idx").on(table.targetKey, table.sequence),
  check("service_observation_result_valid", sql`(${table.success} = 1 AND ${table.snapshot} IS NOT NULL AND json_valid(${table.snapshot}) AND ${table.errorCode} IS NULL) OR (${table.success} = 0 AND ${table.snapshot} IS NULL AND ${table.errorCode} IS NOT NULL)`),
]);

// 실행 루프의 소유권입니다. Run의 활성 상태와 별도로 유지하며 시간만으로 만료시키지 않습니다.
export const executionOwner = sqliteTable("execution_owner", {
  slot: integer("slot").primaryKey().notNull(),
  token: text("token").notNull(),
  hostname: text("hostname").notNull(),
  pid: integer("pid").notNull(),
}, (table) => [
  check("execution_owner_single_slot", sql`${table.slot} = 1`),
  check("execution_owner_positive_pid", sql`${table.pid} > 0`),
]);
