import type { FastifyPluginAsync } from "fastify";
import { createProject, type CreateProjectInput, type Project, type ProjectStore } from "./create-project.js";
import {
  createProjectSchema,
  errorResponses as projectErrorResponses,
  projectsSchema as projectListResponseSchema,
  idParamsSchema as projectParamsSchema,
  projectSchema as projectResponseSchema,
} from "@agent-hub/contracts";

function toResponse(project: Project) {
  return {
    id: project.id,
    name: project.name,
    workspaceKey: project.workspaceKey,
    createdAt: project.createdAt.toISOString(),
  };
}

export const projectRoutes: FastifyPluginAsync<{ store: ProjectStore }> = async (app, { store }) => {
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });

  app.setErrorHandler((error, request, reply) => {
    if (
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 && error.statusCode < 500
    ) {
      return reply.code(error.statusCode).send({
        error: "INVALID_REQUEST",
        message: error.message,
      });
    }

    request.log.error({ err: error }, "Project request failed");
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: "Unable to process project request" });
  });

  app.post<{ Body: CreateProjectInput }>(
    "/projects",
    {
      onRequest: async (request, reply) => {
        const contentType = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
        if (contentType !== "application/json") {
          return reply.code(415).send({ error: "INVALID_REQUEST", message: "Content-Type must be application/json" });
        }
      },
      schema: { body: createProjectSchema, response: { 201: projectResponseSchema, ...projectErrorResponses } },
    },
    async (request, reply) => {
      const project = createProject(request.body, store);
      return reply.code(201).header("Location", `/projects/${project.id}`).send(toResponse(project));
    },
  );

  app.get(
    "/projects",
    { schema: { response: { 200: projectListResponseSchema, ...projectErrorResponses } } },
    async () => ({ projects: store.list().map(toResponse) }),
  );

  app.get<{ Params: { id: string } }>(
    "/projects/:id",
    { schema: { params: projectParamsSchema, response: { 200: projectResponseSchema, ...projectErrorResponses } } },
    async (request, reply) => {
      const project = store.findById(request.params.id);
      if (!project) {
        return reply.code(404).send({ error: "PROJECT_NOT_FOUND", message: "Project not found" });
      }
      return toResponse(project);
    },
  );
};
