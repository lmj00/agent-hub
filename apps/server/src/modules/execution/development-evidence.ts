import { asc, eq, sql } from "drizzle-orm";
import type { DevelopmentEvidence } from "@agent-hub/contracts";
import type { openDatabase } from "../../db/connection.js";
import { changeApplications, developmentRounds, runs } from "../../db/schema.js";
import { redactOutput } from "./analysis.js";
import { parseAssessment } from "./analysis-workflow.js";

// Explicit response projection: paths to host inputs, manifests, test command
// arguments and container identity tokens never enter the public response.
export function readDevelopmentEvidence(
  db: Pick<ReturnType<typeof openDatabase>["db"], "select">,
  run: Pick<typeof runs.$inferSelect, "id" | "developmentVersion">,
): DevelopmentEvidence | null {
  const records = db
    .select({
      sequence: developmentRounds.sequence,
      inputReady: sql<boolean>`${developmentRounds.input} IS NOT NULL`.mapWith(Boolean),
      verificationReady: sql<boolean>`${developmentRounds.verificationInput} IS NOT NULL`.mapWith(
        Boolean,
      ),
      candidate: developmentRounds.candidate,
      test: developmentRounds.verificationResult,
      review: developmentRounds.review,
      createdAt: developmentRounds.createdAt,
      capturedAt: developmentRounds.capturedAt,
      verifiedAt: developmentRounds.verifiedAt,
      reviewedAt: developmentRounds.reviewedAt,
    })
    .from(developmentRounds)
    .where(eq(developmentRounds.runId, run.id))
    .orderBy(asc(developmentRounds.sequence))
    .all();
  if (!records.length && run.developmentVersion !== 1) return null;
  const rounds: DevelopmentEvidence["rounds"] = records.map((record) => ({
    sequence: record.sequence,
    phase: !record.inputReady
      ? "preparing"
      : !record.candidate
        ? "developing"
        : !record.verificationReady
          ? "preparing_test"
          : !record.test
            ? "testing"
            : !record.review
              ? "reviewing"
              : record.review.assessment.complete && record.test.status === "passed"
                ? "verified"
                : "needs_changes",
    createdAt: record.createdAt.toISOString(),
    capturedAt: record.capturedAt?.toISOString() ?? null,
    candidateDigest: record.candidate?.digest ?? null,
    changes:
      record.candidate?.changes.map((change) => ({
        path: redactOutput(change.path),
        action: change.after === null ? "delete" : change.before === null ? "add" : "modify",
        bytes: change.bytes,
      })) ?? [],
    test:
      record.test && record.verifiedAt
        ? {
            status: record.test.status,
            exitCode: record.test.exitCode,
            oomKilled: record.test.oomKilled,
            elapsedMs: record.test.elapsedMs,
            output: redactOutput(record.test.output),
            recordedAt: record.verifiedAt.toISOString(),
          }
        : null,
    review:
      record.review && record.reviewedAt
        ? {
            assessment: parseAssessment(record.review.assessment),
            recordedAt: record.reviewedAt.toISOString(),
          }
        : null,
  }));
  const application = db
    .select({
      id: changeApplications.id,
      status: changeApplications.status,
      roundSequence: changeApplications.roundSequence,
      baseRevision: changeApplications.baseRevision,
      resultCommit: changeApplications.resultCommit,
      candidateDigest: changeApplications.candidateDigest,
      createdAt: changeApplications.createdAt,
      appliedAt: changeApplications.appliedAt,
    })
    .from(changeApplications)
    .where(eq(changeApplications.runId, run.id))
    .get();
  return {
    phase: application
      ? application.status === "applied"
        ? "applied"
        : "applying"
      : (rounds.at(-1)?.phase ?? "preparing"),
    maxRounds: 3,
    rounds,
    application: application
      ? {
          ...application,
          createdAt: application.createdAt.toISOString(),
          appliedAt: application.appliedAt?.toISOString() ?? null,
        }
      : null,
  };
}
