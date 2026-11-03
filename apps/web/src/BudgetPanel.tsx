import { useCallback, useState, type FormEvent } from "react";
import {
  projectBudgetSchema,
  type PeriodBudgetPolicy,
} from "@agent-hub/contracts";
import { api, ApiError, errorMessage } from "./api.js";
import { dateTime } from "./format.js";
import { usePolling } from "./use-polling.js";

export function BudgetPanel({
  projectId,
  onExpired,
}: {
  projectId: string;
  onExpired: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const [draft, setDraft] = useState<{
    version: number;
    policy: PeriodBudgetPolicy;
  } | null>(null);
  const [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  const load = useCallback(
    (signal: AbortSignal) =>
      api.request(`/projects/${projectId}/budget`, projectBudgetSchema, {
        signal,
      }),
    [projectId],
  );
  const poll = usePolling(
    `budget:${projectId}`,
    load,
    onExpired,
    5000,
    revision,
  );
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.request(`/projects/${projectId}/budget`, projectBudgetSchema, {
        method: "PUT",
        body: { expectedVersion: draft.version, policy: draft.policy },
      });
      setDraft(null);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onExpired();
      else setError(failure);
    } finally {
      setBusy(false);
      setRevision((n) => n + 1);
    }
  }
  function update(key: keyof PeriodBudgetPolicy, value: number) {
    setDraft((previous) =>
      previous
        ? { ...previous, policy: { ...previous.policy, [key]: value } }
        : previous,
    );
  }
  return (
    <section className="goals-panel" aria-label="실행 예산">
      <details>
        <summary>실행 예산</summary>
        <p className="subtle-note">
          프로젝트 전체와 각 목표의 호출 수·실행 시간을 함께 제한합니다. 구독
          잔여량과는 다릅니다. 설정 변경은 진행 중인 기간의 사용량을 초기화하지
          않으며 다음 기간에 적용됩니다.
        </p>
        {poll.error || error ? (
          <p className="error-text" role="alert">
            {errorMessage(error ?? poll.error)}
          </p>
        ) : null}
        {poll.error ? (
          <small>마지막 확인 {dateTime(poll.checkedAt)}</small>
        ) : null}
        {poll.data ? (
          <>
            <p>
              프로젝트 설정: {poll.data.policy.windowMs / 60000}분마다 최대{" "}
              {poll.data.policy.maxCalls}회 · {poll.data.policy.maxRunMs / 1000}
              초 실행
            </p>
            {draft ? (
              <form
                onSubmit={(event) => void save(event)}
                aria-label="프로젝트 예산 설정"
                className="goal-form"
              >
                <label>
                  예산 기간(분)
                  <input
                    required
                    type="number"
                    min="10"
                    max="1440"
                    step="1"
                    value={draft.policy.windowMs / 60000}
                    onChange={(e) =>
                      update("windowMs", Number(e.target.value) * 60000)
                    }
                  />
                </label>
                <label>
                  호출 상한(회)
                  <input
                    required
                    type="number"
                    min="1"
                    max="1000"
                    step="1"
                    value={draft.policy.maxCalls}
                    onChange={(e) => update("maxCalls", Number(e.target.value))}
                  />
                </label>
                <label>
                  실행 시간 상한(초)
                  <input
                    required
                    type="number"
                    min="1"
                    max={draft.policy.windowMs / 1000}
                    step="1"
                    value={draft.policy.maxRunMs / 1000}
                    onChange={(e) =>
                      update("maxRunMs", Number(e.target.value) * 1000)
                    }
                  />
                </label>
                <div className="goal-actions">
                  <button disabled={busy}>예산 저장</button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      setDraft(null);
                      setError(null);
                    }}
                  >
                    닫기
                  </button>
                </div>
              </form>
            ) : (
              <button
                className="secondary"
                onClick={() => {
                  setDraft({
                    version: poll.data!.version,
                    policy: { ...poll.data!.policy },
                  });
                  setError(null);
                }}
              >
                프로젝트 예산 수정
              </button>
            )}
            <div className="goal-list">
              {poll.data.accounts.map((account) => (
                <article
                  className="goal-card"
                  key={`${account.scope}:${account.id}`}
                >
                  <h3>
                    {account.scope === "goal" ? "목표" : "프로젝트"}:{" "}
                    {account.label.slice(0, 100)}
                  </h3>
                  {account.period ? (
                    <>
                      <p>
                        {Date.parse(account.period.endsAt) <= Date.now()
                          ? "지난 기간"
                          : "현재 기간"}
                        : {dateTime(account.period.startedAt)} ~{" "}
                        {dateTime(account.period.endsAt)}
                      </p>
                      <p>
                        허용한 호출 {account.period.calls} /{" "}
                        {account.period.policy.maxCalls}회 · 정산{" "}
                        {Math.ceil(account.period.chargedRunMs / 1000)}초 + 예약{" "}
                        {Math.ceil(account.period.reservedRunMs / 1000)}초 /{" "}
                        {account.period.policy.maxRunMs / 1000}초
                      </p>
                    </>
                  ) : (
                    <p>아직 실행 기간이 시작되지 않았습니다.</p>
                  )}
                </article>
              ))}
            </div>
            <small>
              준비 중 실패하거나 실행 여부를 확인할 수 없는 호출도 예약 횟수에
              포함합니다. 종료가 확인되면 예약 시간을 실제 실행 시간으로
              정산합니다.
            </small>
          </>
        ) : (
          <p>예산 확인 중…</p>
        )}
      </details>
    </section>
  );
}
