import { useCallback, useState } from "react";
import { projectOverviewSchema } from "@agent-hub/contracts";
import { api, errorMessage } from "../../shared/api.js";
import { dateTime, Status, taskTitle } from "../../shared/format.js";
import { usePolling } from "../../shared/use-polling.js";
import { ProjectActivity } from "./ProjectActivity.js";

export function ProjectOverview({
  onSelect,
  onExpired,
}: {
  onSelect: (projectId: string, taskId?: string) => void;
  onExpired: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const load = useCallback(
    (signal: AbortSignal) =>
      api.request(`/projects/overview?offset=${offset}`, projectOverviewSchema, { signal }),
    [offset],
  );
  const poll = usePolling(`projects-overview:${offset}`, load, onExpired, 3000, revision);
  return (
    <section className="project-overview" aria-label="프로젝트 전체 현황">
      <div className="section-heading">
        <h2>프로젝트별 진행 상황</h2>
        <small className="muted">마지막 확인 {dateTime(poll.checkedAt)}</small>
      </div>
      {poll.error ? (
        <div className="notice error" role="alert">
          {errorMessage(poll.error)}{" "}
          {poll.data ? "마지막으로 확인한 현황입니다." : "현황을 아직 불러오지 못했습니다."}
          <button className="text-button" onClick={() => setRevision((value) => value + 1)}>
            다시 불러오기
          </button>
        </div>
      ) : null}
      {!poll.data && !poll.error ? <p role="status">진행 상황을 불러오는 중…</p> : null}
      {poll.data?.projects.length === 0 ? (
        <div className="empty-state">
          <h3>{offset === 0 ? "첫 프로젝트를 등록하세요" : "이 페이지에 프로젝트가 없습니다"}</h3>
          <p>
            {offset === 0
              ? "프로젝트 등록에서 서버에 준비한 작업 공간을 연결한 뒤 목표를 맡길 수 있습니다."
              : "이전 페이지에서 프로젝트를 확인하세요."}
          </p>
        </div>
      ) : null}
      <div className="overview-projects">
        {poll.data?.projects
          .toSorted(
            (a, b) =>
              Number(!!b.runningTask && !b.terminationPending) -
              Number(!!a.runningTask && !a.terminationPending),
          )
          .map(
            ({
              project,
              activeGoals,
              nextCheckAt,
              terminationPending,
              runningTask,
              latestTask,
            }) => (
              <article
                className={`overview-project ${runningTask && !terminationPending ? "has-activity" : ""} ${poll.error ? "is-stale" : ""}`}
                key={project.id}
              >
                <div className="overview-project-main">
                  <div className="overview-project-heading">
                    <span className="overview-project-mark" aria-hidden="true">
                      {project.name.slice(0, 1).toUpperCase()}
                    </span>
                    <div>
                      <h3>{project.name}</h3>
                      <p className="overview-current">
                        <span
                          className="overview-state"
                          data-state={
                            poll.error || terminationPending
                              ? "unknown"
                              : runningTask
                                ? "active"
                                : "idle"
                          }
                        >
                          <span aria-hidden="true" />
                          {poll.error
                            ? "현재 상태 확인 필요"
                            : terminationPending
                              ? "이전 실행의 종료 확인 필요"
                              : runningTask
                                ? runningTask.kind === "planning"
                                  ? "다음 작업 계획 중"
                                  : "작업 실행 중"
                                : "실행 중인 작업 없음"}
                        </span>
                        <span>활성 목표 {activeGoals}개</span>
                      </p>
                    </div>
                    <button
                      className="secondary"
                      aria-label={`${project.name} 열기`}
                      onClick={() => onSelect(project.id)}
                    >
                      열기 ↗
                    </button>
                  </div>
                  {runningTask && !terminationPending ? (
                    <div className="overview-running">
                      <span>{poll.error ? "마지막으로 확인한 작업" : "현재 작업"}</span>
                      <button
                        className="text-button"
                        onClick={() => onSelect(project.id, runningTask.id)}
                      >
                        {taskTitle(runningTask.instruction)}
                        <span aria-hidden="true"> ↗</span>
                      </button>
                    </div>
                  ) : null}
                </div>
                {runningTask && !terminationPending ? (
                  <ProjectActivity
                    key={runningTask.id}
                    taskId={runningTask.id}
                    kind={runningTask.kind}
                    stale={!!poll.error}
                    onExpired={onExpired}
                  />
                ) : null}
                <details className="overview-history">
                  <summary>최근 작업과 예약</summary>
                  <dl className="overview-progress">
                    <div>
                      <dt>최근 등록 작업</dt>
                      <dd>
                        {latestTask ? (
                          <>
                            <Status
                              value={latestTask.status}
                              label={
                                latestTask.kind === "planning" && latestTask.status === "succeeded"
                                  ? "판단 완료"
                                  : undefined
                              }
                            />
                            <button
                              className="text-button"
                              onClick={() => onSelect(project.id, latestTask.id)}
                            >
                              {taskTitle(latestTask.instruction)}
                            </button>
                          </>
                        ) : (
                          "아직 작업이 없습니다"
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>다음 목표 점검</dt>
                      <dd>
                        {nextCheckAt
                          ? dateTime(nextCheckAt)
                          : activeGoals
                            ? "예약 시각 없음"
                            : "활성 목표 없음"}
                      </dd>
                    </div>
                  </dl>
                </details>
              </article>
            ),
          )}
      </div>
      {offset > 0 || poll.data?.nextOffset != null ? (
        <nav className="overview-pagination" aria-label="현황 페이지">
          <button
            className="secondary"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 24))}
          >
            이전
          </button>
          <span>{Math.floor(offset / 24) + 1} 페이지</span>
          <button
            className="secondary"
            disabled={poll.data?.nextOffset == null || !!poll.error}
            onClick={() => {
              if (poll.data?.nextOffset != null) setOffset(poll.data.nextOffset);
            }}
          >
            다음
          </button>
        </nav>
      ) : null}
    </section>
  );
}
