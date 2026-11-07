import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, lte, ne, or, sql } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import {
  changeApplications,
  developmentRepositories,
  developmentRounds,
  goals,
  planningCycles,
  projects,
  runs,
  tasks,
} from "../../db/schema.js";
import { readBudgetWait } from "../budgets/budget-store.js";
import { assertExecutionOwner } from "../execution/execution-owner.js";
import { redactOutput } from "../execution/analysis.js";
import type { PlanningContext } from "./goal-plan-policy.js";
import { revalidateGoalWork } from "./revalidate-goal-work.js";
import { readPlanningWork } from "./planning-work-state.js";
import { allowedGoalPath, privateInputPath } from "./prepared-workspace.js";

import { readServiceViews, type ObserverStatus } from "../services/drizzle-service-store.js";

type Db = ReturnType<typeof openDatabase>["db"];
type QueryDb = Pick<Db, "select">;

export function readPlanningContext(
  db: QueryDb,
  taskId: string,
  observer: ObserverStatus = {
    enabledKeys: new Set(),
    errors: new Set(),
    nextChecks: new Map(),
  },
  now = new Date(),
): PlanningContext | undefined {
  const cycle = db.select().from(planningCycles).where(eq(planningCycles.taskId, taskId)).get();
  if (!cycle || cycle.status !== "reserved") return undefined;
  const goal = db.select().from(goals).where(eq(goals.id, cycle.goalId)).get();
  if (!goal || goal.version !== cycle.goalVersion || goal.status !== "active") return undefined;
  const history = db
    .select()
    .from(tasks)
    .where(and(eq(tasks.goalId, goal.id), ne(tasks.id, taskId)))
    .orderBy(desc(tasks.createdAt), desc(tasks.id))
    .limit(20)
    .all();
  const work = readPlanningWork(db, goal.id);
  return {
    goalId: goal.id,
    goalVersion: goal.version,
    definition: goal.definition,
    capturedAt: now.toISOString(),
    historyCount: db
      .select({ total: count() })
      .from(tasks)
      .where(and(eq(tasks.goalId, goal.id), ne(tasks.id, taskId)))
      .get()!.total,
    services: readServiceViews(db, goal.projectId, observer, now, true).map((service) => {
      const clean = (value: typeof service.latest) =>
        value
          ? {
              ...value,
              snapshot: value.snapshot
                ? {
                    ...value.snapshot,
                    summary: redactOutput(value.snapshot.summary),
                  }
                : null,
            }
          : null;
      return {
        key: service.key,
        name: redactOutput(service.name),
        enabled: service.enabled,
        state: service.state,
        reason: service.reason,
        latest: clean(service.latest),
        lastSuccessful: clean(service.lastSuccessful),
      };
    }),
    suppressedWork: work.suppressed.slice(0, 20).map((item) => ({
      ...item,
      paths: item.paths.slice(0, 5),
      acceptanceCriteria: redactOutput(item.acceptanceCriteria).slice(0, 500),
    })),
    suppressedWorkCount: work.suppressed.length,
    history: history.map((task) => {
      const last = db
        .select()
        .from(runs)
        .where(eq(runs.taskId, task.id))
        .orderBy(desc(runs.attempt))
        .get();
      const application = db
        .select()
        .from(changeApplications)
        .where(eq(changeApplications.taskId, task.id))
        .get();
      const candidate = application
        ? db
            .select({ candidate: developmentRounds.candidate })
            .from(developmentRounds)
            .where(
              and(
                eq(developmentRounds.runId, application.runId),
                eq(developmentRounds.sequence, application.roundSequence),
                eq(developmentRounds.repositoryId, application.repositoryId),
              ),
            )
            .get()?.candidate
        : null;
      const changes =
        candidate?.digest === application?.candidateDigest &&
        candidate?.baseRevision === application?.baseRevision
          ? candidate?.changes
          : undefined;
      return {
        id: task.id,
        kind: task.kind,
        status: task.status,
        instruction: redactOutput(task.instruction.slice(0, 500)),
        problemKey: task.plannedWork?.problemKey ?? null,
        changeApplication: application
          ? {
              runId: application.runId,
              goalVersion: application.goalVersion,
              status: application.status,
              baseRevision: application.baseRevision,
              resultCommit: application.resultCommit,
              appliedAt: application.appliedAt?.toISOString() ?? null,
              changedFiles: (changes ?? [])
                .filter(
                  (change) =>
                    !privateInputPath(change.path) && allowedGoalPath(change.path, goal.definition),
                )
                .slice(0, 40)
                .map((change) => ({
                  path: change.path,
                  action:
                    change.after === null
                      ? ("deleted" as const)
                      : change.before === null
                        ? ("added" as const)
                        : ("modified" as const),
                })),
              changedFileCount: changes?.length ?? null,
            }
          : null,
        lastRun: last
          ? {
              status: last.status,
              result: last.result ? redactOutput(last.result).slice(0, 1000) : null,
              errorCode: last.errorCode,
              terminationConfirmed: !!last.terminationConfirmedAt,
            }
          : null,
      };
    }),
  };
}

export function createPlanningStore(db: Db, ownerToken?: string) {
  return {
    reserveNext(
      workspaceKeys: string[],
      now = new Date(),
    ): { taskId: string; goalId: string } | null {
      if (!workspaceKeys.length) return null;
      return db.transaction(
        (tx) => {
          assertExecutionOwner(tx, ownerToken);
          revalidateGoalWork(tx, undefined, now);
          const candidates = tx
            .select({ goal: goals })
            .from(goals)
            .innerJoin(projects, eq(projects.id, goals.projectId))
            .where(
              and(
                eq(goals.status, "active"),
                inArray(projects.workspaceKey, workspaceKeys),
                or(sql`${goals.nextCheckAt} IS NULL`, lte(goals.nextCheckAt, now)),
              ),
            )
            .orderBy(asc(goals.createdAt), asc(goals.id))
            .all()
            .map(({ goal }) => {
              const last = tx
                .select()
                .from(planningCycles)
                .where(eq(planningCycles.goalId, goal.id))
                .orderBy(desc(planningCycles.createdAt))
                .get();
              const age = Math.max(
                0,
                now.getTime() - (last?.createdAt ?? goal.createdAt).getTime(),
              );
              return {
                goal,
                score: goal.definition.priority + Math.floor(age / 60000),
              };
            })
            .sort((a, b) => b.score - a.score);
          for (const { goal } of candidates) {
            const pendingApplication = tx
              .select({ id: changeApplications.id })
              .from(changeApplications)
              .innerJoin(
                developmentRepositories,
                eq(developmentRepositories.id, changeApplications.repositoryId),
              )
              .where(
                and(
                  eq(developmentRepositories.projectId, goal.projectId),
                  eq(changeApplications.status, "pending"),
                ),
              )
              .get();
            if (pendingApplication) continue;
            const reservation = tx
              .select()
              .from(planningCycles)
              .where(and(eq(planningCycles.goalId, goal.id), eq(planningCycles.status, "reserved")))
              .get();
            if (reservation) {
              if (reservation.goalVersion === goal.version) continue;
              const previous = tx
                .select()
                .from(runs)
                .where(eq(runs.taskId, reservation.taskId))
                .orderBy(desc(runs.attempt))
                .get();
              if (previous && !previous.terminationConfirmedAt) continue;
              tx.update(tasks)
                .set({ status: "cancelled", budgetWait: null })
                .where(eq(tasks.id, reservation.taskId))
                .run();
              tx.update(planningCycles)
                .set({
                  status: "rejected",
                  reason: "goal_changed",
                  finishedAt: now,
                })
                .where(eq(planningCycles.taskId, reservation.taskId))
                .run();
            }
            const history = tx.select().from(tasks).where(eq(tasks.goalId, goal.id)).all();
            if (readPlanningWork(tx, goal.id).unresolved) continue;
            if (
              history.some(
                (task) =>
                  task.kind === "planning" &&
                  task.goalVersion === goal.version &&
                  task.status !== "succeeded" &&
                  task.status !== "cancelled",
              )
            )
              continue;
            if (readBudgetWait(tx, { projectId: goal.projectId, goalId: goal.id }, now)) continue;
            const taskId = randomUUID();
            tx.insert(tasks)
              .values({
                id: taskId,
                projectId: goal.projectId,
                kind: "planning",
                goalId: goal.id,
                goalVersion: goal.version,
                instruction: `목표의 다음 개발 작업을 계획합니다.\n${goal.definition.description}\n완료 기준: ${goal.definition.completionCriteria}`,
                requestKey: `plan:${taskId}`,
                createdAt: now,
              })
              .run();
            tx.insert(planningCycles)
              .values({
                taskId,
                goalId: goal.id,
                goalVersion: goal.version,
                status: "reserved",
                createdAt: now,
              })
              .run();
            return { taskId, goalId: goal.id };
          }
          return null;
        },
        { behavior: "immediate" },
      );
    },
    findByTask(taskId: string) {
      return db.select().from(planningCycles).where(eq(planningCycles.taskId, taskId)).get();
    },
  };
}
