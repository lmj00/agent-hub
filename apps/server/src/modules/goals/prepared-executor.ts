import { and, eq, isNotNull } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { runs } from "../../db/schema.js";
import { AnalysisError, type AnalysisExecutor } from "../execution/analysis.js";
import { planningInstruction } from "./goal-plan-policy.js";
import {
  assertSourceUnchanged,
  inputIntent,
  prepareWorkspace,
  removePreparedWorkspace,
  type PreparedInput,
} from "./prepared-workspace.js";

export function createPreparedExecutor(
  executor: AnalysisExecutor,
  root: string,
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
        // Save intent before copying; recovery can clean up even if the parent dies during preparation.
        await onEvent({
          kind: "input.preparing",
          preparedInput: current.input,
        });
        current.input = await prepareWorkspace(current.input, request.signal);
        await onEvent({ kind: "input.ready", preparedInput: current.input });
      } catch (error) {
        if (error instanceof AnalysisError) throw error;
        throw new AnalysisError("input_unavailable");
      } finally {
        finishPreparation();
      }
      request.signal.throwIfAborted();
      const { scope: _scope, planning, workflow, ...rest } = request;
      const analysisRequest = { ...rest, workspace: current.input.directory, ...(planning ? { instruction: planningInstruction(planning, current.input), responseMode: "goal-plan" as const } : workflow ? { workflow } : {}) };
      current.started = true;
      const result = await executor.analyze(
        analysisRequest,
        onEvent,
      );
      if (planning) await onEvent({ kind: "planning.proposed", planningProposal: result.output });
      try {
        await assertSourceUnchanged(current.input, request.signal);
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
}

export async function verifyPreparedResult(db: ReturnType<typeof openDatabase>["db"], runId: string) {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run?.preparedInput || run.preparedInput.phase !== "ready") return false;
  try { await assertSourceUnchanged(run.preparedInput, AbortSignal.timeout(5000)); return true; }
  catch { return false; }
}
