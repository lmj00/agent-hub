import { and, desc, eq, sql } from "drizzle-orm";
import type { GoalProgress, AnalysisAssessment } from "@agent-hub/contracts";
import type { openDatabase } from "../../db/connection.js";
import {
  changeApplications,
  developmentRepositories,
  goals,
  runs,
  tasks,
} from "../../db/schema.js";
import { goalCriteria, validCriterionChecks } from "./goal-criteria.js";
import { readAppliedCriterionEvidence } from "./change-application.js";
import { goalVerificationOutcome } from "./goal-verification.js";
import { GoalError } from "./goal-policy.js";

type Db = Pick<ReturnType<typeof openDatabase>["db"], "select">;

export function readGoalProgress(db: Db, goalId: string): GoalProgress {
  const goal = db.select().from(goals).where(eq(goals.id, goalId)).get();
  if (!goal) throw new GoalError("GOAL_NOT_FOUND");
  const criteria = goalCriteria(goal.id, goal.definition);
  const repository = db
    .select()
    .from(developmentRepositories)
    .where(eq(developmentRepositories.projectId, goal.projectId))
    .get();
  const head = repository?.prepared?.head ?? null;
  const pendingApplication =
    repository &&
    db
      .select({ id: changeApplications.id })
      .from(changeApplications)
      .where(
        and(
          eq(changeApplications.repositoryId, repository.id),
          eq(changeApplications.status, "pending"),
        ),
      )
      .get();
  const application = db
    .select({ application: changeApplications })
    .from(changeApplications)
    .innerJoin(tasks, eq(tasks.id, changeApplications.taskId))
    .where(and(eq(tasks.goalId, goalId), eq(changeApplications.status, "applied")))
    .orderBy(desc(changeApplications.appliedAt), desc(changeApplications.id))
    .get()?.application;
  let proof: {
    runId: string;
    revision: string;
    version: number;
    recordedAt: Date;
    assessment: AnalysisAssessment;
    wholeGoal: boolean;
  } | null = null;
  if (application) {
    const accepted = readAppliedCriterionEvidence(db, application);
    if (accepted && JSON.stringify(accepted.criteria) === JSON.stringify(criteria))
      proof = {
        runId: application.runId,
        revision: application.resultCommit,
        version: application.goalVersion,
        recordedAt: application.appliedAt!,
        assessment: accepted.assessment,
        wholeGoal: false,
      };
  }
  const reviewed = db
    .select({ run: runs })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(
      and(
        eq(tasks.goalId, goalId),
        eq(tasks.kind, "planning"),
        eq(runs.status, "succeeded"),
        sql`json_extract(${runs.planResult}, '$.status') = 'applied'`,
        sql`json_extract(${runs.planResult}, '$.verification.review') IS NOT NULL`,
      ),
    )
    .orderBy(desc(runs.finishedAt), desc(runs.id))
    .get()?.run;
  const verification = reviewed?.planResult?.verification;
  if (
    reviewed &&
    verification?.review &&
    verification.test &&
    reviewed.terminationConfirmedAt &&
    JSON.stringify(reviewed.planningInput?.definition) === JSON.stringify(goal.definition) &&
    (!proof || new Date(verification.review.recordedAt) >= proof.recordedAt)
  ) {
    const outcome = goalVerificationOutcome(db, reviewed);
    if (outcome && verification.test.result.status !== "passed") proof = null;
    else if (outcome)
      proof = {
        runId: reviewed.id,
        revision: verification.sourceRevision,
        version: reviewed.goalVersion!,
        recordedAt: new Date(verification.review.recordedAt),
        assessment: verification.review.assessment,
        wholeGoal: outcome === "passed",
      };
  }
  const checks = proof ? validCriterionChecks(criteria, proof.assessment) : null;
  const versionMatches =
    proof &&
    (proof.version === goal.version ||
      (goal.status === "completed" && proof.wholeGoal && proof.version === goal.version - 1));
  const fresh =
    !!proof && !!head && proof.revision === head && !!versionMatches && !pendingApplication;
  const items: GoalProgress["criteria"] = criteria.map((criterion) => {
    const task = db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.goalId, goalId),
          eq(tasks.kind, "work"),
          sql`EXISTS (SELECT 1 FROM json_each(json_extract(${tasks.plannedWork}, '$.criterionIds')) WHERE value = ${criterion.id})`,
        ),
      )
      .orderBy(desc(tasks.createdAt), desc(tasks.id))
      .get();
    const last = task
      ? db.select().from(runs).where(eq(runs.taskId, task.id)).orderBy(desc(runs.attempt)).get()
      : undefined;
    const check = checks?.find((item) => item.id === criterion.id);
    // Legacy whole-Goal approval evaluated all criteria; a legacy Task approval did not.
    const verified =
      check?.status === "verified" ||
      (proof?.wholeGoal && proof.assessment.criterionChecks === undefined);
    let status: GoalProgress["criteria"][number]["status"] = "pending";
    let reason = "아직 이 조건에 연결된 작업이 없습니다.";
    if (task) {
      status =
        task.status === "running"
          ? "running"
          : ["queued", "waiting_retry", "waiting_capacity"].includes(task.status)
            ? "queued"
            : task.status === "succeeded"
              ? "applied"
              : "blocked";
      reason =
        status === "applied"
          ? "작업은 반영됐지만 조건 전체의 검증은 아직 확인되지 않았습니다."
          : status === "running"
            ? "연결된 작업을 실행하고 있습니다."
            : status === "queued"
              ? "연결된 작업이 실행을 기다립니다."
              : `연결된 작업의 확인이 필요합니다.${last?.errorCode ? ` (${last.errorCode})` : ""}`;
    }
    if (verified) {
      status = fresh ? "verified" : "recheck";
      reason = fresh
        ? "현재 개발 코드에서 실제 테스트·독립 검토 근거를 확인했습니다."
        : "이전 검증 이후 목표 또는 코드가 달라졌거나 현재 코드를 확인할 수 없어 재확인이 필요합니다.";
    } else if (fresh && check) {
      reason = `${check.status === "unmet" ? "미충족" : "근거 부족"}: ${check.evidence.join(" · ")}`;
    }
    return {
      ...criterion,
      status,
      reason,
      taskId: task?.id ?? null,
      agentName: task?.plannedWork?.agent?.name ?? null,
      proof:
        proof && (check || verified)
          ? {
              runId: proof.runId,
              sourceRevision: proof.revision,
              recordedAt: proof.recordedAt.toISOString(),
              evidence: check?.evidence ?? proof.assessment.evidence,
            }
          : null,
    };
  });
  const latest = db
    .select()
    .from(tasks)
    .where(and(eq(tasks.goalId, goalId), eq(tasks.goalVersion, goal.version)))
    .orderBy(desc(tasks.createdAt), desc(tasks.id))
    .get();
  const latestRun = latest
    ? db.select().from(runs).where(eq(runs.taskId, latest.id)).orderBy(desc(runs.attempt)).get()
    : undefined;
  const nextAction =
    goal.status === "paused"
      ? "목표가 일시정지되어 있습니다. 재개하면 남은 조건을 확인합니다."
      : goal.status === "completed"
        ? "전체 목표 검증을 통과해 자동 작업을 종료했습니다."
        : latest &&
            ![
              "queued",
              "running",
              "succeeded",
              "cancelled",
              "waiting_retry",
              "waiting_capacity",
            ].includes(latest.status)
          ? `진행을 막는 실행을 확인해야 합니다.${latestRun?.errorCode ? ` (${latestRun.errorCode})` : ""}`
          : items.some((item) => item.status === "running")
            ? "연결된 작업을 검증한 뒤 남은 조건을 다시 판단합니다."
            : items.some((item) => item.status === "queued")
              ? "대기 중인 작업부터 실행합니다. 예산·실행 조건은 기존 정책을 따릅니다."
              : "다음 계획에서 남은 조건을 확인하고 필요한 전문 역할에 작업을 배정합니다.";
  return {
    goalId,
    goalVersion: goal.version,
    sourceRevision: head,
    nextAction,
    verifiedCount: items.filter((item) => item.status === "verified").length,
    criteria: items,
  };
}
