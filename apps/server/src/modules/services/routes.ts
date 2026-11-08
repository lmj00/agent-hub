import type { FastifyPluginAsync } from "fastify";
import { errorResponses, projectParamsSchema, servicesSchema } from "@agent-hub/contracts";
import type { ObserverStatus, ServiceStore } from "./drizzle-service-store.js";

export const serviceRoutes: FastifyPluginAsync<{
  store: ServiceStore;
  projectExists: (id: string) => boolean;
  getObserverStatus: () => ObserverStatus;
}> = async (app, options) => {
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof Error && "validation" in error)
      return reply.code(400).send({
        error: "INVALID_REQUEST",
        message: "Invalid project identifier",
      });
    request.log.error({ code: "SERVICE_QUERY_ERROR" }, "Unable to query service observations");
    return reply.code(503).send({
      error: "SERVICE_QUERY_ERROR",
      message: "Unable to query service observations",
    });
  });
  app.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/services",
    {
      schema: {
        params: projectParamsSchema,
        response: { 200: servicesSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      if (!options.projectExists(request.params.projectId))
        return reply.code(404).send({ error: "PROJECT_NOT_FOUND", message: "Project not found" });
      const now = new Date();
      return {
        services: options.store.list(request.params.projectId, options.getObserverStatus(), now),
        checkedAt: now.toISOString(),
      };
    },
  );
};
