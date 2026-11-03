import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { goals, planningCycles, runs, tasks } from "../../db/schema.js";
import type { RunCompletion } from "../execution/run-task.js";
import {
  parseGoalPlan,
  problemKey,
  type PlannedWork,
  type PlanResult,
} from "./goal-plan-policy.js";
import { preparedGoalChanged } from "./prepared-input-store.js";
import {
  overlappingWorkPaths,
  readPlanningWork,
} from "./planning-work-state.js";

type Db = Pick<
  ReturnType<typeof openDatabase>["db"],
  "select" | "insert" | "update"
>;

// Called inside the same transaction as Run/Task completion and budget settlement.
export function applyPlanningCompletion(
  db: Db,
  run: typeof runs.$inferSelect,
  completion: RunCompletion,
  now: Date,
): RunCompletion {
  const cycle = db
    .select()
    .from(planningCycles)
    .where(eq(planningCycles.taskId, run.taskId))
    .get();
  if (!cycle) return completion;
  if (cycle.status === "applied")
    return {
      ...completion,
      status: "succeeded",
      result: run.result,
      errorCode: null,
    };
  if (cycle.status !== "reserved")
    return {
      ...completion,
      status: "blocked",
      result: null,
      errorCode: cycle.reason ?? "invalid_plan",
    };
  if (completion.status === "interrupted" || !completion.terminationConfirmedAt)
    return completion.status === "succeeded"
      ? {
          ...completion,
          status: "interrupted",
          errorCode: "termination_unconfirmed",
        }
      : completion;
  const reject = (
    reason: string,
    suppressed?: PlanResult["suppressed"],
  ): RunCompletion => {
    if (run.planResult)
      db.update(runs)
        .set({
          planResult: {
            ...run.planResult,
            status: "rejected",
            reason,
            ...(suppressed ? { suppressed } : {}),
          },
        })
        .where(eq(runs.id, run.id))
        .run();
    db.update(planningCycles)
      .set({ resultRunId: run.id, reason, finishedAt: now })
      .where(eq(planningCycles.taskId, run.taskId))
      .run();
    return {
      ...completion,
      status: completion.status === "succeeded" ? "blocked" : completion.status,
      result: null,
      errorCode: reason,
    };
  };
  if (completion.status !== "succeeded")
    return run.planResult
      ? reject(completion.errorCode ?? "invalid_plan")
      : completion;
  if (
    !run.preparedInput ||
    run.preparedInput.phase !== "ready" ||
    !run.planResult ||
    run.planResult.status !== "proposed" ||
    run.planResult.proposal !== completion.result
  )
    return reject("input_unavailable");
  if (
    cycle.goalId !== run.preparedInput.scope.goalId ||
    cycle.goalVersion !== run.goalVersion
  )
    return reject("goal_changed");
  if (preparedGoalChanged(db, run)) return reject("goal_changed");
  const goal = db.select().from(goals).where(eq(goals.id, cycle.goalId)).get()!;
  let plan;
  try {
    plan = parseGoalPlan(run.planResult.proposal, run.preparedInput);
  } catch {
    return reject("invalid_plan");
  }
  // Completion requires independent code/test evidence, supplied by the development stage.
  if (plan.outcome === "complete") return reject("verification_required");
  const work = readPlanningWork(db, goal.id);
  const previous = work.previous;
  if (work.unresolved) return reject("work_unresolved");
  const createdTaskIds: string[] = [];
  const suppressed: NonNullable<PlanResult["suppressed"]> = [];
  for (const [proposalIndex, proposed] of plan.tasks.entries()) {
    const blocking = work.suppressed.filter((item) =>
      overlappingWorkPaths(item.paths, proposed.paths),
    );
    if (blocking.length) {
      suppressed.push({
        proposalIndex,
        title: proposed.title,
        blockedByTaskIds: blocking.slice(0, 20).map((item) => item.taskId),
        totalBlockingTasks: blocking.length,
      });
      continue;
    }
    const key = problemKey(goal.id, proposed.paths);
    if (
      previous.some(
        (task) =>
          task.goalVersion === goal.version &&
          task.plannedWork?.problemKey === key &&
          task.plannedWork.sourceRevision === run.preparedInput!.revision,
      )
    )
      continue;
    const id = randomUUID();
    const plannedWork: PlannedWork = {
      planningTaskId: run.taskId,
      problemKey: key,
      sourceRevision: run.preparedInput.revision!,
      sourceDigest: run.preparedInput.digest!,
      title: proposed.title,
      paths: [...proposed.paths].sort(),
      acceptanceCriteria: proposed.acceptanceCriteria,
      evidence: proposed.evidence,
    };
    db.insert(tasks)
      .values({
        id,
        projectId: goal.projectId,
        kind: "work",
        goalId: goal.id,
        goalVersion: goal.version,
        instruction: `${proposed.title}\n${proposed.instruction}\n검증 기준: ${proposed.acceptanceCriteria}`,
        plannedWork,
        requestKey: `planned:${run.taskId}:${key}`,
        createdAt: now,
      })
      .run();
    createdTaskIds.push(id);
  }
  const duplicate = plan.outcome === "work" && createdTaskIds.length === 0;
  if (duplicate) {
    const recent = db
      .select()
      .from(planningCycles)
      .where(
        and(
          eq(planningCycles.goalId, goal.id),
          eq(planningCycles.goalVersion, goal.version),
          eq(planningCycles.status, "applied"),
        ),
      )
      .orderBy(desc(planningCycles.createdAt))
      .limit(2)
      .all();
    if (
      recent.length === 2 &&
      recent.every(
        (item) =>
          item.reason === "duplicate_work" || item.reason === "suppressed_work",
      )
    )
      return reject("planning_no_progress", suppressed);
  }
  const reason = duplicate
    ? suppressed.length
      ? "suppressed_work"
      : "duplicate_work"
    : suppressed.length
      ? "work_with_suppression"
      : plan.outcome;
  db.update(planningCycles)
    .set({ status: "applied", resultRunId: run.id, reason, finishedAt: now })
    .where(eq(planningCycles.taskId, run.taskId))
    .run();
  db.update(runs)
    .set({
      planResult: {
        ...run.planResult,
        status: "applied",
        createdTaskIds,
        suppressed,
        reason,
      },
    })
    .where(eq(runs.id, run.id))
    .run();
  db.update(goals)
    .set({
      nextCheckAt: createdTaskIds.length
        ? null
        : new Date(now.getTime() + goal.definition.checkIntervalMs),
    })
    .where(eq(goals.id, goal.id))
    .run();
  return {
    ...completion,
    result: [
      plan.summary,
      ...plan.tasks.map(
        (item, index) =>
          `- ${suppressed.some((held) => held.proposalIndex === index) ? "[기존 문제로 생성 제외] " : ""}${item.title}: ${item.acceptanceCriteria}`,
      ),
      createdTaskIds.length
        ? `생성한 작업: ${createdTaskIds.length}개`
        : "새 작업 없이 다음 점검 시각까지 기다립니다.",
    ].join("\n"),
  };
}
