import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import { eq } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { runs } from "../../db/schema.js";
import type { AnalysisEvent } from "../execution/analysis.js";
import {
  readDevelopmentRepository,
  readDevelopmentRounds,
  type DevelopmentUpdate,
} from "./development-journal.js";
import {
  assertDevelopmentBase,
  developmentInputIntent,
  developmentRepositoryIntent,
  prepareDevelopmentInput,
  prepareDevelopmentRepository,
  recoverDevelopmentInput,
  recoverDevelopmentRepository,
  removeDevelopmentInput,
  stageDevelopmentCandidate,
  type DevelopmentCandidate,
  type DevelopmentInput,
  type DevelopmentRepository,
} from "./development-workspace.js";
import type { GoalScope } from "./prepared-workspace.js";

type Db = Pick<ReturnType<typeof openDatabase>["db"], "select">;
type Save = (event: AnalysisEvent) => void | Promise<void>;
const save = (onEvent: Save, development: DevelopmentUpdate) =>
  onEvent({ kind: `development.${development.type}`, development });
function exists(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// Each intent is acknowledged before file creation. Published files may survive
// a lost ready acknowledgement; only a fully checked publication is adopted.
export async function prepareRecordedDevelopment(
  db: Db,
  request: {
    repositoryRoot: string;
    inputRoot: string;
    projectId: string;
    runId: string;
    source: string;
    sequence: number;
    scope: GoalScope;
    writePaths: string[];
    previous?: DevelopmentCandidate;
    signal: AbortSignal;
  },
  onEvent: Save,
) {
  const { signal } = request;
  signal.throwIfAborted();
  let stored = readDevelopmentRepository(db, request.projectId);
  if (!stored) {
    const repository = developmentRepositoryIntent(
      request.repositoryRoot,
      request.source,
      request.projectId,
    );
    await save(onEvent, { type: "repository.intent", repository });
    stored = readDevelopmentRepository(db, request.projectId);
  }
  if (!stored || stored.intent.source !== request.source)
    throw new Error("Development repository intent was not saved");
  const repository =
    stored.prepared ??
    (exists(stored.intent.directory)
      ? await recoverDevelopmentRepository(stored.intent, signal)
      : await prepareDevelopmentRepository(stored.intent, signal));
  await assertDevelopmentBase(repository, signal);
  if (!stored.prepared)
    await save(onEvent, { type: "repository.ready", repository });
  const round = readDevelopmentRounds(db, request.runId).find(
    (value) => value.sequence === request.sequence,
  );
  const intent =
    round?.intent ??
    developmentInputIntent(
      request.inputRoot,
      repository,
      request.runId,
      request.scope,
      request.writePaths,
      request.previous,
    );
  // Even on resume the owner, scope and prior-candidate checks run again.
  await save(onEvent, {
    type: "input.intent",
    sequence: request.sequence,
    input: intent,
  });
  signal.throwIfAborted();
  const input = exists(dirname(intent.directory))
    ? await recoverDevelopmentInput(intent, repository, signal)
    : await prepareDevelopmentInput(intent, repository, signal);
  await save(onEvent, {
    type: "input.ready",
    sequence: request.sequence,
    input,
  });
  return { repository, input };
}

export async function captureRecordedDevelopment(
  repository: DevelopmentRepository,
  input: DevelopmentInput,
  sequence: number,
  result: unknown,
  signal: AbortSignal,
  onEvent: Save,
) {
  const candidate = await stageDevelopmentCandidate(
    repository,
    input,
    result,
    signal,
  );
  // The store requires the developer container's saved termination proof.
  await save(onEvent, { type: "candidate.ready", sequence, candidate });
  return candidate;
}

export function cleanupRecordedDevelopment(
  db: Db,
  root: string,
  runId: string,
) {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run?.terminationConfirmedAt) return;
  for (const round of readDevelopmentRounds(db, runId))
    removeDevelopmentInput(root, round.intent);
}
