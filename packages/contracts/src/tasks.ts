import { object, nullable, enumeration, text, id, date, requestKey } from "./schema.js";
import { status } from "./states.js";
import { budgetWaitSchema } from "./budgets.js";
import { Type, type Static } from "@sinclair/typebox";

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
    maxRetries: nullable(Type.Integer()),
    maxConsecutiveErrors: nullable(Type.Integer()),
    maxTotalRunMs: nullable(Type.Integer()),
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
export const releaseTaskSchema = object({
  requestKey,
  expectedGoalVersion: Type.Integer({ minimum: 1 }),
});
export type ReleaseTask = Static<typeof releaseTaskSchema>;
export const taskReleaseSchema = object({
  sourceTaskId: id,
  newTaskId: id,
  goalId: id,
  goalVersion: Type.Integer({ minimum: 2 }),
  createdAt: date,
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
