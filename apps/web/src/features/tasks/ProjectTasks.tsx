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
  const [chosenFilter, setFilter] = useState<"all" | "work" | "planning" | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [query, setQuery] = useState("");
  const showDetail = taskId !== null;
  const [focused, setFocused] = useState(false);
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
  const filter =
    chosenFilter ??
    (records.length && !records.some((task) => task.kind === "work") ? "planning" : "work");
  const visible = records.filter(
    (task) =>
      (filter === "all" || task.kind === filter) &&
      (statusFilter === "all" ||
        (statusFilter === "attention" &&
          ["blocked", "failed", "interrupted"].includes(task.status)) ||
        (statusFilter === "active" &&
          ["running", "queued", "waiting_retry", "waiting_capacity"].includes(task.status)) ||
        (statusFilter === "waiting" &&
          ["queued", "waiting_retry", "waiting_capacity"].includes(task.status)) ||
        (statusFilter === "succeeded" && task.status === "succeeded")) &&
      task.instruction.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const selected = records.find((task) => task.id === taskId) ?? null;
  useEffect(() => {
    if (selected && focusSelection.current === selected.id) {
      const heading = document.getElementById("detail-heading");
      heading?.focus({ preventScroll: true });
      heading?.scrollIntoView({ block: "nearest" });
      focusSelection.current = null;
    }
  });
  function selectTask(id: string) {
    if (!visible.some((task) => task.id === id)) {
      setFilter(records.find((task) => task.id === id)?.kind ?? "all");
      setStatusFilter("all");
      setQuery("");
    }
    focusSelection.current = id;
    setTaskId(id);
    // Clicking the already selected record should also return focus to its detail.
    if (id === selected?.id) {
      requestAnimationFrame(() => {
        document.getElementById("detail-heading")?.focus();
        focusSelection.current = null;
      });
    }
  }
  function backToList() {
    const selectedRow = document.querySelector<HTMLButtonElement>('.task-row[aria-pressed="true"]');
    setFocused(false);
    setTaskId(null);
    requestAnimationFrame(() => {
      (selectedRow?.isConnected ? selectedRow : searchInput.current)?.focus();
    });
  }
  const running =
    queue?.state === "running" && executionConnected && !tasks.error
      ? records.find((task) => task.id === queue.taskId && task.status === "running")
      : null;
  return (
    <div className={`project-work ${focused && showDetail ? "is-focused" : ""}`}>
      <ActivityOverview
        tasks={tasks.data?.tasks ?? null}
        running={running ?? null}
        queue={queue}
        gate={gate}
        goals={goals}
        disconnected={!executionConnected || !!tasks.error}
        onExpired={onExpired}
        onOpenGoals={onOpenGoals}
        onSelectTask={selectTask}
        onFilter={(status) => {
          setFilter("work");
          setStatusFilter(status);
          setQuery("");
          backToList();
        }}
      />
      <div className={`task-layout ${showDetail ? "showing-task" : ""}`}>
        <section className="task-column" aria-label="작업 목록과 등록">
          <div className="section-heading task-list-heading">
            <h2>작업 기록</h2>
            <span className="count">
              {tasks.data ? `${visible.length} / ${records.length}` : "—"}
            </span>
          </div>
          <div className="task-toolbar">
            <div className="task-filters" role="group" aria-label="작업 종류 필터">
              {(
                [
                  ["work", "실제 작업"],
                  ["planning", "계획"],
                  ["all", "전체"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="task-search-tools">
              <input
                ref={searchInput}
                className="task-search"
                type="search"
                aria-label="작업 기록 검색"
                placeholder="작업 내용으로 검색"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <select
                className="task-state-filter"
                aria-label="작업 상태 필터"
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
              >
                <option value="all">모든 상태</option>
                <option value="attention">확인 필요</option>
                <option value="active">진행·대기</option>
                <option value="waiting">실행 대기</option>
                <option value="succeeded">완료</option>
              </select>
            </div>
          </div>
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
                <p>{taskTitle(task.instruction)}</p>
                <div className="task-row-meta">
                  <Status
                    value={task.status}
                    label={
                      task.kind === "planning" && task.status === "succeeded"
                        ? "판단 완료"
                        : undefined
                    }
                  />
                  <time dateTime={task.createdAt}>{dateTime(task.createdAt)}</time>
                </div>
                {filter === "all" ? (
                  <small>{task.kind === "planning" ? "계획" : "실제 작업"}</small>
                ) : null}
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
                  setStatusFilter("all");
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
                focusSelection.current = task.id;
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
            onSelectTask={selectTask}
            onBack={backToList}
            focused={focused}
            onFocusChange={setFocused}
            executionConnected={executionConnected}
          />
        ) : (
          <section className="task-detail empty-detail">
            <button className="task-back quiet" onClick={backToList}>
              <span aria-hidden="true">←</span> 작업 목록
            </button>
            <span className="eyebrow">실행 기록</span>
            <h2>{taskId ? "선택한 작업을 확인하고 있습니다" : "작업의 흐름이 여기에 쌓입니다."}</h2>
            {tasks.error ? (
              <p className="notice error" role="alert">
                {errorMessage(tasks.error)} 작업 목록으로 돌아가 연결 상태를 확인하세요.
              </p>
            ) : (
              <p>목록에서 작업을 선택하면 실행 시도별 결과와 최근 활동을 확인할 수 있습니다.</p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
