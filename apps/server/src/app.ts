import { createCreationStore } from "./modules/github/creation-store.js";
import { createCreationWorker } from "./modules/github/creation-worker.js";
import { creationRoutes } from "./modules/github/creation-routes.js";
import { hydrateImports } from "./modules/github/import-runtime.js";
import { createImportStore } from "./modules/github/import-store.js";
import { createImportWorker } from "./modules/github/import-worker.js";
import { importRoutes } from "./modules/github/import-routes.js";
import { createCapacityRecovery } from "./modules/execution/capacity-recovery.js";
import type { GitHubConfig } from "./modules/github/github-config.js";
import { createGitHubClient } from "./modules/github/github-client.js";
import { githubRoutes } from "./modules/github/routes.js";
import { createAutomaticRecovery } from "./modules/execution/automatic-recovery.js";
import Fastify, { type FastifyServerOptions } from "fastify";
import { openDatabase } from "./db/connection.js";
import { healthRoutes } from "./modules/health/routes.js";
import { createDrizzleProjectStore } from "./modules/projects/drizzle-project-store.js";
import { readProjectOverview } from "./modules/projects/project-overview.js";
import { projectRoutes } from "./modules/projects/routes.js";
import { createDrizzleTaskStore } from "./modules/tasks/drizzle-task-store.js";
import { taskRoutes } from "./modules/tasks/routes.js";
import { createDrizzleRunStore } from "./modules/execution/drizzle-run-store.js";
import { executionRoutes } from "./modules/execution/routes.js";
import { acquireExecutionOwner } from "./modules/execution/execution-owner.js";
import { createExecutionQueue } from "./modules/execution/execution-queue.js";
import {
  validateExecutionEnvironment,
  type ExecutionConfig,
} from "./modules/execution/execution-config.js";
import { createConfiguredExecutor } from "./modules/execution/execution-process.js";
import type { AnalysisExecutor } from "./modules/execution/analysis.js";
import { createDrizzleRecoveryStore } from "./modules/execution/drizzle-recovery-store.js";
import {
  createRecoveryProcessor,
  RecoveryError,
  type ExecutionObserver,
  type RecoveryStore,
} from "./modules/execution/recover-task.js";
import { recoveryRoutes } from "./modules/execution/recovery-routes.js";
import {
  removeFinishedContainer,
  stopAndConfirmContainer,
} from "./modules/execution/container-runtime.js";
import type { AuthConfig } from "./modules/auth/auth-config.js";
import { createDrizzleSessionStore } from "./modules/auth/drizzle-session-store.js";
import { installAuthentication } from "./modules/auth/authentication.js";
import { webRoutes } from "./modules/web/routes.js";
import type { ServiceConfig } from "./modules/services/service-config.js";
import { createDrizzleServiceStore } from "./modules/services/drizzle-service-store.js";
import { createServiceObserver } from "./modules/services/service-observer.js";
import { serviceRoutes } from "./modules/services/routes.js";
import { createPlanningStore } from "./modules/goals/planning-store.js";
import { createDrizzleGoalStore } from "./modules/goals/drizzle-goal-store.js";
import { goalRoutes } from "./modules/goals/routes.js";
import { budgetRoutes } from "./modules/budgets/routes.js";
import { createProjectBudgetStore } from "./modules/budgets/project-budget-store.js";
import {
  cleanupConfirmedInputs,
  cleanupPreparedRun,
  createPreparedExecutor,
  verifyPreparedResult,
} from "./modules/execution/workflows/prepared-executor.js";
import {
  configuredDevelopmentWorkspaces,
  createDevelopmentExecutor,
} from "./modules/execution/workflows/development-executor.js";
import { applyChangeApplication } from "./modules/goals/change-application.js";
import { developmentRoot } from "./modules/workspace/development-workspace.js";
import { preparedInputRoot } from "./modules/workspace/prepared-workspace.js";
import { createWorkReleaseStore } from "./modules/goals/work-release-store.js";
import { workReleaseRoutes } from "./modules/goals/work-release-routes.js";
import type { NotificationConfig } from "./modules/operations/notification-config.js";
import {
  createNotificationStore,
  listNotifications,
} from "./modules/operations/notification-store.js";
import { createNotificationWorker } from "./modules/operations/notification-worker.js";

type AppOptions = Omit<FastifyServerOptions, "ajv"> & {
  databasePath: string;
  auth?: AuthConfig;
  github?: GitHubConfig;
  webDirectory?: string;
  services?: ServiceConfig;
  notifications?: NotificationConfig;
  execution?: {
    config: ExecutionConfig;
    executor?: AnalysisExecutor;
    observer?: ExecutionObserver;
    pollIntervalMs?: number;
  };
};

export function buildApp({
  databasePath,
  execution,
  auth,
  github,
  webDirectory,
  services,
  notifications,
  ...options
}: AppOptions) {
  if (webDirectory && !auth) throw new Error("The management UI requires authentication");
  if (github && !auth) throw new Error("GitHub connection requires authentication");
  if (execution?.config.importProfiles?.size && !auth)
    throw new Error("Repository imports require authentication");
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
    let notifier: ReturnType<typeof createNotificationWorker> | undefined;
    let canTrackTermination = false;
    const githubClient = github ? createGitHubClient(github) : undefined;
    let importStore: ReturnType<typeof createImportStore> | undefined;
    let importer: ReturnType<typeof createImportWorker> | undefined;
    let creationStore: ReturnType<typeof createCreationStore> | undefined;
    let creator: ReturnType<typeof createCreationWorker> | undefined;
    const protectedFiles = [
      auth?.sourcePath,
      services?.sourcePath,
      notifications?.sourcePath,
      github?.sourcePath,
    ].filter((path): path is string => path !== undefined);

    scope.addHook("onClose", async () => {
      try {
        await Promise.all([
          queue?.stop(),
          serviceObserver?.stop(),
          notifier?.stop(),
          importer?.stop(),
          creator?.stop(),
        ]);
        owner?.release();
      } finally {
        database.close();
      }
    });
    scope.addHook("preClose", async () => {
      await Promise.all([
        queue?.stop(),
        serviceObserver?.stop(),
        notifier?.stop(),
        importer?.stop(),
        creator?.stop(),
      ]);
    });

    if (execution || services || notifications) {
      try {
        if (execution) validateExecutionEnvironment(execution.config, databasePath, protectedFiles);
        owner = acquireExecutionOwner(database.db);
        importStore = createImportStore(database.db, owner.token);
        importStore.recover();
        creationStore = createCreationStore(database.db, owner.token);
        creationStore.recover();
        if (services) {
          const serviceStore = createDrizzleServiceStore(database.db, owner.token);
          serviceStore.configure(services.targets);
          serviceObserver = createServiceObserver({
            targets: services.targets,
            store: serviceStore,
            report: (event) => {
              if (event.code === "SERVICE_OBSERVER_ERROR")
                scope.log.error(event, "Service observation storage failed");
              else scope.log.info(event, "Service observation storage recovered");
            },
          });
        }
        if (execution) {
          const managed = await hydrateImports(
            database.db,
            execution.config,
            databasePath,
            protectedFiles,
          );
          if (managed && githubClient && execution.config.importProfiles?.size) {
            importer = createImportWorker({
              store: importStore,
              runtime: managed,
              client: githubClient,
              report: () =>
                scope.log.error(
                  { code: "IMPORT_STORAGE_ERROR" },
                  "Repository import storage failed",
                ),
            });
            if (github?.allowRepositoryCreation) {
              creator = createCreationWorker({
                store: creationStore,
                imports: importStore,
                client: githubClient,
                profiles: new Set(execution.config.importProfiles.keys()),
                wakeImporter: () => importer?.wake(),
                report: () =>
                  scope.log.error(
                    { code: "CREATION_STORAGE_ERROR" },
                    "Repository creation storage failed",
                  ),
              });
            }
          }
          const inputRoot = preparedInputRoot(databasePath);
          cleanupConfirmedInputs(database.db, inputRoot);
          const baseExecutor = execution.executor ?? createConfiguredExecutor(execution.config);
          const executor = createDevelopmentExecutor({
            db: database.db,
            analysis: createPreparedExecutor(
              baseExecutor,
              inputRoot,
              database.db,
              execution.config,
            ),
            development: baseExecutor,
            config: execution.config,
            inputRoot,
            repositoryRoot: developmentRoot(databasePath),
            ownerToken: owner.token,
          });
          const developmentWorkspaceKeys = () =>
            configuredDevelopmentWorkspaces(execution.config, baseExecutor);
          const planning = createPlanningStore(database.db, owner.token);
          canTrackTermination = typeof executor.confirmTermination === "function";
          if (execution.config.automaticRecovery && !canTrackTermination)
            throw new Error("Automatic recovery requires execution termination tracking");
          recovery = createDrizzleRecoveryStore(database.db, owner.token);
          queue = createExecutionQueue({
            ...execution,
            store: createDrizzleRunStore(database.db, owner.token, execution.config, {
              repositoryImportsEnabled: !!importer,
              get developmentWorkspaceKeys() {
                return developmentWorkspaceKeys();
              },
              getObserverStatus: () =>
                serviceObserver?.getStatus() ?? {
                  enabledKeys: new Set(),
                  errors: new Set(),
                  nextChecks: new Map(),
                },
            }),
            executor,
            ...(execution.config.containerImage && executor.confirmTermination
              ? {
                  planning: {
                    tick: () => {
                      planning.reserveNext(developmentWorkspaceKeys());
                    },
                  },
                }
              : {}),
            ...(execution.config.automaticRecovery
              ? {
                  automaticRecovery: createAutomaticRecovery({
                    db: database.db,
                    ownerToken: owner.token,
                    policy: execution.config.automaticRecovery,
                    get workspaceKeys() {
                      return [...execution.config.workspaces.keys()];
                    },
                    recovery,
                  }),
                }
              : {}),
            ...(execution.config.automaticRecovery && execution.config.capacityRecovery
              ? {
                  capacityRecovery: createCapacityRecovery({
                    db: database.db,
                    ownerToken: owner.token,
                    policy: execution.config.capacityRecovery,
                    retryPolicy: execution.config.automaticRecovery,
                    get workspaceKeys() {
                      return [...execution.config.workspaces.keys()];
                    },
                  }),
                }
              : {}),
            recovery: createRecoveryProcessor(
              recovery,
              execution.observer ?? {
                confirm: stopAndConfirmContainer,
                cleanup: removeFinishedContainer,
              },
              (runId) => cleanupPreparedRun(database.db, inputRoot, runId),
              (runId) => verifyPreparedResult(database.db, runId),
              async (runId, signal) => {
                await applyChangeApplication(database.db, runId, signal, owner!.token);
              },
            ),
            validate: () => {
              importStore?.reconcileInterrupted();
              validateExecutionEnvironment(execution.config, databasePath, protectedFiles);
            },
            reportDiagnostic: (diagnostic) => {
              if (diagnostic.event === "execution_queue.error")
                scope.log.error(diagnostic, "Execution queue check failed");
              else scope.log.info(diagnostic, "Execution queue check recovered");
            },
          });
        }
        if (notifications)
          notifier = createNotificationWorker({
            config: notifications,
            store: createNotificationStore(database.db, owner.token, notifications, () =>
              queue?.getStatus(),
            ),
            report: (event) => {
              if (event.code === "NOTIFICATION_STORAGE_ERROR")
                scope.log.error(event, "Notification storage failed");
              else scope.log.info(event, "Notification storage recovered");
            },
          });
      } catch (error) {
        owner?.release();
        owner = undefined;
        database.close();
        throw error;
      }
      scope.addHook("onListen", async () => {
        queue?.start();
        importer?.start();
        creator?.start();
        serviceObserver?.start();
        notifier?.start();
      });
    }

    if (auth) await installAuthentication(scope, auth, createDrizzleSessionStore(database.db));
    scope.register(githubRoutes, githubClient ? { client: githubClient } : {});
    scope.register(creationRoutes, {
      db: database.db,
      profiles: [...(execution?.config.importProfiles?.keys() ?? [])],
      ...(creationStore ? { store: creationStore } : {}),
      ...(creator ? { worker: creator } : {}),
    });
    scope.register(importRoutes, {
      db: database.db,
      profiles: [...(execution?.config.importProfiles?.keys() ?? [])],
      ...(importStore ? { store: importStore } : {}),
      ...(importer ? { worker: importer } : {}),
    });
    scope.get("/operations/notifications", async () => ({
      worker: notifier?.getStatus() ?? {
        enabled: false,
        storageError: false,
        delivering: false,
        lastCheckedAt: null,
      },
      notifications: listNotifications(database.db),
    }));
    if (webDirectory) scope.register(webRoutes, { directory: webDirectory });
    scope.register(healthRoutes, { checkDatabase: () => database.checkReady() });
    const projectStore = createDrizzleProjectStore(database.db);
    scope.register(projectRoutes, {
      store: projectStore,
      overview: (offset) => readProjectOverview(database.db, offset),
    });
    scope.register(goalRoutes, { store: createDrizzleGoalStore(database.db) });
    scope.register(workReleaseRoutes, {
      store: createWorkReleaseStore(database.db, execution?.config.automaticRecovery),
    });
    scope.register(budgetRoutes, { store: createProjectBudgetStore(database.db) });
    scope.register(serviceRoutes, {
      store: createDrizzleServiceStore(database.db),
      projectExists: (id) => projectStore.findById(id) !== undefined,
      getObserverStatus: () =>
        serviceObserver?.getStatus() ?? {
          enabledKeys: new Set<string>(),
          errors: new Set<string>(),
          nextChecks: new Map<string, Date>(),
        },
    });
    const taskStore = createDrizzleTaskStore(database.db);
    scope.register(taskRoutes, {
      store: taskStore,
      projectExists: (id) => projectStore.findById(id) !== undefined,
    });
    scope.register(executionRoutes, {
      store: createDrizzleRunStore(database.db),
      taskExists: (id) => taskStore.findById(id) !== undefined,
      getQueueStatus: () =>
        queue?.getStatus() ?? {
          state: "disabled",
          runId: null,
          taskId: null,
          reason: null,
          lastCheckedAt: null,
          automaticRecoveryEnabled: false,
          capacityRecoveryEnabled: false,
        },
    });
    scope.register(recoveryRoutes, {
      queries: createDrizzleRecoveryStore(database.db),
      request: (input) => {
        if (!recovery || !queue) throw new RecoveryError("EXECUTION_DISABLED");
        const result = recovery.request(input, queue.getActiveRunId(), canTrackTermination);
        if (input.action === "cancel") queue.cancel(input.runId);
        return result;
      },
    });
  });

  return app;
}
