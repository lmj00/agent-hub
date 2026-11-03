import { and, asc, desc, eq } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import {
  developmentRepositories,
  developmentRounds,
  runs,
  tasks,
} from "../../db/schema.js";
import { AnalysisError } from "../execution/analysis.js";
import { readExecutions } from "../execution/execution-record-store.js";
import { readGoalExecutionBlock } from "./goal-execution-store.js";
import { readGoalScope } from "./prepared-input-store.js";
import {
  validCandidateDigest,
  validInputDigest,
  type DevelopmentRepositoryIntent,
  type DevelopmentRepository,
  type DevelopmentInputIntent,
  type DevelopmentInput,
  type DevelopmentCandidate,
} from "./development-workspace.js";

export const maxDevelopmentRounds = 3;
export type DevelopmentUpdate =
  | { type: "repository.intent"; repository: DevelopmentRepositoryIntent }
  | { type: "repository.ready"; repository: DevelopmentRepository }
  | { type: "input.intent"; sequence: number; input: DevelopmentInputIntent }
  | { type: "input.ready"; sequence: number; input: DevelopmentInput }
  | {
      type: "candidate.ready";
      sequence: number;
      candidate: DevelopmentCandidate;
    };
type Db = Pick<
  ReturnType<typeof openDatabase>["db"],
  "select" | "insert" | "update"
>;
type Run = typeof runs.$inferSelect;
const same = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);
const fail = () => {
  throw new AnalysisError("input_unavailable");
};

export function readDevelopmentRepository(
  db: Pick<Db, "select">,
  projectId: string,
) {
  return db
    .select()
    .from(developmentRepositories)
    .where(eq(developmentRepositories.projectId, projectId))
    .get();
}
export function readDevelopmentRounds(db: Pick<Db, "select">, runId: string) {
  return db
    .select()
    .from(developmentRounds)
    .where(eq(developmentRounds.runId, runId))
    .orderBy(asc(developmentRounds.sequence))
    .all();
}

// Called inside RunStore's owner-checked transaction. All Git/file I/O happens
// before or after this journal write, never while holding the SQLite writer.
export function saveDevelopmentUpdate(
  db: Db,
  run: Run,
  update: DevelopmentUpdate,
  kind: string,
  now: Date,
) {
  const task = db.select().from(tasks).where(eq(tasks.id, run.taskId)).get();
  if (
    !task?.plannedWork ||
    task.kind !== "work" ||
    task.status !== "running" ||
    run.status !== "running" ||
    kind !== `development.${update.type}`
  )
    fail();
  const selected = task!;
  // Completed evidence may still be kept after a Goal pause; it grants no
  // permission to start another phase or to apply changes.
  if (
    update.type !== "candidate.ready" &&
    (run.stopReason ||
      selected.cancelRequestedAt ||
      readGoalExecutionBlock(db, selected) ||
      selected.goalVersion !== run.goalVersion)
  )
    throw new AnalysisError("goal_changed");
  const executions = readExecutions(db, run.id);
  const idle = executions.every(
    (entry) => entry.terminationConfirmedAt !== null,
  );
  if (update.type === "repository.intent") {
    if (executions.length || update.repository.projectId !== selected.projectId)
      fail();
    const existing = readDevelopmentRepository(db, selected.projectId);
    if (existing) {
      if (!same(existing.intent, update.repository)) fail();
      return;
    }
    db.insert(developmentRepositories)
      .values({
        id: update.repository.id,
        projectId: selected.projectId,
        createdByRunId: run.id,
        intent: update.repository,
        createdAt: now,
      })
      .run();
    return;
  }
  if (update.type === "repository.ready") {
    const existing = readDevelopmentRepository(db, selected.projectId);
    const {
      sourceRevision: _source,
      head: _head,
      headTree: _tree,
      ...intent
    } = update.repository;
    if (
      !existing ||
      executions.length ||
      !same(existing.intent, intent) ||
      update.repository.projectId !== selected.projectId ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(update.repository.head) ||
      update.repository.head !== update.repository.sourceRevision ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(update.repository.headTree)
    )
      fail();
    if (existing!.prepared) {
      if (!same(existing!.prepared, update.repository)) fail();
      return;
    }
    db.update(developmentRepositories)
      .set({ prepared: update.repository, preparedAt: now })
      .where(eq(developmentRepositories.id, existing!.id))
      .run();
    return;
  }
  const repository = readDevelopmentRepository(
    db,
    selected.projectId,
  )?.prepared;
  if (
    !repository ||
    !idle ||
    !Number.isInteger(update.sequence) ||
    update.sequence < 1 ||
    update.sequence > maxDevelopmentRounds
  )
    fail();
  const rounds = readDevelopmentRounds(db, run.id),
    current = rounds.find((round) => round.sequence === update.sequence);
  const where = and(
    eq(developmentRounds.runId, run.id),
    eq(developmentRounds.sequence, update.sequence),
  );
  if (update.type === "input.intent") {
    const input = update.input;
    if (
      input.repositoryId !== repository!.id ||
      input.runId !== run.id ||
      input.revision !== repository!.head ||
      !same(input.scope, readGoalScope(db, selected.goalId)) ||
      !same(
        [...input.writePaths].sort(),
        [...selected.plannedWork!.paths].sort(),
      )
    )
      fail();
    if (current) {
      if (!same(current.intent, input)) fail();
      return;
    }
    if (update.sequence !== rounds.length + 1) fail();
    const previous = rounds.at(-1);
    if (
      previous &&
      (!previous.candidate ||
        previous.candidate.digest !== input.previousCandidate ||
        previous.candidate.tree !== input.tree)
    )
      fail();
    if (!previous && input.previousCandidate) {
      const candidates = db
        .select({ round: developmentRounds, prior: runs })
        .from(developmentRounds)
        .innerJoin(runs, eq(runs.id, developmentRounds.runId))
        .where(eq(runs.taskId, selected.id))
        .orderBy(desc(runs.attempt), desc(developmentRounds.sequence))
        .all();
      const prior = candidates.find((value) => value.round.candidate !== null);
      if (
        !prior?.prior.terminationConfirmedAt ||
        prior.round.candidate?.digest !== input.previousCandidate ||
        prior.round.candidate.tree !== input.tree ||
        prior.round.candidate.baseRevision !== input.revision
      )
        fail();
    } else if (!previous && input.tree !== repository!.headTree) fail();
    db.insert(developmentRounds)
      .values({
        runId: run.id,
        sequence: update.sequence,
        repositoryId: repository!.id,
        inputId: input.id,
        planningRevision: selected.plannedWork!.sourceRevision,
        intent: input,
        executionOffset: executions.length,
        createdAt: now,
      })
      .run();
    return;
  }
  if (!current) fail();
  if (update.type === "input.ready") {
    const { files: _files, digest: _digest, ...intent } = update.input;
    if (
      !same(current!.intent, intent) ||
      !validInputDigest(update.input) ||
      executions.length !== current!.executionOffset
    )
      fail();
    if (current!.input) {
      if (!same(current!.input, update.input)) fail();
      return;
    }
    db.update(developmentRounds)
      .set({ input: update.input, preparedAt: now })
      .where(where)
      .run();
    return;
  }
  const candidate = update.candidate;
  if (
    !current!.input ||
    !validCandidateDigest(candidate) ||
    candidate.repositoryId !== repository!.id ||
    candidate.runId !== run.id ||
    candidate.baseRevision !== current!.input.revision ||
    candidate.inputDigest !== current!.input.digest ||
    executions.length !== current!.executionOffset + 1
  )
    fail();
  if (current!.candidate) {
    if (!same(current!.candidate, candidate)) fail();
    return;
  }
  db.update(developmentRounds)
    .set({ candidate, capturedAt: now })
    .where(where)
    .run();
}

export function assertDevelopmentExecutionReady(
  db: Pick<Db, "select">,
  run: Run,
) {
  const task = db.select().from(tasks).where(eq(tasks.id, run.taskId)).get();
  if (!task?.plannedWork) return;
  const current = readDevelopmentRounds(db, run.id).at(-1);
  if (
    !current?.input ||
    !same(current.input.scope, readGoalScope(db, task.goalId)) ||
    readGoalExecutionBlock(db, task) ||
    run.stopReason ||
    task.cancelRequestedAt
  )
    throw new AnalysisError("input_unavailable");
  if (
    readExecutions(db, run.id).length > current.executionOffset &&
    !current.candidate
  )
    throw new AnalysisError("input_unavailable");
}
