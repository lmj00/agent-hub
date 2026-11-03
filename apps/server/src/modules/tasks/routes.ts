import type { FastifyPluginAsync } from "fastify";
import { createTask, TaskRegistrationError, type CreateTaskInput, type Task, type TaskStore } from "./create-task.js";
import {
  createTaskSchema, errorResponses as taskErrorResponses, tasksSchema as taskListResponseSchema,
  idParamsSchema as taskParamsSchema, projectParamsSchema as taskProjectParamsSchema, taskSchema as taskResponseSchema,
} from "@agent-hub/contracts";

type TaskOptions = { store: TaskStore; projectExists: (id: string) => boolean };

function toResponse(task: Task) {
  return {
    id: task.id,
    projectId: task.projectId,
    kind: task.kind ?? "work",
    goalId: task.goalId ?? null,
    goalVersion: task.goalVersion ?? null,
    budgetWait: task.budgetWait ?? null,
    instruction: task.instruction,
    requestKey: task.requestKey,
    status: task.status,
    retryState: task.retryState ?? null,
    createdAt: task.createdAt.toISOString(),
  };
}

export const taskRoutes: FastifyPluginAsync<TaskOptions> = async (app, { store, projectExists }) => {
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof TaskRegistrationError) {
      return reply.code(error.code === "PROJECT_NOT_FOUND" ? 404 : 409)
        .send({ error: error.code, message: error.message });
    }
    if (
      error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" &&
      error.statusCode >= 400 && error.statusCode < 500
    ) {
      return reply.code(error.statusCode).send({ error: "INVALID_REQUEST", message: error.message });
    }
    request.log.error({ err: error }, "Task request failed");
    return reply.code(500).send({ error: "INTERNAL_ERROR", message: "Unable to process task request" });
  });

  app.post<{ Params: { projectId: string }; Body: CreateTaskInput }>(
    "/projects/:projectId/tasks",
    {
      onRequest: async (request, reply) => {
        const contentType = request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
        if (contentType !== "application/json") {
          return reply.code(415).send({ error: "INVALID_REQUEST", message: "Content-Type must be application/json" });
        }
      },
      schema: {
        params: taskProjectParamsSchema, body: createTaskSchema,
        response: { 200: taskResponseSchema, 201: taskResponseSchema, ...taskErrorResponses },
      },
    },
    async (request, reply) => {
      const result = createTask(request.params.projectId, request.body, store, projectExists);
      return reply.code(result.created ? 201 : 200)
        .header("Location", `/tasks/${result.task.id}`).send(toResponse(result.task));
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/tasks",
    { schema: { params: taskProjectParamsSchema, response: { 200: taskListResponseSchema, ...taskErrorResponses } } },
    async (request) => {
      if (!projectExists(request.params.projectId)) throw new TaskRegistrationError("PROJECT_NOT_FOUND");
      return { tasks: store.listByProject(request.params.projectId).map(toResponse) };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/tasks/:id",
    { schema: { params: taskParamsSchema, response: { 200: taskResponseSchema, ...taskErrorResponses } } },
    async (request, reply) => {
      const task = store.findById(request.params.id);
      if (!task) return reply.code(404).send({ error: "TASK_NOT_FOUND", message: "Task not found" });
      return toResponse(task);
    },
  );
};
