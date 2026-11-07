import { and, eq } from "drizzle-orm";
import type { AnalysisAssessment } from "@agent-hub/contracts";
import type { openDatabase } from "../../db/connection.js";
import { developmentRounds, steps } from "../../db/schema.js";
import {
  AnalysisError,
  type ExecutionIdentity,
  type ExecutionRecord,
} from "../execution/analysis.js";
import { parseAssessment } from "../execution/analysis-workflow.js";
import {
  parseVerificationConfig,
  parseVerificationResult,
  verificationResultDigest,
  type VerificationConfig,
  type VerificationResult,
} from "../execution/verification-config.js";
import {
  validInputDigest,
  type DevelopmentInputIntent,
  type DevelopmentInput,
} from "./development-workspace.js";

export type DevelopmentVerificationIntent = {
  candidateDigest: string;
  input: DevelopmentInputIntent;
  configuration: VerificationConfig;
};
export type DevelopmentReview = {
  candidateDigest: string;
  verificationDigest: string;
  execution: ExecutionIdentity;
  stepSequence: number;
  assessment: AnalysisAssessment;
};
export type DevelopmentVerificationUpdate =
  | {
      type: "verification.intent";
      sequence: number;
      verification: DevelopmentVerificationIntent;
    }
  | { type: "verification.ready"; sequence: number; input: DevelopmentInput }
  | {
      type: "verification.complete";
      sequence: number;
      result: VerificationResult;
    }
  | { type: "review.complete"; sequence: number; review: DevelopmentReview };

type Db = Pick<ReturnType<typeof openDatabase>["db"], "select" | "update">;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameIdentity = (a: ExecutionIdentity, b: ExecutionIdentity) =>
  a.kind === b.kind &&
  a.containerId === b.containerId &&
  a.token === b.token &&
  a.engineId === b.engineId;
function fail(): never {
  throw new AnalysisError("input_unavailable");
}

// The caller owns the Run transaction and has checked scope, ordering and all
// physical termination proofs. No file or process operation occurs here.
export function saveDevelopmentVerification(
  db: Db,
  current: typeof developmentRounds.$inferSelect,
  executions: ExecutionRecord[],
  update: DevelopmentVerificationUpdate,
  now: Date,
) {
  const where = and(
    eq(developmentRounds.runId, current.runId),
    eq(developmentRounds.sequence, current.sequence),
  );
  const { candidate, input } = current;
  if (!candidate || !input) fail();
  const count = executions.length - current.executionOffset;
  if (update.type === "verification.intent") {
    const intent = update.verification;
    const prepared = intent.input;
    const configuration = parseVerificationConfig(intent.configuration);
    if (
      count !== 1 ||
      intent.candidateDigest !== candidate.digest ||
      prepared.id === input.id ||
      prepared.directory === input.directory ||
      prepared.repositoryId !== input.repositoryId ||
      prepared.runId !== current.runId ||
      prepared.revision !== input.revision ||
      prepared.tree !== candidate.tree ||
      prepared.previousCandidate !== candidate.digest ||
      !same(prepared.scope, input.scope) ||
      !same(prepared.writePaths, input.writePaths) ||
      !same(configuration, intent.configuration)
    )
      fail();
    if (current.verificationIntent) {
      if (!same(current.verificationIntent, intent)) fail();
      return;
    }
    db.update(developmentRounds).set({ verificationIntent: intent }).where(where).run();
    return;
  }
  if (!current.verificationIntent) fail();
  if (update.type === "verification.ready") {
    const { files: _files, digest: _digest, ...intent } = update.input;
    if (
      count !== 1 ||
      !same(intent, current.verificationIntent.input) ||
      !validInputDigest(update.input)
    )
      fail();
    if (current.verificationInput) {
      if (!same(current.verificationInput, update.input)) fail();
      return;
    }
    db.update(developmentRounds)
      .set({ verificationInput: update.input, verificationPreparedAt: now })
      .where(where)
      .run();
    return;
  }
  if (!current.verificationInput) fail();
  if (update.type === "verification.complete") {
    const result = parseVerificationResult(update.result);
    if (
      count !== 2 ||
      result.candidateDigest !== candidate.digest ||
      result.inputDigest !== current.verificationInput.digest ||
      !same(result.configuration, current.verificationIntent.configuration) ||
      !sameIdentity(result.execution, executions.at(-1)!.identity)
    )
      fail();
    if (current.verificationResult) {
      if (!same(current.verificationResult, result)) fail();
      return;
    }
    db.update(developmentRounds)
      .set({ verificationResult: result, verifiedAt: now })
      .where(where)
      .run();
    return;
  }
  if (!current.verificationResult) fail();
  const review = {
    ...update.review,
    assessment: parseAssessment(update.review.assessment),
  };
  const step = db
    .select()
    .from(steps)
    .where(and(eq(steps.runId, current.runId), eq(steps.sequence, current.sequence * 2)))
    .get();
  if (
    count !== 3 ||
    review.candidateDigest !== candidate.digest ||
    review.verificationDigest !== verificationResultDigest(current.verificationResult) ||
    review.stepSequence !== current.sequence * 2 ||
    !step ||
    step.status !== "succeeded" ||
    !same(step.assessment, review.assessment) ||
    !sameIdentity(review.execution, executions.at(-1)!.identity) ||
    (review.assessment.complete && current.verificationResult.status !== "passed")
  )
    fail();
  if (current.review) {
    if (!same(current.review, review)) fail();
    return;
  }
  db.update(developmentRounds).set({ review, reviewedAt: now }).where(where).run();
}
