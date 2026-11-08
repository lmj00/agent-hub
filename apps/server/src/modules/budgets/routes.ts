import type { FastifyPluginAsync } from "fastify";
import {
  errorResponses,
  projectParamsSchema,
  projectBudgetSchema,
  updateProjectBudgetSchema,
  type Static,
} from "@agent-hub/contracts";
import { BudgetError } from "./budget-policy.js";
import type { createProjectBudgetStore } from "./project-budget-store.js";

export const budgetRoutes: FastifyPluginAsync<{
  store: ReturnType<typeof createProjectBudgetStore>;
}> = async (app, { store }) => {
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (
      request.method === "PUT" &&
      request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json"
    )
      return reply.code(415).send({
        error: "INVALID_REQUEST",
        message: "Content-Type must be application/json",
      });
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof BudgetError)
      return reply
        .code(
          error.code === "PROJECT_NOT_FOUND" ? 404 : error.code === "INVALID_BUDGET" ? 400 : 409,
        )
        .send({ error: error.code, message: error.message });
    if (
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    )
      return reply.code(error.statusCode).send({
        error: "INVALID_REQUEST",
        message: "Budget request does not match the contract",
      });
    request.log.error({ code: "BUDGET_STORAGE_ERROR" }, "Budget request failed");
    return reply.code(500).send({
      error: "INTERNAL_ERROR",
      message: "Unable to process budget request",
    });
  });
  app.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/budget",
    {
      schema: {
        params: projectParamsSchema,
        response: { 200: projectBudgetSchema, ...errorResponses },
      },
    },
    async (request) => store.view(request.params.projectId),
  );
  app.put<{
    Params: { projectId: string };
    Body: Static<typeof updateProjectBudgetSchema>;
  }>(
    "/projects/:projectId/budget",
    {
      schema: {
        params: projectParamsSchema,
        body: updateProjectBudgetSchema,
        response: { 200: projectBudgetSchema, ...errorResponses },
      },
    },
    async (request) =>
      store.change(request.params.projectId, request.body.expectedVersion, request.body.policy),
  );
};
