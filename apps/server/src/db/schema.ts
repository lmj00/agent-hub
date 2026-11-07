import type { AnalysisWorkflowPolicy } from "../modules/execution/analysis-workflow.js";
import type { EffortPolicy } from "../modules/execution/effort-policy.js";
import type { RetryState } from "../modules/execution/retry-policy.js";
import type { PreparedInput } from "../modules/goals/prepared-workspace.js";
import type { DevelopmentRepositoryIntent, DevelopmentRepository, DevelopmentInputIntent, DevelopmentInput, DevelopmentCandidate } from "../modules/goals/development-workspace.js";
import type { DevelopmentVerificationIntent, DevelopmentReview } from "../modules/goals/development-verification-store.js";
import type { VerificationResult } from "../modules/execution/verification-config.js";
import type { RuntimeSkillSelection } from "../modules/execution/runtime-skills.js";
import type { PlannedWork, PlanResult, PlanningInput } from "../modules/goals/goal-plan-policy.js";
import { sql } from "drizzle-orm";
import type { ServiceSnapshot, CapacityState, AnalysisAssessment, GoalDefinition, Goal, PeriodBudgetPolicy, BudgetWait, TaskGoalReview } from "@agent-hub/contracts";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { taskStatuses } from "../modules/tasks/task-state.js";
import { maxRunExecutions, stopReasons } from "../modules/execution/analysis.js";
import { recoveryActions } from "../modules/execution/recover-task.js";
import type { NotificationReason, DeliveryResult } from "../modules/operations/notification-delivery.js";

// Latest delivery receipt per issue source. Task/Run remain the source of truth.
export const notifications = sqliteTable("notifications", {
  sourceKey: text("source_key").primaryKey().notNull(),
  conditionKey: text("condition_key").notNull(),
  id: text("id").notNull(),
  destinationHash: text("destination_hash").notNull(),
  reason: text("reason").$type<NotificationReason>().notNull(),
  projectId: text("project_id").references(() => projects.id, { onDelete: "restrict" }),
  taskId: text("task_id").references(() => tasks.id, { onDelete: "restrict" }),
  runId: text("run_id").references(() => runs.id, { onDelete: "restrict" }),
  status: text("status", { enum: ["pending", "delivered", "exhausted", "resolved"] }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: integer("next_attempt_at", { mode: "timestamp_ms" }),
  lastAttemptAt: integer("last_attempt_at", { mode: "timestamp_ms" }),
  lastResult: text("last_result").$type<DeliveryResult>(),
  detectedAt: integer("detected_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, table => [
  uniqueIndex("notifications_id_unique").on(table.id),
  index("notifications_due_idx").on(table.status, table.nextAttemptAt, table.sourceKey),
  index("notifications_updated_idx").on(table.updatedAt, table.sourceKey),
  check("notifications_status_valid", sql`${table.status} IN ('pending', 'delivered', 'exhausted', 'resolved')`),
  check("notifications_attempts_valid", sql`${table.attempts} >= 0 AND ${table.attempts} <= 20`),
  check("notifications_pending_due", sql`(${table.status} = 'pending') = (${table.nextAttemptAt} IS NOT NULL)`),
]);

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
    kind: text("kind", { enum: ["planning", "work"] }).notNull().default("work"),
    goalId: text("goal_id").references(() => goals.id, { onDelete: "restrict" }),
    goalVersion: integer("goal_version"),
    goalReview: text("goal_review", { mode: "json" }).$type<TaskGoalReview>(),
    budgetWait: text("budget_wait", { mode: "json" }).$type<BudgetWait>(),
    plannedWork: text("planned_work", { mode: "json" }).$type<PlannedWork>(),
    instruction: text("instruction").notNull(),
    requestKey: text("request_key").notNull(),
    status: text("status", { enum: taskStatuses }).notNull().default("queued"),
    cancelRequestedAt: integer("cancel_requested_at", { mode: "timestamp_ms" }),
    retryState: text("retry_state", { mode: "json" }).$type<RetryState>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("tasks_project_request_key_unique").on(table.projectId, table.requestKey),
    index("tasks_project_created_at_idx").on(table.projectId, table.createdAt, table.id),
    index("tasks_status_created_at_idx").on(table.status, table.createdAt, table.id),
    index("tasks_goal_status_idx").on(table.goalId, table.status, table.createdAt, table.id),
    check("tasks_kind_valid", sql`${table.kind} IN ('planning', 'work')`),
    check("tasks_goal_binding_valid", sql`(${table.goalId} IS NULL AND ${table.goalVersion} IS NULL AND ${table.kind} = 'work') OR (${table.goalId} IS NOT NULL AND ${table.goalVersion} IS NOT NULL AND ${table.goalVersion} > 0)`),
    check("tasks_instruction_not_blank", sql`length(trim(${table.instruction})) > 0`),
    check("tasks_request_key_not_blank", sql`length(trim(${table.requestKey})) > 0`),
    check("tasks_status_valid", sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted', 'blocked', 'waiting_capacity', 'waiting_retry')`),
  ],
);

export const taskReleases = sqliteTable("task_releases", {
  sourceTaskId: text("source_task_id").primaryKey().notNull().references(() => tasks.id, { onDelete: "restrict" }),
  newTaskId: text("new_task_id").notNull().references(() => tasks.id, { onDelete: "restrict" }),
  goalId: text("goal_id").notNull().references(() => goals.id, { onDelete: "restrict" }),
  goalVersion: integer("goal_version").notNull(),
  requestKey: text("request_key").notNull(),
  commandHash: text("command_hash").notNull(),
  priorAttempts: integer("prior_attempts").notNull(),
  priorRetryState: text("prior_retry_state", { mode: "json" }).$type<RetryState>().notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, table => [
  uniqueIndex("task_releases_new_task_unique").on(table.newTaskId),
  check("task_releases_distinct_tasks", sql`${table.sourceTaskId} <> ${table.newTaskId}`),
  check("task_releases_attempts_valid", sql`${table.priorAttempts} >= 0`),
  check("task_releases_goal_version_valid", sql`${table.goalVersion} > 1`),
]);

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey().notNull(),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "restrict" }),
  attempt: integer("attempt").notNull().default(1),
  goalVersion: integer("goal_version"),
  instanceId: text("instance_id").notNull(),
  slot: integer("slot").notNull().default(1),
  status: text("status", { enum: taskStatuses }).notNull(),
  model: text("model").notNull(),
  effort: text("effort").notNull(),
  effortPolicy: text("effort_policy", { mode: "json" }).$type<EffortPolicy>(),
  workflowPolicy: text("workflow_policy", { mode: "json" }).$type<AnalysisWorkflowPolicy>(),
  developmentVersion: integer("development_version"),
  runtimeSkillVersion: integer("runtime_skill_version"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  lastActivityAt: integer("last_activity_at", { mode: "timestamp_ms" }).notNull(),
  result: text("result"),
  errorCode: text("error_code"),
  stopReason: text("stop_reason", { enum: stopReasons }),
  stopRequestedAt: integer("stop_requested_at", { mode: "timestamp_ms" }),
  // SDK 응답 완료와 실제 자식 실행의 종료 확인은 별개의 사실입니다.
  terminationConfirmedAt: integer("termination_confirmed_at", { mode: "timestamp_ms" }),
  preparedInput: text("prepared_input", { mode: "json" }).$type<PreparedInput>(),
  planningInput: text("planning_input", { mode: "json" }).$type<PlanningInput>(),
  planResult: text("plan_result", { mode: "json" }).$type<PlanResult>(),
  retryAt: integer("retry_at", { mode: "timestamp_ms" }),
  providerGateVersion: integer("provider_gate_version"),
  accountedDurationMs: integer("accounted_duration_ms").notNull().default(0),
}, (table) => [
  check("runs_slot_valid", sql`${table.slot} = 1`),
  check("runs_development_version_valid", sql`${table.developmentVersion} IS NULL OR ${table.developmentVersion} = 1`),
  check("runs_runtime_skill_version_valid", sql`${table.runtimeSkillVersion} IS NULL OR ${table.runtimeSkillVersion} = 1`),
  uniqueIndex("runs_one_active").on(table.slot).where(sql`${table.status} = 'running' OR (${table.status} IN ('interrupted', 'blocked', 'waiting_capacity') AND ${table.terminationConfirmedAt} IS NULL)`),
  index("runs_task_started_at_idx").on(table.taskId, table.startedAt),
  uniqueIndex("runs_task_attempt_unique").on(table.taskId, table.attempt),
]);

// A Run may own several sequential containers. Only one can lack termination
// evidence; a later phase never replaces an earlier container's identity.
export const runExecutions = sqliteTable("run_executions", {
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "restrict" }),
  sequence: integer("sequence").notNull(),
  containerId: text("container_id").notNull(),
  token: text("token").notNull(),
  engineId: text("engine_id").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  terminationConfirmedAt: integer("termination_confirmed_at", { mode: "timestamp_ms" }),
}, table => [
  primaryKey({ columns: [table.runId, table.sequence] }),
  uniqueIndex("run_executions_container_unique").on(table.runId, table.containerId),
  uniqueIndex("run_executions_one_unconfirmed").on(table.runId).where(sql`${table.terminationConfirmedAt} IS NULL`),
  check("run_executions_sequence_valid", sql`${table.sequence} BETWEEN 1 AND ${sql.raw(String(maxRunExecutions))}`),
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
  capacityState: text("capacity_state", { mode: "json" }).$type<CapacityState>(),
}, table => [check("provider_gate_version_positive", sql`${table.version} > 0`)]);

export const steps = sqliteTable("steps", {
  id: text("id").primaryKey().notNull(),
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "restrict" }),
  sequence: integer("sequence").notNull(),
  status: text("status", { enum: taskStatuses }).notNull(),
  sessionId: text("session_id"),
  effort: text("effort", { enum: ["medium", "high", "xhigh"] }),
  effortReason: text("effort_reason"),
  effortPolicyVersion: integer("effort_policy_version"),
  proposedEffort: text("proposed_effort"),
  purpose: text("purpose"),
  model: text("model"),
  runtimeSkill: text("runtime_skill", { mode: "json" }).$type<RuntimeSkillSelection>(),
  runtimeSkillSelectedAt: integer("runtime_skill_selected_at", { mode: "timestamp_ms" }),
  runtimeSkillLoadedAt: integer("runtime_skill_loaded_at", { mode: "timestamp_ms" }),
  assessment: text("assessment", { mode: "json" }).$type<AnalysisAssessment>(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  usage: text("usage", { mode: "json" }).$type<{ inputTokens: number; cachedInputTokens: number; outputTokens: number }>(),
}, (table) => [uniqueIndex("steps_run_sequence_unique").on(table.runId, table.sequence)]);

export const goals = sqliteTable("goals", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id),
  requestKey: text("request_key").notNull(),
  definition: text("definition", { mode: "json" }).$type<GoalDefinition>().notNull(),
  status: text("status", { enum: ["active", "paused", "completed"] }).notNull(),
  version: integer("version").notNull(),
  nextCheckAt: integer("next_check_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, table => [uniqueIndex("goals_project_request_unique").on(table.projectId, table.requestKey)]);

export const planningCycles = sqliteTable("planning_cycles", {
  taskId: text("task_id").primaryKey().references(() => tasks.id),
  goalId: text("goal_id").notNull().references(() => goals.id),
  goalVersion: integer("goal_version").notNull(),
  status: text("status", { enum: ["reserved", "applied", "rejected"] }).notNull(),
  resultRunId: text("result_run_id").references(() => runs.id),
  reason: text("reason"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
}, table => [
  uniqueIndex("planning_cycles_one_reservation").on(table.goalId).where(sql`${table.status} = 'reserved'`),
  index("planning_cycles_goal_created_idx").on(table.goalId, table.createdAt),
  check("planning_cycles_status_valid", sql`${table.status} IN ('reserved', 'applied', 'rejected')`),
]);

export const projectBudgets = sqliteTable("project_budgets", {
  projectId: text("project_id").primaryKey().references(() => projects.id),
  version: integer("version").notNull(),
  policy: text("policy", { mode: "json" }).$type<PeriodBudgetPolicy>().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const developmentRepositories = sqliteTable("development_repositories", {
  id: text("id").primaryKey().notNull(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "restrict" }),
  createdByRunId: text("created_by_run_id").notNull().references(() => runs.id, { onDelete: "restrict" }),
  intent: text("intent", { mode: "json" }).$type<DevelopmentRepositoryIntent>().notNull(),
  prepared: text("prepared", { mode: "json" }).$type<DevelopmentRepository>(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  preparedAt: integer("prepared_at", { mode: "timestamp_ms" }),
}, table => [
  uniqueIndex("development_repositories_project_unique").on(table.projectId),
  check("development_repository_preparation_valid", sql`(${table.prepared} IS NULL AND ${table.preparedAt} IS NULL) OR (${table.prepared} IS NOT NULL AND ${table.preparedAt} IS NOT NULL)`),
]);

export const developmentRounds = sqliteTable("development_rounds", {
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "restrict" }),
  sequence: integer("sequence").notNull(),
  repositoryId: text("repository_id").notNull().references(() => developmentRepositories.id, { onDelete: "restrict" }),
  inputId: text("input_id").notNull(),
  planningRevision: text("planning_revision").notNull(),
  intent: text("intent", { mode: "json" }).$type<DevelopmentInputIntent>().notNull(),
  input: text("input", { mode: "json" }).$type<DevelopmentInput>(),
  candidate: text("candidate", { mode: "json" }).$type<DevelopmentCandidate>(),
  verificationIntent: text("verification_intent", { mode: "json" }).$type<DevelopmentVerificationIntent>(),
  verificationInput: text("verification_input", { mode: "json" }).$type<DevelopmentInput>(),
  verificationResult: text("verification_result", { mode: "json" }).$type<VerificationResult>(),
  review: text("review", { mode: "json" }).$type<DevelopmentReview>(),
  executionOffset: integer("execution_offset").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  preparedAt: integer("prepared_at", { mode: "timestamp_ms" }),
  capturedAt: integer("captured_at", { mode: "timestamp_ms" }),
  verificationPreparedAt: integer("verification_prepared_at", { mode: "timestamp_ms" }),
  verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
  reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
}, table => [
  primaryKey({ columns: [table.runId, table.sequence] }),
  uniqueIndex("development_rounds_input_unique").on(table.inputId),
  check("development_rounds_sequence_valid", sql`${table.sequence} BETWEEN 1 AND 3`),
  check("development_rounds_execution_offset_valid", sql`${table.executionOffset} BETWEEN 0 AND 11`),
  check("development_rounds_preparation_valid", sql`(${table.input} IS NULL AND ${table.preparedAt} IS NULL) OR (${table.input} IS NOT NULL AND ${table.preparedAt} IS NOT NULL)`),
  check("development_rounds_capture_valid", sql`(${table.candidate} IS NULL AND ${table.capturedAt} IS NULL) OR (${table.input} IS NOT NULL AND ${table.candidate} IS NOT NULL AND ${table.capturedAt} IS NOT NULL)`),
  check("development_rounds_verification_intent_valid", sql`${table.verificationIntent} IS NULL OR ${table.candidate} IS NOT NULL`),
  check("development_rounds_verification_input_valid", sql`(${table.verificationInput} IS NULL AND ${table.verificationPreparedAt} IS NULL) OR (${table.verificationIntent} IS NOT NULL AND ${table.verificationInput} IS NOT NULL AND ${table.verificationPreparedAt} IS NOT NULL)`),
  check("development_rounds_verification_result_valid", sql`(${table.verificationResult} IS NULL AND ${table.verifiedAt} IS NULL) OR (${table.verificationInput} IS NOT NULL AND ${table.verificationResult} IS NOT NULL AND ${table.verifiedAt} IS NOT NULL)`),
  check("development_rounds_review_valid", sql`(${table.review} IS NULL AND ${table.reviewedAt} IS NULL) OR (${table.verificationResult} IS NOT NULL AND ${table.review} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL)`),
]);

// One durable authorization per Task. A pending Git outcome blocks subsequent
// applications to that repository until the exact recorded commit is reconciled.
export const changeApplications = sqliteTable("change_applications", {
  id: text("id").primaryKey().notNull(),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "restrict" }),
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "restrict" }),
  repositoryId: text("repository_id").notNull().references(() => developmentRepositories.id, { onDelete: "restrict" }),
  roundSequence: integer("round_sequence").notNull(),
  goalVersion: integer("goal_version").notNull(),
  baseRevision: text("base_revision").notNull(),
  tree: text("tree").notNull(),
  candidateDigest: text("candidate_digest").notNull(),
  evidenceDigest: text("evidence_digest").notNull(),
  resultCommit: text("result_commit").notNull(),
  targetRef: text("target_ref").notNull(),
  status: text("status", { enum: ["pending", "applied"] }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  appliedAt: integer("applied_at", { mode: "timestamp_ms" }),
}, table => [
  uniqueIndex("change_applications_task_unique").on(table.taskId),
  uniqueIndex("change_applications_run_unique").on(table.runId),
  uniqueIndex("change_applications_repository_pending").on(table.repositoryId).where(sql`${table.status} = 'pending'`),
  check("change_applications_status_valid", sql`(${table.status} = 'pending' AND ${table.appliedAt} IS NULL) OR (${table.status} = 'applied' AND ${table.appliedAt} IS NOT NULL)`),
  check("change_applications_round_valid", sql`${table.roundSequence} BETWEEN 1 AND 3`),
  check("change_applications_goal_version_valid", sql`${table.goalVersion} > 0`),
  check("change_applications_ref_valid", sql`${table.targetRef} = 'refs/heads/development'`),
]);

export const budgetPeriods = sqliteTable("budget_periods", {
  id: text("id").primaryKey(),
  accountKey: text("account_key").notNull(),
  projectId: text("project_id").notNull().references(() => projects.id),
  goalId: text("goal_id").references(() => goals.id),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  endsAt: integer("ends_at", { mode: "timestamp_ms" }).notNull(),
  policy: text("policy", { mode: "json" }).$type<PeriodBudgetPolicy>().notNull(),
  calls: integer("calls").notNull().default(0),
  // Includes unsettled reservations. A confirmed finish replaces its reservation with elapsed time.
  runMs: integer("run_ms").notNull().default(0),
}, table => [
  uniqueIndex("budget_periods_account_start_unique").on(table.accountKey, table.startedAt),
  check("budget_periods_valid", sql`${table.endsAt} > ${table.startedAt} AND ${table.calls} >= 0 AND ${table.runMs} >= 0`),
]);

export const budgetReservations = sqliteTable("budget_reservations", {
  runId: text("run_id").primaryKey().references(() => runs.id),
  projectPeriodId: text("project_period_id").notNull().references(() => budgetPeriods.id),
  goalPeriodId: text("goal_period_id").references(() => budgetPeriods.id),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  reservedRunMs: integer("reserved_run_ms").notNull(),
  settledRunMs: integer("settled_run_ms"),
  settledAt: integer("settled_at", { mode: "timestamp_ms" }),
}, table => [
  check("budget_reservations_valid", sql`${table.reservedRunMs} > 0 AND (${table.settledRunMs} IS NULL OR ${table.settledRunMs} >= 0)`),
]);

export const goalRevisions = sqliteTable("goal_revisions", {
  goalId: text("goal_id").notNull().references(() => goals.id),
  version: integer("version").notNull(),
  requestKey: text("request_key").notNull(),
  commandHash: text("command_hash").notNull(),
  snapshot: text("snapshot", { mode: "json" }).$type<Goal>().notNull(),
}, table => [
  uniqueIndex("goal_revisions_version_unique").on(table.goalId, table.version),
  uniqueIndex("goal_revisions_request_unique").on(table.goalId, table.requestKey),
]);

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
