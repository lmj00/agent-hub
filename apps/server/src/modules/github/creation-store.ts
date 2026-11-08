import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { repositoryCreations } from "../../db/schema.js";
import { assertExecutionOwner } from "../execution/execution-owner.js";

type Db = ReturnType<typeof openDatabase>["db"];
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type CreationJob = typeof repositoryCreations.$inferSelect;
export type CreationInput = Pick<CreationJob, "requestKey" | "repositoryName" | "name" | "profile">;
export class CreationError extends Error {
  constructor(
    public readonly code:
      | "CREATION_REQUEST_CONFLICT"
      | "CREATION_NAME_RESERVED"
      | "CREATION_QUEUE_FULL"
      | "CREATION_NOT_FOUND"
      | "CREATION_ATTEMPT_LIMIT"
      | "CREATION_STATE_CONFLICT"
      | "CREATION_NOT_CONFIGURED"
      | "CREATION_PROFILE_UNAVAILABLE",
  ) {
    super(code);
  }
}
function queueSpace(db: Pick<Db, "select">) {
  const count = db
    .select({ count: sql<number>`count(*)` })
    .from(repositoryCreations)
    .where(inArray(repositoryCreations.status, ["queued", "authorizing", "creating", "created"]))
    .get()!.count;
  if (count >= 20) throw new CreationError("CREATION_QUEUE_FULL");
}
export function createCreationStore(db: Db, ownerToken: string) {
  function transaction<T>(work: (tx: Tx) => T): T {
    return db.transaction(
      (tx) => {
        assertExecutionOwner(tx, ownerToken);
        return work(tx);
      },
      { behavior: "immediate" },
    );
  }
  const find = (id: string) =>
    db.select().from(repositoryCreations).where(eq(repositoryCreations.id, id)).get();
  const match = (job: CreationJob, status: CreationJob["status"]) =>
    and(
      eq(repositoryCreations.id, job.id),
      eq(repositoryCreations.attempt, job.attempt),
      eq(repositoryCreations.status, status),
    );
  return {
    find,
    register(input: CreationInput) {
      const name = input.name.trim(),
        repositoryName = input.repositoryName.trim();
      const hash = createHash("sha256")
        .update(JSON.stringify([repositoryName, name, input.profile]))
        .digest("hex");
      return transaction((tx) => {
        const previous = tx
          .select()
          .from(repositoryCreations)
          .where(eq(repositoryCreations.requestKey, input.requestKey))
          .get();
        if (previous) {
          if (previous.commandHash !== hash) throw new CreationError("CREATION_REQUEST_CONFLICT");
          return previous;
        }
        if (
          tx
            .select()
            .from(repositoryCreations)
            .where(eq(repositoryCreations.normalizedName, repositoryName.toLowerCase()))
            .get()
        )
          throw new CreationError("CREATION_NAME_RESERVED");
        queueSpace(tx);
        const now = new Date();
        return tx
          .insert(repositoryCreations)
          .values({
            ...input,
            id: randomUUID(),
            name,
            repositoryName,
            normalizedName: repositoryName.toLowerCase(),
            commandHash: hash,
            status: "queued",
            createdAt: now,
            updatedAt: now,
          })
          .returning()
          .get();
      });
    },
    recover() {
      transaction((tx) => {
        tx.update(repositoryCreations)
          .set({ status: "uncertain", errorCode: "GITHUB_CREATE_UNCERTAIN", updatedAt: new Date() })
          .where(eq(repositoryCreations.status, "creating"))
          .run();
        tx.update(repositoryCreations)
          .set({ status: "failed", errorCode: "CREATION_INTERRUPTED", updatedAt: new Date() })
          .where(eq(repositoryCreations.status, "authorizing"))
          .run();
      });
    },
    claim() {
      return transaction((tx) => {
        if (
          tx
            .select()
            .from(repositoryCreations)
            .where(inArray(repositoryCreations.status, ["authorizing", "creating"]))
            .get()
        )
          return undefined;
        const job = tx
          .select()
          .from(repositoryCreations)
          .where(eq(repositoryCreations.status, "queued"))
          .orderBy(asc(repositoryCreations.createdAt), asc(repositoryCreations.id))
          .get();
        if (!job) return undefined;
        if (job.attempt >= 5) throw new CreationError("CREATION_ATTEMPT_LIMIT");
        return tx
          .update(repositoryCreations)
          .set({
            status: "authorizing",
            attempt: job.attempt + 1,
            errorCode: null,
            updatedAt: new Date(),
          })
          .where(eq(repositoryCreations.id, job.id))
          .returning()
          .get();
      });
    },
    dispatch(job: CreationJob) {
      transaction((tx) => {
        const changed = tx
          .update(repositoryCreations)
          .set({ status: "creating", updatedAt: new Date() })
          .where(match(job, "authorizing"))
          .run();
        if (changed.changes !== 1) throw new CreationError("CREATION_STATE_CONFLICT");
      });
    },
    created(job: CreationJob, result: { repositoryId: number; fullName: string }) {
      transaction((tx) => {
        if (
          tx
            .update(repositoryCreations)
            .set({ ...result, status: "created", errorCode: null, updatedAt: new Date() })
            .where(match(job, "creating"))
            .run().changes !== 1
        )
          throw new CreationError("CREATION_STATE_CONFLICT");
      });
    },
    fail(job: CreationJob, code: string) {
      transaction((tx) => {
        const current = tx
          .select()
          .from(repositoryCreations)
          .where(eq(repositoryCreations.id, job.id))
          .get();
        if (
          !current ||
          current.attempt !== job.attempt ||
          !["authorizing", "creating"].includes(current.status)
        )
          return;
        const uncertain = current.status === "creating" && code !== "GITHUB_CREATE_REJECTED";
        tx.update(repositoryCreations)
          .set({
            status: uncertain ? "uncertain" : "failed",
            errorCode: uncertain ? "GITHUB_CREATE_UNCERTAIN" : code,
            updatedAt: new Date(),
          })
          .where(eq(repositoryCreations.id, job.id))
          .run();
      });
    },
    nextCreated() {
      return db
        .select()
        .from(repositoryCreations)
        .where(
          and(eq(repositoryCreations.status, "created"), isNull(repositoryCreations.errorCode)),
        )
        .orderBy(asc(repositoryCreations.createdAt), asc(repositoryCreations.id))
        .get();
    },
    link(job: CreationJob, importId: string) {
      transaction((tx) => {
        if (
          tx
            .update(repositoryCreations)
            .set({ status: "linked", importId, errorCode: null, updatedAt: new Date() })
            .where(match(job, "created"))
            .run().changes !== 1
        )
          throw new CreationError("CREATION_STATE_CONFLICT");
      });
    },
    linkFailed(job: CreationJob) {
      transaction((tx) => {
        tx.update(repositoryCreations)
          .set({ errorCode: "CREATION_IMPORT_FAILED", updatedAt: new Date() })
          .where(match(job, "created"))
          .run();
      });
    },
    action(id: string, action: "retry" | "cancel") {
      return transaction((tx) => {
        const job = tx
          .select()
          .from(repositoryCreations)
          .where(eq(repositoryCreations.id, id))
          .get();
        if (!job) throw new CreationError("CREATION_NOT_FOUND");
        if (action === "cancel") {
          if (!["queued", "failed"].includes(job.status)) return job;
          return tx
            .update(repositoryCreations)
            .set({ status: "cancelled", errorCode: null, updatedAt: new Date() })
            .where(eq(repositoryCreations.id, id))
            .returning()
            .get();
        }
        if (job.status === "created")
          return tx
            .update(repositoryCreations)
            .set({ errorCode: null, updatedAt: new Date() })
            .where(eq(repositoryCreations.id, id))
            .returning()
            .get();
        if (!["failed", "cancelled"].includes(job.status)) return job;
        if (job.attempt >= 5) throw new CreationError("CREATION_ATTEMPT_LIMIT");
        queueSpace(tx);
        return tx
          .update(repositoryCreations)
          .set({ status: "queued", errorCode: null, updatedAt: new Date() })
          .where(eq(repositoryCreations.id, id))
          .returning()
          .get();
      });
    },
  };
}
