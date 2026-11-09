import { useEffect, useState } from "react";
import { projectPublicationSchema, type ProjectPublication } from "@agent-hub/contracts";
import { api, ApiError, errorMessage } from "../../shared/api.js";

export function PublicationPanel({
  projectId,
  onExpired,
}: {
  projectId: string;
  onExpired: () => void;
}) {
  const [value, setValue] = useState<ProjectPublication | null>(null);
  const [draft, setDraft] = useState<ProjectPublication>({ listed: false, name: "" });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api
      .request(`/projects/${projectId}/publication`, projectPublicationSchema, {
        signal: controller.signal,
      })
      .then((data) => {
        if (!controller.signal.aborted) {
          setValue(data);
          setDraft(data);
          setError(null);
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted) {
          if (failure instanceof ApiError && failure.status === 401) onExpired();
          else setError(failure);
        }
      });
    return () => controller.abort();
  }, [projectId, onExpired, revision]);
  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.request(
        `/projects/${projectId}/publication`,
        projectPublicationSchema,
        { method: "PUT", body: draft },
      );
      setValue(saved);
      setDraft(saved);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onExpired();
      else setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="publication-panel" aria-label="프로젝트 공개 설정">
      <details>
        <summary>
          공개 여부{" "}
          <span className="muted">{value ? (value.listed ? "공개" : "비공개") : "확인 중"}</span>
        </summary>
        <p>
          공개를 켜면 누구나 공개용 이름과 실행 상태를 볼 수 있습니다. 목표·작업 지시·로그는
          공개하지 않습니다. GitHub 저장소의 공개 여부는 바뀌지 않습니다.
        </p>
        {error ? (
          <p className="error-text" role="alert">
            {errorMessage(error)} 저장 결과가 불확실하면{" "}
            <button className="text-button" onClick={() => setRevision((n) => n + 1)}>
              다시 확인
            </button>
            하세요.
          </p>
        ) : null}
        {value ? (
          <form
            className="publication-form stack"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label htmlFor="public-name">공개용 이름</label>
            <input
              id="public-name"
              value={draft.name}
              maxLength={100}
              required
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={draft.listed}
                onChange={(event) => setDraft({ ...draft, listed: event.target.checked })}
              />
              방문자에게 공개
            </label>
            <div>
              <button className="secondary" disabled={busy || !draft.name.trim()}>
                공개 설정 저장
              </button>{" "}
              <a href="#public">공개 화면 보기</a>
            </div>
          </form>
        ) : null}
      </details>
    </section>
  );
}
