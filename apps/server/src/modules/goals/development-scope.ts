import { and, desc, eq, ne } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { developmentRepositories, developmentRounds, runs, tasks } from "../../db/schema.js";
import { AnalysisError } from "../execution/analysis.js";
import { readExecutions } from "../execution/execution-record-store.js";
import { allowedGoalPath, privateInputPath } from "../workspace/prepared-workspace.js";
import { readGoalScope } from "./prepared-input-store.js";
import { overlappingWorkPaths, retiredPlanningWork } from "./planning-work-state.js";

type Db = Pick<ReturnType<typeof openDatabase>["db"], "select" | "update">;

// Called in the owner-checked journal transaction, after all containers stopped.
// A saved independent review requests files; the server retains Goal authority.
export function expandDevelopmentScope(
  db: Db,
  run: typeof runs.$inferSelect,
  task: typeof tasks.$inferSelect,
  sourceRunId: string,
  sequence: number,
) {
  const prior = db
    .select({ round: developmentRounds, run: runs })
    .from(developmentRounds)
    .innerJoin(runs, eq(runs.id, developmentRounds.runId))
    .where(eq(runs.taskId, task.id))
    .orderBy(desc(runs.attempt), desc(developmentRounds.sequence))
    .all()
    .find((entry) => entry.round.candidate !== null);
  const repository = db
    .select()
    .from(developmentRepositories)
    .where(eq(developmentRepositories.projectId, task.projectId))
    .get()?.prepared;
  const scope = readGoalScope(db, task.goalId);
  if (
    !task.plannedWork ||
    !scope ||
    !prior ||
    prior.run.id !== sourceRunId ||
    prior.round.sequence !== sequence ||
    (sourceRunId !== run.id && !prior.run.terminationConfirmedAt) ||
    readExecutions(db, sourceRunId).some((entry) => !entry.terminationConfirmedAt) ||
    !prior.round.review ||
    !prior.round.verificationInput ||
    prior.round.review.assessment.complete ||
    !prior.round.review.assessment.next ||
    prior.run.goalVersion !== run.goalVersion ||
    JSON.stringify(prior.round.input?.scope) !== JSON.stringify(scope) ||
    !repository ||
    prior.round.candidate?.baseRevision !== repository.head
  )
    throw new AnalysisError("input_unavailable");
  const request = prior.round.review.assessment.scopeExpansion;
  if (!request) throw new AnalysisError("input_unavailable");
  const paths = [...task.plannedWork.paths];
  const added: string[] = [];
  for (const path of request.paths) {
    // Existing manifest files exclude directories, symlinks and private inputs.
    if (
      !allowedGoalPath(path, scope) ||
      privateInputPath(path) ||
      !prior.round.verificationInput.files.some((file) => file.path === path)
    )
      throw new AnalysisError("analysis_incomplete");
    if (allowedGoalPath(path, { allowedPaths: paths, excludedPaths: [] })) continue;
    if (overlappingWorkPaths(paths, [path])) throw new AnalysisError("analysis_incomplete");
    paths.push(path);
    added.push(path);
  }
  if (paths.length > 20) throw new AnalysisError("analysis_incomplete");
  if (!added.length) return;
  const other = db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, task.projectId), eq(tasks.kind, "work"), ne(tasks.id, task.id)))
    .all();
  if (
    other.some(
      (entry) =>
        (entry.status !== "succeeded" || entry.cancelRequestedAt) &&
        !retiredPlanningWork(db, entry) &&
        (!entry.plannedWork || overlappingWorkPaths(entry.plannedWork.paths, added)),
    )
  )
    throw new AnalysisError("analysis_incomplete");
  // Preserve the original problem identity, criteria, candidate and retry budget.
  // The review, scope event and each immutable input retain the before/after evidence.
  db.update(tasks)
    .set({ plannedWork: { ...task.plannedWork, paths: paths.sort() } })
    .where(eq(tasks.id, task.id))
    .run();
}
