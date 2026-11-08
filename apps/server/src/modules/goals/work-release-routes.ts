import type { FastifyPluginAsync } from "fastify";
import {
  errorResponses,
  idParamsSchema,
  releaseTaskSchema,
  taskReleaseSchema,
  type ReleaseTask,
} from "@agent-hub/contracts";
import { WorkReleaseError, type createWorkReleaseStore } from "./work-release-store.js";

export const workReleaseRoutes: FastifyPluginAsync<{
  store: ReturnType<typeof createWorkReleaseStore>;
}> = async (app, { store }) => {
  app.setErrorHandler((error, request, reply) => {
    if (
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      return reply
        .code(error.statusCode)
        .send({ error: "INVALID_REQUEST", message: error.message });
    }
    request.log.error({ err: error }, "Work release request failed");
    return reply.code(500).send({
      error: "INTERNAL_ERROR",
      message: "Unable to release cancelled work",
    });
  });
  app.post<{ Params: { id: string }; Body: ReleaseTask }>(
    "/tasks/:id/release",
    {
      onRequest: async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        if (
          request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
          "application/json"
        )
          return reply.code(415).send({
            error: "INVALID_REQUEST",
            message: "Content-Type must be application/json",
          });
      },
      schema: {
        params: idParamsSchema,
        body: releaseTaskSchema,
        response: {
          200: taskReleaseSchema,
          201: taskReleaseSchema,
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      try {
        const result = store.release(request.params.id, request.body);
        return reply
          .code(result.created ? 201 : 200)
          .header("Location", `/tasks/${result.release.newTaskId}`)
          .send(result.release);
      } catch (error) {
        if (error instanceof WorkReleaseError)
          return reply
            .code(error.code === "TASK_NOT_FOUND" ? 404 : 409)
            .send({ error: error.code, message: error.message });
        request.log.error({ err: error }, "Work release failed");
        return reply.code(500).send({
          error: "INTERNAL_ERROR",
          message: "Unable to release cancelled work",
        });
      }
    },
  );
};
