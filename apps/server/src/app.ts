import Fastify, { type FastifyServerOptions } from "fastify";
import { openDatabase } from "./db/connection.js";
import { healthRoutes } from "./modules/health/routes.js";
import { createDrizzleProjectStore } from "./modules/projects/drizzle-project-store.js";
import { projectRoutes } from "./modules/projects/routes.js";
import { createDrizzleTaskStore } from "./modules/tasks/drizzle-task-store.js";
import { taskRoutes } from "./modules/tasks/routes.js";
import { createDrizzleRunStore } from "./modules/execution/drizzle-run-store.js";
import { executionRoutes } from "./modules/execution/routes.js";
import { acquireExecutionOwner } from "./modules/execution/execution-owner.js";
import { createExecutionQueue } from "./modules/execution/execution-queue.js";
import { validateExecutionEnvironment, type ExecutionConfig } from "./modules/execution/execution-config.js";
import { createConfiguredExecutor } from "./modules/execution/execution-process.js";
import type { AnalysisExecutor } from "./modules/execution/analysis.js";
import { createDrizzleRecoveryStore } from "./modules/execution/drizzle-recovery-store.js";
import { createRecoveryProcessor, RecoveryError, type ExecutionObserver, type RecoveryStore } from "./modules/execution/recover-task.js";
import { recoveryRoutes } from "./modules/execution/recovery-routes.js";
import { removeFinishedContainer, stopAndConfirmContainer } from "./modules/execution/container-runtime.js";
import type { AuthConfig } from "./modules/auth/auth-config.js";
import { createDrizzleSessionStore } from "./modules/auth/drizzle-session-store.js";
import { installAuthentication } from "./modules/auth/authentication.js";
import { webRoutes } from "./modules/web/routes.js";

type AppOptions = Omit<FastifyServerOptions, "ajv"> & {
  databasePath: string;
  auth?: AuthConfig;
  webDirectory?: string;
  execution?: { config: ExecutionConfig; executor?: AnalysisExecutor; observer?: ExecutionObserver; pollIntervalMs?: number };
};

export function buildApp({ databasePath, execution, auth, webDirectory, ...options }: AppOptions) {
  if (webDirectory && !auth) throw new Error("The management UI requires authentication");
  const app = Fastify({
    ...options,
    // 잘못된 타입과 알 수 없는 필드를 자동 보정하지 않고 요청 오류로 알립니다.
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });

  app.register(async (scope) => {
    const database = openDatabase(databasePath);
    let owner: ReturnType<typeof acquireExecutionOwner> | undefined;
    let queue: ReturnType<typeof createExecutionQueue> | undefined;
    let recovery: RecoveryStore | undefined;
    let canTrackTermination = false;

    scope.addHook("onClose", async () => {
      try {
        await queue?.stop();
        owner?.release();
      } finally { database.close(); }
    });
    scope.addHook("preClose", async () => { await queue?.stop(); });

    if (execution) {
      try {
        validateExecutionEnvironment(execution.config, databasePath, auth ? [auth.sourcePath] : []);
        owner = acquireExecutionOwner(database.db);
        const executor = execution.executor ?? createConfiguredExecutor(execution.config);
        canTrackTermination = typeof executor.confirmTermination === "function";
        recovery = createDrizzleRecoveryStore(database.db, owner.token);
        queue = createExecutionQueue({
          ...execution,
          store: createDrizzleRunStore(database.db, owner.token),
          executor,
          recovery: createRecoveryProcessor(recovery, execution.observer ?? { confirm: stopAndConfirmContainer, cleanup: removeFinishedContainer }),
          validate: () => validateExecutionEnvironment(execution.config, databasePath, auth ? [auth.sourcePath] : []),
          reportDiagnostic: (diagnostic) => {
            if (diagnostic.event === "execution_queue.error") scope.log.error(diagnostic, "Execution queue check failed");
            else scope.log.info(diagnostic, "Execution queue check recovered");
          },
        });
      } catch (error) {
        owner?.release();
        database.close();
        throw error;
      }
      scope.addHook("onListen", async () => { queue?.start(); });
    }

    if (auth) await installAuthentication(scope, auth, createDrizzleSessionStore(database.db));
    if (webDirectory) scope.register(webRoutes, { directory: webDirectory });
    scope.register(healthRoutes, { checkDatabase: () => database.checkReady() });
    const projectStore = createDrizzleProjectStore(database.db);
    scope.register(projectRoutes, { store: projectStore });
    const taskStore = createDrizzleTaskStore(database.db);
    scope.register(taskRoutes, {
      store: taskStore,
      projectExists: (id) => projectStore.findById(id) !== undefined,
    });
    scope.register(executionRoutes, {
      store: createDrizzleRunStore(database.db),
      taskExists: (id) => taskStore.findById(id) !== undefined,
      getQueueStatus: () => queue?.getStatus() ?? {
        state: "disabled", runId: null, taskId: null, reason: null, lastCheckedAt: null,
      },
    });
    scope.register(recoveryRoutes, {
      queries: createDrizzleRecoveryStore(database.db),
      request: input => {
        if (!recovery || !queue) throw new RecoveryError("EXECUTION_DISABLED");
        const result = recovery.request(input, queue.getActiveRunId(), canTrackTermination);
        if (input.action === "cancel") queue.cancel(input.runId);
        return result;
      },
    });
  });

  return app;
}
