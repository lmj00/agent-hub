import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { projects, repositoryImports } from "../../db/schema.js";
import { assertExecutionOwner } from "../execution/execution-owner.js";
import { ImportError } from "./import-workspace.js";

type Db = ReturnType<typeof openDatabase>["db"];
function requireQueueSpace(db: Pick<Db, "select">) {
  const outstanding = db
    .select({ count: sql<number>`count(*)` })
    .from(repositoryImports)
    .where(or(eq(repositoryImports.status, "queued"), eq(repositoryImports.status, "preparing")))
    .get()!.count;
  if (outstanding >= 20) throw new ImportError("IMPORT_QUEUE_FULL");
}
export type ImportJob = typeof repositoryImports.$inferSelect;
export type ImportInput = {
  requestKey: string;
  repositoryId: number;
  name: string;
  profile: string;
};
export const importedWorkspaceKey = (job: Pick<ImportJob, "id">) => `import-${job.id}`;

export function createImportStore(db: Db, ownerToken: string) {
  const find = (id: string) =>
    db.select().from(repositoryImports).where(eq(repositoryImports.id, id)).get();
  return {
    find,
    list: () =>
      db
        .select()
        .from(repositoryImports)
        .orderBy(desc(repositoryImports.createdAt), asc(repositoryImports.id))
        .limit(20)
        .all(),
    register(input: ImportInput) {
      const commandHash = createHash("sha256")
        .update(JSON.stringify([input.repositoryId, input.name.trim(), input.profile]))
        .digest("hex");
      return db.transaction(
        (tx) => {
          assertExecutionOwner(tx, ownerToken);
          const previous = tx
            .select()
            .from(repositoryImports)
            .where(
              or(
                eq(repositoryImports.requestKey, input.requestKey),
                eq(repositoryImports.repositoryId, input.repositoryId),
              ),
            )
            .all();
          const request = previous.find((job) => job.requestKey === input.requestKey);
          if (request && request.commandHash !== commandHash)
            throw new ImportError("IMPORT_REQUEST_CONFLICT");
          if (previous.length) return request ?? previous[0]!;
          requireQueueSpace(tx);
          const now = new Date();
          return tx
            .insert(repositoryImports)
            .values({
              id: randomUUID(),
              ...input,
              name: input.name.trim(),
              commandHash,
              status: "queued",
              createdAt: now,
              updatedAt: now,
            })
            .returning()
            .get();
        },
        { behavior: "immediate" },
      );
    },
    recover() {
      db.transaction(
        (tx) => {
          assertExecutionOwner(tx, ownerToken);
          tx.update(repositoryImports)
            .set({ status: "failed", errorCode: "IMPORT_INTERRUPTED", updatedAt: new Date() })
            .where(eq(repositoryImports.status, "preparing"))
            .run();
        },
        { behavior: "immediate" },
      );
    },
    claim() {
      return db.transaction(
        (tx) => {
          assertExecutionOwner(tx, ownerToken);
          if (
            tx
              .select()
              .from(repositoryImports)
              .where(eq(repositoryImports.status, "preparing"))
              .get()
          )
            return undefined;
          const job = tx
            .select()
            .from(repositoryImports)
            .where(eq(repositoryImports.status, "queued"))
            .orderBy(asc(repositoryImports.createdAt), asc(repositoryImports.id))
            .get();
          if (!job) return undefined;
          if (job.attempt >= 5) throw new ImportError("IMPORT_ATTEMPT_LIMIT");
          return tx
            .update(repositoryImports)
            .set({
              status: "preparing",
              attempt: job.attempt + 1,
              attemptId: randomUUID(),
              errorCode: null,
              fullName: null,
              revision: null,
              localRevision: null,
              updatedAt: new Date(),
            })
            .where(eq(repositoryImports.id, job.id))
            .returning()
            .get();
        },
        { behavior: "immediate" },
      );
    },
    finish(job: ImportJob, source: { fullName: string; revision: string; localRevision: string }) {
      return db.transaction(
        (tx) => {
          assertExecutionOwner(tx, ownerToken);
          const current = tx
            .select()
            .from(repositoryImports)
            .where(eq(repositoryImports.id, job.id))
            .get();
          if (current?.status !== "preparing" || current.attemptId !== job.attemptId)
            return undefined;
          tx.insert(projects)
            .values({
              id: job.id,
              name: job.name,
              workspaceKey: importedWorkspaceKey(job),
              createdAt: new Date(),
            })
            .run();
          return tx
            .update(repositoryImports)
            .set({
              ...source,
              status: "ready",
              projectId: job.id,
              errorCode: null,
              updatedAt: new Date(),
            })
            .where(eq(repositoryImports.id, job.id))
            .returning()
            .get();
        },
        { behavior: "immediate" },
      );
    },
    fail(job: ImportJob, errorCode: string) {
      assertExecutionOwner(db, ownerToken);
      db.update(repositoryImports)
        .set({ status: "failed", errorCode, updatedAt: new Date() })
        .where(
          and(
            eq(repositoryImports.id, job.id),
            eq(repositoryImports.status, "preparing"),
            eq(repositoryImports.attemptId, job.attemptId!),
          ),
        )
        .run();
    },
    action(id: string, action: "cancel" | "retry") {
      return db.transaction(
        (tx) => {
          assertExecutionOwner(tx, ownerToken);
          const job = tx.select().from(repositoryImports).where(eq(repositoryImports.id, id)).get();
          if (!job) throw new ImportError("IMPORT_NOT_FOUND");
          if (action === "cancel") {
            if (["queued", "preparing"].includes(job.status))
              return tx
                .update(repositoryImports)
                .set({ status: "cancelled", errorCode: null, updatedAt: new Date() })
                .where(eq(repositoryImports.id, id))
                .returning()
                .get();
            return job;
          }
          if (job.status === "queued" || job.status === "preparing" || job.status === "ready")
            return job;
          if (job.attempt >= 5) throw new ImportError("IMPORT_ATTEMPT_LIMIT");
          requireQueueSpace(tx);
          return tx
            .update(repositoryImports)
            .set({ status: "queued", errorCode: null, updatedAt: new Date() })
            .where(eq(repositoryImports.id, id))
            .returning()
            .get();
        },
        { behavior: "immediate" },
      );
    },
  };
}
