import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { taskStatuses } from "../modules/tasks/task-state.js";
import { stopReasons, type ExecutionIdentity } from "../modules/execution/analysis.js";

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
    check("tasks_status_valid", sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed', 'interrupted', 'blocked', 'waiting_capacity', 'waiting_retry')`),
  ],
);

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey().notNull(),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "restrict" }),
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
}, (table) => [
  check("runs_slot_valid", sql`${table.slot} = 1`),
  uniqueIndex("runs_one_active").on(table.slot).where(sql`${table.status} IN ('running', 'interrupted')`),
  index("runs_task_started_at_idx").on(table.taskId, table.startedAt),
]);

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

export const events = sqliteTable("events", {
  id: text("id").primaryKey().notNull(),
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "restrict" }),
  sequence: integer("sequence").notNull(),
  kind: text("kind").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [uniqueIndex("events_run_sequence_unique").on(table.runId, table.sequence)]);

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
