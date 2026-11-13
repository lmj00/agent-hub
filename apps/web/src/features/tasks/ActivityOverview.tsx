import type { Goal, ProviderGate, Queue, Task } from "@agent-hub/contracts";
import { taskTitle } from "../../shared/format.js";
import { PlanningSummary } from "./PlanningSummary.js";

export function ActivityOverview({
  tasks,
  running,
  queue,
  gate,
  goals,
  disconnected,
  onOpenGoals,
  onSelectTask,
  onFilter,
  onExpired,
}: {
  tasks: Task[] | null;
  running: Task | null;
  queue: Queue | null;
  gate: ProviderGate | null;
  goals: Goal[] | null;
  disconnected: boolean;
  onOpenGoals: () => void;
  onSelectTask: (id: string) => void;
  onFilter: (status: "succeeded" | "waiting" | "attention") => void;
  onExpired: () => void;
}) {
  const attention = tasks?.find((task) =>
    ["blocked", "failed", "interrupted"].includes(task.status),
  );
  let showAttention = false;
  let showPlanning = false;
  const latestPlan = tasks?.find((task) => task.kind === "planning");
  const currentPlan =
    latestPlan?.status === "succeeded" &&
    goals?.some(
      (goal) =>
        goal.id === latestPlan.goalId &&
        goal.version === latestPlan.goalVersion &&
        goal.status === "active",
    )
      ? latestPlan
      : null;
  let title = "실행 상태를 확인하고 있어요";
  let description = "서버에서 작업 기록을 가져옵니다.";
  if (disconnected) {
    title = "현재 상태를 확인할 수 없어요";
    description = "아래에는 마지막으로 확인한 기록이 남아 있습니다.";
  } else if (queue && tasks) {
    if (running) {
      title = running.kind === "planning" ? "다음 작업을 찾고 있어요" : "작업을 진행하고 있어요";
      description = taskTitle(running.instruction);
    } else if (goals?.length && goals.every((goal) => goal.status !== "active")) {
      title = goals.some((goal) => goal.status === "paused")
        ? "목표가 일시정지돼 있어요"
        : "등록한 목표가 모두 완료됐어요";
      description = goals.some((goal) => goal.status === "paused")
        ? "목표 메뉴에서 내용을 확인하고 재개할 수 있습니다."
        : "새 목표를 맡기거나 아래에서 완료된 작업을 확인하세요.";
    } else if (queue.state === "running") {
      title = "서버에서 작업이 실행 중이에요";
      description = "선택한 프로젝트에서는 아직 실행 중인 작업이 확인되지 않았습니다.";
    } else if (
      gate?.blocked ||
      ["held", "recovering", "error", "stopping", "stopped", "disabled"].includes(queue.state)
    ) {
      title = "실행 조건을 확인해야 해요";
      description = "서버 실행 상태의 대기 사유를 확인하세요. 저장된 작업과 결과는 유지됩니다.";
    } else if (attention) {
      title = "확인 후 이어갈 작업이 있어요";
      description = "보류된 작업의 원인을 확인하고 재개할 수 있습니다.";
      showAttention = true;
    } else {
      title = "지금은 실행 중인 작업이 없어요";
      showPlanning = !!currentPlan;
      description =
        goals === null
          ? "목표 상태는 아직 확인되지 않았습니다. 목표 메뉴에서 조회 상태를 확인하세요."
          : goals.length === 0
            ? "목표를 등록하면 에이전트가 할 일을 찾고 개발과 검증을 이어갑니다."
            : "목표의 실행 조건을 기다리고 있습니다. 최근 판단은 계획 기록에서 확인하세요.";
    }
  }
  const work = tasks?.filter((task) => task.kind === "work");
  return (
    <section
      className={`activity-overview ${disconnected ? "is-stale" : running ? "is-running" : showAttention ? "needs-attention" : ""}`}
      aria-label="프로젝트 작업 현황"
    >
      <div className="activity-message" role="status">
        <span className="activity-signal" aria-hidden="true" />
        <span className="activity-caption">
          {disconnected ? "연결 확인 필요" : running ? "현재 실행" : "현재 상황"}
        </span>
        <h2>{title}</h2>
        {(!running || disconnected) && !showPlanning ? <p>{description}</p> : null}
        {running && !disconnected ? (
          <div aria-label="이 프로젝트의 현재 작업" role="region">
            <p>{description}</p>
            <button className="primary" onClick={() => onSelectTask(running.id)}>
              진행 중인 작업 보기 ↗
            </button>
          </div>
        ) : showAttention && attention ? (
          <button className="secondary" onClick={() => onSelectTask(attention.id)}>
            보류 사유 확인
          </button>
        ) : showPlanning && currentPlan ? (
          <PlanningSummary
            task={currentPlan}
            onExpired={onExpired}
            onSelect={() => onSelectTask(currentPlan.id)}
          />
        ) : (
          <button className="secondary" onClick={onOpenGoals}>
            목표 확인
          </button>
        )}
      </div>
      <details className="activity-counts">
        <summary>작업 집계</summary>
        <dl
          className="activity-totals"
          aria-label={disconnected ? "마지막 실제 작업 집계" : "실제 작업 집계"}
        >
          <div>
            <dt>완료한 작업</dt>
            <dd>
              <button
                aria-label="완료한 작업 보기"
                disabled={!work}
                onClick={() => onFilter("succeeded")}
              >
                {work ? work.filter((task) => task.status === "succeeded").length : "—"}
              </button>
            </dd>
          </div>
          <div>
            <dt>실행 대기</dt>
            <dd>
              <button
                aria-label="실행 대기 작업 보기"
                disabled={!work}
                onClick={() => onFilter("waiting")}
              >
                {work
                  ? work.filter((task) =>
                      ["queued", "waiting_retry", "waiting_capacity"].includes(task.status),
                    ).length
                  : "—"}
              </button>
            </dd>
          </div>
          <div>
            <dt>확인 필요</dt>
            <dd>
              <button
                aria-label="확인이 필요한 작업 보기"
                disabled={!work}
                onClick={() => onFilter("attention")}
              >
                {work
                  ? work.filter((task) =>
                      ["blocked", "failed", "interrupted"].includes(task.status),
                    ).length
                  : "—"}
              </button>
            </dd>
          </div>
        </dl>
      </details>
    </section>
  );
}
