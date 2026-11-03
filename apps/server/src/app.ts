import { createCapacityRecovery } from "./modules/execution/capacity-recovery.js";
import { createAutomaticRecovery } from "./modules/execution/automatic-recovery.js";
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
import type { ServiceConfig } from "./modules/services/service-config.js";
import { createDrizzleServiceStore } from "./modules/services/drizzle-service-store.js";
import { createServiceObserver } from "./modules/services/service-observer.js";
import { serviceRoutes } from "./modules/services/routes.js";
import { createDrizzleGoalStore } from "./modules/goals/drizzle-goal-store.js";
import { goalRoutes } from "./modules/goals/routes.js";
import { budgetRoutes } from "./modules/budgets/routes.js";
import { createProjectBudgetStore } from "./modules/budgets/project-budget-store.js";
import { cleanupConfirmedInputs, cleanupPreparedRun, createPreparedExecutor } from "./modules/goals/prepared-executor.js";
import { preparedInputRoot } from "./modules/goals/prepared-workspace.js";

type AppOptions = Omit<FastifyServerOptions, "ajv"> & {
  databasePath: string;
  auth?: AuthConfig;
  webDirectory?: string;
  services?: ServiceConfig;
  execution?: { config: ExecutionConfig; executor?: AnalysisExecutor; observer?: ExecutionObserver; pollIntervalMs?: number };
};

export function buildApp({ databasePath, execution, auth, webDirectory, services, ...options }: AppOptions) {
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
    let serviceObserver: ReturnType<typeof createServiceObserver> | undefined;
    let canTrackTermination = false;
    const protectedFiles = [auth?.sourcePath, services?.sourcePath].filter((path): path is string => path !== undefined);

    scope.addHook("onClose", async () => {
      try {
        await Promise.all([queue?.stop(), serviceObserver?.stop()]);
        owner?.release();
      } finally { database.close(); }
    });
    scope.addHook("preClose", async () => { await Promise.all([queue?.stop(), serviceObserver?.stop()]); });

    if (execution || services) {
      try {
        if (execution) validateExecutionEnvironment(execution.config, databasePath, protectedFiles);
        owner = acquireExecutionOwner(database.db);
        if (services) {
          const serviceStore = createDrizzleServiceStore(database.db, owner.token);
          serviceStore.configure(services.targets);
          serviceObserver = createServiceObserver({ targets: services.targets, store: serviceStore, report: event => {
            if (event.code === "SERVICE_OBSERVER_ERROR") scope.log.error(event, "Service observation storage failed");
            else scope.log.info(event, "Service observation storage recovered");
          } });
        }
        if (execution) {
          const inputRoot = preparedInputRoot(databasePath);
          cleanupConfirmedInputs(database.db, inputRoot);
          const executor = createPreparedExecutor(execution.executor ?? createConfiguredExecutor(execution.config), inputRoot);
          canTrackTermination = typeof executor.confirmTermination === "function";
          if (execution.config.automaticRecovery && !canTrackTermination) throw new Error("Automatic recovery requires execution termination tracking");
          recovery = createDrizzleRecoveryStore(database.db, owner.token);
          queue = createExecutionQueue({
            ...execution,
            store: createDrizzleRunStore(database.db, owner.token, execution.config),
            executor,
            ...(execution.config.automaticRecovery ? { automaticRecovery: createAutomaticRecovery({ db: database.db, ownerToken: owner.token, policy: execution.config.automaticRecovery, workspaceKeys: [...execution.config.workspaces.keys()], recovery }) } : {}),
            ...(execution.config.automaticRecovery && execution.config.capacityRecovery ? { capacityRecovery: createCapacityRecovery({ db: database.db, ownerToken: owner.token, policy: execution.config.capacityRecovery, retryPolicy: execution.config.automaticRecovery, workspaceKeys: [...execution.config.workspaces.keys()] }) } : {}),
            recovery: createRecoveryProcessor(recovery, execution.observer ?? { confirm: stopAndConfirmContainer, cleanup: removeFinishedContainer }, runId => cleanupPreparedRun(database.db, inputRoot, runId)),
            validate: () => validateExecutionEnvironment(execution.config, databasePath, protectedFiles),
            reportDiagnostic: (diagnostic) => {
              if (diagnostic.event === "execution_queue.error") scope.log.error(diagnostic, "Execution queue check failed");
              else scope.log.info(diagnostic, "Execution queue check recovered");
            },
          });
        }
      } catch (error) {
        owner?.release();
        owner = undefined;
        database.close();
        throw error;
      }
      scope.addHook("onListen", async () => { queue?.start(); serviceObserver?.start(); });
    }

    if (auth) await installAuthentication(scope, auth, createDrizzleSessionStore(database.db));
    if (webDirectory) scope.register(webRoutes, { directory: webDirectory });
    scope.register(healthRoutes, { checkDatabase: () => database.checkReady() });
    const projectStore = createDrizzleProjectStore(database.db);
    scope.register(projectRoutes, { store: projectStore });
    scope.register(goalRoutes, { store: createDrizzleGoalStore(database.db) });
    scope.register(budgetRoutes, { store: createProjectBudgetStore(database.db) });
    scope.register(serviceRoutes, {
      store: createDrizzleServiceStore(database.db), projectExists: id => projectStore.findById(id) !== undefined,
      getObserverStatus: () => serviceObserver?.getStatus() ?? { enabledKeys: new Set<string>(), errors: new Set<string>(), nextChecks: new Map<string, Date>() },
    });
    const taskStore = createDrizzleTaskStore(database.db);
    scope.register(taskRoutes, {
      store: taskStore,
      projectExists: (id) => projectStore.findById(id) !== undefined,
    });
    scope.register(executionRoutes, {
      store: createDrizzleRunStore(database.db),
      taskExists: (id) => taskStore.findById(id) !== undefined,
      getQueueStatus: () => queue?.getStatus() ?? {
        state: "disabled", runId: null, taskId: null, reason: null, lastCheckedAt: null, automaticRecoveryEnabled: false, capacityRecoveryEnabled: false,
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
