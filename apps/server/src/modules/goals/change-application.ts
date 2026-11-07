import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import {
  changeApplications,
  developmentRepositories,
  runs,
  steps,
  tasks,
} from "../../db/schema.js";
import { AnalysisError } from "../execution/analysis.js";
import { assertExecutionOwner } from "../execution/execution-owner.js";
import { readExecutions } from "../execution/execution-record-store.js";
import { requireRuntimeSkillEvidence } from "../execution/runtime-skill-store.js";
import {
  parseVerificationResult,
  verificationResultDigest,
} from "../execution/verification-config.js";
import {
  readDevelopmentRepository,
  readDevelopmentRounds,
} from "./development-journal.js";
import { readGoalExecutionBlock } from "./goal-execution-store.js";
import { readGoalScope } from "./prepared-input-store.js";
import {
  developmentRef,
  validCandidateDigest,
  validInputDigest,
  verifyDevelopmentCandidate,
} from "./development-workspace.js";
import { applicationCommit, applyGitChange } from "./change-application-git.js";

type Db = ReturnType<typeof openDatabase>["db"];
type Reader = Pick<Db, "select">;
export type ChangeApplication = typeof changeApplications.$inferSelect;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(): never {
  throw new AnalysisError("input_unavailable");
}

export function readChangeApplication(db: Reader, runId: string) {
  return db
    .select()
    .from(changeApplications)
    .where(eq(changeApplications.runId, runId))
    .get();
}

// Only persisted parent-owned evidence is accepted, never an agent's success
// message. Rechecking its digest also detects evidence changes during Git I/O.
function evidence(db: Reader, runId: string) {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run || run.developmentVersion !== 1) fail();
  const task = db.select().from(tasks).where(eq(tasks.id, run.taskId)).get();
  if (!task?.plannedWork || task.kind !== "work") fail();
  const stored = readDevelopmentRepository(db, task.projectId);
  const repository = stored?.prepared;
  const round = readDevelopmentRounds(db, runId).at(-1);
  if (
    !repository ||
    !round?.input ||
    !round.candidate ||
    !round.verificationInput ||
    !round.verificationIntent ||
    !round.verificationResult ||
    !round.review ||
    !round.reviewedAt ||
    !round.verifiedAt ||
    !round.capturedAt
  )
    fail();
  const { input, candidate, verificationInput, verificationIntent, review } =
    round;
  const result = parseVerificationResult(round.verificationResult);
  const executions = readExecutions(db, runId);
  const history = db
    .select()
    .from(steps)
    .where(eq(steps.runId, runId))
    .orderBy(asc(steps.sequence))
    .all();
  const reviewer = history.at(-1);
  if (
    !validInputDigest(input) ||
    !validInputDigest(verificationInput) ||
    !validCandidateDigest(candidate) ||
    round.repositoryId !== repository.id ||
    input.repositoryId !== repository.id ||
    input.runId !== runId ||
    candidate.repositoryId !== repository.id ||
    candidate.runId !== runId ||
    candidate.baseRevision !== input.revision ||
    candidate.inputDigest !== input.digest ||
    input.scope.goalId !== task.goalId ||
    input.scope.goalVersion !== run.goalVersion ||
    verificationInput.repositoryId !== repository.id ||
    verificationInput.runId !== runId ||
    verificationInput.revision !== input.revision ||
    verificationInput.tree !== candidate.tree ||
    verificationInput.previousCandidate !== candidate.digest ||
    !same(verificationInput.scope, input.scope) ||
    !same(verificationInput.writePaths, input.writePaths) ||
    verificationIntent.candidateDigest !== candidate.digest ||
    result.status !== "passed" ||
    result.candidateDigest !== candidate.digest ||
    result.inputDigest !== verificationInput.digest ||
    !same(result.configuration, verificationIntent.configuration) ||
    review.candidateDigest !== candidate.digest ||
    review.verificationDigest !== verificationResultDigest(result) ||
    !review.assessment.complete ||
    review.stepSequence !== round.sequence * 2 ||
    executions.length !== round.executionOffset + 3 ||
    executions.some((entry) => !entry.terminationConfirmedAt) ||
    !same(result.execution, executions.at(-2)?.identity) ||
    !same(review.execution, executions.at(-1)?.identity) ||
    history.length !== round.sequence * 2 ||
    history.some((step) => step.status !== "succeeded") ||
    reviewer?.sequence !== review.stepSequence ||
    !same(reviewer.assessment, review.assessment)
  )
    fail();
  if (
    requireRuntimeSkillEvidence(db, run, {
      status: "succeeded",
      result: review.assessment.report,
      errorCode: null,
      usage: null,
      terminationConfirmedAt: executions.at(-1)!.terminationConfirmedAt,
    }).status !== "succeeded"
  )
    fail();
  return {
    run,
    task,
    repository,
    round,
    input,
    candidate,
    evidenceDigest: digest({
      round,
      executions,
      history,
      repository: stored!.intent,
      sourceRevision: repository.sourceRevision,
      work: task.plannedWork,
      goalVersion: run.goalVersion,
      workflowPolicy: run.workflowPolicy,
      runtimeSkillVersion: run.runtimeSkillVersion,
    }),
  };
}

function matches(
  application: ChangeApplication,
  current: ReturnType<typeof evidence>,
) {
  return (
    application.taskId === current.task.id &&
    application.runId === current.run.id &&
    application.repositoryId === current.repository.id &&
    application.roundSequence === current.round.sequence &&
    application.goalVersion === current.run.goalVersion &&
    application.baseRevision === current.candidate.baseRevision &&
    application.tree === current.candidate.tree &&
    application.candidateDigest === current.candidate.digest &&
    application.evidenceDigest === current.evidenceDigest &&
    application.targetRef === developmentRef &&
    application.resultCommit === applicationCommit(application).oid
  );
}

// Reservation and cancel/Goal updates are ordered by the SQLite writer. Only a
// reservation made before a stop may reach Git; subsequent stops do not erase it.
export async function prepareChangeApplication(
  db: Db,
  runId: string,
  signal: AbortSignal,
  ownerToken?: string,
) {
  assertExecutionOwner(db, ownerToken);
  const current = evidence(db, runId);
  const existing = readChangeApplication(db, runId);
  if (existing) {
    if (!matches(existing, current)) fail();
    return existing;
  }
  signal.throwIfAborted();
  await verifyDevelopmentCandidate(
    current.repository,
    current.input,
    current.candidate,
    signal,
  );
  signal.throwIfAborted();
  const intent = {
    id: randomUUID(),
    taskId: current.task.id,
    runId,
    repositoryId: current.repository.id,
    roundSequence: current.round.sequence,
    goalVersion: current.run.goalVersion!,
    baseRevision: current.candidate.baseRevision,
    tree: current.candidate.tree,
    candidateDigest: current.candidate.digest,
    evidenceDigest: current.evidenceDigest,
    targetRef: developmentRef,
    status: "pending" as const,
    createdAt: new Date(),
    appliedAt: null,
  };
  const application = {
    ...intent,
    resultCommit: applicationCommit(intent).oid,
  };
  return db.transaction(
    (tx) => {
      assertExecutionOwner(tx, ownerToken);
      signal.throwIfAborted();
      const fresh = evidence(tx, runId);
      const concurrent = readChangeApplication(tx, runId);
      if (concurrent) {
        if (!matches(concurrent, fresh)) fail();
        return concurrent;
      }
      if (
        !matches(application, fresh) ||
        !same(fresh.repository, current.repository)
      )
        fail();
      if (
        fresh.run.status !== "running" ||
        fresh.task.status !== "running" ||
        (ownerToken !== undefined && fresh.run.instanceId !== ownerToken) ||
        fresh.run.stopReason ||
        fresh.task.cancelRequestedAt ||
        fresh.task.goalVersion !== fresh.run.goalVersion ||
        readGoalExecutionBlock(tx, fresh.task) ||
        !same(fresh.input.scope, readGoalScope(tx, fresh.task.goalId))
      )
        throw new AnalysisError("goal_changed");
      const latest = tx
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.taskId, fresh.task.id))
        .orderBy(desc(runs.attempt))
        .get();
      if (
        latest?.id !== runId ||
        tx
          .select()
          .from(changeApplications)
          .where(
            and(
              eq(changeApplications.repositoryId, fresh.repository.id),
              eq(changeApplications.status, "pending"),
            ),
          )
          .get()
      )
        fail();
      tx.insert(changeApplications).values(application).run();
      return application;
    },
    { behavior: "immediate" },
  );
}

// This is also the restart path. Reconcile a pending application BEFORE checking
// the old repository head: Git may already have advanced while SQLite did not.
export async function applyChangeApplication(
  db: Db,
  runId: string,
  signal: AbortSignal,
  ownerToken?: string,
) {
  assertExecutionOwner(db, ownerToken);
  const application = readChangeApplication(db, runId);
  if (!application) fail();
  const current = evidence(db, runId);
  if (!matches(application, current)) fail();
  if (application.status === "applied") return application;
  signal.throwIfAborted();
  const updated = await applyGitChange(
    application,
    current.repository,
    current.input,
    current.candidate,
    signal,
  );
  signal.throwIfAborted();
  return db.transaction(
    (tx) => {
      assertExecutionOwner(tx, ownerToken);
      const fresh = evidence(tx, runId);
      const stored = readChangeApplication(tx, runId);
      if (!stored || !matches(stored, fresh) || !matches(application, fresh))
        fail();
      if (stored.status === "applied") return stored;
      if (
        !same(stored, application) ||
        !same(fresh.repository, current.repository)
      )
        fail();
      tx.update(developmentRepositories)
        .set({ prepared: updated })
        .where(eq(developmentRepositories.id, updated.id))
        .run();
      const applied = {
        ...stored,
        status: "applied" as const,
        appliedAt: new Date(),
      };
      tx.update(changeApplications)
        .set({ status: applied.status, appliedAt: applied.appliedAt })
        .where(eq(changeApplications.id, stored.id))
        .run();
      return applied;
    },
    { behavior: "immediate" },
  );
}
