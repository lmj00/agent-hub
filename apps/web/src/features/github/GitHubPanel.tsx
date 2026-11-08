import { RepositoryImports } from "./RepositoryImports.js";
import { useEffect, useRef, useState } from "react";
import {
  githubConnectionSchema,
  githubRepositoriesSchema,
  type GitHubRepositories,
} from "@agent-hub/contracts";
import { api, ApiError, errorMessage } from "../../shared/api.js";
import { dateTime } from "../../shared/format.js";

export function GitHubPanel({
  onExpired,
  onOpen,
}: {
  onExpired: () => void;
  onOpen: (id: string) => void;
}) {
  const [selected, setSelected] = useState<{ id: number; name: string; fullName: string } | null>(
    null,
  );
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [data, setData] = useState<GitHubRepositories | null>(null);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void api
      .request("/integrations/github", githubConnectionSchema, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setConfigured(value.configured);
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && failure.status === 401) onExpired();
        else setError(failure);
      });
    return () => {
      controller.abort();
      request.current?.abort();
    };
  }, [onExpired, revision]);
  async function load(nextPage: number) {
    if (busy) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(null);
    // Old repository access may have been revoked; do not retain it after a failed check.
    setData(null);
    setSelected(null);
    try {
      const result = await api.request(
        "/integrations/github/repositories",
        githubRepositoriesSchema,
        { method: "POST", body: { page: nextPage }, signal: controller.signal },
      );
      if (!controller.signal.aborted) {
        setData(result);
        setPage(nextPage);
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (failure instanceof ApiError && failure.status === 401) onExpired();
        else setError(failure);
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section className="github-panel" aria-label="GitHub 저장소 연결">
      <details>
        <summary>GitHub 저장소 연결</summary>
        <p className="subtle-note">
          허용한 저장소를 확인하고 프로젝트로 가져옵니다. 새 저장소 생성은 아직 연결되지 않았습니다.
        </p>
        {configured === false ? (
          <p>
            서버에 GitHub App 연결 설정이 필요합니다. 설정 후 여기에서 허용한 저장소를 확인할 수
            있습니다.
          </p>
        ) : null}
        {configured === null && !error ? <p role="status">연결 설정 확인 중…</p> : null}
        {error ? (
          <p className="error-text" role="alert">
            {errorMessage(error)}
          </p>
        ) : null}
        {configured ? (
          <button className="secondary" disabled={busy} onClick={() => void load(1)}>
            {busy ? "GitHub 확인 중…" : "연결 확인 및 저장소 조회"}
          </button>
        ) : (
          <button className="secondary" onClick={() => setRevision((value) => value + 1)}>
            설정 다시 확인
          </button>
        )}
        {data ? (
          <>
            <p>
              <strong>{data.owner}</strong> · 확인 시각 {dateTime(data.checkedAt)}
            </p>
            <ul className="github-repositories">
              {data.repositories.map((repo) => (
                <li key={repo.id}>
                  <span>{repo.fullName}</span>
                  <small>
                    {repo.private ? "비공개" : "공개"}
                    {repo.archived ? " · 보관됨" : ""}
                  </small>
                  <button
                    className="secondary"
                    disabled={repo.archived}
                    onClick={() => setSelected(repo)}
                  >
                    가져오기 선택
                  </button>
                </li>
              ))}
            </ul>
            {!data.repositories.length ? (
              <p>허용한 저장소가 없습니다. GitHub App 설치 설정에서 저장소를 선택하세요.</p>
            ) : null}
            <nav className="overview-pagination" aria-label="GitHub 저장소 페이지">
              <button
                className="secondary"
                disabled={busy || page === 1}
                onClick={() => void load(page - 1)}
              >
                이전
              </button>
              <span>{page} 페이지</span>
              <button
                className="secondary"
                disabled={busy || data.nextPage === null}
                onClick={() => {
                  if (data.nextPage) void load(data.nextPage);
                }}
              >
                다음
              </button>
            </nav>
          </>
        ) : null}
        <RepositoryImports selected={selected} onExpired={onExpired} onOpen={onOpen} />
      </details>
    </section>
  );
}
