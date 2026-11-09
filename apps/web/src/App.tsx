import { useCallback, useEffect, useState } from "react";
import type { Session } from "@agent-hub/contracts";
import { api, errorMessage } from "./shared/api.js";
import { Login } from "./features/auth/Login.js";
import { PublicProjects } from "./features/public/PublicProjects.js";
import { Brand } from "./shared/Brand.js";
import { Workspace } from "./features/workspace/Workspace.js";

export function App() {
  const [view, setView] = useState(window.location.hash);
  useEffect(() => {
    const navigate = () => setView(window.location.hash);
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, []);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [checking, setChecking] = useState(true);
  const refreshSession = useCallback(() => {
    setChecking(true);
    setError(null);
    void api
      .session()
      .then(setSession)
      .catch(setError)
      .finally(() => setChecking(false));
  }, []);
  useEffect(refreshSession, [refreshSession]);
  const expired = useCallback(() => {
    window.location.hash = "login";
    setSession(null);
    refreshSession();
  }, [refreshSession]);

  if (session?.authenticated && view !== "#public")
    return (
      <Workspace
        onExpired={expired}
        onLogout={() => {
          window.location.hash = "login";
          setSession(null);
          refreshSession();
        }}
      />
    );
  if (view !== "#login" && !checking && !error)
    return <PublicProjects owner={session?.authenticated === true} />;
  return (
    <main className="login-layout">
      <section className="login-intro">
        <a href="#public" aria-label="공개 화면 보기">
          <Brand />
        </a>
        <div className="login-message">
          <p className="eyebrow">프로젝트 작업 공간</p>
          <h1>
            맡긴 일의 흐름을,
            <br />
            한곳에서.
          </h1>
          <p>
            프로젝트에 목표를 맡기고,
            <br />
            실행 과정과 결과를 확인하세요.
          </p>
        </div>
        <ol className="login-flow">
          <li>프로젝트 선택</li>
          <li>목표와 범위 설정</li>
          <li>실행 기록 확인</li>
        </ol>
      </section>
      <section className="login-panel" aria-labelledby="login-title">
        <p className="eyebrow">내 작업 공간으로</p>
        <h2 id="login-title">로그인</h2>
        <p className="muted">초기 설정에서 만든 비밀번호를 입력하세요.</p>
        {checking ? (
          <p role="status">접속 상태를 확인하고 있습니다.</p>
        ) : error ? (
          <div className="notice error">
            <p role="alert">{errorMessage(error)}</p>
            <button className="secondary" onClick={refreshSession}>
              다시 연결
            </button>
          </div>
        ) : (
          <Login
            onLogin={(value) => {
              window.location.hash = "";
              setSession(value);
            }}
          />
        )}
        <p className="login-footnote">이 공간에는 프로젝트 지시와 실행 결과가 저장됩니다.</p>
      </section>
    </main>
  );
}
