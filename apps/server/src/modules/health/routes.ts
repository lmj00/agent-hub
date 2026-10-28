import type { FastifyPluginAsync } from "fastify";

type LivenessResponse = {
  status: "ok";
  checkedAt: string;
};

export const healthRoutes: FastifyPluginAsync = async (app) => {
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
};
