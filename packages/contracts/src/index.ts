import {
  Type,
  FormatRegistry,
  type Static,
  type TSchema,
} from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
export { goalPlanSchema, type GoalPlan } from "./goal-plan.js";

// 서버는 같은 JSON Schema를 Fastify에 전달하고, 화면은 응답을 받은 뒤 검사합니다.
FormatRegistry.Set("uuid", (value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
);
FormatRegistry.Set("date-time", (value) => {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  )
    return false;
  const day = value.slice(0, 10);
  return new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
});
export function parseResponse<T extends TSchema>(
  schema: T,
  value: unknown,
): Static<T> {
  if (!Value.Check(schema, value))
    throw new Error("API response does not match its contract");
  return value;
}
export type { Static, TSchema };
const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const nullable = <T extends TSchema>(schema: T) =>
  Type.Union([schema, Type.Null()]);
const enumeration = <T extends readonly string[]>(values: T) =>
  Type.Union(values.map((value) => Type.Literal(value as T[number])));
const text = Type.String();
const id = Type.String({ format: "uuid" });
const date = Type.String({ format: "date-time" });
const requestKey = Type.String({
  minLength: 1,
  maxLength: 100,
  pattern: "^[A-Za-z0-9]",
  not: { pattern: "[^A-Za-z0-9._-]" },
});
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
export const analysisAssessmentSchema = object({
  report: Type.String({ minLength: 1, maxLength: 16000 }),
  evidence: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
    maxItems: 8,
  }),
  unresolved: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
    maxItems: 8,
  }),
  complete: Type.Boolean(),
  next: nullable(
    object({
      purpose: Type.String({ minLength: 1, maxLength: 1000 }),
      effort: Type.String({ minLength: 1, maxLength: 20 }),
      reason: Type.String({ minLength: 1, maxLength: 500 }),
    }),
  ),
});
export type AnalysisAssessment = Static<typeof analysisAssessmentSchema>;
export const periodBudgetPolicySchema = object({
  windowMs: Type.Integer({ minimum: 600000, maximum: 86400000 }),
  maxCalls: Type.Integer({ minimum: 1, maximum: 1000 }),
  maxRunMs: Type.Integer({ minimum: 1000, maximum: 86400000 }),
});
export type PeriodBudgetPolicy = Static<typeof periodBudgetPolicySchema>;
export const budgetWaitSchema = object({
  scope: enumeration(["project", "goal"] as const),
  reason: enumeration(["call_limit", "time_limit", "period_end"] as const),
  retryAt: date,
});
export type BudgetWait = Static<typeof budgetWaitSchema>;
export const budgetPeriodSchema = object({
  startedAt: date,
  endsAt: date,
  policy: periodBudgetPolicySchema,
  calls: Type.Integer({ minimum: 0 }),
  chargedRunMs: Type.Integer({ minimum: 0 }),
  reservedRunMs: Type.Integer({ minimum: 0 }),
});
export const projectBudgetSchema = object({
  version: Type.Integer({ minimum: 0 }),
  policy: periodBudgetPolicySchema,
  accounts: Type.Array(object({
    scope: enumeration(["project", "goal"] as const),
    id,
    label: text,
    period: nullable(budgetPeriodSchema),
  })),
});
export const updateProjectBudgetSchema = object({
  expectedVersion: Type.Integer({ minimum: 0 }),
  policy: periodBudgetPolicySchema,
});
export type ProjectBudget = Static<typeof projectBudgetSchema>;
export const goalDefinitionSchema = object({
  description: Type.String({ minLength: 1, maxLength: 10000 }),
  completionCriteria: Type.String({ minLength: 1, maxLength: 6000 }),
  kind: enumeration(["finite", "continuous"] as const),
  priority: Type.Integer({ minimum: 0, maximum: 100 }),
  allowedPaths: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), {
    minItems: 1,
    maxItems: 30,
    uniqueItems: true,
  }),
  excludedPaths: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), {
    maxItems: 30,
    uniqueItems: true,
  }),
  checkIntervalMs: Type.Integer({ minimum: 60000, maximum: 86400000 }),
  budget: periodBudgetPolicySchema,
});
export type GoalDefinition = Static<typeof goalDefinitionSchema>;
export const goalSchema = object({
  id,
  projectId: id,
  definition: goalDefinitionSchema,
  status: enumeration(["active", "paused", "completed"] as const),
  version: Type.Integer({ minimum: 1 }),
  nextCheckAt: nullable(date),
  createdAt: date,
  updatedAt: date,
});
export type Goal = Static<typeof goalSchema>;
export const goalsSchema = object({ goals: Type.Array(goalSchema) });
export const createGoalSchema = object({
  requestKey,
  definition: goalDefinitionSchema,
});
export const updateGoalSchema = object({
  requestKey,
  expectedVersion: Type.Integer({ minimum: 1 }),
  definition: goalDefinitionSchema,
});
export const controlGoalSchema = object({
  requestKey,
  expectedVersion: Type.Integer({ minimum: 1 }),
  action: enumeration(["pause", "resume"] as const),
});
export const goalHistorySchema = object({ revisions: Type.Array(goalSchema) });
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
const status = enumeration(taskStatuses);

export const errorSchema = object({ error: text, message: text });
export const errorResponses = { "4xx": errorSchema, "5xx": errorSchema };
export const idParamsSchema = object({ id });
export const projectParamsSchema = object({ projectId: id });
export const createProjectSchema = object({
  name: Type.String({ minLength: 1, maxLength: 100, pattern: "\\S" }),
  workspaceKey: requestKey,
});
export const projectSchema = object({
  id,
  name: text,
  workspaceKey: text,
  createdAt: date,
});
export const projectsSchema = object({ projects: Type.Array(projectSchema) });
export type Project = Static<typeof projectSchema>;
export type CreateProject = Static<typeof createProjectSchema>;

export const taskKinds = ["planning", "work"] as const;
export type TaskKind = (typeof taskKinds)[number];

export const createTaskSchema = object({
  instruction: Type.String({ minLength: 1, maxLength: 10000, pattern: "\\S" }),
  requestKey,
});
export const retryStateSchema = object({
  policy: object({
    version: Type.Literal(1),
    initialDelayMs: Type.Integer(),
    maxDelayMs: Type.Integer(),
    jitterRatio: Type.Number(),
    maxRetries: Type.Integer(),
    maxConsecutiveErrors: Type.Integer(),
    maxTotalRunMs: Type.Integer(),
  }),
  retries: Type.Integer(),
  consecutiveErrors: Type.Integer(),
  lastError: nullable(text),
  decisionRunId: nullable(id),
  nextAttemptAt: nullable(date),
  reason: nullable(text),
  totalRunMs: Type.Integer(),
});
export type RetryState = Static<typeof retryStateSchema>;
export const taskGoalReviewSchema = object({
  fromVersion: Type.Integer({ minimum: 1 }),
  toVersion: Type.Integer({ minimum: 1 }),
  decision: enumeration(["retained", "excluded"] as const),
  paths: Type.Array(text, { minItems: 1, maxItems: 20 }),
  checkedAt: date,
});
export type TaskGoalReview = Static<typeof taskGoalReviewSchema>;
export const releaseTaskSchema = object({ requestKey, expectedGoalVersion: Type.Integer({ minimum: 1 }) });
export type ReleaseTask = Static<typeof releaseTaskSchema>;
export const taskReleaseSchema = object({
  sourceTaskId: id, newTaskId: id, goalId: id, goalVersion: Type.Integer({ minimum: 2 }), createdAt: date,
});
export type TaskRelease = Static<typeof taskReleaseSchema>;
export const taskSchema = object({
  id,
  projectId: id,
  kind: enumeration(taskKinds),
  goalId: nullable(id),
  goalVersion: nullable(Type.Integer({ minimum: 1 })),
  goalReview: nullable(taskGoalReviewSchema),
  planningTaskId: nullable(id),
  previousTaskId: nullable(id),
  nextTaskId: nullable(id),
  budgetWait: nullable(budgetWaitSchema),
  instruction: text,
  requestKey: text,
  status,
  retryState: nullable(retryStateSchema),
  createdAt: date,
});
export const tasksSchema = object({ tasks: Type.Array(taskSchema) });
export type Task = Static<typeof taskSchema>;
export type CreateTask = Static<typeof createTaskSchema>;

export const runSchema = object({
  id: text,
  taskId: text,
  attempt: Type.Integer({ minimum: 1 }),
  goalVersion: nullable(Type.Integer({ minimum: 1 })),
  status,
  model: text,
  effort: text,
  startedAt: date,
  finishedAt: nullable(date),
});
export const runsSchema = object({ runs: Type.Array(runSchema) });
export const runDetailsSchema = object({
  ...runSchema.properties,
  lastActivityAt: date,
  result: nullable(text),
  errorCode: nullable(text),
  stopReason: nullable(enumeration(stopReasons)),
  stopRequestedAt: nullable(date),
  terminationConfirmedAt: nullable(date),
  retryAt: nullable(date),
  steps: Type.Array(
    object({
      sequence: Type.Integer(),
      status,
      sessionId: nullable(text),
      effort: nullable(enumeration(efforts)),
      effortReason: nullable(text),
      effortPolicyVersion: nullable(Type.Integer()),
      proposedEffort: nullable(text),
      purpose: nullable(text),
      model: nullable(text),
      assessment: nullable(analysisAssessmentSchema),
      usage: nullable(
        object({
          inputTokens: Type.Integer(),
          cachedInputTokens: Type.Integer(),
          outputTokens: Type.Integer(),
        }),
      ),
      startedAt: date,
      finishedAt: nullable(date),
    }),
  ),
  events: Type.Array(
    object({ sequence: Type.Integer(), kind: text, createdAt: date }),
  ),
});
export type Run = Static<typeof runSchema>;
export type RunDetails = Static<typeof runDetailsSchema>;
export const queueSchema = object({
  state: enumeration([
    "disabled",
    "idle",
    "running",
    "recovering",
    "held",
    "error",
    "stopping",
    "stopped",
  ] as const),
  runId: nullable(text),
  taskId: nullable(text),
  reason: nullable(text),
  lastCheckedAt: nullable(date),
  automaticRecoveryEnabled: Type.Boolean(),
  capacityRecoveryEnabled: Type.Boolean(),
});
export type Queue = Static<typeof queueSchema>;
export const capacityStateSchema = object({
  policy: object({
    version: Type.Literal(1),
    initialDelayMs: Type.Integer(),
    maxDelayMs: Type.Integer(),
    jitterRatio: Type.Number(),
    maxChecks: Type.Integer(),
  }),
  checks: Type.Integer(),
  nextCheckAt: nullable(date),
  decisionVersion: Type.Integer(),
  reason: text,
});
export type CapacityState = Static<typeof capacityStateSchema>;
export const providerGateSchema = object({
  version: Type.Integer({ minimum: 0 }),
  blocked: Type.Boolean(),
  reason: nullable(
    enumeration(["authentication", "capacity", "configuration"] as const),
  ),
  blockedAt: nullable(date),
  retryAt: nullable(date),
  sourceRunId: nullable(text),
  probeTaskId: nullable(text),
  probeRunId: nullable(text),
  capacityState: nullable(capacityStateSchema),
});
export type ProviderGate = Static<typeof providerGateSchema>;

export const recoveryInputSchema = object({
  requestKey,
  runId: nullable(id),
  action: enumeration(recoveryActions),
  providerGateVersion: Type.Optional(nullable(Type.Integer({ minimum: 0 }))),
});
export const recoverySchema = object({
  id,
  taskId: id,
  runId: nullable(id),
  requestKey: text,
  action: enumeration(recoveryActions),
  providerGateVersion: nullable(Type.Integer()),
  status: enumeration(["pending", "completed", "rejected"] as const),
  resultStatus: nullable(status),
  errorCode: nullable(text),
  createdAt: date,
  finishedAt: nullable(date),
});
export type RecoveryInput = Static<typeof recoveryInputSchema>;
export type Recovery = Static<typeof recoverySchema>;

export const sessionSchema = object({
  authenticated: Type.Boolean(),
  csrfToken: text,
  expiresAt: nullable(date),
});
export type Session = Static<typeof sessionSchema>;
export const loginSchema = object({
  password: Type.String({ minLength: 1, maxLength: 1024 }),
});

export const serviceSnapshotSchema = object({
  observedAt: date,
  processState: enumeration(["running", "stopped", "unknown"] as const),
  activityState: enumeration([
    "working",
    "waiting",
    "degraded",
    "unknown",
  ] as const),
  lastSuccessAt: nullable(date),
  nextExpectedAt: nullable(date),
  errorCount: Type.Integer({ minimum: 0, maximum: 2147483647 }),
  summary: Type.String({ maxLength: 500 }),
});
export type ServiceSnapshot = Static<typeof serviceSnapshotSchema>;
export const serviceObservationSchema = object({
  id,
  receivedAt: date,
  success: Type.Boolean(),
  errorCode: nullable(text),
  snapshot: nullable(serviceSnapshotSchema),
});
export type ServiceObservation = Static<typeof serviceObservationSchema>;
export const serviceStates = [
  "healthy",
  "waiting",
  "degraded",
  "stopped",
  "stale",
  "unavailable",
  "unknown",
] as const;
export type ServiceState = (typeof serviceStates)[number];
export const serviceSchema = object({
  key: text,
  name: text,
  projectId: id,
  enabled: Type.Boolean(),
  intervalMs: Type.Integer(),
  staleAfterMs: Type.Integer(),
  allowWaiting: Type.Boolean(),
  activityTimeoutMs: nullable(Type.Integer()),
  state: enumeration(serviceStates),
  reason: text,
  nextCheckAt: nullable(date),
  latest: nullable(serviceObservationSchema),
  lastSuccessful: nullable(serviceObservationSchema),
});
export type Service = Static<typeof serviceSchema>;
export const servicesSchema = object({
  services: Type.Array(serviceSchema),
  checkedAt: date,
});
