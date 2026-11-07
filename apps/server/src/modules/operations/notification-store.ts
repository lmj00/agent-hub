import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, lte, or } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { changeApplications, notifications, runs, taskReleases, tasks } from "../../db/schema.js";
import { assertExecutionOwner } from "../execution/execution-owner.js";
import type { QueueStatus } from "../execution/execution-queue.js";
import { readProviderGate } from "../execution/provider-gate.js";
import type { NotificationConfig } from "./notification-config.js";
import type {
  DeliveryResult,
  NotificationPayload,
  NotificationReason,
} from "./notification-delivery.js";

type Db = ReturnType<typeof openDatabase>["db"];
type Receipt = typeof notifications.$inferSelect;
type Issue = Pick<Receipt, "reason" | "conditionKey" | "projectId" | "taskId" | "runId">;
const taskStates = ["blocked", "failed", "interrupted", "waiting_capacity"] as const;
const retryLimits = new Set(["retry_limit", "repeated_error_limit", "task_time_limit"]);

export function listNotifications(db: Db) {
  return db
    .select({
      id: notifications.id,
      reason: notifications.reason,
      projectId: notifications.projectId,
      taskId: notifications.taskId,
      runId: notifications.runId,
      status: notifications.status,
      attempts: notifications.attempts,
      nextAttemptAt: notifications.nextAttemptAt,
      lastAttemptAt: notifications.lastAttemptAt,
      lastResult: notifications.lastResult,
      detectedAt: notifications.detectedAt,
      updatedAt: notifications.updatedAt,
    })
    .from(notifications)
    .orderBy(desc(notifications.updatedAt), desc(notifications.sourceKey))
    .limit(50)
    .all();
}

export function createNotificationStore(
  db: Db,
  ownerToken: string,
  config: NotificationConfig,
  getQueue: () => QueueStatus | undefined,
) {
  const cursors = new Map<string, { at: Date; id: string }>();
  let receiptCursor = "";
  let applicationCursor = "";

  function current(sourceKey: string): Issue | null | undefined {
    if (sourceKey === "queue") {
      const queue = getQueue();
      if (queue && queue.lastCheckedAt === null) return undefined;
      // claimNext has found a surviving running record instead of starting work.
      // A genuinely running queue, however old its activity timestamp, is excluded.
      if (queue?.state === "held" && queue.reason === "running" && queue.runId) {
        const held = db
          .select({
            runId: runs.id,
            taskId: runs.taskId,
            projectId: tasks.projectId,
          })
          .from(runs)
          .innerJoin(tasks, eq(tasks.id, runs.taskId))
          .where(and(eq(runs.id, queue.runId), eq(runs.status, "running")))
          .get();
        return held
          ? {
              ...held,
              reason: "execution_recovery_required",
              conditionKey: `recovery:${held.runId}`,
            }
          : null;
      }
      if (queue?.state !== "error") return null;
      const reason =
        queue.reason === "configuration_invalid" ? "configuration_required" : "storage_error";
      return {
        conditionKey: reason,
        reason,
        projectId: null,
        taskId: null,
        runId: null,
      };
    }
    if (sourceKey === "provider") {
      const gate = readProviderGate(db);
      if (!gate?.blocked) return null;
      const reason =
        gate.reason === "authentication"
          ? "authentication_required"
          : gate.reason === "configuration"
            ? "configuration_required"
            : ["check_limit", "task_unavailable", "task_limit"].includes(
                  gate.capacityState?.reason ?? "",
                )
              ? "capacity_recovery_exhausted"
              : null;
      return reason
        ? {
            reason,
            conditionKey: `${gate.version}:${reason}`,
            projectId: null,
            taskId: null,
            runId: gate.sourceRunId,
          }
        : null;
    }
    if (sourceKey.startsWith("application:")) {
      const application = db
        .select({
          runId: runs.id,
          taskId: tasks.id,
          projectId: tasks.projectId,
          runStatus: runs.status,
        })
        .from(changeApplications)
        .innerJoin(runs, eq(runs.id, changeApplications.runId))
        .innerJoin(tasks, eq(tasks.id, changeApplications.taskId))
        .where(
          and(
            eq(changeApplications.id, sourceKey.slice(12)),
            eq(changeApplications.status, "pending"),
          ),
        )
        .get();
      // During normal development the pending journal is transient. Terminal task
      // cancellation/budget waiting cannot turn an unsettled Git effect into safety.
      if (!application || application.runStatus === "running") return null;
      return {
        reason: "change_application_unconfirmed",
        conditionKey: sourceKey,
        projectId: application.projectId,
        taskId: application.taskId,
        runId: application.runId,
      };
    }
    if (!sourceKey.startsWith("task:")) return null;
    const taskId = sourceKey.slice(5);
    const task = db
      .select({
        id: tasks.id,
        projectId: tasks.projectId,
        status: tasks.status,
        retryState: tasks.retryState,
        budgetWait: tasks.budgetWait,
        cancelRequestedAt: tasks.cancelRequestedAt,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .get();
    if (!task || !taskStates.some((status) => status === task.status)) return null;
    const run = db
      .select({
        id: runs.id,
        errorCode: runs.errorCode,
        terminationConfirmedAt: runs.terminationConfirmedAt,
      })
      .from(runs)
      .where(eq(runs.taskId, taskId))
      .orderBy(desc(runs.attempt))
      .limit(1)
      .get();
    let reason: NotificationReason;
    // An unconfirmed terminal attempt needs attention even if cancellation/budget caused the stop.
    if (run && !run.terminationConfirmedAt) reason = "termination_unconfirmed";
    else {
      if (
        task.cancelRequestedAt ||
        task.budgetWait ||
        task.retryState?.nextAttemptAt ||
        db
          .select({ id: changeApplications.id })
          .from(changeApplications)
          .where(
            and(eq(changeApplications.taskId, taskId), eq(changeApplications.status, "pending")),
          )
          .get() ||
        db
          .select({ id: taskReleases.sourceTaskId })
          .from(taskReleases)
          .where(eq(taskReleases.sourceTaskId, taskId))
          .get()
      )
        return null;
      const gate = readProviderGate(db);
      // Account-wide holds have one provider notification, not one per affected task.
      if (
        gate?.blocked &&
        ["authentication", "unsupported_settings", "capacity"].includes(run?.errorCode ?? "")
      )
        return null;
      if (task.status === "waiting_capacity" || run?.errorCode === "capacity") return null;
      const retryReason = task.retryState?.reason ?? "";
      reason = retryLimits.has(retryReason)
        ? (retryReason as NotificationReason)
        : run?.errorCode === "authentication"
          ? "authentication_required"
          : run?.errorCode === "unsupported_settings"
            ? "configuration_required"
            : task.status === "failed" || task.status === "interrupted"
              ? "task_failed"
              : "task_blocked";
    }
    return {
      reason,
      conditionKey: `${run?.id ?? "none"}:${reason}`,
      projectId: task.projectId,
      taskId,
      runId: run?.id ?? null,
    };
  }

  function sync(sourceKey: string, now: Date) {
    const issue = current(sourceKey);
    if (issue === undefined) return;
    const previous = db
      .select()
      .from(notifications)
      .where(eq(notifications.sourceKey, sourceKey))
      .get();
    if (!issue) {
      if (previous && previous.status !== "resolved")
        db.update(notifications)
          .set({ status: "resolved", nextAttemptAt: null, updatedAt: now })
          .where(eq(notifications.sourceKey, sourceKey))
          .run();
      return;
    }
    if (
      previous &&
      previous.status !== "resolved" &&
      previous.conditionKey === issue.conditionKey &&
      previous.destinationHash === config.destinationHash
    )
      return;
    const values = {
      ...issue,
      sourceKey,
      id: randomUUID(),
      destinationHash: config.destinationHash,
      status: "pending" as const,
      attempts: 0,
      nextAttemptAt: new Date(now.getTime() + config.graceMs),
      lastAttemptAt: null,
      lastResult: null,
      detectedAt: now,
      updatedAt: now,
    };
    db.insert(notifications)
      .values(values)
      .onConflictDoUpdate({ target: notifications.sourceKey, set: values })
      .run();
  }

  return {
    scan(now = new Date()) {
      db.transaction(
        () => {
          assertExecutionOwner(db, ownerToken);
          sync("queue", now);
          sync("provider", now);
          const applications = db
            .select({
              id: changeApplications.id,
              repositoryId: changeApplications.repositoryId,
            })
            .from(changeApplications)
            .where(
              and(
                eq(changeApplications.status, "pending"),
                gt(changeApplications.repositoryId, applicationCursor),
              ),
            )
            .orderBy(asc(changeApplications.repositoryId))
            .limit(25)
            .all();
          for (const application of applications) sync(`application:${application.id}`, now);
          applicationCursor = applications.length === 25 ? applications.at(-1)!.repositoryId : "";
          for (const status of taskStates) {
            const cursor = cursors.get(status);
            const page = db
              .select({ id: tasks.id, at: tasks.createdAt })
              .from(tasks)
              .where(
                and(
                  eq(tasks.status, status),
                  cursor
                    ? or(
                        gt(tasks.createdAt, cursor.at),
                        and(eq(tasks.createdAt, cursor.at), gt(tasks.id, cursor.id)),
                      )
                    : undefined,
                ),
              )
              .orderBy(asc(tasks.createdAt), asc(tasks.id))
              .limit(25)
              .all();
            for (const task of page) sync(`task:${task.id}`, now);
            if (page.length === 25) cursors.set(status, page.at(-1)!);
            else cursors.delete(status);
          }
          // Read each source to resolve it; absence from a scan page proves nothing.
          const page = db
            .select({ key: notifications.sourceKey })
            .from(notifications)
            .where(gt(notifications.sourceKey, receiptCursor))
            .orderBy(asc(notifications.sourceKey))
            .limit(50)
            .all();
          for (const row of page) sync(row.key, now);
          receiptCursor = page.length === 50 ? page.at(-1)!.key : "";
        },
        { behavior: "immediate" },
      );
    },
    claim(
      now = new Date(),
    ): { id: string; attempt: number; payload: NotificationPayload } | undefined {
      return db.transaction(
        () => {
          assertExecutionOwner(db, ownerToken);
          const row = db
            .select()
            .from(notifications)
            .where(and(eq(notifications.status, "pending"), lte(notifications.nextAttemptAt, now)))
            .orderBy(asc(notifications.nextAttemptAt), asc(notifications.sourceKey))
            .limit(1)
            .get();
          if (!row) return;
          sync(row.sourceKey, now);
          const fresh = db
            .select()
            .from(notifications)
            .where(eq(notifications.sourceKey, row.sourceKey))
            .get()!;
          if (
            fresh.id !== row.id ||
            fresh.status !== "pending" ||
            current(row.sourceKey) === undefined
          )
            return;
          if (row.attempts >= config.maxAttempts) {
            db.update(notifications)
              .set({ status: "exhausted", nextAttemptAt: null, updatedAt: now })
              .where(eq(notifications.id, row.id))
              .run();
            return;
          }
          const attempt = row.attempts + 1;
          const delay = Math.min(config.maxDelayMs, config.initialDelayMs * 2 ** (attempt - 1));
          // A crash after delivery but before acknowledgement retries the same id.
          db.update(notifications)
            .set({
              attempts: attempt,
              lastAttemptAt: now,
              lastResult: null,
              nextAttemptAt: new Date(now.getTime() + delay),
              updatedAt: now,
            })
            .where(eq(notifications.id, row.id))
            .run();
          return {
            id: row.id,
            attempt,
            payload: {
              version: 1,
              id: row.id,
              type: "action_required",
              reason: row.reason,
              projectId: row.projectId,
              taskId: row.taskId,
              runId: row.runId,
              detectedAt: row.detectedAt.toISOString(),
            },
          };
        },
        { behavior: "immediate" },
      );
    },
    finish(id: string, attempt: number, result: DeliveryResult, now = new Date()) {
      db.transaction(
        () => {
          assertExecutionOwner(db, ownerToken);
          const row = db.select().from(notifications).where(eq(notifications.id, id)).get();
          if (!row || row.status !== "pending" || row.attempts !== attempt) return;
          sync(row.sourceKey, now);
          const status =
            result === "delivered"
              ? "delivered"
              : attempt >= config.maxAttempts
                ? "exhausted"
                : "pending";
          db.update(notifications)
            .set({
              status,
              lastResult: result,
              nextAttemptAt: status === "pending" ? row.nextAttemptAt : null,
              updatedAt: now,
            })
            .where(and(eq(notifications.id, id), eq(notifications.status, "pending")))
            .run();
        },
        { behavior: "immediate" },
      );
    },
  };
}
