import { useState, type FormEvent } from "react";
import type { Session } from "@agent-hub/contracts";
import { api, errorMessage } from "../../shared/api.js";

export function Login({ onLogin }: { onLogin: (session: Session) => void }) {
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
