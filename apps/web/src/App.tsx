import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Session } from "@agent-hub/contracts";
import { api, errorMessage } from "./api.js";
import { Workspace } from "./Workspace.js";

export function App() {
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
    setSession(null);
    refreshSession();
  }, [refreshSession]);

  if (session?.authenticated) return <Workspace onExpired={expired} onLogout={refreshSession} />;
  return (
    <main className="login-layout">
      <section className="login-intro">
        <p className="brand">
          <span className="brand-mark" aria-hidden="true">
            a
          </span>
          agent-hub
        </p>
        <div className="login-message">
          <p className="eyebrow">프로젝트 작업 공간</p>
          <h1>
            맡긴 일의 흐름을,
            <br />
            한곳에서.
          </h1>
          <p>
            프로젝트에 분석을 요청하고,
            <br />
            실행 과정과 결과를 확인하세요.
          </p>
        </div>
        <ol className="login-flow">
          <li>프로젝트 선택</li>
          <li>분석 요청</li>
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
          <Login onLogin={setSession} />
        )}
        <p className="login-footnote">이 공간에는 프로젝트 지시와 실행 결과가 저장됩니다.</p>
      </section>
    </main>
  );
}

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onLogin(await api.login(password));
      setPassword("");
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)} className="stack">
      <label htmlFor="password">비밀번호</label>
      <input
        id="password"
        type="password"
        autoComplete="current-password"
        required
        maxLength={1024}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        autoFocus
      />
      {error ? (
        <p className="error-text" role="alert">
          {errorMessage(error)}
        </p>
      ) : null}
      <button className="primary" disabled={busy || !password}>
        {busy ? "로그인 중…" : "작업 공간 열기"}
        <span aria-hidden="true">↗</span>
      </button>
    </form>
  );
}
