import type { FastifyPluginAsync } from "fastify";
import { asc, eq, sql } from "drizzle-orm";
import {
  projectPublicationSchema,
  updateProjectPublicationSchema,
  publicProjectsSchema,
  projectOverviewQuerySchema,
  idParamsSchema,
  errorResponses,
  type ProjectPublication,
  type PublicProjects,
} from "@agent-hub/contracts";
import type { openDatabase } from "../../db/connection.js";
import { projects, projectPublications, tasks, runs } from "../../db/schema.js";

export const publicationRoutes: FastifyPluginAsync<{
  db: ReturnType<typeof openDatabase>["db"];
}> = async (app, { db }) => {
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });
  app.setErrorHandler((error, request, reply) => {
    const code = error instanceof Error && "statusCode" in error ? error.statusCode : 500;
    if (typeof code === "number" && code >= 400 && code < 500)
      return reply
        .code(code)
        .send({ error: "INVALID_REQUEST", message: "Invalid publication request" });
    request.log.error({ err: error }, "Publication request failed");
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: "Unable to read publication" });
  });
  app.get<{ Querystring: { offset?: string } }>(
    "/public/projects",
    {
      schema: {
        querystring: projectOverviewQuerySchema,
        response: { 200: publicProjectsSchema, ...errorResponses },
      },
    },
    async (request): Promise<PublicProjects> => {
      const offset = Number(request.query.offset ?? 0);
      // Never select private names, workspace keys, instructions, goals or AI output.
      // A single read transaction keeps the list and private count consistent.
      return db.transaction((tx) => {
        const rows = tx
          .select({
            id: projectPublications.projectId,
            name: projectPublications.name,
            state: sql<"attention" | "running" | "idle">`case
          when exists (select 1 from ${runs} join ${tasks} on ${tasks.id} = ${runs.taskId} where ${tasks.projectId} = ${projectPublications.projectId} and ${runs.status} in ('interrupted', 'blocked', 'waiting_capacity') and ${runs.terminationConfirmedAt} is null) then 'attention'
          when exists (select 1 from ${tasks} where ${tasks.projectId} = ${projectPublications.projectId} and ${tasks.status} = 'running') then 'running'
          else 'idle' end`,
          })
          .from(projectPublications)
          .innerJoin(projects, eq(projects.id, projectPublications.projectId))
          .where(eq(projectPublications.listed, true))
          .orderBy(asc(projectPublications.projectId))
          .limit(25)
          .offset(offset)
          .all();
        const count = tx
          .select({ count: sql<number>`count(*)` })
          .from(projects)
          .where(
            sql`not exists (select 1 from ${projectPublications} where ${projectPublications.projectId} = ${projects.id} and ${projectPublications.listed} = 1)`,
          )
          .get()!;
        return {
          projects: rows.slice(0, 24),
          privateCount: count.count,
          nextOffset: rows.length > 24 ? offset + 24 : null,
        };
      });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/projects/:id/publication",
    {
      schema: {
        params: idParamsSchema,
        response: { 200: projectPublicationSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const project = db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, request.params.id))
        .get();
      if (!project)
        return reply.code(404).send({ error: "PROJECT_NOT_FOUND", message: "Project not found" });
      const publication = db
        .select({ listed: projectPublications.listed, name: projectPublications.name })
        .from(projectPublications)
        .where(eq(projectPublications.projectId, project.id))
        .get();
      return publication ?? { listed: false, name: "" };
    },
  );
  app.put<{ Params: { id: string }; Body: ProjectPublication }>(
    "/projects/:id/publication",
    {
      schema: {
        params: idParamsSchema,
        body: updateProjectPublicationSchema,
        response: { 200: projectPublicationSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const project = db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, request.params.id))
        .get();
      if (!project)
        return reply.code(404).send({ error: "PROJECT_NOT_FOUND", message: "Project not found" });
      const publication = { listed: request.body.listed, name: request.body.name.trim() };
      db.insert(projectPublications)
        .values({ projectId: project.id, ...publication })
        .onConflictDoUpdate({ target: projectPublications.projectId, set: publication })
        .run();
      return publication;
    },
  );
};
