import type { FastifyPluginAsync } from "fastify";

type LivenessResponse = {
  status: "ok";
  checkedAt: string;
};

type HealthOptions = {
  checkDatabase: () => void;
};

type ReadinessResponse = {
  status: "ok" | "unavailable";
  database: "ok" | "unavailable";
  checkedAt: string;
};

const readinessSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "database", "checkedAt"],
  properties: {
    status: { type: "string", enum: ["ok", "unavailable"] },
    database: { type: "string", enum: ["ok", "unavailable"] },
    checkedAt: { type: "string", format: "date-time" },
  },
};

export const healthRoutes: FastifyPluginAsync<HealthOptions> = async (app, { checkDatabase }) => {
  app.get<{ Reply: LivenessResponse }>(
    "/health/live",
    {
      schema: {
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["status", "checkedAt"],
            properties: {
              status: { type: "string", enum: ["ok"] },
              checkedAt: { type: "string", format: "date-time" },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
      return { status: "ok", checkedAt: new Date().toISOString() };
    },
  );

  app.get<{ Reply: ReadinessResponse }>(
    "/health/ready",
    { schema: { response: { 200: readinessSchema, 503: readinessSchema } } },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");

      try {
        checkDatabase();
        return { status: "ok", database: "ok", checkedAt: new Date().toISOString() };
      } catch (error) {
        request.log.error({ err: error }, "Database readiness check failed");
        reply.code(503);
        return { status: "unavailable", database: "unavailable", checkedAt: new Date().toISOString() };
      }
    },
  );
};
