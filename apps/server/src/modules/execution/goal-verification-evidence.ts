import {
  goalVerificationEvidenceSchema,
  parseResponse,
  type GoalVerificationEvidence,
} from "@agent-hub/contracts";
import type { runs } from "../../db/schema.js";
import { parseAssessment } from "./analysis-workflow.js";
import { redactOutput } from "./analysis.js";

// Historical display only. The completion transaction validates the proof;
// this projection never exposes commands, host paths or execution credentials.
export function readGoalVerificationEvidence(
  run: Pick<typeof runs.$inferSelect, "planResult">,
): GoalVerificationEvidence | null {
  const verification = run.planResult?.verification;
  if (!verification) return null;
  if (verification.version !== 1) throw new Error("Unsupported Goal verification evidence");
  const result = verification.test?.result;
  const review = verification.review;
  const assessment = review ? parseAssessment(review.assessment) : null;
  const completionApplied =
    run.planResult!.status === "applied" && run.planResult!.reason === "complete";
  if (completionApplied && (!result || !assessment?.complete || result.status !== "passed"))
    throw new Error("Incomplete Goal completion evidence");
  return parseResponse(goalVerificationEvidenceSchema, {
    sourceRevision: verification.sourceRevision,
    inputDigest: verification.inputDigest,
    startedAt: verification.startedAt,
    phase: !result
      ? "testing"
      : !review
        ? "reviewing"
        : result.status === "passed" && assessment!.complete
          ? "verified"
          : "needs_changes",
    completionApplied,
    test: result
      ? {
          status: result.status,
          exitCode: result.exitCode,
          oomKilled: result.oomKilled,
          elapsedMs: result.elapsedMs,
          output: redactOutput(result.output),
          recordedAt: verification.test!.recordedAt,
        }
      : null,
    review: review ? { assessment, recordedAt: review.recordedAt } : null,
  });
}
