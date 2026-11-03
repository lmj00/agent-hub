import type { FastifyPluginAsync } from "fastify";
import { errorResponses, idParamsSchema, providerGateSchema, queueSchema, runDetailsSchema, runsSchema } from "@agent-hub/contracts";
import type { RunQueries, RunSummary } from "./run-task.js";
import type { QueueStatus } from "./execution-queue.js";

function summary(run: RunSummary) {
  return { ...run, goalVersion: run.goalVersion ?? null, startedAt: run.startedAt.toISOString(), finishedAt: run.finishedAt?.toISOString() ?? null };
}

export const executionRoutes: FastifyPluginAsync<{
  store: RunQueries;
  taskExists: (id: string) => boolean;
  getQueueStatus: () => QueueStatus;
}> = async (app, { store, taskExists, getQueueStatus }) => {
  app.addHook("onRequest", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof Error && "validation" in error) return reply.code(400).send({ error: "INVALID_REQUEST", message: error.message });
    request.log.error({ err: error }, "Execution query failed");
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: "Unable to query execution" });
  });
  app.get("/execution", { schema: { response: { 200: queueSchema, ...errorResponses } } }, async () => getQueueStatus());
  app.get("/execution/provider-gate", { schema: { response: { 200: providerGateSchema, ...errorResponses } } }, async () => {
    const gate = store.getProviderGate();
    return { ...gate, blockedAt: gate.blockedAt?.toISOString() ?? null, retryAt: gate.retryAt?.toISOString() ?? null };
  });
  app.get<{ Params: { id: string } }>("/tasks/:id/runs", {
    schema: { params: idParamsSchema, response: { 200: runsSchema, ...errorResponses } },
  }, async (request, reply) => {
    if (!taskExists(request.params.id)) return reply.code(404).send({ error: "TASK_NOT_FOUND", message: "Task not found" });
    return { runs: store.listByTask(request.params.id).map(summary) };
  });
  app.get<{ Params: { id: string } }>("/runs/:id", { schema: { params: idParamsSchema, response: { 200: runDetailsSchema, ...errorResponses } } }, async (request, reply) => {
    const run = store.findById(request.params.id);
    if (!run) return reply.code(404).send({ error: "RUN_NOT_FOUND", message: "Run not found" });
    return {
      ...summary(run), result: run.result, errorCode: run.errorCode, lastActivityAt: run.lastActivityAt.toISOString(),
      stopReason: run.stopReason, stopRequestedAt: run.stopRequestedAt?.toISOString() ?? null,
      terminationConfirmedAt: run.terminationConfirmedAt?.toISOString() ?? null,
      retryAt: run.retryAt?.toISOString() ?? null,
      steps: run.steps.map(step => ({ ...step, startedAt: step.startedAt.toISOString(), finishedAt: step.finishedAt?.toISOString() ?? null })),
      events: run.events.map(event => ({ ...event, createdAt: event.createdAt.toISOString() })),
    };
  });
};
