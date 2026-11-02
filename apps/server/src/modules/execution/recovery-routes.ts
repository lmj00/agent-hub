import type { FastifyPluginAsync } from "fastify";
import { RecoveryError, type RecoveryInput, type RecoveryRequest, type RecoveryStore } from "./recover-task.js";
import { errorSchema, idParamsSchema as params, recoveryInputSchema, recoverySchema as responseSchema } from "@agent-hub/contracts";

function response(request: RecoveryRequest) {
  return { ...request, createdAt: request.createdAt.toISOString(), finishedAt: request.finishedAt?.toISOString() ?? null };
}

export const recoveryRoutes: FastifyPluginAsync<{
  queries: Pick<RecoveryStore, "findById">;
  request: (input: RecoveryInput) => ReturnType<RecoveryStore["request"]>;
}> = async (app, options) => {
  app.addHook("onRequest", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof RecoveryError) {
      const status = error.code === "TASK_NOT_FOUND" ? 404 : error.code === "EXECUTION_DISABLED" ? 503 : 409;
      return reply.code(status).send({ error: error.code, message: "Recovery request cannot be accepted; inspect the task, latest run and provider gate" });
    }
    if (error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: "INVALID_REQUEST", message: error.message });
    }
    request.log.error({ code: "RECOVERY_STORAGE_ERROR" }, "Unable to persist or query recovery request");
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: "Unable to process recovery request" });
  });
  app.post<{ Params: { id: string }; Body: Omit<RecoveryInput, "taskId" | "providerGateVersion"> & { providerGateVersion?: number | null } }>("/tasks/:id/recovery-requests", {
    onRequest: async (request, reply) => {
      if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
        return reply.code(415).send({ error: "INVALID_REQUEST", message: "Content-Type must be application/json" });
      }
    },
    schema: {
      params,
      body: recoveryInputSchema,
      response: { 200: responseSchema, 202: responseSchema, "4xx": errorSchema, "5xx": errorSchema },
    },
  }, async (request, reply) => {
    const result = options.request({ ...request.body, taskId: request.params.id, providerGateVersion: request.body.providerGateVersion ?? null });
    return reply.code(result.created ? 202 : 200).header("Location", `/recovery-requests/${result.request.id}`).send(response(result.request));
  });
  app.get<{ Params: { id: string } }>("/recovery-requests/:id", {
    schema: { params, response: { 200: responseSchema, "4xx": errorSchema, "5xx": errorSchema } },
  }, async (request, reply) => {
    const found = options.queries.findById(request.params.id);
    if (!found) return reply.code(404).send({ error: "RECOVERY_NOT_FOUND", message: "Recovery request not found" });
    return response(found);
  });
};
