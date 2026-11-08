import { eq } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { projects, repositoryImports } from "../../db/schema.js";
import {
  validateExecutionEnvironment,
  type ExecutionConfig,
} from "../execution/execution-config.js";
import { importedWorkspaceKey, type ImportJob } from "./import-store.js";
import { ImportError, importRoot, verifyImportedSource } from "./import-workspace.js";

export function importRuntime(
  config: ExecutionConfig,
  databasePath: string,
  protectedFiles: string[],
) {
  const root = importRoot(databasePath);
  function prepare(job: ImportJob, workspace: string) {
    const profile = config.importProfiles?.get(job.profile);
    if (!profile || !config.verification) throw new ImportError("IMPORT_PROFILE_UNAVAILABLE");
    const key = importedWorkspaceKey(job);
    if (config.workspaces.has(key)) throw new ImportError("IMPORT_WORKSPACE_CONFLICT");
    validateExecutionEnvironment(
      { ...config, workspaces: new Map([...config.workspaces, [key, workspace]]) },
      databasePath,
      protectedFiles,
    );
    return () => {
      config.workspaces.set(key, workspace);
      config.verification!.set(key, profile);
    };
  }
  return { root, prepare };
}
export async function hydrateImports(
  db: ReturnType<typeof openDatabase>["db"],
  config: ExecutionConfig,
  databasePath: string,
  protectedFiles: string[],
) {
  const jobs = db
    .select()
    .from(repositoryImports)
    .where(eq(repositoryImports.status, "ready"))
    .all();
  if (!jobs.length && !config.importProfiles?.size) return undefined;
  const runtime = importRuntime(config, databasePath, protectedFiles);
  const signal = AbortSignal.timeout(120000);
  for (const job of jobs) {
    const project = job.projectId
      ? db.select().from(projects).where(eq(projects.id, job.projectId)).get()
      : undefined;
    if (
      !job.attemptId ||
      !job.revision ||
      !job.localRevision ||
      !project ||
      project.workspaceKey !== importedWorkspaceKey(job)
    )
      throw new ImportError("IMPORT_SOURCE_CHANGED");
    const workspace = await verifyImportedSource(
      runtime.root,
      {
        jobId: job.id,
        attemptId: job.attemptId,
        repositoryId: job.repositoryId,
        revision: job.revision,
        localRevision: job.localRevision,
      },
      signal,
    );
    runtime.prepare(job, workspace)();
  }
  return runtime;
}
