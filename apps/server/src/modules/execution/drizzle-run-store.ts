import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { events, runs, steps, tasks } from "../../db/schema.js";
import type { AnalysisEvent } from "./analysis.js";
import type { RunCompletion } from "./run-task.js";

export function createDrizzleRunStore(db: ReturnType<typeof openDatabase>["db"]) {
  const instanceId = randomUUID();
  return {
    claim(taskId: string, model: string) {
      return db.transaction((tx) => {
        const held = tx.select({ id: runs.id }).from(runs)
          .where(inArray(runs.status, ["running", "interrupted", "blocked", "waiting_capacity"])).get();
        if (held) throw new Error("A previous run needs completion or recovery before starting another run");
        const task = tx.select().from(tasks).where(eq(tasks.id, taskId)).get();
        if (!task) throw new Error("Task not found");
        if (task.status !== "queued") throw new Error("Only queued tasks can be started");
        const id = randomUUID();
        const now = new Date();
        tx.update(tasks).set({ status: "running" }).where(eq(tasks.id, taskId)).run();
        tx.insert(runs).values({ id, taskId, instanceId, status: "running", model, effort: "medium", startedAt: now, lastActivityAt: now }).run();
        tx.insert(steps).values({ id: randomUUID(), runId: id, sequence: 1, status: "running", startedAt: now }).run();
        tx.insert(events).values({ id: randomUUID(), runId: id, sequence: 1, kind: "run.started", createdAt: now }).run();
        return { id, taskId, instruction: task.instruction };
      }, { behavior: "immediate" });
    },
    record(runId: string, event: AnalysisEvent) {
      db.transaction((tx) => {
        const run = tx.select().from(runs).where(and(eq(runs.id, runId), eq(runs.instanceId, instanceId), eq(runs.status, "running"))).get();
        if (!run) throw new Error("Run is no longer active");
        const now = new Date();
        tx.update(runs).set({ lastActivityAt: now }).where(eq(runs.id, runId)).run();
        if (event.sessionId) tx.update(steps).set({ sessionId: event.sessionId }).where(eq(steps.runId, runId)).run();
        const last = tx.select({ sequence: sql<number>`max(${events.sequence})` }).from(events).where(eq(events.runId, runId)).get();
        const sequence = (last?.sequence ?? 0) + 1;
        if (sequence <= 1000) tx.insert(events).values({
          id: randomUUID(), runId, sequence, kind: event.kind.slice(0, 100), createdAt: now,
        }).run();
      }, { behavior: "immediate" });
    },
    finish(runId: string, completion: RunCompletion) {
      db.transaction((tx) => {
        const run = tx.select().from(runs).where(and(eq(runs.id, runId), eq(runs.instanceId, instanceId), eq(runs.status, "running"))).get();
        if (!run) throw new Error("Cannot finish a run not owned by this executor");
        const now = new Date();
        const finishedAt = completion.status === "interrupted" ? null : now;
        tx.update(tasks).set({ status: completion.status }).where(eq(tasks.id, run.taskId)).run();
        tx.update(runs).set({ status: completion.status, result: completion.result, errorCode: completion.errorCode, finishedAt, lastActivityAt: now })
          .where(eq(runs.id, runId)).run();
        tx.update(steps).set({ status: completion.status, usage: completion.usage, finishedAt }).where(eq(steps.runId, runId)).run();
        const last = tx.select({ sequence: sql<number>`max(${events.sequence})` }).from(events).where(eq(events.runId, runId)).get();
        tx.insert(events).values({ id: randomUUID(), runId, sequence: (last?.sequence ?? 0) + 1, kind: `run.${completion.status}`, createdAt: now }).run();
      }, { behavior: "immediate" });
    },
    listByTask(taskId: string) {
      return db.select({ id: runs.id, taskId: runs.taskId, status: runs.status, model: runs.model, effort: runs.effort, startedAt: runs.startedAt, finishedAt: runs.finishedAt })
        .from(runs).where(eq(runs.taskId, taskId)).orderBy(desc(runs.startedAt), asc(runs.id)).all();
    },
    findById(id: string) {
      const run = db.select().from(runs).where(eq(runs.id, id)).get();
      if (!run) return undefined;
      return {
        id: run.id, taskId: run.taskId, status: run.status, model: run.model, effort: run.effort,
        startedAt: run.startedAt, finishedAt: run.finishedAt, lastActivityAt: run.lastActivityAt,
        result: run.result, errorCode: run.errorCode,
        steps: db.select({ sequence: steps.sequence, status: steps.status, sessionId: steps.sessionId, usage: steps.usage, startedAt: steps.startedAt, finishedAt: steps.finishedAt })
          .from(steps).where(eq(steps.runId, id)).orderBy(asc(steps.sequence)).all(),
        events: db.select({ sequence: events.sequence, kind: events.kind, createdAt: events.createdAt })
          .from(events).where(eq(events.runId, id)).orderBy(asc(events.sequence)).all(),
      };
    },
  };
}
