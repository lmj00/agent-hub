import { useCallback, useRef, useState, type FormEvent } from "react";
import {
  projectSchema,
  projectsSchema,
  tasksSchema,
  taskSchema,
  queueSchema,
  providerGateSchema,
  type Project,
  type Queue,
  type ProviderGate,
  type Task,
} from "@agent-hub/contracts";
import { api, ApiError, errorMessage } from "./api.js";
import { usePolling } from "./use-polling.js";
import { dateTime, Status } from "./format.js";
import { TaskDetail } from "./TaskDetail.js";
import { ServicePanel } from "./ServicePanel.js";
import { GoalPanel } from "./GoalPanel.js";
import { BudgetPanel } from "./BudgetPanel.js";

const queueLabels: Record<Queue["state"], string> = {
  disabled: "자동 실행 꺼짐",
  idle: "다음 작업 대기",
  running: "작업 실행 중",
  recovering: "실행 상태 확인 중",
  held: "새 실행 보류",
  error: "실행기 확인 필요",
  stopping: "실행기 종료 중",
  stopped: "실행기 종료됨",
};
const gateLabels: Record<NonNullable<ProviderGate["reason"]>, string> = {
  capacity: "계정 사용량 제한",
  authentication: "AI 계정 인증 확인 필요",
  configuration: "AI 실행 설정 확인 필요",
};

export function Workspace({
  onExpired,
  onLogout,
}: {
  onExpired: () => void;
  onLogout: () => void;
}) {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const [logoutError, setLogoutError] = useState<unknown>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const load = useCallback(async (signal: AbortSignal) => {
    const [projects, queue, gate] = await Promise.all([
      api.request("/projects", projectsSchema, { signal }),
      api.request("/execution", queueSchema, { signal }),
      api.request("/execution/provider-gate", providerGateSchema, { signal }),
    ]);
    return { projects: projects.projects, queue, gate };
  }, []);
  const overview = usePolling("overview", load, onExpired, 3000, revision);
  const projects = overview.data?.projects ?? [];
  const project =
    projects.find((value) => value.id === projectId) ?? projects[0] ?? null;
  function selectProject(id: string) {
    setProjectId(id);
    setTaskId(null);
  }
  async function logout() {
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await api.logout();
      onLogout();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onExpired();
      else setLogoutError(error);
    } finally {
      setLoggingOut(false);
    }
  }
  return (
    <div className="workspace">
      <header className="topbar">
        <a className="brand" href="/" aria-label="agent-hub 처음 화면">
          <span className="brand-mark" aria-hidden="true">
            a
          </span>
          agent-hub
        </a>
        <span className="topbar-label">프로젝트 작업 공간</span>
        <button
          className="quiet"
          onClick={() => void logout()}
          disabled={loggingOut}
        >
          로그아웃
        </button>
      </header>
      {logoutError ? (
        <p className="notice error" role="alert">
          {errorMessage(logoutError)}
        </p>
      ) : null}
      <div className="workspace-grid">
        <aside className="sidebar" aria-label="프로젝트 목록">
          <div className="section-heading">
            <h2>프로젝트</h2>
            <span className="count">{projects.length}</span>
          </div>
          <nav className="project-list">
            {projects.map((item) => (
              <button
                key={item.id}
                className={`project-link ${project?.id === item.id ? "selected" : ""}`}
                aria-pressed={project?.id === item.id}
                onClick={() => selectProject(item.id)}
              >
                <span className="project-initial" aria-hidden="true">
                  {item.name.slice(0, 1)}
                </span>
                <span>
                  <strong>{item.name}</strong>
                  <small>{item.workspaceKey}</small>
                </span>
              </button>
            ))}
          </nav>
          {!overview.data && !overview.error ? (
            <p className="muted">프로젝트를 불러오는 중…</p>
          ) : null}
          {overview.data && !projects.length ? (
            <p className="muted">첫 프로젝트를 등록해 분석을 시작하세요.</p>
          ) : null}
          <ProjectForm
            onCreated={(item) => {
              selectProject(item.id);
              refresh();
            }}
            onExpired={onExpired}
          />
          {project ? (
            <details className="project-connection-info">
              <summary>프로젝트 연결 정보</summary>
              <p>서비스 관측 설정에 사용하는 프로젝트 ID입니다.</p>
              <code>{project.id}</code>
            </details>
          ) : null}
          <div className="sidebar-note">
            <span className="eyebrow">현재 지원 범위</span>
            <p>분석과 개발 작업</p>
            <small>
              분석 결과를 기록하고, 설정이 준비된 개발 작업은 수정·검증 후
              개발용 브랜치에 반영합니다. 목표의 자동 계획 시작은 준비 중입니다.
            </small>
          </div>
        </aside>
        <main className="main-workspace">
          <section className="workspace-heading">
            <div>
              <p className="eyebrow">현재 프로젝트</p>
              <h1>{project?.name ?? "프로젝트를 연결하세요"}</h1>
            </div>
            <div className="connection" role="status">
              <span
                className={`connection-dot ${overview.error ? "offline" : overview.checkedAt ? "online" : ""}`}
              />
              {overview.error
                ? "서버 연결 확인 필요"
                : overview.checkedAt
                  ? "서버 연결됨"
                  : "연결 확인 중"}
              <small>마지막 확인 {dateTime(overview.checkedAt)}</small>
            </div>
          </section>
          {overview.error ? (
            <div className="notice error" role="alert">
              {errorMessage(overview.error)}{" "}
              <button className="text-button" onClick={refresh}>
                다시 확인
              </button>
            </div>
          ) : null}
          {overview.data ? (
            <ExecutionBar
              queue={overview.data.queue}
              gate={overview.data.gate}
            />
          ) : null}
          {project ? (
            <ServicePanel
              key={`services:${project.id}`}
              projectId={project.id}
              onExpired={onExpired}
            />
          ) : null}
          {project ? (
            <>
            <GoalPanel key={`goals:${project.id}`} projectId={project.id} onExpired={onExpired} />
            <BudgetPanel key={`budget:${project.id}`} projectId={project.id} onExpired={onExpired} />
            </>
          ) : null}
          {project ? (
            <ProjectTasks
              key={`tasks:${project.id}`}
              project={project}
              taskId={taskId}
              setTaskId={setTaskId}
              queue={overview.data?.queue ?? null}
              gate={overview.data?.gate ?? null}
              onExpired={onExpired}
              refreshOverview={refresh}
            />
          ) : (
            <div className="empty-state">
              <span className="empty-symbol" aria-hidden="true">
                ↗
              </span>
              <h2>분석할 프로젝트부터</h2>
              <p>
                프로젝트 이름과 서버에 등록한 작업 공간 키를 입력하세요.
                <br />
                등록한 프로젝트별로 지시와 실행 기록을 모아 볼 수 있습니다.
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

const capacityReasons: Record<string, string> = {
  waiting: "확인 시각까지 기다립니다.",
  ready: "확인 실행 하나를 예약했습니다.",
  checking: "확인 실행이 진행 중입니다.",
  check_limit: "계정 확인 횟수 상한에 도달했습니다. 제한 정책을 검토해 주세요.",
  task_limit:
    "원인 작업의 실행 상한에 도달했습니다. 작업 기록을 검토해 주세요.",
  task_unavailable:
    "원인 작업을 자동으로 재개할 수 없습니다. 실행 가능한 작업을 선택해 수동으로 확인해 주세요.",
  termination_unconfirmed: "이전 실행의 종료를 먼저 확인해야 합니다.",
};
function ExecutionBar({ queue, gate }: { queue: Queue; gate: ProviderGate }) {
  return (
    <section
      className={`execution-bar ${gate.blocked || queue.state === "held" || queue.state === "error" ? "attention" : ""}`}
      aria-label="자동 실행 상태"
    >
      <div>
        <span className="eyebrow">실행기</span>
        <strong>{queue.reason === "period_budget" ? "기간 예산 대기" : queue.reason === "development_pending" ? "개발 실행 연결 대기" : queueLabels[queue.state]}</strong>
      </div>
      <p>
        {gate.blocked
          ? `${gateLabels[gate.reason!] ?? "AI 계정 확인 필요"} · 제공자 재시도 시각 ${gate.retryAt ? dateTime(gate.retryAt) : "미제공"}`
          : queue.state === "disabled"
            ? "서버에 실행 설정을 연결하면 대기 작업을 순서대로 처리합니다."
            : queue.reason === "period_budget"
              ? "실행 예산이 있는 작업을 기다립니다. 각 작업에서 대기 이유와 다음 확인 시각을 볼 수 있습니다."
            : queue.reason === "development_pending"
              ? "개발 작업을 시작하려면 해당 작업 공간의 컨테이너 실행과 테스트 설정이 필요합니다."
            : queue.reason === "change_application_pending"
              ? "이전 코드 반영 결과를 확인해야 합니다. 해당 작업에서 상태 확인을 요청해 주세요."
            : queue.state === "held"
              ? "종료가 확인되지 않은 실행을 먼저 확인해 주세요."
              : queue.state === "error"
                ? "실행기 상태 조회에 실패했습니다. 서버 기록을 확인해 주세요."
                : "한 번에 하나의 작업을 처리합니다. 실행 기록에서 진행 상황을 확인하세요."}
      </p>
      {gate.blocked && gate.reason === "capacity" && gate.capacityState ? (
        <div className="capacity-summary" aria-label="계정 사용량 확인">
          <strong>
            계정 확인 {gate.capacityState.checks} /{" "}
            {gate.capacityState.policy.maxChecks}회
          </strong>
          {gate.capacityState.nextCheckAt ? (
            <span>
              다음 확인 가능 시각 {dateTime(gate.capacityState.nextCheckAt)}
            </span>
          ) : null}
          <span>
            {capacityReasons[gate.capacityState.reason] ??
              "계정 확인 조건을 검토하고 있습니다."}
          </span>
          {!queue.capacityRecoveryEnabled ? (
            <span>
              현재 자동 한도 확인은 꺼져 있으며 저장된 제한은 유지됩니다.
            </span>
          ) : null}
        </div>
      ) : null}
      {queue.lastCheckedAt ? (
        <small>실행기 확인 {dateTime(queue.lastCheckedAt)}</small>
      ) : null}
    </section>
  );
}

function ProjectForm({
  onCreated,
  onExpired,
}: {
  onCreated: (project: Project) => void;
  onExpired: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [workspaceKey, setWorkspaceKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const project = await api.request("/projects", projectSchema, {
        method: "POST",
        body: { name: name.trim(), workspaceKey: workspaceKey.trim() },
      });
      onCreated(project);
      setName("");
      setWorkspaceKey("");
      setOpen(false);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onExpired();
      else setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="project-form">
      <button
        className="add-project"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? "등록 닫기 −" : "프로젝트 등록 +"}
      </button>
      {open ? (
        <form
          className="stack compact"
          onSubmit={(event) => void submit(event)}
        >
          <label htmlFor="project-name">프로젝트 이름</label>
          <input
            id="project-name"
            required
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="예: 언어 공부 앱"
          />
          <label htmlFor="workspace-key">작업 공간 키</label>
          <input
            id="workspace-key"
            required
            maxLength={100}
            pattern="[A-Za-z0-9][A-Za-z0-9._\-]*"
            value={workspaceKey}
            onChange={(event) => setWorkspaceKey(event.target.value)}
            placeholder="예: language-app"
            aria-describedby="workspace-help"
          />
          <small id="workspace-help">
            서버 실행 설정에 등록한 키를 입력하세요.
          </small>
          {error ? (
            <p className="error-text" role="alert">
              {errorMessage(error)} 응답이 끊겼다면 중복 등록 전에 프로젝트
              목록을 확인해 주세요.
            </p>
          ) : null}
          <button
            className="primary"
            disabled={busy || !name.trim() || !workspaceKey.trim()}
          >
            {busy ? "등록 중…" : "프로젝트 등록"}
          </button>
        </form>
      ) : null}
    </div>
  );
}

function ProjectTasks({
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
    (signal: AbortSignal) =>
      api.request(`/projects/${project.id}/tasks`, tasksSchema, { signal }),
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
                <time dateTime={task.createdAt}>
                  {dateTime(task.createdAt)}
                </time>
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
          <p>
            목록에서 작업을 선택하면 실행 시도별 결과와 최근 활동을 확인할 수
            있습니다.
          </p>
        </section>
      )}
    </div>
  );
}

function TaskForm({
  project,
  onCreated,
  onExpired,
}: {
  project: Project;
  onCreated: (task: Task) => void;
  onExpired: () => void;
}) {
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const identity = useRef<{ instruction: string; requestKey: string } | null>(
    null,
  );
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const value = instruction.trim();
    if (!value) return;
    if (identity.current?.instruction !== value)
      identity.current = {
        instruction: value,
        requestKey: crypto.randomUUID(),
      };
    setBusy(true);
    setError(null);
    try {
      const task = await api.request(
        `/projects/${project.id}/tasks`,
        taskSchema,
        { method: "POST", body: identity.current },
      );
      onCreated(task);
      setInstruction("");
      identity.current = null;
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onExpired();
      else setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="task-composer" onSubmit={(event) => void submit(event)}>
      <div className="section-heading">
        <h2>
          <label htmlFor="instruction">분석 작업 등록</label>
        </h2>
        <span className="small-tag">읽기 전용</span>
      </div>
      <textarea
        id="instruction"
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        maxLength={10000}
        required
        placeholder="예: README와 코드 구조를 읽고, 다음에 개발할 기능과 확인할 문제를 정리해 줘."
        rows={5}
        disabled={busy}
      />
      <div className="composer-bottom">
        <small>{instruction.length.toLocaleString()} / 10,000</small>
        <button className="primary" disabled={busy || !instruction.trim()}>
          {busy ? "등록 중…" : "분석 요청"}
          <span aria-hidden="true">↑</span>
        </button>
      </div>
      {error ? (
        <p className="error-text" role="alert">
          {errorMessage(error)} 같은 내용으로 다시 요청하면 중복 등록을
          방지합니다.
        </p>
      ) : null}
    </form>
  );
}
