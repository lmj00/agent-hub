import { useCallback } from "react";
import { runsSchema, runDetailsSchema, type Task } from "@agent-hub/contracts";
import { api } from "../../shared/api.js";
import { dateTime } from "../../shared/format.js";
import { usePolling } from "../../shared/use-polling.js";

// This is the latest recorded decision, not a prediction of the next execution.
export function PlanningSummary({
  task,
  onExpired,
  onSelect,
}: {
  task: Task;
  onExpired: () => void;
  onSelect: () => void;
}) {
  const load = useCallback(
    async (signal: AbortSignal) => {
      const { runs } = await api.request(`/tasks/${task.id}/runs`, runsSchema, { signal });
      return runs[0] ? api.request(`/runs/${runs[0].id}`, runDetailsSchema, { signal }) : null;
    },
    [task.id],
  );
  const record = usePolling(task.id, load, onExpired, 15000);
  const run = record.error ? null : record.data;
  const current = run?.status === "succeeded" && run.goalVersion === task.goalVersion;
  return (
    <div className="planning-summary">
      <p className="planning-summary-label">
        최근 판단{current ? ` · ${dateTime(run.finishedAt)}` : ""}
      </p>
      <p className="planning-summary-text">
        {record.error
          ? "최근 판단을 불러오지 못했습니다. 판단 기록에서 다시 확인하세요."
          : current && run.result
            ? run.result.split("\n")[0]
            : record.checkedAt
              ? "표시할 판단 요약이 없습니다. 전체 기록을 확인하세요."
              : "판단 내용을 불러오는 중…"}
      </p>
      <button className="secondary" onClick={onSelect}>
        판단 내용 보기
      </button>
    </div>
  );
}
