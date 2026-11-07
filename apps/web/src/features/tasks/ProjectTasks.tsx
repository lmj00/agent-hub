import { useCallback, useState } from "react";
import { tasksSchema, type Project, type Queue, type ProviderGate } from "@agent-hub/contracts";
import { api, errorMessage } from "../../shared/api.js";
import { usePolling } from "../../shared/use-polling.js";
import { dateTime, Status } from "../../shared/format.js";
import { TaskDetail } from "./TaskDetail.js";
import { TaskForm } from "./TaskForm.js";

export function ProjectTasks({
  project,
  taskId,
  setTaskId,
  queue,
  gate,
  onExpired,
  refreshOverview,
}: {
  project: Project;
  taskId: string | null;
  setTaskId: (id: string | null) => void;
  queue: Queue | null;
  gate: ProviderGate | null;
  onExpired: () => void;
  refreshOverview: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => {
    setRevision((value) => value + 1);
    refreshOverview();
  }, [refreshOverview]);
  const load = useCallback(
    (signal: AbortSignal) => api.request(`/projects/${project.id}/tasks`, tasksSchema, { signal }),
    [project.id],
  );
  const tasks = usePolling(project.id, load, onExpired, 3000, revision);
  const selected =
    tasks.data?.tasks.find((task) => task.id === taskId) ??
    (taskId === null ? tasks.data?.tasks[0] : null) ??
    null;
  return (
    <div className="task-layout">
      <section className="task-column" aria-label="작업 목록과 등록">
        <TaskForm
          project={project}
          onCreated={(task) => {
            setTaskId(task.id);
            refresh();
          }}
          onExpired={onExpired}
        />
        <div className="section-heading task-list-heading">
          <h2>작업 기록</h2>
          <span className="count">{tasks.data?.tasks.length ?? "—"}</span>
        </div>
        {tasks.error ? (
          <p className="notice error" role="alert">
            {errorMessage(tasks.error)}
            <small>마지막 확인 {dateTime(tasks.checkedAt)}</small>
          </p>
        ) : null}
        <div className="task-list">
          {tasks.data?.tasks.map((task) => (
            <button
              className={`task-row ${selected?.id === task.id ? "selected" : ""}`}
              aria-pressed={selected?.id === task.id}
              key={task.id}
              onClick={() => setTaskId(task.id)}
            >
              <div className="task-row-meta">
                <Status value={task.status} />
                <time dateTime={task.createdAt}>{dateTime(task.createdAt)}</time>
              </div>
              <p>{task.instruction}</p>
              <small>
                작업 {task.id.slice(0, 8)} <span aria-hidden="true">↗</span>
              </small>
            </button>
          ))}
        </div>
        {tasks.data && !tasks.data.tasks.length ? (
          <div className="empty-list">
            <p>아직 등록한 작업이 없습니다.</p>
            <small>위 입력란에서 첫 분석을 요청하세요.</small>
          </div>
        ) : null}
      </section>
      {selected ? (
        <TaskDetail
          key={selected.id}
          task={selected}
          queue={queue}
          gate={gate}
          onExpired={onExpired}
          onChanged={refresh}
          onSelectTask={setTaskId}
        />
      ) : (
        <section className="task-detail empty-detail">
          <span className="eyebrow">실행 기록</span>
          <h2>작업의 흐름이 여기에 쌓입니다.</h2>
          <p>목록에서 작업을 선택하면 실행 시도별 결과와 최근 활동을 확인할 수 있습니다.</p>
        </section>
      )}
    </div>
  );
}
