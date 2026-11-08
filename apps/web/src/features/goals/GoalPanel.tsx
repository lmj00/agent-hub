import { useCallback, useRef, useState, type FormEvent } from "react";
import {
  goalSchema,
  goalsSchema,
  goalHistorySchema,
  type Goal,
  type GoalDefinition,
} from "@agent-hub/contracts";
import { api, ApiError, errorMessage } from "../../shared/api.js";
import { usePolling } from "../../shared/use-polling.js";
import { dateTime } from "../../shared/format.js";

const labels = { active: "활성", paused: "일시정지", completed: "완료" };
const defaults: GoalDefinition = {
  description: "",
  completionCriteria: "",
  kind: "finite",
  priority: 50,
  allowedPaths: ["."],
  excludedPaths: [".git", ".codex", ".local"],
  checkIntervalMs: 900000,
  budget: { windowMs: 3600000, maxCalls: 20, maxRunMs: 1800000 },
};

export function GoalPanel({ projectId, onExpired }: { projectId: string; onExpired: () => void }) {
  const [revision, setRevision] = useState(0),
    [editing, setEditing] = useState<Goal | "new" | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false);
  const pending = useRef<{ signature: string; key: string } | null>(null);
  const load = useCallback(
    (signal: AbortSignal) => api.request(`/projects/${projectId}/goals`, goalsSchema, { signal }),
    [projectId],
  );
  const poll = usePolling(`goals:${projectId}`, load, onExpired, 5000, revision);
  const goals = poll.data?.goals ?? [];
  async function change(path: string, method: "POST" | "PATCH", body: object) {
    if (busy) return;
    const signature = JSON.stringify({ path, method, body });
    if (pending.current?.signature !== signature)
      pending.current = { signature, key: crypto.randomUUID() };
    setBusy(true);
    setError(null);
    try {
      await api.request(path, goalSchema, {
        method,
        body: { ...body, requestKey: pending.current.key },
      });
      pending.current = null;
      setEditing(null);
      setRevision((value) => value + 1);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) onExpired();
      else {
        setError(failure);
        setRevision((value) => value + 1);
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="goals-panel" aria-label="프로젝트 목표">
      <details>
        <summary>
          프로젝트 목표 <span className="count">{goals.length}</span>
        </summary>
        <p className="subtle-note">
          목표와 실행 기준을 저장합니다. 목표에서 자동으로 작업을 만드는 기능은 아직 연결되지
          않았습니다.
        </p>
        {poll.error || error ? (
          <p className="error-text" role="alert">
            {errorMessage(error ?? poll.error)}
          </p>
        ) : null}
        {poll.error ? <small>마지막 확인 {dateTime(poll.checkedAt)}</small> : null}
        <div className="goal-list">
          {goals.map((goal) => (
            <article className="goal-card" key={goal.id}>
              <div className="section-heading">
                <h3>{goal.definition.description.slice(0, 100)}</h3>
                <span>
                  {labels[goal.status]} · 버전 {goal.version}
                </span>
              </div>
              <p>{goal.definition.completionCriteria}</p>
              <p className="subtle-note">
                {goal.definition.kind === "finite" ? "완료 기준이 있는 목표" : "지속 관리 목표"} ·
                우선순위 {goal.definition.priority}
              </p>
              <details className="goal-scope">
                <summary>범위와 예산</summary>
                <p>목표: {goal.definition.description}</p>
                <p>
                  허용: {goal.definition.allowedPaths.join(", ")} · 제외:{" "}
                  {goal.definition.excludedPaths.join(", ") || "없음"}
                </p>
                <p>
                  점검 간격 {goal.definition.checkIntervalMs / 60000}분 ·{" "}
                  {goal.definition.budget.windowMs / 60000}분마다 최대{" "}
                  {goal.definition.budget.maxCalls}회·
                  {goal.definition.budget.maxRunMs / 60000}분 실행
                </p>
                <small>
                  현재 기간의 사용량은 실행 예산에서 확인합니다. 예산 수정은 다음 기간부터 적용되며,
                  다음 점검 예약은 아직 연결되지 않았습니다.
                </small>
              </details>
              <div className="goal-actions">
                <button
                  className="secondary"
                  disabled={busy || goal.status === "completed"}
                  onClick={() => {
                    setEditing(goal);
                    setError(null);
                  }}
                >
                  목표 수정
                </button>
                <button
                  className="secondary"
                  disabled={busy || goal.status === "completed"}
                  onClick={() =>
                    void change(`/goals/${goal.id}/control`, "POST", {
                      expectedVersion: goal.version,
                      action: goal.status === "paused" ? "resume" : "pause",
                    })
                  }
                >
                  {goal.status === "paused" ? "목표 재개" : "목표 일시정지"}
                </button>
                <button
                  className="text-button"
                  onClick={() => setHistoryId(historyId === goal.id ? null : goal.id)}
                >
                  변경 이력
                </button>
              </div>
              {historyId === goal.id ? (
                <GoalHistory
                  key={`${goal.id}:${goal.version}`}
                  id={goal.id}
                  onExpired={onExpired}
                />
              ) : null}
            </article>
          ))}
        </div>
        {!editing ? (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              setEditing("new");
              setError(null);
            }}
          >
            목표 등록 +
          </button>
        ) : (
          <GoalForm
            key={editing === "new" ? "new" : `${editing.id}:${editing.version}`}
            initial={editing === "new" ? defaults : editing.definition}
            busy={busy}
            onClose={() => setEditing(null)}
            onSave={(definition) =>
              change(
                editing === "new" ? `/projects/${projectId}/goals` : `/goals/${editing.id}`,
                editing === "new" ? "POST" : "PATCH",
                {
                  definition,
                  ...(editing === "new" ? {} : { expectedVersion: editing.version }),
                },
              )
            }
          />
        )}
      </details>
    </section>
  );
}

function GoalHistory({ id, onExpired }: { id: string; onExpired: () => void }) {
  const load = useCallback(
    (signal: AbortSignal) => api.request(`/goals/${id}/revisions`, goalHistorySchema, { signal }),
    [id],
  );
  const poll = usePolling(`goal-history:${id}`, load, onExpired, 10000);
  return (
    <div className="goal-history">
      {poll.error ? <p role="alert">{errorMessage(poll.error)}</p> : null}
      {poll.data?.revisions.map((goal) => (
        <details key={goal.version}>
          <summary>
            버전 {goal.version} · {labels[goal.status]} · {dateTime(goal.updatedAt)}
          </summary>
          <p>{goal.definition.description}</p>
          <p>완료 기준: {goal.definition.completionCriteria}</p>
        </details>
      ))}
    </div>
  );
}

function GoalForm({
  initial,
  busy,
  onClose,
  onSave,
}: {
  initial: GoalDefinition;
  busy: boolean;
  onClose: () => void;
  onSave: (definition: GoalDefinition) => Promise<void>;
}) {
  const [draft, setDraft] = useState(initial),
    [allowed, setAllowed] = useState(initial.allowedPaths.join("\n")),
    [excluded, setExcluded] = useState(initial.excludedPaths.join("\n"));
  async function submit(event: FormEvent) {
    event.preventDefault();
    await onSave({
      ...draft,
      allowedPaths: allowed
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean),
      excludedPaths: excluded
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean),
    });
  }
  return (
    <form className="goal-form stack" onSubmit={(event) => void submit(event)}>
      <label htmlFor="goal-description">프로젝트 목표</label>
      <textarea
        id="goal-description"
        required
        maxLength={10000}
        value={draft.description}
        onChange={(event) => setDraft({ ...draft, description: event.target.value })}
      />
      <label htmlFor="goal-criteria">완료·평가 기준</label>
      <textarea
        id="goal-criteria"
        required
        maxLength={6000}
        value={draft.completionCriteria}
        onChange={(event) => setDraft({ ...draft, completionCriteria: event.target.value })}
      />
      <div className="goal-fields">
        <label>
          목표 종류
          <select
            value={draft.kind}
            onChange={(event) =>
              setDraft({
                ...draft,
                kind: event.target.value as GoalDefinition["kind"],
              })
            }
          >
            <option value="finite">완료 기준이 있는 목표</option>
            <option value="continuous">지속 관리</option>
          </select>
        </label>
        <label>
          우선순위
          <input
            type="number"
            min={0}
            max={100}
            required
            value={draft.priority}
            onChange={(event) => setDraft({ ...draft, priority: Number(event.target.value) })}
          />
        </label>
      </div>
      <details>
        <summary>허용 범위와 실행 예산</summary>
        <div className="stack">
          <p className="subtle-note">
            경로는 작업 폴더 기준으로 한 줄에 하나씩 입력합니다. 점(.)은 전체 폴더이며 제외 경로를
            함께 적용합니다.
          </p>
          <label htmlFor="goal-allowed">허용 경로</label>
          <textarea
            id="goal-allowed"
            required
            value={allowed}
            onChange={(event) => setAllowed(event.target.value)}
          />
          <label htmlFor="goal-excluded">제외 경로</label>
          <textarea
            id="goal-excluded"
            value={excluded}
            onChange={(event) => setExcluded(event.target.value)}
          />
          <div className="goal-fields">
            <label>
              점검 간격(분)
              <input
                type="number"
                min={1}
                step="any"
                max={1440}
                required
                value={draft.checkIntervalMs / 60000}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    checkIntervalMs: Math.round(Number(event.target.value) * 60000),
                  })
                }
              />
            </label>
            <label>
              예산 기간(분)
              <input
                type="number"
                min={10}
                step="any"
                max={1440}
                required
                value={draft.budget.windowMs / 60000}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    budget: {
                      ...draft.budget,
                      windowMs: Math.round(Number(event.target.value) * 60000),
                    },
                  })
                }
              />
            </label>
            <label>
              기간 내 최대 호출
              <input
                type="number"
                min={1}
                max={1000}
                required
                value={draft.budget.maxCalls}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    budget: {
                      ...draft.budget,
                      maxCalls: Number(event.target.value),
                    },
                  })
                }
              />
            </label>
            <label>
              기간 내 실행 시간(분)
              <input
                type="number"
                min={1 / 60}
                step="any"
                max={draft.budget.windowMs / 60000}
                required
                value={draft.budget.maxRunMs / 60000}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    budget: {
                      ...draft.budget,
                      maxRunMs: Math.round(Number(event.target.value) * 60000),
                    },
                  })
                }
              />
            </label>
          </div>
        </div>
      </details>
      <div className="goal-actions">
        <button
          className="primary"
          disabled={busy || !draft.description.trim() || !draft.completionCriteria.trim()}
        >
          목표 저장
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={onClose}>
          입력 닫기
        </button>
      </div>
    </form>
  );
}
