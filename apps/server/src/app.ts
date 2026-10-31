import Fastify, { type FastifyServerOptions } from "fastify";
import { openDatabase } from "./db/connection.js";
import { healthRoutes } from "./modules/health/routes.js";

type AppOptions = FastifyServerOptions & { databasePath: string };

export function buildApp({ databasePath, ...options }: AppOptions) {
  const app = Fastify(options);

  app.register(async (scope) => {
    const database = openDatabase(databasePath);

    scope.addHook("onClose", async () => {
      database.close();
    });

    scope.register(healthRoutes, { checkDatabase: () => database.checkReady() });
  });

  return app;
}
