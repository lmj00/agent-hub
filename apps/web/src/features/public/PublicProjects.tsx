import { useCallback, useState } from "react";
import { publicProjectsSchema } from "@agent-hub/contracts";
import { api } from "../../shared/api.js";
import { Brand } from "../../shared/Brand.js";
import { usePolling } from "../../shared/use-polling.js";

const ignoreExpired = () => {};
const states = { running: "작업 실행 중", attention: "확인 필요", idle: "실행 중인 작업 없음" };
export function PublicProjects({ owner }: { owner: boolean }) {
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const load = useCallback(
    (signal: AbortSignal) =>
      api.request(`/public/projects?offset=${offset}`, publicProjectsSchema, { signal }),
    [offset],
  );
  const poll = usePolling(`public:${offset}`, load, ignoreExpired, 5000, revision);
  // Withdraw stale public data on errors. Visibility may have changed since the last poll.
  const data = poll.error ? null : poll.data;
  const selected = data?.projects.find((project) => project.id === selectedId) ?? data?.projects[0];
  return (
    <div className="public-workspace">
      <header className="public-header">
        <a href="/" aria-label="agent-hub 처음 화면">
          <Brand />
        </a>
        <span className="public-tab">프로젝트</span>
        <a className="quiet" href={owner ? "#" : "#login"}>
          {owner ? "내 작업 공간" : "관리자 로그인"}
        </a>
      </header>
      <main className="public-main">
        <div className="workspace-heading">
          <div>
            <p className="eyebrow">프로젝트 작업실</p>
            <h1>목표에서 다음 작업까지</h1>
            <p className="public-intro">공개한 프로젝트와 현재 실행 상태를 확인하세요</p>
          </div>
          <span className="muted">읽기 전용</span>
        </div>
        {poll.error ? (
          <div role="alert" className="notice error">
            공개 현황을 확인하지 못했습니다.{" "}
            <button className="text-button" onClick={() => setRevision((value) => value + 1)}>
              다시 확인
            </button>
          </div>
        ) : null}
        {!data && !poll.error ? <p role="status">공개 프로젝트를 불러오는 중…</p> : null}
        {data ? (
          <div className="public-columns">
            <section aria-label="공개 프로젝트 목록">
              <div className="section-heading">
                <h2>프로젝트</h2>
                <span className="muted">비공개 {data.privateCount}개</span>
              </div>
              <div className="public-project-list">
                {data.projects.map((project) => (
                  <button
                    key={project.id}
                    className="public-project-row"
                    aria-pressed={selected?.id === project.id}
                    onClick={() => setSelectedId(project.id)}
                  >
                    <span>
                      <strong>{project.name}</strong>
                      <small>공개 프로젝트</small>
                    </span>
                    <span className={`public-state ${project.state}`}>
                      {states[project.state]} <span aria-hidden="true">↗</span>
                    </span>
                  </button>
                ))}
              </div>
              {!data.projects.length ? (
                <p className="empty-list">
                  {offset
                    ? "이 페이지에 공개 프로젝트가 없습니다."
                    : "아직 공개한 프로젝트가 없습니다."}
                </p>
              ) : null}
              {data.privateCount > 0 ? (
                <div className="private-placeholder">
                  <span aria-hidden="true">—</span>
                  <div>
                    <strong>비공개 프로젝트 · {data.privateCount}개</strong>
                    <p>이름과 작업 내용은 소유자만 볼 수 있습니다</p>
                  </div>
                </div>
              ) : null}
              {offset > 0 || data.nextOffset !== null ? (
                <nav className="overview-pagination" aria-label="공개 현황 페이지">
                  <button
                    className="secondary"
                    disabled={offset === 0}
                    onClick={() => {
                      setOffset(Math.max(0, offset - 24));
                      setSelectedId(null);
                    }}
                  >
                    이전
                  </button>
                  <span>{Math.floor(offset / 24) + 1} 페이지</span>
                  <button
                    className="secondary"
                    disabled={data.nextOffset === null}
                    onClick={() => {
                      if (data.nextOffset !== null) {
                        setOffset(data.nextOffset);
                        setSelectedId(null);
                      }
                    }}
                  >
                    다음
                  </button>
                </nav>
              ) : null}
            </section>
            <section className="public-detail" aria-label="선택한 공개 프로젝트" aria-live="polite">
              {selected ? (
                <>
                  <p className="eyebrow">
                    선택한 프로젝트 <span>공개</span>
                  </p>
                  <h2>{selected.name}</h2>
                  <p className={`public-state ${selected.state}`}>{states[selected.state]}</p>
                  <div className="public-detail-note">
                    <h3>공개된 실행 현황</h3>
                    <p>
                      프로젝트의 현재 실행 여부만 보여줍니다. 목표와 작업 지시, 상세 실행 기록은
                      공개하지 않습니다.
                    </p>
                  </div>
                </>
              ) : (
                <p className="muted">공개 프로젝트가 등록되면 여기서 현황을 확인할 수 있습니다.</p>
              )}
            </section>
          </div>
        ) : null}
      </main>
    </div>
  );
}
