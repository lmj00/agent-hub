import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  repositoryCreationsSchema,
  repositoryCreationSchema,
  type RepositoryCreation,
} from "@agent-hub/contracts";
import { api, ApiError, errorMessage } from "../../shared/api.js";
import { usePolling } from "../../shared/use-polling.js";
import { dateTime } from "../../shared/format.js";

const labels: Record<RepositoryCreation["status"], string> = {
  queued: "생성 대기",
  authorizing: "권한 확인 중",
  creating: "GitHub 저장소 생성 중",
  created: "저장소 생성 완료 · 가져오기 연결 중",
  linked: "가져오기 요청 완료",
  failed: "생성 요청 실패",
  uncertain: "GitHub에서 생성 여부 확인 필요",
  cancelled: "생성 대기 취소됨",
};
export function RepositoryCreations({ onExpired }: { onExpired: () => void }) {
  const [repositoryName, setRepositoryName] = useState("");
  const [name, setName] = useState("");
  const [profile, setProfile] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  const requestKey = useRef(crypto.randomUUID());
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(
    (signal: AbortSignal) =>
      api.request("/integrations/github/creations", repositoryCreationsSchema, { signal }),
    [],
  );
  const poll = usePolling("github-creations", load, onExpired, 3000, revision);
  useEffect(() => () => controller.current?.abort(), []);
  const chosenProfile = profile || poll.data?.profiles[0] || "";
  function changed() {
    requestKey.current = crypto.randomUUID();
    setError(null);
  }
  async function change(path: string, body: unknown) {
    if (busy) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError(null);
    try {
      await api.request(path, repositoryCreationSchema, {
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
    void change("/integrations/github/creations", {
      requestKey: requestKey.current,
      repositoryName: repositoryName.trim(),
      name: name.trim() || repositoryName.trim(),
      profile: chosenProfile,
    });
  }
  return (
    <section className="repository-imports" aria-label="새 프로젝트 만들기">
      <h3>새 프로젝트 만들기</h3>
      <p className="subtle-note">
        내 GitHub 계정에 비공개 저장소와 README를 만들고 개발용 소스를 준비합니다. 준비 후
        프로젝트를 열어 만들고 싶은 앱의 목표를 맡기세요.
      </p>
      {poll.error || error ? (
        <p className="error-text" role="alert">
          {errorMessage(error ?? poll.error)}{" "}
          {poll.error && poll.data ? "마지막으로 확인한 기록입니다." : ""}
        </p>
      ) : null}
      {poll.data?.enabled ? (
        <form className="stack compact" onSubmit={submit}>
          <label htmlFor="create-repository-name">GitHub 저장소 이름</label>
          <input
            id="create-repository-name"
            value={repositoryName}
            required
            maxLength={100}
            pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{0,99}"
            disabled={busy}
            onChange={(event) => {
              setRepositoryName(event.target.value);
              changed();
            }}
          />
          <small>영문·숫자로 시작하고 영문·숫자·점·밑줄·하이픈을 사용할 수 있습니다.</small>
          <label htmlFor="create-project-name">화면에 표시할 프로젝트 이름</label>
          <input
            id="create-project-name"
            value={name}
            maxLength={100}
            disabled={busy}
            placeholder="비우면 저장소 이름을 사용합니다"
            onChange={(event) => {
              setName(event.target.value);
              changed();
            }}
          />
          <label htmlFor="create-profile">검증 환경</label>
          <select
            id="create-profile"
            value={chosenProfile}
            disabled={busy}
            onChange={(event) => {
              setProfile(event.target.value);
              changed();
            }}
          >
            {poll.data.profiles.map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
          <small>
            만들 앱의 기술과 맞는 서버의 테스트 환경을 선택하세요. 생성 후 가져오기를 취소해도
            GitHub 저장소는 남습니다.
          </small>
          <button className="primary" disabled={busy || !repositoryName.trim() || !chosenProfile}>
            {busy ? "요청 중…" : "비공개 저장소 만들기"}
          </button>
        </form>
      ) : poll.data ? (
        <p>
          서버에 저장소 생성 허용과 GitHub 생성 권한을 설정해야 합니다. 기존 저장소 가져오기는
          별도로 사용할 수 있습니다.
        </p>
      ) : null}
      <ul className="import-jobs">
        {poll.data?.creations.map((job) => (
          <li key={job.id}>
            <div>
              <strong>{job.name}</strong>
              <span className="muted">{labels[job.status]}</span>
            </div>
            <small>
              {job.fullName ?? job.repositoryName} · 시도 {job.attempt}/5 ·{" "}
              {dateTime(job.updatedAt)}
            </small>
            {job.errorCode ? (
              <p className="error-text">{errorMessage(new ApiError(409, job.errorCode))}</p>
            ) : null}
            {job.status === "uncertain" ? (
              <p>
                GitHub에서 이 저장소의 생성 여부를 직접 확인하세요. 저장소가 있다면 위 목록을 새로
                조회하고 선택해 가져올 수 있습니다. 이 생성 요청은 자동으로 반복하지 않습니다.
              </p>
            ) : null}
            {job.importId ? (
              <p>아래 ‘프로젝트 가져오기’에서 준비 상태를 확인하고 프로젝트를 여세요.</p>
            ) : null}
            <div className="import-actions">
              {["queued", "failed"].includes(job.status) ? (
                <button
                  className="secondary"
                  disabled={busy || !poll.data?.enabled}
                  onClick={() =>
                    void change(`/integrations/github/creations/${job.id}`, { action: "cancel" })
                  }
                >
                  생성 대기 취소
                </button>
              ) : null}
              {(["failed", "cancelled"].includes(job.status) && job.attempt < 5) ||
              (job.status === "created" && job.errorCode) ? (
                <button
                  className="secondary"
                  disabled={busy || !poll.data?.enabled}
                  onClick={() =>
                    void change(`/integrations/github/creations/${job.id}`, { action: "retry" })
                  }
                >
                  {job.status === "created" ? "가져오기 연결 재시도" : "생성 다시 요청"}
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <button className="text-button" onClick={() => setRevision((value) => value + 1)}>
        생성 상태 새로고침
      </button>
    </section>
  );
}
