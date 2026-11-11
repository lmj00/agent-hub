import { useCallback, useEffect, useRef, useState } from "react";
import {
  tasksSchema,
  type Goal,
  type Project,
  type Queue,
  type ProviderGate,
} from "@agent-hub/contracts";
import { api, errorMessage } from "../../shared/api.js";
import { usePolling } from "../../shared/use-polling.js";
import { dateTime, Status, taskTitle } from "../../shared/format.js";
import { TaskDetail } from "./TaskDetail.js";
import { TaskForm } from "./TaskForm.js";
import { ActivityOverview } from "./ActivityOverview.js";

export function ProjectTasks({
  project,
  taskId,
  setTaskId,
  queue,
  executionConnected,
  gate,
  onExpired,
  refreshOverview,
  goals,
  onOpenGoals,
}: {
  project: Project;
  taskId: string | null;
  setTaskId: (id: string | null) => void;
  queue: Queue | null;
  executionConnected: boolean;
  gate: ProviderGate | null;
  onExpired: () => void;
  refreshOverview: () => void;
  goals: Goal[] | null;
  onOpenGoals: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const [filter, setFilter] = useState<"all" | "work" | "planning">("all");
  const [query, setQuery] = useState("");
  const focusSelection = useRef<string | null>(null);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const refresh = useCallback(() => {
    setRevision((value) => value + 1);
    refreshOverview();
  }, [refreshOverview]);
  const load = useCallback(
    (signal: AbortSignal) => api.request(`/projects/${project.id}/tasks`, tasksSchema, { signal }),
    [project.id],
  );
  const tasks = usePolling(project.id, load, onExpired, 3000, revision);
  const records = tasks.data?.tasks ?? [];
  const visible = records.filter(
    (task) =>
      (filter === "all" || task.kind === filter) &&
      task.instruction.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const selected =
    records.find((task) => task.id === taskId) ?? (taskId === null ? records[0] : null) ?? null;
  // Keep the inspected record stable when polling inserts a newer planning task.
  useEffect(() => {
    if (taskId === null && selected) setTaskId(selected.id);
  }, [taskId, selected?.id, setTaskId]);
  useEffect(() => {
    if (selected && focusSelection.current === selected.id) {
      const heading = document.getElementById("detail-heading");
      heading?.focus({ preventScroll: true });
      heading?.scrollIntoView({ block: "nearest" });
      focusSelection.current = null;
    }
  });
  function selectTask(id: string) {
    focusSelection.current = id;
    setTaskId(id);
    // Clicking the already selected record should also return focus to its detail.
    if (id === selected?.id) {
      document.getElementById("detail-heading")?.focus();
      focusSelection.current = null;
    }
  }
  const running =
    queue?.state === "running" && executionConnected && !tasks.error
      ? records.find((task) => task.id === queue.taskId && task.status === "running")
      : null;
  return (
    <div className="project-work">
      <ActivityOverview
        tasks={tasks.data?.tasks ?? null}
        running={running ?? null}
        queue={queue}
        gate={gate}
        goals={goals}
        disconnected={!executionConnected || !!tasks.error}
        onOpenGoals={onOpenGoals}
        onSelectTask={selectTask}
      />
      <div className="task-layout">
        <section className="task-column" aria-label="작업 목록과 등록">
          <div className="section-heading task-list-heading">
            <h2>작업 기록</h2>
            <span className="count">
              {tasks.data ? `${visible.length} / ${records.length}` : "—"}
            </span>
          </div>
          <div className="task-filters" role="group" aria-label="작업 종류 필터">
            {(
              [
                ["all", "전체"],
                ["work", "실제 작업"],
                ["planning", "계획"],
              ] as const
            ).map(([value, label]) => (
              <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
                {label}
              </button>
            ))}
          </div>
          <input
            ref={searchInput}
            className="task-search"
            type="search"
            aria-label="작업 기록 검색"
            placeholder="작업 내용으로 검색"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {selected && !visible.some((task) => task.id === selected.id) ? (
            <p className="filter-note">
              선택한 작업은 현재 필터 밖에 있습니다. 상세 내용은 유지됩니다.
            </p>
          ) : null}
          {tasks.error ? (
            <p className="notice error" role="alert">
              {errorMessage(tasks.error)}
              <small>마지막 확인 {dateTime(tasks.checkedAt)}</small>
            </p>
          ) : null}
          <div className="task-list">
            {visible.map((task) => (
              <button
                className={`task-row ${selected?.id === task.id ? "selected" : ""}`}
                aria-pressed={selected?.id === task.id}
                key={task.id}
                onClick={() => selectTask(task.id)}
              >
                <div className="task-row-meta">
                  <span key={task.status} className="task-status-update">
                    <Status
                      value={task.status}
                      label={
                        task.kind === "planning" && task.status === "succeeded"
                          ? "판단 완료"
                          : undefined
                      }
                    />
                  </span>
                  <time dateTime={task.createdAt}>{dateTime(task.createdAt)}</time>
                </div>
                <p>{taskTitle(task.instruction)}</p>
                <small>
                  {task.kind === "planning" ? "계획" : "실제 작업"}{" "}
                  <span aria-hidden="true">↗</span>
                </small>
              </button>
            ))}
          </div>
          {records.length > 0 && visible.length === 0 ? (
            <p className="empty-list">
              조건에 맞는 작업이 없습니다.{" "}
              <button
                className="text-button"
                onClick={() => {
                  setFilter("all");
                  setQuery("");
                  searchInput.current?.focus();
                }}
              >
                필터 초기화
              </button>
            </p>
          ) : null}
          {tasks.data && !tasks.data.tasks.length ? (
            <div className="empty-list">
              <p>아직 등록한 작업이 없습니다.</p>
              <small>목표를 등록하거나 아래에서 분석을 요청하세요.</small>
            </div>
          ) : null}
          <details className="analysis-composer">
            <summary>새 분석 요청</summary>
            <TaskForm
              project={project}
              onCreated={(task) => {
                setTaskId(task.id);
                refresh();
              }}
              onExpired={onExpired}
            />
          </details>
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
    </div>
  );
}
