import type { FastifyPluginAsync } from "fastify";
import { taskStatuses } from "../tasks/task-state.js";
import type { RunQueries, RunSummary } from "./run-task.js";

const date = { type: "string", format: "date-time" };
const nullableDate = { anyOf: [date, { type: "null" }] };
const nullableText = { type: ["string", "null"] };
const status = { type: "string", enum: taskStatuses };
const summaryProperties = {
  id: { type: "string" }, taskId: { type: "string" }, status,
  model: { type: "string" }, effort: { type: "string" }, startedAt: date, finishedAt: nullableDate,
};
const summarySchema = { type: "object", additionalProperties: false, required: Object.keys(summaryProperties), properties: summaryProperties };
const detailsSchema = {
  type: "object", additionalProperties: false,
  required: [...Object.keys(summaryProperties), "lastActivityAt", "result", "errorCode", "steps", "events"],
  properties: {
    ...summaryProperties, lastActivityAt: date, result: nullableText, errorCode: nullableText,
    steps: { type: "array", items: {
      type: "object", additionalProperties: false,
      required: ["sequence", "status", "sessionId", "usage", "startedAt", "finishedAt"],
      properties: {
        sequence: { type: "integer" }, status, sessionId: nullableText, startedAt: date, finishedAt: nullableDate,
        usage: { anyOf: [{ type: "null" }, {
          type: "object", additionalProperties: false, required: ["inputTokens", "cachedInputTokens", "outputTokens"],
          properties: { inputTokens: { type: "integer" }, cachedInputTokens: { type: "integer" }, outputTokens: { type: "integer" } },
        }] },
      },
    } },
    events: { type: "array", items: {
      type: "object", additionalProperties: false, required: ["sequence", "kind", "createdAt"],
      properties: { sequence: { type: "integer" }, kind: { type: "string" }, createdAt: date },
    } },
  },
};
const params = { type: "object", required: ["id"], additionalProperties: false, properties: { id: { type: "string", format: "uuid" } } };
const errorSchema = { type: "object", additionalProperties: false, required: ["error", "message"], properties: { error: { type: "string" }, message: { type: "string" } } };
const errors = { "4xx": errorSchema, "5xx": errorSchema };

function summary(run: RunSummary) {
  return { ...run, startedAt: run.startedAt.toISOString(), finishedAt: run.finishedAt?.toISOString() ?? null };
}

export const executionRoutes: FastifyPluginAsync<{ store: RunQueries; taskExists: (id: string) => boolean }> = async (app, { store, taskExists }) => {
  app.addHook("onRequest", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof Error && "validation" in error) return reply.code(400).send({ error: "INVALID_REQUEST", message: error.message });
    request.log.error({ err: error }, "Execution query failed");
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: "Unable to query execution" });
  });
  app.get<{ Params: { id: string } }>("/tasks/:id/runs", {
    schema: { params, response: { 200: { type: "object", required: ["runs"], additionalProperties: false, properties: { runs: { type: "array", items: summarySchema } } }, ...errors } },
  }, async (request, reply) => {
    if (!taskExists(request.params.id)) return reply.code(404).send({ error: "TASK_NOT_FOUND", message: "Task not found" });
    return { runs: store.listByTask(request.params.id).map(summary) };
  });
  app.get<{ Params: { id: string } }>("/runs/:id", { schema: { params, response: { 200: detailsSchema, ...errors } } }, async (request, reply) => {
    const run = store.findById(request.params.id);
    if (!run) return reply.code(404).send({ error: "RUN_NOT_FOUND", message: "Run not found" });
    return {
      ...summary(run), result: run.result, errorCode: run.errorCode, lastActivityAt: run.lastActivityAt.toISOString(),
      steps: run.steps.map(step => ({ ...step, startedAt: step.startedAt.toISOString(), finishedAt: step.finishedAt?.toISOString() ?? null })),
      events: run.events.map(event => ({ ...event, createdAt: event.createdAt.toISOString() })),
    };
  });
};
