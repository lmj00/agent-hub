import Fastify, { type FastifyServerOptions } from "fastify";
import { openDatabase } from "./db/connection.js";
import { healthRoutes } from "./modules/health/routes.js";
import { createDrizzleProjectStore } from "./modules/projects/drizzle-project-store.js";
import { projectRoutes } from "./modules/projects/routes.js";

type AppOptions = Omit<FastifyServerOptions, "ajv"> & { databasePath: string };

export function buildApp({ databasePath, ...options }: AppOptions) {
  const app = Fastify({
    ...options,
    // 잘못된 타입과 알 수 없는 필드를 자동 보정하지 않고 요청 오류로 알립니다.
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });

  app.register(async (scope) => {
    const database = openDatabase(databasePath);

    scope.addHook("onClose", async () => {
      database.close();
    });

    scope.register(healthRoutes, { checkDatabase: () => database.checkReady() });
    scope.register(projectRoutes, { store: createDrizzleProjectStore(database.db) });
  });

  return app;
}
