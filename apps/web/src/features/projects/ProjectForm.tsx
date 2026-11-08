import { useState, type FormEvent } from "react";
import { projectSchema, type Project } from "@agent-hub/contracts";
import { api, ApiError, errorMessage } from "../../shared/api.js";

export function ProjectForm({
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
        <form className="stack compact" onSubmit={(event) => void submit(event)}>
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
          <small id="workspace-help">서버 실행 설정에 등록한 키를 입력하세요.</small>
          {error ? (
            <p className="error-text" role="alert">
              {errorMessage(error)} 응답이 끊겼다면 중복 등록 전에 프로젝트 목록을 확인해 주세요.
            </p>
          ) : null}
          <button className="primary" disabled={busy || !name.trim() || !workspaceKey.trim()}>
            {busy ? "등록 중…" : "프로젝트 등록"}
          </button>
        </form>
      ) : null}
    </div>
  );
}
