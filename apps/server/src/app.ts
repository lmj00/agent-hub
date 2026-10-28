import Fastify, { type FastifyServerOptions } from "fastify";
import { healthRoutes } from "./modules/health/routes.js";

export function buildApp(options: FastifyServerOptions = {}) {
  const app = Fastify(options);

  app.register(healthRoutes);

  return app;
}
