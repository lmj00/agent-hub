import { and, asc, eq, isNull } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { runExecutions } from "../../db/schema.js";
import {
  maxRunExecutions,
  type AnalysisEvent,
  type ExecutionIdentity,
  type ExecutionRecord,
} from "./analysis.js";

type Db = Pick<ReturnType<typeof openDatabase>["db"], "select" | "insert" | "update">;

export function readExecutions(db: Pick<Db, "select">, runId: string): ExecutionRecord[] {
  return db
    .select()
    .from(runExecutions)
    .where(eq(runExecutions.runId, runId))
    .orderBy(asc(runExecutions.sequence))
    .all()
    .map((row) => ({
      sequence: row.sequence,
      createdAt: row.createdAt,
      terminationConfirmedAt: row.terminationConfirmedAt,
      identity: {
        kind: "docker",
        containerId: row.containerId,
        token: row.token,
        engineId: row.engineId,
      },
    }));
}

function sameIdentity(a: ExecutionIdentity, b: ExecutionIdentity) {
  return (
    a.kind === b.kind &&
    a.containerId === b.containerId &&
    a.engineId === b.engineId &&
    a.token === b.token
  );
}

// Called inside the Run owner's transaction, never by the container protocol.
export function recordExecution(
  db: Db,
  run: { id: string; stopReason: unknown },
  event: AnalysisEvent,
  now: Date,
) {
  if (!event.execution && !event.executionTermination) return;
  if (event.execution && event.executionTermination) throw new Error("Ambiguous execution event");
  const records = readExecutions(db, run.id);
  if (event.execution) {
    const identity = event.execution;
    if (event.kind !== "execution.prepared" || run.stopReason)
      throw new Error("Execution cannot start");
    if (
      identity.kind !== "docker" ||
      !/^[a-f0-9]{64}$/.test(identity.containerId) ||
      [identity.token, identity.engineId].some(
        (value) => typeof value !== "string" || !value || value.length > 200,
      )
    )
      throw new Error("Invalid execution identity");
    if (
      records.some(
        (row) => !row.terminationConfirmedAt || row.identity.containerId === identity.containerId,
      )
    )
      throw new Error("Execution identity is already assigned or termination is unconfirmed");
    if (records.length >= maxRunExecutions) throw new Error("Execution resource limit reached");
    db.insert(runExecutions)
      .values({
        runId: run.id,
        sequence: records.length + 1,
        containerId: identity.containerId,
        engineId: identity.engineId,
        token: identity.token,
        createdAt: now,
      })
      .run();
  } else {
    const proof = event.executionTermination!;
    const record = records.find((row) => sameIdentity(row.identity, proof.identity));
    if (
      event.kind !== "execution.terminated" ||
      !record ||
      !(proof.confirmedAt instanceof Date) ||
      !Number.isFinite(proof.confirmedAt.getTime()) ||
      proof.confirmedAt < record.createdAt ||
      proof.confirmedAt > now
    )
      throw new Error("Invalid execution termination evidence");
    // Duplicate delivery is harmless; the first saved observation is immutable.
    if (!record.terminationConfirmedAt)
      db.update(runExecutions)
        .set({ terminationConfirmedAt: proof.confirmedAt })
        .where(and(eq(runExecutions.runId, run.id), eq(runExecutions.sequence, record.sequence)))
        .run();
  }
}

// A trusted parent has observed every container. Persist that aggregate proof
// in the same transaction as the Run/recovery result, before any cleanup.
export function confirmExecutions(
  db: Pick<Db, "update">,
  runId: string,
  confirmedAt: Date | null | undefined,
) {
  if (!confirmedAt) return;
  if (!Number.isFinite(confirmedAt.getTime())) throw new Error("Invalid termination time");
  db.update(runExecutions)
    .set({ terminationConfirmedAt: confirmedAt })
    .where(and(eq(runExecutions.runId, runId), isNull(runExecutions.terminationConfirmedAt)))
    .run();
}
