import { useCallback, useEffect, useRef, useState } from "react";
import {
  runsSchema,
  runDetailsSchema,
  recoverySchema,
  type Task,
  type Queue,
  type ProviderGate,
  type Recovery,
  type RecoveryAction,
  type RunDetails,
} from "@agent-hub/contracts";
import { api, ApiError, errorMessage } from "./api.js";
import { dateTime, elapsed, Status, statusLabels } from "./format.js";
import { usePolling } from "./use-polling.js";

const actions: Record<RecoveryAction, string> = {
  cancel: "취소",
  reconcile: "종료 확인",
  resume: "재개",
};
const stopReasons = {
  user_cancel: "사용자 취소 요청",
  server_shutdown: "서버 종료",
  timeout: "제한 시간 초과",
  unknown: "중단 이유 미확인",
};
const retryReasons: Record<string, string> = {
  capacity_waiting:
    "사용량 제한 회복을 확인할 시각까지 기다립니다. 계정 전체의 차단은 유지됩니다.",
  capacity_check_ready: "사용량 제한을 확인할 실행 하나를 예약했습니다.",
  capacity_check_limit:
    "계정 확인 횟수 상한에 도달했습니다. 정책을 검토해 주세요.",
  capacity_termination_unconfirmed:
    "이전 실행의 종료를 확인하지 못해 한도 확인도 보류했습니다.",
  retry_scheduled: "일시적 오류로 기다린 뒤 자동으로 다시 시도합니다.",
  retry_ready: "재시도 시각이 됐습니다. 배정 조건을 확인하고 있습니다.",
  retry_limit:
    "재시도 횟수 상한에 도달했습니다. 정책과 실패 원인을 검토해 주세요.",
  repeated_error_limit: "같은 오류가 반복되어 자동 실행을 보류했습니다.",
  task_time_limit: "작업의 누적 실행 시간 상한에 도달했습니다.",
  termination_unconfirmed:
    "이전 실행의 종료 근거가 부족합니다. 종료 확인이 필요합니다.",
  capacity_manual_check:
    "사용량 제한으로 보류했습니다. 현재 단계에서는 수동 확인 실행이 필요합니다.",
  authentication_required: "AI 계정 로그인을 복구한 뒤 재개해 주세요.",
  configuration_required: "AI 실행 설정을 확인해 주세요.",
  not_retryable:
    "자동 재시도 대상이 아닌 오류입니다. 실행 결과를 확인해 주세요.",
  user_cancelled: "사용자가 취소하여 다시 실행하지 않습니다.",
};
const runErrors: Record<string, string> = {
  termination_unconfirmed:
    "결과가 있어도 전체 실행 종료를 확인하기 전까지 새 실행은 보류합니다.",
  owner_lost:
    "실행을 관리하던 서버가 중단됐습니다. 이전 실행의 종료를 확인해 주세요.",
  timeout: "정해진 실행 시간을 초과했습니다.",
  transient: "AI 서비스와의 연결에 일시적인 오류가 발생했습니다.",
  server_shutdown: "서버 종료로 멈췄습니다. 종료 확인 후 재개할 수 있습니다.",
  cancel_requested:
    "취소 요청을 기록했습니다. 종료가 확인되면 취소가 완료됩니다.",
  capacity: "AI 계정의 사용량 제한으로 실행을 보류했습니다.",
  authentication: "AI 계정 로그인을 확인해 주세요.",
  configuration: "AI 실행 설정을 확인해 주세요.",
};

export function TaskDetail({
  task,
  queue,
  gate,
  onExpired,
  onChanged,
}: {
  task: Task;
  queue: Queue | null;
  gate: ProviderGate | null;
  onExpired: () => void;
  onChanged: () => void;
}) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
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
      const detail = id
        ? await api.request(`/runs/${id}`, runDetailsSchema, { signal })
        : null;
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

  async function requestAction(action: RecoveryAction) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const runId = latest?.id ?? null;
    const providerGateVersion =
      action === "resume" && gate?.blocked ? gate.version : null;
    const signature = JSON.stringify({ action, runId, providerGateVersion });
    let requestKey = identities.current.get(signature);
    if (!requestKey) {
      requestKey = crypto.randomUUID();
      identities.current.set(signature, requestKey);
    }
    try {
      const accepted = await api.request(
        `/tasks/${task.id}/recovery-requests`,
        recoverySchema,
        {
          method: "POST",
          body: { action, runId, providerGateVersion, requestKey },
        },
      );
      setReceipt(accepted);
      identities.current.delete(signature);
      refresh();
    } catch (failure) {
      // 명확한 거부는 다음 요청에서 다시 판단합니다. 통신 단절·5xx는 같은 접수 키를 유지합니다.
      if (
        failure instanceof ApiError &&
        failure.status >= 400 &&
        failure.status < 500
      )
        identities.current.delete(signature);
      if (failure instanceof ApiError && failure.status === 401) onExpired();
      else setError(failure);
      refresh();
    } finally {
      setBusy(false);
    }
  }
  const active =
    !!latest && queue?.state === "running" && queue.runId === latest.id;
  const terminal = task.status === "succeeded" || task.status === "cancelled";
  const pending = receipt?.status === "pending";
  const enabled =
    queue !== null &&
    queue.state !== "disabled" &&
    queue.state !== "stopped" &&
    queue.state !== "stopping";
  const viewingLatest = run?.id === latest?.id;
  const capacityLimited =
    gate?.reason === "capacity" &&
    !!gate.capacityState &&
    (gate.capacityState.checks >= gate.capacityState.policy.maxChecks ||
      (!!gate.capacityState.nextCheckAt &&
        Date.parse(gate.capacityState.nextCheckAt) > Date.now()));
  const retryLimited =
    !!task.retryState &&
    (task.retryState.retries >= task.retryState.policy.maxRetries ||
      task.retryState.consecutiveErrors >=
        task.retryState.policy.maxConsecutiveErrors ||
      task.retryState.totalRunMs >= task.retryState.policy.maxTotalRunMs ||
      (!!task.retryState.nextAttemptAt &&
        Date.parse(task.retryState.nextAttemptAt) > Date.now()));
  return (
    <section className="task-detail" aria-labelledby="detail-heading">
      <div className="detail-top">
        <p className="eyebrow">선택한 작업 · {task.id.slice(0, 8)}</p>
        <Status value={task.status} />
      </div>
      <h2 id="detail-heading" className="instruction-title">
        {task.instruction}
      </h2>
      <p className="detail-created">등록 {dateTime(task.createdAt)}</p>
      {task.retryState ? (
        <div className="notice retry-status" aria-label="자동 복구 정책">
          <strong>
            재시도 {task.retryState.retries} /{" "}
            {task.retryState.policy.maxRetries}회 · 같은 오류{" "}
            {task.retryState.consecutiveErrors} /{" "}
            {task.retryState.policy.maxConsecutiveErrors}회
          </strong>
          <span>
            누적 실행 {Math.ceil(task.retryState.totalRunMs / 1000)}초 /{" "}
            {Math.ceil(task.retryState.policy.maxTotalRunMs / 1000)}초
          </span>
          {task.retryState.nextAttemptAt ? (
            <span>
              다음 시도 가능 시각 {dateTime(task.retryState.nextAttemptAt)}
            </span>
          ) : null}
          {task.retryState.reason ? (
            <span>
              {retryReasons[task.retryState.reason] ??
                "저장된 복구 조건을 확인하고 있습니다."}
            </span>
          ) : null}
          {gate?.blocked && task.retryState.nextAttemptAt ? (
            <small>
              계정 차단 중에는 허용된 확인 실행 하나만 시작할 수 있습니다.
            </small>
          ) : null}
          {!queue?.automaticRecoveryEnabled ? (
            <small>
              현재 자동 복구가 꺼져 있습니다. 저장된 예약은 자동 복구를 켠
              서버에서 확인합니다.
            </small>
          ) : null}
        </div>
      ) : null}
      {records.error ? (
        <div className="notice error" role="alert">
          {errorMessage(records.error)}
          <small>마지막 확인 {dateTime(records.checkedAt)}</small>
        </div>
      ) : null}
      <div className="task-actions" aria-label="작업 제어">
        <button
          className="secondary"
          disabled={
            !enabled ||
            busy ||
            pending ||
            active ||
            terminal ||
            retryLimited ||
            capacityLimited ||
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
            (!!run?.terminationConfirmedAt && viewingLatest)
          }
          onClick={() => void requestAction("reconcile")}
        >
          종료 확인
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
      <p className="action-help">
        {terminal
          ? task.status === "succeeded"
            ? "분석이 완료됐습니다. 아래 결과를 확인하거나 새 작업을 등록하세요."
            : "취소가 완료됐습니다. 다시 분석하려면 새 작업을 등록하세요."
          : !enabled
            ? "자동 실행을 설정한 서버에서 취소·재개를 요청할 수 있습니다."
            : active
              ? "취소를 요청하면 현재 분석을 멈추고, 종료 여부를 확인합니다."
              : "재개 요청은 종료 여부와 실행 제한을 확인한 뒤 대기열에 넣습니다."}
      </p>
      {error ? (
        <div className="notice error" role="alert">
          {errorMessage(error)}
        </div>
      ) : null}
      {receipt ? (
        <div
          className={`notice ${receipt.status === "rejected" ? "error" : ""}`}
          role="status"
        >
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
      <div className="section-heading attempts-heading">
        <h3>실행 시도</h3>
        <span className="count">{runs.length}</span>
      </div>
      {runs.length ? (
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
      ) : (
        <p className="empty-list">
          {records.data
            ? "아직 실행 기록이 없습니다. 대기 작업은 실행기가 순서대로 가져갑니다."
            : "실행 기록을 불러오는 중…"}
        </p>
      )}
      {run ? (
        <RunRecord
          run={run}
          viewingLatest={viewingLatest}
          checkedAt={records.checkedAt}
          disconnected={!!records.error}
        />
      ) : null}
    </section>
  );
}

function RunRecord({
  run,
  viewingLatest,
  checkedAt,
  disconnected,
}: {
  run: RunDetails;
  viewingLatest: boolean;
  checkedAt: Date | null;
  disconnected: boolean;
}) {
  return (
    <div className="run-record">
      {!viewingLatest ? (
        <p className="notice">
          이전 실행 기록입니다. 위 작업 제어는 현재 작업의 최신 실행에
          적용됩니다.
        </p>
      ) : null}
      <dl className="run-facts">
        <div>
          <dt>실행 상태</dt>
          <dd>
            <Status value={run.status} />
          </dd>
        </div>
        <div>
          <dt>{run.finishedAt ? "실행 시간" : "시작 후 경과"}</dt>
          <dd>
            {elapsed(
              run.startedAt,
              run.finishedAt ??
                (disconnected
                  ? (checkedAt?.toISOString() ?? run.lastActivityAt)
                  : null),
            )}
          </dd>
        </div>
        <div>
          <dt>현재 단계</dt>
          <dd>
            {run.steps.length
              ? `분석 · 단계 ${run.steps.at(-1)!.sequence}`
              : "실행 준비"}
          </dd>
        </div>
        <div>
          <dt>최근 활동 기록</dt>
          <dd>{dateTime(run.lastActivityAt)}</dd>
        </div>
        <div>
          <dt>모델</dt>
          <dd className="mono">{run.model}</dd>
        </div>
        <div>
          <dt>추론 강도</dt>
          <dd>
            {run.effort}{" "}
            <small>
              {run.steps.at(-1)?.effortReason ??
                "이전 버전의 실행으로 선택 이유가 기록되지 않았습니다."}
            </small>
          </dd>
        </div>
      </dl>
      <p className="subtle-note">
        최근 활동은 마지막으로 기록한 이벤트 시각입니다. 현재 프로세스의
        생존이나 작업 진척을 보장하지 않습니다.
      </p>
      {run.stopReason || run.errorCode ? (
        <div className="notice attention">
          <strong>
            {run.stopReason ? stopReasons[run.stopReason] : "실행 확인 필요"}
          </strong>
          {run.errorCode ? (
            <p>
              {runErrors[run.errorCode] ??
                "실행 중 문제가 기록됐습니다. 아래 코드와 서버 기록을 확인해 주세요."}{" "}
              <code>{run.errorCode}</code>
            </p>
          ) : null}
          <dl className="notice-facts">
            <div>
              <dt>종료 확인</dt>
              <dd>{dateTime(run.terminationConfirmedAt)}</dd>
            </div>
            {run.retryAt || run.status === "waiting_capacity" ? (
              <div>
                <dt>재시도 시각</dt>
                <dd>{dateTime(run.retryAt)}</dd>
              </div>
            ) : null}
          </dl>
        </div>
      ) : null}
      <div className="section-heading report-heading">
        <h3>분석 결과</h3>
        {run.finishedAt ? <small>{dateTime(run.finishedAt)}</small> : null}
      </div>
      {run.result ? (
        <pre className="analysis-result">{run.result}</pre>
      ) : (
        <p className="empty-list">
          {run.status === "running"
            ? "분석이 진행 중입니다. 결과가 저장되면 여기에 표시됩니다."
            : "저장된 분석 결과가 없습니다."}
        </p>
      )}
      <details className="event-details">
        <summary>
          활동 기록 <span>{run.events.length}건</span>
        </summary>
        <ol className="event-list">
          {run.events.map((event) => (
            <li key={event.sequence}>
              <span className="event-index">{event.sequence}</span>
              <code>{event.kind}</code>
              <time dateTime={event.createdAt}>
                {dateTime(event.createdAt)}
              </time>
            </li>
          ))}
        </ol>
        {!run.events.length ? (
          <p className="muted">기록된 이벤트가 없습니다.</p>
        ) : null}
      </details>
    </div>
  );
}
