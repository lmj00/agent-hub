import type { FastifyPluginAsync } from "fastify";
import { asc, desc, sql } from "drizzle-orm";
import {
  repositoryCreationInputSchema,
  repositoryCreationSchema,
  repositoryCreationsSchema,
  repositoryImportActionSchema,
  idParamsSchema,
  errorResponses,
  type RepositoryCreationInput,
} from "@agent-hub/contracts";
import type { openDatabase } from "../../db/connection.js";
import { repositoryCreations } from "../../db/schema.js";
import { CreationError, type createCreationStore, type CreationJob } from "./creation-store.js";
import type { createCreationWorker } from "./creation-worker.js";

function response(job: CreationJob) {
  return {
    id: job.id,
    repositoryName: job.repositoryName,
    name: job.name,
    profile: job.profile,
    status: job.status,
    attempt: job.attempt,
    repositoryId: job.repositoryId,
    fullName: job.fullName,
    importId: job.importId,
    errorCode: job.errorCode,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}
export const creationRoutes: FastifyPluginAsync<{
  db: ReturnType<typeof openDatabase>["db"];
  profiles: string[];
  store?: ReturnType<typeof createCreationStore>;
  worker?: ReturnType<typeof createCreationWorker>;
}> = async (app, { db, profiles, store, worker }) => {
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof CreationError)
      return reply
        .code(error.code === "CREATION_NOT_FOUND" ? 404 : 409)
        .send({ error: error.code, message: "Unable to change repository creation" });
    if (
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    )
      return reply
        .code(error.statusCode)
        .send({ error: "INVALID_REQUEST", message: "Invalid creation request" });
    return reply
      .code(500)
      .send({ error: "CREATION_FAILED", message: "Unable to change repository creation" });
  });
  app.get(
    "/integrations/github/creations",
    { schema: { response: { 200: repositoryCreationsSchema, ...errorResponses } } },
    async () => ({
      enabled: !!worker,
      profiles,
      creations: db
        .select()
        .from(repositoryCreations)
        .orderBy(
          sql`CASE WHEN ${repositoryCreations.status} IN ('queued', 'authorizing', 'creating', 'created', 'uncertain') THEN 0 ELSE 1 END`,
          desc(repositoryCreations.createdAt),
          asc(repositoryCreations.id),
        )
        .limit(20)
        .all()
        .map(response),
    }),
  );
  app.post<{ Body: RepositoryCreationInput }>(
    "/integrations/github/creations",
    {
      schema: {
        body: repositoryCreationInputSchema,
        response: { 202: repositoryCreationSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      if (!store || !worker) throw new CreationError("CREATION_NOT_CONFIGURED");
      if (!profiles.includes(request.body.profile))
        throw new CreationError("CREATION_PROFILE_UNAVAILABLE");
      const job = store.register(request.body);
      worker.wake();
      return reply.code(202).send(response(job));
    },
  );
  app.post<{ Params: { id: string }; Body: { action: "retry" | "cancel" } }>(
    "/integrations/github/creations/:id",
    {
      schema: {
        params: idParamsSchema,
        body: repositoryImportActionSchema,
        response: { 200: repositoryCreationSchema, ...errorResponses },
      },
    },
    async (request) => {
      if (!store || !worker) throw new CreationError("CREATION_NOT_CONFIGURED");
      const job = store.action(request.params.id, request.body.action);
      worker.wake();
      return response(job);
    },
  );
};
