import { useRef, useState, type FormEvent } from "react";
import { taskSchema, type Project, type Task } from "@agent-hub/contracts";
import { api, ApiError, errorMessage } from "../../shared/api.js";

export function TaskForm({
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
  const identity = useRef<{ instruction: string; requestKey: string } | null>(null);
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
      const task = await api.request(`/projects/${project.id}/tasks`, taskSchema, {
        method: "POST",
        body: identity.current,
      });
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
          {errorMessage(error)} 같은 내용으로 다시 요청하면 중복 등록을 방지합니다.
        </p>
      ) : null}
    </form>
  );
}
