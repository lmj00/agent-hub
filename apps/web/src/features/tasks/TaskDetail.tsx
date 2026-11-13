import { useCallback, useEffect, useRef, useState } from "react";
import {
  runsSchema,
  goalSchema,
  taskReleaseSchema,
  type ReleaseTask,
  runDetailsSchema,
  recoverySchema,
  type Task,
  type Queue,
  type ProviderGate,
  type Recovery,
  type RecoveryAction,
} from "@agent-hub/contracts";
import { api, ApiError, errorMessage } from "../../shared/api.js";
import { dateTime, Status, statusLabels, taskTitle } from "../../shared/format.js";
import { usePolling } from "../../shared/use-polling.js";

import { RunActivity, RunAttention, RunRecord, type RunView } from "../execution/RunRecord.js";

const actions: Record<RecoveryAction, string> = {
  cancel: "취소",
  reconcile: "상태 확인",
  resume: "재개",
};
const retryReasons: Record<string, string> = {
  capacity_waiting: "사용량 제한 회복을 확인할 시각까지 기다립니다. 계정 전체의 차단은 유지됩니다.",
  capacity_check_ready: "사용량 제한을 확인할 실행 하나를 예약했습니다.",
  capacity_check_limit: "계정 확인 횟수 상한에 도달했습니다. 정책을 검토해 주세요.",
  capacity_termination_unconfirmed: "이전 실행의 종료를 확인하지 못해 한도 확인도 보류했습니다.",
  retry_scheduled: "예약된 시각에 실행 조건을 확인한 뒤 자동으로 이어갑니다.",
  retry_ready: "재시도 시각이 됐습니다. 배정 조건을 확인하고 있습니다.",
  retry_limit: "재시도 횟수 상한에 도달했습니다. 정책과 실패 원인을 검토해 주세요.",
  repeated_error_limit: "같은 오류가 반복되어 자동 실행을 보류했습니다.",
  task_time_limit: "작업의 누적 실행 시간 상한에 도달했습니다.",
  termination_unconfirmed: "이전 실행의 종료 근거가 부족합니다. 종료 확인이 필요합니다.",
  change_application_unconfirmed:
    "코드 반영 결과를 대조하지 못했습니다. 원본과 개발 저장소 상태를 확인한 뒤 상태 확인을 요청해 주세요.",
  capacity_manual_check:
    "사용량 제한으로 보류했습니다. 현재 단계에서는 수동 확인 실행이 필요합니다.",
  authentication_required: "AI 계정 로그인을 복구한 뒤 재개해 주세요.",
  configuration_required: "AI 실행 설정을 확인해 주세요.",
  not_retryable: "자동 재시도 대상이 아닌 오류입니다. 실행 결과를 확인해 주세요.",
  user_cancelled: "사용자가 취소하여 다시 실행하지 않습니다.",
};
const continuationReasons: Record<string, string> = {
  retry_limit: "추가 실행 횟수 상한에 도달했습니다. 남은 수정과 실행 정책을 확인해 주세요.",
  repeated_error_limit: "연속 이어가기 횟수 상한에 도달하여 자동 실행을 보류했습니다.",
};
export function TaskDetail({
  task,
  queue,
  gate,
  onExpired,
  onChanged,
  onSelectTask,
  onBack,
  executionConnected,
  focused,
  onFocusChange,
}: {
  task: Task;
  queue: Queue | null;
  gate: ProviderGate | null;
  onExpired: () => void;
  onChanged: () => void;
  onSelectTask: (id: string) => void;
  onBack: () => void;
  executionConnected: boolean;
  focused: boolean;
  onFocusChange: (focused: boolean) => void;
}) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runView, setRunView] = useState<RunView>("result");
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => {
    setRevision((value) => value + 1);
    onChanged();
  }, [onChanged]);
  const load = useCallback(
    async (signal: AbortSignal) => {
      const { runs } = await api.request(`/tasks/${task.id}/runs`, runsSchema, {
        signal,
      });
      const id = selectedRunId ?? runs[0]?.id;
      const detail = id ? await api.request(`/runs/${id}`, runDetailsSchema, { signal }) : null;
      return { runs, detail };
    },
    [task.id, selectedRunId],
  );
  const records = usePolling(
    `${task.id}:${selectedRunId ?? "latest"}`,
    load,
    onExpired,
    3000,
    revision,
  );
  const runs = records.data?.runs ?? [];
  const run = records.data?.detail ?? null;
  const latest = runs[0] ?? null;
  const [receipt, setReceipt] = useState<Recovery | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const releaseCommand = useRef<ReleaseTask | null>(null);
  const identities = useRef(new Map<string, string>());
  const receiptId = receipt?.status === "pending" ? receipt.id : null;
  const loadReceipt = useCallback(
    (signal: AbortSignal) =>
      api.request(`/recovery-requests/${receiptId}`, recoverySchema, {
        signal,
      }),
    [receiptId],
  );
  const receiptPoll = usePolling(receiptId, loadReceipt, onExpired, 1000);
  useEffect(() => {
    if (receiptPoll.data && receiptPoll.data.status !== "pending") {
      setReceipt(receiptPoll.data);
      refresh();
    }
  }, [receiptPoll.data, refresh]);

  async function releaseWork() {
    if (busy || !task.goalId) return;
    setBusy(true);
    setError(null);
    try {
      if (!releaseCommand.current) {
        const goal = await api.request(`/goals/${task.goalId}`, goalSchema);
        releaseCommand.current = {
          requestKey: crypto.randomUUID(),
          expectedGoalVersion: goal.version,
        };
      }
      const accepted = await api.request(`/tasks/${task.id}/release`, taskReleaseSchema, {
        method: "POST",
        body: releaseCommand.current,
      });
      releaseCommand.current = null;
      refresh();
      onSelectTask(accepted.newTaskId);
    } catch (failure) {
      // Uncertain delivery retains both the key and the expected Goal version.
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500)
        releaseCommand.current = null;
      if (failure instanceof ApiError && failure.status === 401) onExpired();
      else setError(failure);
      refresh();
    } finally {
      setBusy(false);
    }
  }

  async function requestAction(action: RecoveryAction) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const runId = latest?.id ?? null;
    const providerGateVersion = action === "resume" && gate?.blocked ? gate.version : null;
    const signature = JSON.stringify({ action, runId, providerGateVersion });
    let requestKey = identities.current.get(signature);
    if (!requestKey) {
      requestKey = crypto.randomUUID();
      identities.current.set(signature, requestKey);
    }
    try {
      const accepted = await api.request(`/tasks/${task.id}/recovery-requests`, recoverySchema, {
        method: "POST",
        body: { action, runId, providerGateVersion, requestKey },
      });
      setReceipt(accepted);
      identities.current.delete(signature);
      refresh();
    } catch (failure) {
      // 명확한 거부는 다음 요청에서 다시 판단합니다. 통신 단절·5xx는 같은 접수 키를 유지합니다.
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500)
        identities.current.delete(signature);
      if (failure instanceof ApiError && failure.status === 401) onExpired();
      else setError(failure);
      refresh();
    } finally {
      setBusy(false);
    }
  }
  const active = !!latest && queue?.state === "running" && queue.runId === latest.id;
  const terminal = task.status === "succeeded" || task.status === "cancelled";
  const pending = receipt?.status === "pending";
  const enabled =
    queue !== null &&
    queue.state !== "disabled" &&
    queue.state !== "stopped" &&
    queue.state !== "stopping";
  const viewingLatest = run?.id === latest?.id;
  const title = taskTitle(task.instruction);
  const capacityLimited =
    gate?.reason === "capacity" &&
    !!gate.capacityState &&
    (gate.capacityState.checks >= gate.capacityState.policy.maxChecks ||
      (!!gate.capacityState.nextCheckAt &&
        Date.parse(gate.capacityState.nextCheckAt) > Date.now()));
  const retryLimited =
    !!task.retryState &&
    ((task.retryState.policy.maxRetries !== null &&
      task.retryState.retries >= task.retryState.policy.maxRetries) ||
      (task.retryState.policy.maxConsecutiveErrors !== null &&
        task.retryState.consecutiveErrors >= task.retryState.policy.maxConsecutiveErrors) ||
      (task.retryState.policy.maxTotalRunMs !== null &&
        task.retryState.totalRunMs >= task.retryState.policy.maxTotalRunMs) ||
      (!!task.retryState.nextAttemptAt && Date.parse(task.retryState.nextAttemptAt) > Date.now()));
  const goalReview = task.goalReview ? (
    <details
      className="task-context"
      aria-label="목표 범위 재검사"
      open={task.goalReview.decision !== "retained"}
    >
      <summary>
        {task.goalReview.decision === "retained"
          ? "변경된 목표에서도 허용된 작업입니다."
          : "목표의 허용 범위를 벗어나 제외한 작업입니다."}
      </summary>
      <p>
        목표 버전 {task.goalReview.fromVersion} → {task.goalReview.toVersion} · 확인{" "}
        {dateTime(task.goalReview.checkedAt)}
      </p>
      <small>
        {task.goalReview.decision === "retained"
          ? "기존 실행 이력과 재시도·시간 제한은 유지합니다."
          : "사용자 취소와 구분해 기록하며 이 작업을 자동 재개하지 않습니다."}
      </small>
    </details>
  ) : null;
  return (
    <section
      className="task-detail"
      aria-labelledby="detail-heading"
      onKeyDown={(event) => {
        if (event.key === "Escape" && focused && !event.defaultPrevented) {
          onFocusChange(false);
          event.currentTarget.querySelector<HTMLButtonElement>(".detail-focus")?.focus();
        }
      }}
    >
      <button className="task-back quiet" onClick={onBack}>
        <span aria-hidden="true">←</span> 작업 목록
      </button>
      <header className="task-detail-header">
        <div className="detail-top">
          <p className="eyebrow">{task.kind === "planning" ? "계획 기록" : "선택한 작업"}</p>
          <div className="detail-tools">
            <Status
              value={task.status}
              label={
                task.kind === "planning" && task.status === "succeeded" ? "판단 완료" : undefined
              }
            />
            <button
              className="quiet detail-focus"
              aria-pressed={focused}
              onClick={() => onFocusChange(!focused)}
              title={focused ? "Escape로 목록과 함께 보기" : "작업 목록을 접고 넓게 읽기"}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                <path
                  d={
                    focused
                      ? "M4 9h5V4m6 0v5h5M4 15h5v5m6 0v-5h5"
                      : "M4 9V4h5m6 0h5v5M4 15v5h5m6 0h5v-5"
                  }
                />
              </svg>
              {focused ? "목록과 함께 보기" : "집중 보기"}
            </button>
          </div>
        </div>
        <h2 id="detail-heading" className="instruction-title" tabIndex={-1}>
          {title}
        </h2>
      </header>
      {run ? (
        <RunActivity
          run={run}
          live={active && viewingLatest && task.status === "running"}
          checkedAt={records.checkedAt}
          disconnected={!!records.error || !executionConnected}
        />
      ) : null}
      <details className="task-info">
        <summary>
          작업 정보{" "}
          <span>
            등록 {dateTime(task.createdAt)} · 실행 {runs.length}회
          </span>
        </summary>
        <div className="task-instruction">
          <h3>작업 지시와 검증 기준</h3>
          <pre>{task.instruction}</pre>
        </div>
        {task.previousTaskId || task.nextTaskId ? (
          <details className="task-context" aria-label="다시 허용한 작업 연결">
            <summary>이전 작업과의 연결</summary>
            <p>취소 기록과 이전 실행 한도를 이어받는 작업입니다.</p>
            {task.previousTaskId ? (
              <button className="quiet" onClick={() => onSelectTask(task.previousTaskId!)}>
                이전 취소 작업 보기
              </button>
            ) : null}
            {task.nextTaskId ? (
              <button className="quiet" onClick={() => onSelectTask(task.nextTaskId!)}>
                다시 허용한 작업 보기
              </button>
            ) : null}
          </details>
        ) : null}
        {task.goalReview?.decision === "retained" ? goalReview : null}
      </details>
      {task.goalReview?.decision !== "retained" ? goalReview : null}
      {task.status === "cancelled" && task.planningTaskId && !task.nextTaskId ? (
        <div className="notice" aria-label="취소 작업 다시 허용">
          <p>
            현재 목표에서 허용하는 작업이면 새 작업으로 이어갑니다. 기존 취소 기록과 재시도·누적
            시간 한도는 유지합니다.
          </p>
          <button
            className="secondary"
            disabled={busy || pending}
            onClick={() => void releaseWork()}
          >
            취소한 작업 다시 허용
          </button>
        </div>
      ) : null}
      {task.budgetWait ? (
        <div className="notice attention" aria-label="기간 예산 대기">
          <strong>{task.budgetWait.scope === "goal" ? "목표" : "프로젝트"} 실행 예산 대기</strong>
          <p>
            {task.budgetWait.reason === "call_limit"
              ? "호출 횟수 한도"
              : task.budgetWait.reason === "time_limit"
                ? "실행 시간 한도"
                : "예산 기간 종료"}{" "}
            · 다음 확인 {dateTime(task.budgetWait.retryAt)}
          </p>
          <small>
            예산 기간이 바뀌면 자동으로 실행 조건을 다시 확인합니다. 계정 차단·목표 일시정지·작업
            취소와 재시도 한도는 유지됩니다.
          </small>
        </div>
      ) : null}
      {records.error ? (
        <div className="notice error" role="alert">
          {errorMessage(records.error)}
          <small>마지막 확인 {dateTime(records.checkedAt)}</small>
        </div>
      ) : null}
      {run ? <RunAttention run={run} viewingLatest={viewingLatest} /> : null}
      {task.status !== "succeeded" ? (
        <div className="task-actions" aria-label="작업 제어">
          <button
            className="primary"
            disabled={
              !enabled ||
              busy ||
              pending ||
              active ||
              terminal ||
              (viewingLatest && !!run?.developmentEvidence?.application) ||
              retryLimited ||
              capacityLimited ||
              (!!task.budgetWait && Date.parse(task.budgetWait.retryAt) > Date.now()) ||
              (task.status === "queued" && !gate?.blocked) ||
              !records.data
            }
            onClick={() => void requestAction("resume")}
          >
            작업 재개
          </button>
          <button
            className="secondary"
            disabled={
              !enabled ||
              busy ||
              pending ||
              active ||
              !latest ||
              (!!run?.terminationConfirmedAt &&
                viewingLatest &&
                !run.developmentEvidence?.application)
            }
            onClick={() => void requestAction("reconcile")}
          >
            상태 확인
          </button>
          <button
            className="danger-button"
            disabled={
              !enabled ||
              busy ||
              terminal ||
              !!(pending && receipt.action === "cancel") ||
              !records.data
            }
            onClick={() => void requestAction("cancel")}
          >
            작업 취소
          </button>
        </div>
      ) : null}
      {task.status !== "succeeded" ? (
        <p className="action-help">
          {terminal
            ? task.planningTaskId
              ? "취소가 완료됐습니다. 명시적으로 다시 허용하기 전에는 이 작업을 실행하지 않습니다."
              : "취소가 완료됐습니다. 다시 분석하려면 새 작업을 등록하세요."
            : !enabled
              ? "자동 실행을 설정한 서버에서 취소·재개를 요청할 수 있습니다."
              : active
                ? "취소를 요청하면 현재 분석을 멈추고, 종료 여부를 확인합니다."
                : "재개 요청은 종료 여부와 실행 제한을 확인한 뒤 대기열에 넣습니다."}
        </p>
      ) : null}
      {error ? (
        <div className="notice error" role="alert">
          {errorMessage(error)}
        </div>
      ) : null}
      {receipt ? (
        <div className={`notice ${receipt.status === "rejected" ? "error" : ""}`} role="status">
          <strong>
            {actions[receipt.action]}{" "}
            {receipt.status === "pending"
              ? "요청 접수됨"
              : receipt.status === "completed"
                ? "요청 처리됨"
                : "요청 보류됨"}
          </strong>
          <p>
            {receipt.status === "pending"
              ? "서버에서 조건을 확인하고 있습니다. 접수는 작업 완료를 뜻하지 않습니다."
              : receipt.errorCode
                ? errorMessage(new ApiError(409, receipt.errorCode))
                : receipt.resultStatus
                  ? `처리 결과: ${statusLabels[receipt.resultStatus]}`
                  : "최신 실행 기록을 확인해 주세요."}
          </p>
          {receiptPoll.error ? (
            <p className="error-text">
              처리 결과를 확인하지 못했습니다. {errorMessage(receiptPoll.error)}
            </p>
          ) : null}
        </div>
      ) : null}
      {runs.length > 1 ? (
        <div className="section-heading attempts-heading">
          <h3>실행 시도</h3>
          <span className="count">{runs.length}</span>
        </div>
      ) : null}
      {runs.length > 1 ? (
        <div className="attempts" aria-label="실행 시도 선택">
          {runs.map((item, index) => (
            <button
              key={item.id}
              className={`attempt ${run?.id === item.id ? "selected" : ""}`}
              aria-pressed={run?.id === item.id}
              onClick={() => setSelectedRunId(index === 0 ? null : item.id)}
            >
              <span className="attempt-number">{item.attempt}</span>
              <span>
                <strong>{index === 0 ? "최근 실행" : "이전 실행"}</strong>
                <small>{statusLabels[item.status]}</small>
              </span>
            </button>
          ))}
        </div>
      ) : runs.length === 0 ? (
        <p className="empty-list">
          {records.data
            ? task.status === "cancelled"
              ? "실행 전에 취소된 작업입니다. 자동으로 시작하지 않습니다."
              : task.budgetWait
                ? "예산 대기 중이며 아직 실행을 시작하지 않았습니다."
                : "아직 실행 기록이 없습니다. 대기 작업은 실행기가 순서대로 가져갑니다."
            : "실행 기록을 불러오는 중…"}
        </p>
      ) : null}
      {run ? (
        <RunRecord
          key={run.id}
          run={run}
          view={runView}
          onView={setRunView}
          viewingLatest={viewingLatest}
          checkedAt={records.checkedAt}
          disconnected={!!records.error || !executionConnected}
        />
      ) : null}
      {task.retryState ? (
        <div className="notice retry-status" aria-label="자동 복구 정책">
          <strong>
            {task.retryState.lastError === "development_continue" ? "추가 실행" : "재시도"}{" "}
            {task.retryState.retries}
            {task.retryState.policy.maxRetries === null
              ? "회 · 제한 없음"
              : ` / ${task.retryState.policy.maxRetries}회`}{" "}
            · {task.retryState.lastError === "development_continue" ? "연속 이어가기" : "같은 오류"}{" "}
            {task.retryState.consecutiveErrors}
            {task.retryState.policy.maxConsecutiveErrors === null
              ? "회 · 제한 없음"
              : ` / ${task.retryState.policy.maxConsecutiveErrors}회`}
          </strong>
          <span>
            누적 실행 {Math.ceil(task.retryState.totalRunMs / 1000)}초
            {task.retryState.policy.maxTotalRunMs === null
              ? " · 제한 없음"
              : ` / ${Math.ceil(task.retryState.policy.maxTotalRunMs / 1000)}초`}
          </span>
          {task.retryState.nextAttemptAt ? (
            <span>다음 시도 가능 시각 {dateTime(task.retryState.nextAttemptAt)}</span>
          ) : null}
          {task.retryState.reason ? (
            <span>
              {(task.retryState.lastError === "development_continue"
                ? continuationReasons[task.retryState.reason]
                : undefined) ??
                retryReasons[task.retryState.reason] ??
                "저장된 복구 조건을 확인하고 있습니다."}
            </span>
          ) : null}
          {gate?.blocked && task.retryState.nextAttemptAt ? (
            <small>계정 차단 중에는 허용된 확인 실행 하나만 시작할 수 있습니다.</small>
          ) : null}
          {!queue?.automaticRecoveryEnabled ? (
            <small>
              현재 자동 복구가 꺼져 있습니다. 저장된 예약은 자동 복구를 켠 서버에서 확인합니다.
            </small>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
