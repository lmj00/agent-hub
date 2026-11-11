import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  repositoryImportsSchema,
  repositoryImportSchema,
  type RepositoryImport,
} from "@agent-hub/contracts";
import { api, ApiError, errorMessage } from "../../shared/api.js";
import { usePolling } from "../../shared/use-polling.js";
import { dateTime } from "../../shared/format.js";

const labels: Record<RepositoryImport["status"], string> = {
  queued: "가져오기 대기",
  preparing: "소스 준비 중",
  ready: "프로젝트 준비 완료",
  failed: "가져오기 실패",
  cancelled: "취소됨",
};
export function RepositoryImports({
  selected,
  onOpen,
  onExpired,
}: {
  selected: { id: number; name: string; fullName: string } | null;
  onOpen: (id: string) => void;
  onExpired: () => void;
}) {
  const [name, setName] = useState("");
  const [profile, setProfile] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  const requestKey = useRef(crypto.randomUUID());
  const controller = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const load = useCallback(
    (signal: AbortSignal) =>
      api.request("/integrations/github/imports", repositoryImportsSchema, { signal }),
    [],
  );
  const poll = usePolling("github-imports", load, onExpired, 3000, revision);
  useEffect(() => {
    if (selected) heading.current?.focus();
  }, [selected]);
  useEffect(() => {
    setName(selected?.name ?? "");
    requestKey.current = crypto.randomUUID();
    setError(null);
  }, [selected?.id, selected?.name]);
  useEffect(() => () => controller.current?.abort(), []);
  const chosenProfile = profile || poll.data?.profiles[0] || "";
  async function change(path: string, body: unknown) {
    if (busy) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError(null);
    try {
      await api.request(path, repositoryImportSchema, {
        method: "POST",
        body,
        signal: request.signal,
      });
      if (!request.signal.aborted) setRevision((value) => value + 1);
    } catch (failure) {
      if (!request.signal.aborted) {
        if (failure instanceof ApiError && failure.status === 401) onExpired();
        else setError(failure);
      }
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (selected)
      void change("/integrations/github/imports", {
        requestKey: requestKey.current,
        repositoryId: selected.id,
        name: name.trim(),
        profile: chosenProfile,
      });
  }
  return (
    <section id="repository-imports" className="repository-imports" aria-label="프로젝트 가져오기">
      <h3 ref={heading} tabIndex={-1}>
        프로젝트 가져오기
      </h3>
      <p className="subtle-note">
        선택한 저장소의 현재 소스를 별도 폴더로 준비합니다. GitHub 원본과 과거 커밋 이력은 변경하지
        않습니다. 준비 후 프로젝트를 열어 목표를 맡기세요.
      </p>
      {selected ? (
        <p role="status">
          선택한 저장소: <strong>{selected.fullName}</strong>
        </p>
      ) : null}
      {!poll.data && !poll.error ? <p>가져오기 환경 확인 중…</p> : null}
      {poll.error || error ? (
        <p className="error-text" role="alert">
          {errorMessage(error ?? poll.error)}{" "}
          {poll.error && poll.data ? "마지막으로 확인한 기록입니다." : ""}
        </p>
      ) : null}
      {poll.data && !poll.data.enabled ? (
        <p>
          <strong>아직 가져올 수 없습니다.</strong> 가져오려면 서버에 GitHub 연결과 개발·검증 환경을
          설정해야 합니다. 저장소 선택만으로 가져오기가 시작되지는 않습니다.
        </p>
      ) : null}
      {selected && poll.data?.enabled ? (
        <form className="stack compact" onSubmit={submit}>
          <label htmlFor="import-project-name">가져올 프로젝트 이름</label>
          <input
            id="import-project-name"
            value={name}
            required
            maxLength={100}
            disabled={busy}
            onChange={(event) => {
              setName(event.target.value);
              requestKey.current = crypto.randomUUID();
            }}
          />
          <label htmlFor="import-profile">검증 환경</label>
          <select
            id="import-profile"
            value={chosenProfile}
            disabled={busy}
            onChange={(event) => {
              setProfile(event.target.value);
              requestKey.current = crypto.randomUUID();
            }}
          >
            {poll.data.profiles.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
          <small>
            서버에서 준비한 테스트 환경을 선택합니다. 저장소의 기술과 맞는 환경이어야 합니다.
          </small>
          <button className="primary" disabled={busy || !name.trim() || !chosenProfile}>
            {busy ? "요청 중…" : "이 저장소 가져오기"}
          </button>
        </form>
      ) : poll.data?.enabled ? (
        <p>위 저장소 목록에서 가져올 저장소를 선택하세요.</p>
      ) : null}
      <ul className="import-jobs">
        {poll.data?.imports.map((job) => (
          <li key={job.id}>
            <div>
              <strong>{job.name}</strong>
              <span className="muted">
                {job.status === "preparing" && job.cancelRequestedAt
                  ? "취소 처리 중"
                  : labels[job.status]}
              </span>
            </div>
            <small>
              {job.fullName ?? `저장소 번호 ${job.repositoryId}`} · 시도 {job.attempt}/5 ·{" "}
              {dateTime(job.updatedAt)}
            </small>
            {job.status === "queued" ? (
              <small>다른 가져오기나 AI 실행이 끝나면 시작합니다.</small>
            ) : null}
            {job.status === "preparing" && job.cancelRequestedAt ? (
              <small>소스 준비가 멈춘 것을 확인하고 실행 자원을 반환합니다.</small>
            ) : null}
            {job.revision ? <small>원본 커밋 {job.revision.slice(0, 12)}</small> : null}
            {job.errorCode ? (
              <p className="error-text">{errorMessage(new ApiError(409, job.errorCode))}</p>
            ) : null}
            <div className="import-actions">
              {job.projectId ? (
                <button className="secondary" onClick={() => onOpen(job.projectId!)}>
                  프로젝트 열기
                </button>
              ) : null}
              {["queued", "preparing"].includes(job.status) && !job.cancelRequestedAt ? (
                <button
                  className="secondary"
                  disabled={busy || !poll.data?.enabled}
                  onClick={() =>
                    void change(`/integrations/github/imports/${job.id}`, { action: "cancel" })
                  }
                >
                  가져오기 취소
                </button>
              ) : null}
              {["failed", "cancelled"].includes(job.status) && job.attempt < 5 ? (
                <button
                  className="secondary"
                  disabled={busy || !poll.data?.enabled}
                  onClick={() =>
                    void change(`/integrations/github/imports/${job.id}`, { action: "retry" })
                  }
                >
                  다시 가져오기
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <button className="text-button" onClick={() => setRevision((value) => value + 1)}>
        가져오기 상태 새로고침
      </button>
    </section>
  );
}
