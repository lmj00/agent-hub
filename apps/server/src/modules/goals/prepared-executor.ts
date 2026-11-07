import { join } from "node:path";
import { and, eq, isNotNull } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { developmentRepositories, projects, runs, steps, tasks } from "../../db/schema.js";
import { AnalysisError, type AnalysisExecutor } from "../execution/analysis.js";
import { assertDevelopmentBase } from "./development-workspace.js";
import { planningSourceChanged } from "./prepared-input-store.js";
import { buildPlanningInput, parseGoalPlan, planningInstruction } from "./goal-plan-policy.js";
import type { ExecutionConfig } from "../execution/execution-config.js";
import type { Effort } from "@agent-hub/contracts";
import {
  readDevelopmentAssessment,
  reviewerAssessment,
} from "../execution/development-workflow.js";
import { goalVerificationInstruction } from "./goal-verification.js";
import {
  cleanupConfirmedDevelopmentInputs,
  cleanupRecordedDevelopment,
} from "./recorded-development.js";
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
  config?: Pick<ExecutionConfig, "verification">,
): AnalysisExecutor {
  const prepared = new Map<
    string,
    {
      input: PreparedInput | null;
      started: boolean;
      settled: Promise<void>;
      completed: Promise<void>;
      controller: AbortController;
      verifying: boolean;
      stopping: boolean;
    }
  >();
  return {
    ...executor,
    async analyze(request, onEvent) {
      if (!request.scope) return executor.analyze(request, onEvent);
      if (!request.runId) throw new AnalysisError("input_unavailable");
      const runId = request.runId;
      const scope = request.scope;
      let finishPreparation!: () => void;
      const finished = Promise.withResolvers<void>();
      const current = {
        input: null as PreparedInput | null,
        started: false,
        controller: new AbortController(),
        verifying: false,
        stopping: false,
        completed: finished.promise,
        settled: new Promise<void>((resolve) => {
          finishPreparation = resolve;
        }),
      };
      prepared.set(request.runId, current);
      request = {
        ...request,
        signal: AbortSignal.any([request.signal, current.controller.signal]),
      };
      const originalEmit = onEvent;
      onEvent = async (event) => {
        request.signal.throwIfAborted();
        await originalEmit(event);
        request.signal.throwIfAborted();
      };
      try {
        try {
          current.input = inputIntent(root, request.workspace, runId, scope);
          if (request.planning && db) {
            const task = db
              .select({ projectId: tasks.projectId })
              .from(tasks)
              .innerJoin(runs, eq(runs.taskId, tasks.id))
              .where(eq(runs.id, runId))
              .get();
            if (!task) throw new AnalysisError("input_unavailable");
            const stored = db
              .select()
              .from(developmentRepositories)
              .where(eq(developmentRepositories.projectId, task.projectId))
              .get();
            if (stored) {
              if (!stored.prepared || stored.prepared.source !== request.workspace)
                throw new AnalysisError("input_unavailable");
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
            current.input = await prepareGitWorkspace(current.input, request.signal, {
              directory: join(repository.directory, "git"),
              revision: repository.head,
            });
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
        const analysisRequest = {
          ...rest,
          workspace: current.input.directory,
          ...(input
            ? {
                instruction: planningInstruction(input),
                responseMode: "goal-plan" as const,
              }
            : workflow
              ? { workflow }
              : {}),
        };
        current.started = true;
        const result = await executor.analyze(analysisRequest, onEvent);
        if (planning)
          await onEvent({
            kind: "planning.proposed",
            planningProposal: result.output,
          });
        if (
          input &&
          input.definition.kind === "finite" &&
          parseGoalPlan(result.output, current.input).outcome === "complete" &&
          db &&
          config?.verification
        ) {
          current.verifying = true;
          if (current.stopping) throw new AnalysisError("input_unavailable");
          const project = db
            .select({ workspaceKey: projects.workspaceKey })
            .from(projects)
            .innerJoin(tasks, eq(tasks.projectId, projects.id))
            .innerJoin(runs, eq(runs.taskId, tasks.id))
            .where(eq(runs.id, request.runId!))
            .get();
          const configuration = project ? config.verification.get(project.workspaceKey) : undefined;
          if (!configuration || !executor.confirmTermination)
            throw new AnalysisError("unsupported_settings");
          await assertPreparedSource(current.input, request.signal);
          await onEvent({
            kind: "goal-verification.started",
            goalVerification: {
              type: "started",
              configuration,
              usage: result.usage,
            },
          });
          const recorded = db.select().from(runs).where(eq(runs.id, runId)).get()
            ?.planResult?.verification;
          if (!recorded) throw new AnalysisError("input_unavailable");
          const tested = await executor.analyze(
            {
              runId: request.runId!,
              model: request.model,
              signal: request.signal,
              instruction: "Run the fixed goal verification",
              workspace: current.input.directory,
              development: {
                baseRevision: current.input.revision!,
                inputDigest: current.input.digest!,
                scope: current.input.scope,
                writePaths: [],
                files: current.input.files.map((file) => {
                  if (!file.mode) throw new AnalysisError("input_unavailable");
                  return { ...file, mode: file.mode };
                }),
              },
              verification: {
                candidateDigest: current.input.digest!,
                config: recorded.configuration,
              },
            },
            onEvent,
          );
          if (!tested.verification) throw new AnalysisError("input_unavailable");
          await onEvent({
            kind: "goal-verification.tested",
            goalVerification: { type: "tested", result: tested.verification },
          });
          await onEvent({
            kind: "step.started",
            step: { type: "start", sequence: 2 },
          });
          const step = db
            .select()
            .from(steps)
            .where(and(eq(steps.runId, request.runId!), eq(steps.sequence, 2)))
            .get();
          if (step?.status !== "running" || !step.effort)
            throw new AnalysisError("input_unavailable");
          const reviewed = await executor.analyze(
            {
              runId: request.runId!,
              model: request.model,
              effort: step.effort as Effort,
              signal: request.signal,
              responseMode: "assessment",
              workspace: current.input.directory,
              ...(request.runtimeSkillVersion !== undefined
                ? {
                    runtimeSkillVersion: request.runtimeSkillVersion,
                    stepSequence: 2,
                  }
                : {}),
              instruction: goalVerificationInstruction(input, tested.verification),
            },
            onEvent,
          );
          const assessment = reviewerAssessment(
            readDevelopmentAssessment(reviewed.output),
            tested.verification,
            step.effort as Effort,
          );
          await onEvent({
            kind: "step.completed",
            step: {
              type: "complete",
              sequence: 2,
              assessment,
              usage: reviewed.usage,
            },
          });
          await onEvent({
            kind: "goal-verification.reviewed",
            goalVerification: { type: "reviewed" },
          });
          result.usage =
            result.usage && reviewed.usage
              ? {
                  inputTokens: result.usage.inputTokens + reviewed.usage.inputTokens,
                  cachedInputTokens:
                    result.usage.cachedInputTokens + reviewed.usage.cachedInputTokens,
                  outputTokens: result.usage.outputTokens + reviewed.usage.outputTokens,
                }
              : null;
        }
        try {
          await assertPreparedSource(current.input, request.signal);
        } catch {
          throw new AnalysisError("input_changed");
        }
        return result;
      } finally {
        finished.resolve();
      }
    },
    ...(executor.confirmTermination
      ? {
          async confirmTermination(runId: string) {
            const current = prepared.get(runId);
            if (current) {
              current.stopping = true;
              if (current.verifying) {
                current.controller.abort();
                const proof = executor.confirmTermination!(runId);
                await current.completed;
                return await proof;
              }
              if (!current.started) {
                await current.settled;
                if (!current.started) return new Date();
              }
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
export function cleanupConfirmedInputs(db: ReturnType<typeof openDatabase>["db"], root: string) {
  const confirmed = db
    .select({ id: runs.id })
    .from(runs)
    .where(and(isNotNull(runs.preparedInput), isNotNull(runs.terminationConfirmedAt)))
    .all();
  for (const run of confirmed) cleanupPreparedRun(db, root, run.id);
  cleanupConfirmedDevelopmentInputs(db, root);
}

async function assertPreparedSource(input: PreparedInput, signal: AbortSignal) {
  if (!input.developmentRepository) return assertSourceUnchanged(input, signal);
  if (
    input.phase !== "ready" ||
    input.source !== input.developmentRepository.source ||
    input.revision !== input.developmentRepository.head
  )
    throw new AnalysisError("input_changed");
  await assertDevelopmentBase(input.developmentRepository, signal);
}

export async function verifyPreparedResult(
  db: ReturnType<typeof openDatabase>["db"],
  runId: string,
) {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run?.preparedInput || run.preparedInput.phase !== "ready" || planningSourceChanged(db, run))
    return false;
  try {
    await assertPreparedSource(run.preparedInput, AbortSignal.timeout(5000));
    return true;
  } catch {
    return false;
  }
}
