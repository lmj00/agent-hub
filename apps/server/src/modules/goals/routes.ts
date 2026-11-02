import type { FastifyPluginAsync } from "fastify";
import {
  createGoalSchema,
  updateGoalSchema,
  controlGoalSchema,
  goalSchema,
  goalsSchema,
  goalHistorySchema,
  errorResponses,
  idParamsSchema,
  projectParamsSchema,
  type Static,
} from "@agent-hub/contracts";
import type { createDrizzleGoalStore } from "./drizzle-goal-store.js";
import { GoalError } from "./goal-policy.js";

export const goalRoutes: FastifyPluginAsync<{
  store: ReturnType<typeof createDrizzleGoalStore>;
}> = async (app, { store }) => {
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (
      ["POST", "PATCH"].includes(request.method) &&
      request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
        "application/json"
    )
      return reply
        .code(415)
        .send({
          error: "INVALID_REQUEST",
          message: "Content-Type must be application/json",
        });
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof GoalError)
      return reply
        .code(
          error.code.endsWith("NOT_FOUND")
            ? 404
            : error.code === "INVALID_GOAL"
              ? 400
              : 409,
        )
        .send({ error: error.code, message: error.message });
    if (
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    )
      return reply
        .code(error.statusCode)
        .send({
          error: "INVALID_REQUEST",
          message: "Goal request does not match the contract",
        });
    request.log.error({ code: "GOAL_STORAGE_ERROR" }, "Goal request failed");
    return reply
      .code(500)
      .send({
        error: "INTERNAL_ERROR",
        message: "Unable to process goal request",
      });
  });
  app.post<{
    Params: { projectId: string };
    Body: Static<typeof createGoalSchema>;
  }>(
    "/projects/:projectId/goals",
    {
      schema: {
        params: projectParamsSchema,
        body: createGoalSchema,
        response: { 200: goalSchema, 201: goalSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const result = store.register(
        request.params.projectId,
        request.body.requestKey,
        request.body.definition,
      );
      return reply
        .code(result.created ? 201 : 200)
        .header("Location", `/goals/${result.goal.id}`)
        .send(result.goal);
    },
  );
  app.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/goals",
    {
      schema: {
        params: projectParamsSchema,
        response: { 200: goalsSchema, ...errorResponses },
      },
    },
    async (request) => ({
      goals: store.listByProject(request.params.projectId),
    }),
  );
  app.get<{ Params: { id: string } }>(
    "/goals/:id",
    {
      schema: {
        params: idParamsSchema,
        response: { 200: goalSchema, ...errorResponses },
      },
    },
    async (request) => store.findById(request.params.id),
  );
  app.get<{ Params: { id: string } }>(
    "/goals/:id/revisions",
    {
      schema: {
        params: idParamsSchema,
        response: { 200: goalHistorySchema, ...errorResponses },
      },
    },
    async (request) => ({ revisions: store.history(request.params.id) }),
  );
  app.patch<{ Params: { id: string }; Body: Static<typeof updateGoalSchema> }>(
    "/goals/:id",
    {
      schema: {
        params: idParamsSchema,
        body: updateGoalSchema,
        response: { 200: goalSchema, ...errorResponses },
      },
    },
    async (request) =>
      store.change(
        request.params.id,
        request.body.requestKey,
        request.body.expectedVersion,
        { definition: request.body.definition },
      ),
  );
  app.post<{ Params: { id: string }; Body: Static<typeof controlGoalSchema> }>(
    "/goals/:id/control",
    {
      schema: {
        params: idParamsSchema,
        body: controlGoalSchema,
        response: { 200: goalSchema, ...errorResponses },
      },
    },
    async (request) =>
      store.change(
        request.params.id,
        request.body.requestKey,
        request.body.expectedVersion,
        { action: request.body.action },
      ),
  );
};
