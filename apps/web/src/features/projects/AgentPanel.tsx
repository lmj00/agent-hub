import { useCallback, useState } from "react";
import { projectAgentsSchema } from "@agent-hub/contracts";
import { api, errorMessage } from "../../shared/api.js";
import { usePolling } from "../../shared/use-polling.js";
import { Status } from "../../shared/format.js";

export function AgentPanel({
  projectId,
  onExpired,
  onOpenTask,
}: {
  projectId: string;
  onExpired: () => void;
  onOpenTask: (id: string) => void;
}) {
  const [offset, setOffset] = useState(0);
  const load = useCallback(
    (signal: AbortSignal) =>
      api.request(`/projects/${projectId}/agents?offset=${offset}`, projectAgentsSchema, {
        signal,
      }),
    [projectId, offset],
  );
  const poll = usePolling(`agents:${projectId}:${offset}`, load, onExpired, 5000);
  return (
    <section aria-label="프로젝트 에이전트">
      <div className="page-intro">
        <h2>에이전트</h2>
        <p>
          총괄이 목표에 필요한 전문 역할을 정하고 작업을 배정합니다. 지금은 한 번에 한 작업을
          실행하며, 별도 검토자가 결과를 확인합니다.
        </p>
      </div>
      {poll.error ? (
        <p role="alert" className="error-text">
          {errorMessage(poll.error)} 마지막 기록이 표시될 수 있습니다.
        </p>
      ) : null}
      {!poll.data && !poll.error ? <p role="status">에이전트를 불러오는 중…</p> : null}
      {poll.data?.agents.length === 0 ? (
        <p>
          아직 배정된 전문 역할이 없습니다. 다음 작업 계획부터 필요한 역할이 자동으로 만들어집니다.
          이전 작업은 소급 배정하지 않습니다.
        </p>
      ) : null}
      <ul className="agent-roster">
        {poll.data?.agents.map((agent) => (
          <li key={agent.id}>
            <div className="section-heading">
              <h3>{agent.name}</h3>
              <span>{agent.runningTasks ? "작업 중" : "실행 기록"}</span>
            </div>
            <p>{agent.mission}</p>
            <p className="subtle-note">
              배정 {agent.taskCount}건 · 완료 {agent.completedTasks}건
            </p>
            <button className="text-button" onClick={() => onOpenTask(agent.latestTask.id)}>
              {agent.latestTask.title}
            </button>{" "}
            <Status value={agent.latestTask.status} />
          </li>
        ))}
      </ul>
      {offset > 0 || (poll.data?.nextOffset !== null && poll.data?.nextOffset !== undefined) ? (
        <nav aria-label="에이전트 페이지">
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>
            이전
          </button>{" "}
          <button
            disabled={poll.data?.nextOffset == null || !!poll.error}
            onClick={() => setOffset(poll.data!.nextOffset!)}
          >
            다음
          </button>
        </nav>
      ) : null}
    </section>
  );
}
