import { useCallback } from "react";
import { goalProgressSchema } from "@agent-hub/contracts";
import { api, errorMessage } from "../../shared/api.js";
import { usePolling } from "../../shared/use-polling.js";
import { dateTime } from "../../shared/format.js";

const labels = {
  pending: "미착수",
  queued: "실행 대기",
  running: "작업 중",
  blocked: "확인 필요",
  applied: "작업 반영",
  verified: "검증 완료",
  recheck: "재확인 필요",
};

export function GoalProgress({
  goalId,
  version,
  onExpired,
  onOpenTask,
}: {
  goalId: string;
  version: number;
  onExpired: () => void;
  onOpenTask?: (id: string) => void;
}) {
  const load = useCallback(
    (signal: AbortSignal) =>
      api.request(`/goals/${goalId}/progress`, goalProgressSchema, { signal }),
    [goalId],
  );
  const poll = usePolling(`goal-progress:${goalId}:${version}`, load, onExpired, 5000);
  const progress = poll.data;
  return (
    <section className="goal-progress" aria-label="완료 조건별 진행">
      {poll.error ? (
        <p role="alert" className="error-text">
          {errorMessage(poll.error)} 현재 진행 상황을 확인할 수 없습니다.
        </p>
      ) : null}
      {!progress && !poll.error ? <p role="status">완료 조건을 확인하는 중…</p> : null}
      {progress ? (
        <>
          <p className="goal-progress-summary">
            {poll.error ? "마지막 확인 기록 · " : ""}
            <strong>
              {progress.criteria.length}개 중 {progress.verifiedCount}개 검증 완료
            </strong>
            <span>작업 완료와 조건 전체 검증은 구분합니다.</span>
          </p>
          <p className="subtle-note">{progress.nextAction}</p>
          <ol className="goal-progress-list">
            {progress.criteria.map((item) => (
              <li key={item.id} data-state={item.status}>
                <div className="goal-progress-heading">
                  <span className="goal-progress-marker" aria-hidden="true">
                    {item.status === "verified" ? "✓" : item.status === "running" ? "◉" : "○"}
                  </span>
                  <strong>{item.text}</strong>
                  <span className="goal-progress-status">{labels[item.status]}</span>
                </div>
                <p>{item.reason}</p>
                {item.taskId && onOpenTask ? (
                  <button className="text-button" onClick={() => onOpenTask(item.taskId!)}>
                    {item.agentName ? `${item.agentName} · ` : ""}연결된 작업 보기 →
                  </button>
                ) : null}
                {item.proof ? (
                  <details>
                    <summary>검증 근거 · {dateTime(item.proof.recordedAt)}</summary>
                    <ul>
                      {item.proof.evidence.map((text, index) => (
                        <li key={index}>{text}</li>
                      ))}
                    </ul>
                    <small>
                      검증 코드 <code>{item.proof.sourceRevision.slice(0, 12)}</code>
                    </small>
                  </details>
                ) : null}
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </section>
  );
}
