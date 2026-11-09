import type { FastifyPluginAsync } from "fastify";
import { desc, asc, sql } from "drizzle-orm";
import {
  repositoryImportInputSchema,
  repositoryImportSchema,
  repositoryImportsSchema,
  repositoryImportActionSchema,
  idParamsSchema,
  errorResponses,
  type RepositoryImportInput,
} from "@agent-hub/contracts";
import type { openDatabase } from "../../db/connection.js";
import { repositoryImports } from "../../db/schema.js";
import type { createImportStore, ImportJob } from "./import-store.js";
import type { createImportWorker } from "./import-worker.js";
import { ImportError } from "./import-workspace.js";

function response(job: ImportJob) {
  return {
    id: job.id,
    repositoryId: job.repositoryId,
    name: job.name,
    profile: job.profile,
    status: job.status,
    attempt: job.attempt,
    cancelRequestedAt: job.cancelRequestedAt?.toISOString() ?? null,
    fullName: job.fullName,
    revision: job.revision,
    errorCode: job.errorCode,
    projectId: job.projectId,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}
export const importRoutes: FastifyPluginAsync<{
  db: ReturnType<typeof openDatabase>["db"];
  profiles: string[];
  store?: ReturnType<typeof createImportStore>;
  worker?: ReturnType<typeof createImportWorker>;
}> = async (app, { db, profiles, store, worker }) => {
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ImportError)
      return reply
        .code(error.code === "IMPORT_NOT_FOUND" ? 404 : 409)
        .send({ error: error.code, message: "Unable to change repository import" });
    if (
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    )
      return reply
        .code(error.statusCode)
        .send({ error: "INVALID_REQUEST", message: "Invalid import request" });
    return reply
      .code(500)
      .send({ error: "IMPORT_FAILED", message: "Unable to change repository import" });
  });
  app.get(
    "/integrations/github/imports",
    { schema: { response: { 200: repositoryImportsSchema, ...errorResponses } } },
    async () => ({
      enabled: !!worker,
      profiles,
      imports: db
        .select()
        .from(repositoryImports)
        .orderBy(
          sql`CASE WHEN ${repositoryImports.status} IN ('preparing', 'queued') THEN 0 ELSE 1 END`,
          desc(repositoryImports.createdAt),
          asc(repositoryImports.id),
        )
        .limit(20)
        .all()
        .map(response),
    }),
  );
  app.post<{ Body: RepositoryImportInput }>(
    "/integrations/github/imports",
    {
      schema: {
        body: repositoryImportInputSchema,
        response: { 202: repositoryImportSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      if (!store || !worker) throw new ImportError("IMPORT_NOT_CONFIGURED");
      if (!profiles.includes(request.body.profile))
        throw new ImportError("IMPORT_PROFILE_UNAVAILABLE");
      const job = store.register(request.body);
      worker.wake();
      return reply.code(202).send(response(job));
    },
  );
  app.post<{ Params: { id: string }; Body: { action: "retry" | "cancel" } }>(
    "/integrations/github/imports/:id",
    {
      schema: {
        params: idParamsSchema,
        body: repositoryImportActionSchema,
        response: { 200: repositoryImportSchema, ...errorResponses },
      },
    },
    async (request) => {
      if (!store || !worker) throw new ImportError("IMPORT_NOT_CONFIGURED");
      const job = store.action(request.params.id, request.body.action);
      if (request.body.action === "cancel") worker.cancel(job.id);
      worker.wake();
      return response(job);
    },
  );
};
