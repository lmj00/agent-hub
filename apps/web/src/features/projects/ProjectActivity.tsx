import { useCallback } from "react";
import { runDetailsSchema, runsSchema } from "@agent-hub/contracts";
import { api } from "../../shared/api.js";
import { usePolling } from "../../shared/use-polling.js";
import { RunActivity } from "../execution/RunRecord.js";

export function ProjectActivity({
  taskId,
  kind,
  stale,
  onExpired,
}: {
  taskId: string;
  kind: "planning" | "work";
  stale: boolean;
  onExpired: () => void;
}) {
  const load = useCallback(
    async (signal: AbortSignal) => {
      const { runs } = await api.request(`/tasks/${taskId}/runs`, runsSchema, { signal });
      return runs[0] ? api.request(`/runs/${runs[0].id}`, runDetailsSchema, { signal }) : null;
    },
    [taskId],
  );
  const poll = usePolling(`project-activity:${taskId}`, load, onExpired);
  const run = poll.data;
  const disconnected = stale || !!poll.error;
  const live =
    !!run && !disconnected && run.status === "running" && !run.finishedAt && !run.stopRequestedAt;
  return (
    <div className="project-activity" data-live={live}>
      <div className="project-activity-status" role="status">
        <svg className="project-activity-signal" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
          <path
            d="M12 3a9 9 0 0 1 9 9"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
        {disconnected
          ? "현재 활동 확인 필요"
          : live
            ? "실행 중"
            : run?.stopRequestedAt
              ? "종료 확인 중"
              : run
                ? "최근 실행 종료"
                : "실행 단계 확인 중"}
      </div>
      {run ? (
        <RunActivity
          run={run}
          live={live}
          checkedAt={poll.checkedAt}
          disconnected={disconnected}
          taskKind={kind}
        />
      ) : (
        <p className="project-activity-pending">
          {disconnected
            ? "다시 연결되면 실행 단계를 표시합니다."
            : "현재 실행의 단계와 최근 활동을 확인합니다."}
        </p>
      )}
    </div>
  );
}
