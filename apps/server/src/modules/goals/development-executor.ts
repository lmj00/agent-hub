import { and, desc, eq } from "drizzle-orm";
import type { Effort } from "@agent-hub/contracts";
import type { openDatabase } from "../../db/connection.js";
import { developmentRounds, projects, runs, steps, tasks } from "../../db/schema.js";
import {
  AnalysisError,
  type AnalysisEvent,
  type AnalysisExecutor,
  type AnalysisRequest,
  type AnalysisUsage,
} from "../execution/analysis.js";
import type { ExecutionConfig } from "../execution/execution-config.js";
import {
  developerAssessment,
  developmentInstruction,
  maxDevelopmentRounds,
  readDevelopmentAssessment,
  reviewerAssessment,
} from "../execution/development-workflow.js";
import { readExecutions } from "../execution/execution-record-store.js";
import {
  parseVerificationConfig,
  verificationResultDigest,
} from "../execution/verification-config.js";
import {
  captureRecordedDevelopment,
  cleanupRecordedDevelopment,
  prepareRecordedDevelopment,
  prepareRecordedVerification,
} from "./recorded-development.js";
import { readDevelopmentRounds } from "./development-journal.js";
import { readGoalScope } from "./prepared-input-store.js";
import type { DevelopmentInput } from "./development-workspace.js";
import { applyChangeApplication, prepareChangeApplication } from "./change-application.js";

type Db = ReturnType<typeof openDatabase>["db"];
const manifest = (input: DevelopmentInput) => ({
  baseRevision: input.revision,
  inputDigest: input.digest,
  scope: input.scope,
  writePaths: input.writePaths,
  files: input.files,
});
const addUsage = (
  total: AnalysisUsage | null,
  usage: AnalysisUsage | null,
): AnalysisUsage | null =>
  total && usage
    ? {
        inputTokens: total.inputTokens + usage.inputTokens,
        cachedInputTokens: total.cachedInputTokens + usage.cachedInputTokens,
        outputTokens: total.outputTokens + usage.outputTokens,
      }
    : null;

export function configuredDevelopmentWorkspaces(
  config: Pick<ExecutionConfig, "workspaces" | "verification" | "containerImage">,
  executor: AnalysisExecutor,
) {
  return config.containerImage && executor.confirmTermination
    ? [...(config.verification?.keys() ?? [])].filter((key) => config.workspaces.has(key))
    : [];
}

export function createDevelopmentExecutor(options: {
  db: Db;
  analysis: AnalysisExecutor;
  development: AnalysisExecutor;
  config: Pick<ExecutionConfig, "workspaces" | "verification" | "containerImage">;
  inputRoot: string;
  repositoryRoot: string;
  ownerToken?: string;
}): AnalysisExecutor {
  const { db, analysis, development, config, inputRoot, repositoryRoot } = options;
  const active = new Map<
    string,
    { started: boolean; controller: AbortController; settled: Promise<void> }
  >();
  return {
    ...(development.runtimeSkillVersion !== undefined
      ? { runtimeSkillVersion: development.runtimeSkillVersion }
      : analysis.runtimeSkillVersion !== undefined
        ? { runtimeSkillVersion: analysis.runtimeSkillVersion }
        : {}),
    async analyze(request, onEvent) {
      const selected = request.runId
        ? db
            .select({ run: runs, task: tasks, project: projects })
            .from(runs)
            .innerJoin(tasks, eq(tasks.id, runs.taskId))
            .innerJoin(projects, eq(projects.id, tasks.projectId))
            .where(eq(runs.id, request.runId))
            .get()
        : undefined;
      if (!selected?.task.plannedWork) return analysis.analyze(request, onEvent);
      const { run, task, project } = selected;
      if (active.has(run.id)) throw new AnalysisError("input_unavailable");
      const settled = Promise.withResolvers<void>();
      const current = {
        started: false,
        controller: new AbortController(),
        settled: settled.promise,
      };
      active.set(run.id, current);
      const signal = AbortSignal.any([request.signal, current.controller.signal]);
      const emit = async (event: AnalysisEvent) => {
        signal.throwIfAborted();
        await onEvent(event);
        signal.throwIfAborted();
      };
      const startStep = async (sequence: number) => {
        await emit({ kind: "step.started", step: { type: "start", sequence } });
        const step = db
          .select()
          .from(steps)
          .where(and(eq(steps.runId, run.id), eq(steps.sequence, sequence)))
          .get();
        if (step?.status !== "running" || !step.purpose || !step.effort)
          throw new AnalysisError("input_unavailable");
        return step.effort as Effort;
      };
      const execute = (phase: AnalysisRequest) => {
        signal.throwIfAborted();
        current.started = true;
        return development.analyze(phase, emit);
      };
      try {
        signal.throwIfAborted();
        const configured = config.verification?.get(project.workspaceKey);
        const configuration = configured ? parseVerificationConfig(configured) : undefined;
        const source = config.workspaces.get(project.workspaceKey);
        const scope = readGoalScope(db, task.goalId);
        if (!config.containerImage || !development.confirmTermination || !configuration)
          throw new AnalysisError("unsupported_settings");
        if (
          !source ||
          !scope ||
          run.status !== "running" ||
          run.goalVersion !== scope.goalVersion ||
          readDevelopmentRounds(db, run.id).length
        )
          throw new AnalysisError("input_unavailable");
        await emit({
          kind: "development.workflow.started",
          development: { type: "workflow.started" },
        });
        if (db.select().from(runs).where(eq(runs.id, run.id)).get()?.developmentVersion !== 1)
          throw new AnalysisError("input_unavailable");
        const prior = db
          .select({ round: developmentRounds, run: runs })
          .from(developmentRounds)
          .innerJoin(runs, eq(runs.id, developmentRounds.runId))
          .where(eq(runs.taskId, task.id))
          .orderBy(desc(runs.attempt), desc(developmentRounds.sequence))
          .all()
          .find((value) => value.round.candidate !== null);
        if (prior && !prior.run.terminationConfirmedAt)
          throw new AnalysisError("input_unavailable");
        let previous = prior?.round.candidate ?? undefined;
        let previousReview = prior?.round.review?.assessment;
        let verification = prior?.round.verificationResult ?? undefined;
        let usage: AnalysisUsage | null = {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
        };
        for (let sequence = 1; sequence <= maxDevelopmentRounds; sequence++) {
          signal.throwIfAborted();
          const prepared = await prepareRecordedDevelopment(
            db,
            {
              runId: run.id,
              projectId: project.id,
              source,
              inputRoot,
              repositoryRoot,
              sequence,
              scope,
              writePaths: task.plannedWork!.paths,
              ...(previous ? { previous } : {}),
              signal,
            },
            emit,
          );
          const effort = await startStep(sequence * 2 - 1);
          const changed = await execute({
            ...(run.runtimeSkillVersion !== null
              ? { runtimeSkillVersion: run.runtimeSkillVersion, stepSequence: sequence * 2 - 1 }
              : {}),
            runId: run.id,
            model: run.model,
            effort,
            signal,
            responseMode: "assessment",
            workspace: prepared.input.directory,
            development: manifest(prepared.input),
            instruction: developmentInstruction({
              instruction: request.instruction,
              work: task.plannedWork!,
              round: sequence,
              role: "developer",
              ...(previous ? { candidate: previous } : {}),
              ...(previousReview ? { previousReview } : {}),
              ...(verification ? { verification } : {}),
            }),
          });
          const developerReport = developerAssessment(
            readDevelopmentAssessment(changed.output),
            effort,
          );
          const candidate = await captureRecordedDevelopment(
            prepared.repository,
            prepared.input,
            sequence,
            changed.development,
            signal,
            emit,
          );
          await emit({
            kind: "step.completed",
            step: {
              type: "complete",
              sequence: sequence * 2 - 1,
              assessment: developerReport,
              usage: changed.usage,
            },
          });
          usage = addUsage(usage, changed.usage);
          const testing = await prepareRecordedVerification(
            db,
            { runId: run.id, sequence, inputRoot, configuration, signal },
            emit,
          );
          const tested = await execute({
            runId: run.id,
            model: run.model,
            signal,
            instruction: "Run the fixed verification",
            workspace: testing.input.directory,
            development: manifest(testing.input),
            verification: {
              candidateDigest: candidate.digest,
              config: testing.configuration,
            },
          });
          if (!tested.verification) throw new AnalysisError("input_unavailable");
          await emit({
            kind: "development.verification.complete",
            development: {
              type: "verification.complete",
              sequence,
              result: tested.verification,
            },
          });
          verification = readDevelopmentRounds(db, run.id).at(-1)?.verificationResult ?? undefined;
          if (!verification) throw new AnalysisError("input_unavailable");
          const reviewEffort = await startStep(sequence * 2);
          const reviewed = await execute({
            ...(run.runtimeSkillVersion !== null
              ? { runtimeSkillVersion: run.runtimeSkillVersion, stepSequence: sequence * 2 }
              : {}),
            runId: run.id,
            model: run.model,
            effort: reviewEffort,
            signal,
            responseMode: "assessment",
            workspace: testing.input.directory,
            instruction: developmentInstruction({
              instruction: request.instruction,
              work: task.plannedWork!,
              round: sequence,
              role: "reviewer",
              candidate,
              verification,
            }),
          });
          const assessment = reviewerAssessment(
            readDevelopmentAssessment(reviewed.output),
            verification,
            reviewEffort,
          );
          await emit({
            kind: "step.completed",
            step: {
              type: "complete",
              sequence: sequence * 2,
              assessment,
              usage: reviewed.usage,
            },
          });
          usage = addUsage(usage, reviewed.usage);
          const execution = readExecutions(db, run.id).at(-1);
          if (!execution?.terminationConfirmedAt) throw new AnalysisError("input_unavailable");
          await emit({
            kind: "development.review.complete",
            development: {
              type: "review.complete",
              sequence,
              review: {
                candidateDigest: candidate.digest,
                verificationDigest: verificationResultDigest(verification),
                execution: execution.identity,
                stepSequence: sequence * 2,
                assessment,
              },
            },
          });
          if (assessment.complete) {
            await prepareChangeApplication(db, run.id, signal, options.ownerToken);
            await applyChangeApplication(db, run.id, signal, options.ownerToken);
            return { output: assessment.report, usage };
          }
          if (!assessment.next) throw new AnalysisError("analysis_incomplete");
          previous = candidate;
          previousReview = assessment;
        }
        throw new AnalysisError("workflow_limit");
      } finally {
        settled.resolve();
      }
    },
    ...(analysis.confirmTermination || development.confirmTermination
      ? {
          async confirmTermination(runId: string) {
            const current = active.get(runId);
            if (!current) return analysis.confirmTermination?.(runId) ?? null;
            current.controller.abort();
            // Stop a live container while waiting for host preparation/callbacks to
            // settle. No later phase can pass the now-aborted signal.
            const proof = current.started
              ? development.confirmTermination!(runId).catch(() => null)
              : null;
            await current.settled;
            if (!current.started) return new Date();
            const confirmedAt = proof ? await proof : null;
            if (confirmedAt) return confirmedAt;
            // A container preflight may fail before the executor creates its
            // in-memory entry. The durable version-1 no-start rule still applies.
            return db.select().from(runs).where(eq(runs.id, runId)).get()?.developmentVersion ===
              1 && !readExecutions(db, runId).length
              ? new Date()
              : null;
          },
        }
      : {}),
    async cleanup(runId) {
      if (!active.has(runId)) return analysis.cleanup?.(runId);
      if (!db.select().from(runs).where(eq(runs.id, runId)).get()?.terminationConfirmedAt) return;
      await development.cleanup?.(runId);
      cleanupRecordedDevelopment(db, inputRoot, runId);
      active.delete(runId);
    },
  };
}
