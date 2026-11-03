import { readGoalExecutionBlock } from "../goals/goal-execution-store.js";
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { CapacityState } from "@agent-hub/contracts";
import type { openDatabase } from "../../db/connection.js";
import {
  events,
  projects,
  providerGates,
  recoveryRequests,
  runs,
  tasks,
} from "../../db/schema.js";
import { assertExecutionOwner } from "./execution-owner.js";
import { unresolvedRun } from "./drizzle-run-store.js";
import {
  providerScope,
  readProviderGate,
  reserveProviderCheck,
} from "./provider-gate.js";
import { ensureRetryState } from "./retry-state-store.js";
import { retryLimitReason, type RetryPolicy } from "./retry-policy.js";
import { capacityCheckAt, type CapacityPolicy } from "./capacity-policy.js";

export function createCapacityRecovery(options: {
  db: ReturnType<typeof openDatabase>["db"];
  ownerToken: string;
  policy: CapacityPolicy;
  retryPolicy: RetryPolicy;
  workspaceKeys: string[];
  now?: () => Date;
  random?: () => number;
}) {
  return {
    tick(): boolean {
      return options.db.transaction(
        (tx) => {
          assertExecutionOwner(tx, options.ownerToken);
          const gate = readProviderGate(tx);
          if (
            !gate?.blocked ||
            gate.reason !== "capacity" ||
            gate.probeTaskId ||
            gate.probeRunId
          )
            return false;
          if (tx.select({ id: runs.id }).from(runs).where(unresolvedRun).get())
            return false;
          const now = (options.now ?? (() => new Date()))();
          const source = gate.sourceRunId
            ? tx.select().from(runs).where(eq(runs.id, gate.sourceRunId)).get()
            : undefined;
          const task = source
            ? tx.select().from(tasks).where(eq(tasks.id, source.taskId)).get()
            : undefined;
          const project = task
            ? tx
                .select()
                .from(projects)
                .where(eq(projects.id, task.projectId))
                .get()
            : undefined;
          const latest = task
            ? tx
                .select()
                .from(runs)
                .where(eq(runs.taskId, task.id))
                .orderBy(desc(runs.attempt))
                .get()
            : undefined;
          const pending = task
            ? tx
                .select({ id: recoveryRequests.id })
                .from(recoveryRequests)
                .where(
                  and(
                    eq(recoveryRequests.taskId, task.id),
                    eq(recoveryRequests.status, "pending"),
                  ),
                )
                .get()
            : false;
          if (pending) return false;
          const retry = task
            ? ensureRetryState(tx, task.id, options.retryPolicy)
            : null;
          const unavailable =
            !task ||
            readGoalExecutionBlock(tx, task) !== null ||
            task.cancelRequestedAt ||
            ["succeeded", "cancelled"].includes(task.status) ||
            !project ||
            !options.workspaceKeys.includes(project.workspaceKey);
          const limit = retry && retryLimitReason(retry);
          let state: CapacityState = gate.capacityState ?? {
            policy: { ...options.policy },
            checks: 0,
            nextCheckAt: null,
            decisionVersion: 0,
            reason: "waiting",
          };
          const hold =
            state.checks >= state.policy.maxChecks
              ? "check_limit"
              : unavailable
                ? "task_unavailable"
                : limit
                  ? "task_limit"
                  : !latest?.terminationConfirmedAt
                    ? "termination_unconfirmed"
                    : null;
          const event = (kind: string) => {
            if (!latest) return;
            const sequence =
              (tx
                .select({ value: sql<number>`max(${events.sequence})` })
                .from(events)
                .where(eq(events.runId, latest.id))
                .get()?.value ?? 0) + 1;
            tx.insert(events)
              .values({
                id: randomUUID(),
                runId: latest.id,
                sequence,
                kind,
                createdAt: now,
              })
              .run();
          };
          if (hold) {
            if (
              state.decisionVersion === gate.version &&
              state.reason === hold &&
              (unavailable || retry?.reason === (limit ?? `capacity_${hold}`))
            )
              return false;
            state = {
              ...state,
              decisionVersion: gate.version,
              nextCheckAt: hold === "check_limit" ? null : state.nextCheckAt,
              reason: hold,
            };
            tx.update(providerGates)
              .set({ capacityState: state })
              .where(eq(providerGates.scope, providerScope))
              .run();
            if (task && retry && !unavailable)
              tx.update(tasks)
                .set({
                  status: "blocked",
                  retryState: {
                    ...retry,
                    decisionRunId: latest!.id,
                    nextAttemptAt: null,
                    reason: limit ?? `capacity_${hold}`,
                  },
                })
                .where(eq(tasks.id, task.id))
                .run();
            event(`capacity.held.${hold}`);
            return true;
          }
          if (
            !gate.capacityState ||
            state.decisionVersion !== gate.version ||
            state.reason !== "waiting"
          ) {
            state = {
              ...state,
              decisionVersion: gate.version,
              nextCheckAt: capacityCheckAt(
                state.policy,
                state.checks,
                now,
                gate.retryAt,
                (options.random ?? Math.random)(),
              ),
              reason: "waiting",
            };
            tx.update(providerGates)
              .set({ capacityState: state })
              .where(eq(providerGates.scope, providerScope))
              .run();
            tx.update(tasks)
              .set({
                status: "waiting_capacity",
                retryState: {
                  ...retry!,
                  decisionRunId: latest!.id,
                  nextAttemptAt: state.nextCheckAt,
                  reason: "capacity_waiting",
                },
              })
              .where(eq(tasks.id, task!.id))
              .run();
            event("capacity.check_scheduled");
            return true;
          }
          if (
            retry!.nextAttemptAt !== state.nextCheckAt ||
            retry!.reason !== "capacity_waiting"
          ) {
            tx.update(tasks)
              .set({
                status: "waiting_capacity",
                retryState: {
                  ...retry!,
                  decisionRunId: latest!.id,
                  nextAttemptAt: state.nextCheckAt,
                  reason: "capacity_waiting",
                },
              })
              .where(eq(tasks.id, task!.id))
              .run();
            event("capacity.check_scheduled");
            return true;
          }
          if (
            !state.nextCheckAt ||
            Date.parse(state.nextCheckAt) > now.getTime()
          )
            return false;
          reserveProviderCheck(tx, task!.id, gate.version, now);
          tx.update(providerGates)
            .set({ capacityState: { ...state, reason: "ready" } })
            .where(eq(providerGates.scope, providerScope))
            .run();
          tx.update(tasks)
            .set({
              status: "queued",
              retryState: { ...retry!, reason: "capacity_check_ready" },
            })
            .where(eq(tasks.id, task!.id))
            .run();
          event("capacity.check_reserved");
          return true;
        },
        { behavior: "immediate" },
      );
    },
  };
}
