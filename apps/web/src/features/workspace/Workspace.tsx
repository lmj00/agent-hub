import { useCallback, useEffect, useState } from "react";
import { projectsSchema, queueSchema, providerGateSchema } from "@agent-hub/contracts";
import { api, ApiError, errorMessage } from "../../shared/api.js";
import { usePolling } from "../../shared/use-polling.js";
import { dateTime } from "../../shared/format.js";
import { ProjectForm } from "../projects/ProjectForm.js";
import { ProjectOverview } from "../projects/ProjectOverview.js";
import { GitHubPanel } from "../github/GitHubPanel.js";
import { ProjectTasks } from "../tasks/ProjectTasks.js";
import { ExecutionBar } from "../execution/ExecutionBar.js";
import { ServicePanel } from "../services/ServicePanel.js";
import { GoalPanel } from "../goals/GoalPanel.js";
import { BudgetPanel } from "../budgets/BudgetPanel.js";

export function Workspace({
  onExpired,
  onLogout,
}: {
  onExpired: () => void;
  onLogout: () => void;
}) {
  const [projectId, setProjectId] = useState<string | null>(() => selectedProject());
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
  const project = projects.find((value) => value.id === projectId) ?? null;
  useEffect(() => {
    function navigate() {
      setProjectId(selectedProject());
      setTaskId(null);
    }
    window.addEventListener("popstate", navigate);
    return () => window.removeEventListener("popstate", navigate);
  }, []);
  function selectProject(id: string | null, selectedTaskId?: string) {
    window.history.pushState(null, "", id ? `/#project/${id}` : "/");
    setProjectId(id);
    setTaskId(selectedTaskId ?? null);
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
        <button className="quiet" onClick={() => void logout()} disabled={loggingOut}>
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
          <button
            className={`overview-link ${!projectId ? "selected" : ""}`}
            aria-pressed={!projectId}
            onClick={() => selectProject(null)}
          >
            전체 현황
          </button>
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
            <p className="muted">첫 프로젝트를 등록해 목표를 맡기세요.</p>
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
              분석 결과를 기록하고, 실행·개발 설정이 준비된 목표는 스스로 계획합니다. 검증된 변경은
              개발용 브랜치에 반영합니다.
            </small>
          </div>
        </aside>
        <main className="main-workspace">
          <section className="workspace-heading">
            <div>
              <p className="eyebrow">{projectId ? "현재 프로젝트" : "내 프로젝트 작업 공간"}</p>
              <h1>{projectId ? (project?.name ?? "프로젝트 확인 중") : "전체 현황"}</h1>
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
            <ExecutionBar queue={overview.data.queue} gate={overview.data.gate} />
          ) : null}
          {!projectId ? (
            <>
              <GitHubPanel
                onExpired={onExpired}
                onOpen={(id) => {
                  refresh();
                  selectProject(id);
                }}
              />
              <ProjectOverview onSelect={selectProject} onExpired={onExpired} />
            </>
          ) : null}
          {project ? (
            <>
              <GoalPanel key={`goals:${project.id}`} projectId={project.id} onExpired={onExpired} />
              <ServicePanel
                key={`services:${project.id}`}
                projectId={project.id}
                onExpired={onExpired}
              />
              <BudgetPanel
                key={`budget:${project.id}`}
                projectId={project.id}
                onExpired={onExpired}
              />
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
          ) : projectId && overview.data ? (
            <div className="empty-state">
              <span className="empty-symbol" aria-hidden="true">
                ↗
              </span>
              <h2>프로젝트를 찾을 수 없습니다</h2>
              <p>전체 현황에서 프로젝트를 다시 선택하세요.</p>
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}

function selectedProject() {
  return /^#project\/([0-9a-f-]{36})$/i.exec(window.location.hash)?.[1] ?? null;
}
