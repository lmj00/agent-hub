import { join } from "node:path";
import { and, eq, isNotNull } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { developmentRepositories, runs, tasks } from "../../db/schema.js";
import { AnalysisError, type AnalysisExecutor } from "../execution/analysis.js";
import { assertDevelopmentBase } from "./development-workspace.js";
import { planningSourceChanged } from "./prepared-input-store.js";
import { buildPlanningInput, planningInstruction } from "./goal-plan-policy.js";
import { cleanupConfirmedDevelopmentInputs, cleanupRecordedDevelopment } from "./recorded-development.js";
import {
  assertSourceUnchanged,
  inputIntent,
  prepareWorkspace,
  prepareGitWorkspace,
  removePreparedWorkspace,
  type PreparedInput,
} from "./prepared-workspace.js";

export function createPreparedExecutor(
  executor: AnalysisExecutor,
  root: string,
  db?: Pick<ReturnType<typeof openDatabase>["db"], "select">,
): AnalysisExecutor {
  const prepared = new Map<
    string,
    { input: PreparedInput | null; started: boolean; settled: Promise<void> }
  >();
  return {
    ...executor,
    async analyze(request, onEvent) {
      if (!request.scope) return executor.analyze(request, onEvent);
      if (!request.runId) throw new AnalysisError("input_unavailable");
      let finishPreparation!: () => void;
      const current = {
        input: null as PreparedInput | null,
        started: false,
        settled: new Promise<void>((resolve) => {
          finishPreparation = resolve;
        }),
      };
      prepared.set(request.runId, current);
      try {
        current.input = inputIntent(
          root,
          request.workspace,
          request.runId,
          request.scope,
        );
        if (request.planning && db) {
          const task = db.select({ projectId: tasks.projectId }).from(tasks).innerJoin(runs, eq(runs.taskId, tasks.id)).where(eq(runs.id, request.runId)).get();
          if (!task) throw new AnalysisError("input_unavailable");
          const stored = db.select().from(developmentRepositories).where(eq(developmentRepositories.projectId, task.projectId)).get();
          if (stored) {
            if (!stored.prepared || stored.prepared.source !== request.workspace) throw new AnalysisError("input_unavailable");
            current.input.developmentRepository = stored.prepared;
          }
        }
        // Save intent before copying; recovery can clean up even if the parent dies during preparation.
        await onEvent({
          kind: "input.preparing",
          preparedInput: current.input,
        });
        const repository = current.input.developmentRepository;
        if (repository) {
          await assertDevelopmentBase(repository, request.signal);
          current.input = await prepareGitWorkspace(current.input, request.signal, { directory: join(repository.directory, "git"), revision: repository.head });
          await assertPreparedSource(current.input, request.signal);
        } else {
          current.input = await prepareWorkspace(current.input, request.signal);
        }
        await onEvent({ kind: "input.ready", preparedInput: current.input });
      } catch (error) {
        if (error instanceof AnalysisError) throw error;
        throw new AnalysisError("input_unavailable");
      } finally {
        finishPreparation();
      }
      request.signal.throwIfAborted();
      const { scope: _scope, planning, workflow, ...rest } = request;
      const input = planning ? buildPlanningInput(planning, current.input) : null;
      if (input) await onEvent({ kind: "planning.input_ready", planningInput: input });
      request.signal.throwIfAborted();
      const analysisRequest = { ...rest, workspace: current.input.directory, ...(input ? { instruction: planningInstruction(input), responseMode: "goal-plan" as const } : workflow ? { workflow } : {}) };
      current.started = true;
      const result = await executor.analyze(
        analysisRequest,
        onEvent,
      );
      if (planning) await onEvent({ kind: "planning.proposed", planningProposal: result.output });
      try {
        await assertPreparedSource(current.input, request.signal);
      } catch {
        throw new AnalysisError("input_changed");
      }
      return result;
    },
    ...(executor.confirmTermination
      ? {
          async confirmTermination(runId: string) {
            const current = prepared.get(runId);
            if (current && !current.started) {
              await current.settled;
              if (!current.started) return new Date();
            }
            return executor.confirmTermination!(runId);
          },
        }
      : {}),
    async cleanup(runId) {
      await executor.cleanup?.(runId);
      const current = prepared.get(runId);
      if (current?.input) removePreparedWorkspace(root, current.input);
      prepared.delete(runId);
    },
  };
}

export function cleanupPreparedRun(
  db: ReturnType<typeof openDatabase>["db"],
  root: string,
  runId: string,
) {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (run?.terminationConfirmedAt && run.preparedInput)
    removePreparedWorkspace(root, run.preparedInput);
  cleanupRecordedDevelopment(db, root, runId);
}

// Resume cleanup after a crash between committing termination proof and removing files.
export function cleanupConfirmedInputs(
  db: ReturnType<typeof openDatabase>["db"],
  root: string,
) {
  const confirmed = db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        isNotNull(runs.preparedInput),
        isNotNull(runs.terminationConfirmedAt),
      ),
    )
    .all();
  for (const run of confirmed) cleanupPreparedRun(db, root, run.id);
  cleanupConfirmedDevelopmentInputs(db, root);
}

async function assertPreparedSource(input: PreparedInput, signal: AbortSignal) {
  if (!input.developmentRepository) return assertSourceUnchanged(input, signal);
  if (input.phase !== "ready" || input.source !== input.developmentRepository.source || input.revision !== input.developmentRepository.head) throw new AnalysisError("input_changed");
  await assertDevelopmentBase(input.developmentRepository, signal);
}

export async function verifyPreparedResult(db: ReturnType<typeof openDatabase>["db"], runId: string) {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run?.preparedInput || run.preparedInput.phase !== "ready" || planningSourceChanged(db, run)) return false;
  try { await assertPreparedSource(run.preparedInput, AbortSignal.timeout(5000)); return true; }
  catch { return false; }
}
