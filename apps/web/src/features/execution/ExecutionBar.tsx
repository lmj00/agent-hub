import type { Queue, ProviderGate } from "@agent-hub/contracts";
import { useEffect, useRef } from "react";
import { dateTime } from "../../shared/format.js";

const queueLabels: Record<Queue["state"], string> = {
  disabled: "자동 실행 꺼짐",
  idle: "다음 작업 대기",
  running: "작업 실행 중",
  recovering: "실행 상태 확인 중",
  held: "새 실행 보류",
  error: "실행기 확인 필요",
  stopping: "실행기 종료 중",
  stopped: "실행기 종료됨",
};
const gateLabels: Record<NonNullable<ProviderGate["reason"]>, string> = {
  capacity: "계정 사용량 제한",
  authentication: "AI 계정 인증 확인 필요",
  configuration: "AI 실행 설정 확인 필요",
};

const capacityReasons: Record<string, string> = {
  waiting: "확인 시각까지 기다립니다.",
  ready: "확인 실행 하나를 예약했습니다.",
  checking: "확인 실행이 진행 중입니다.",
  check_limit: "계정 확인 횟수 상한에 도달했습니다. 제한 정책을 검토해 주세요.",
  task_limit: "원인 작업의 실행 상한에 도달했습니다. 작업 기록을 검토해 주세요.",
  task_unavailable:
    "원인 작업을 자동으로 재개할 수 없습니다. 실행 가능한 작업을 선택해 수동으로 확인해 주세요.",
  termination_unconfirmed: "이전 실행의 종료를 먼저 확인해야 합니다.",
};
export function ExecutionBar({
  queue,
  gate,
  stale = false,
}: {
  queue: Queue;
  gate: ProviderGate;
  stale?: boolean;
}) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const needsAttention =
    gate.blocked || queue.state === "held" || queue.state === "error" || !!queue.reason || stale;
  useEffect(() => {
    // Open a changed warning without replacing the focused summary or undoing a
    // manual collapse on ordinary polling updates.
    if (needsAttention && disclosure.current) disclosure.current.open = true;
  }, [needsAttention, queue.state, queue.reason, queue.runId, gate.version, stale]);
  return (
    <section
      className={`execution-bar ${gate.blocked || queue.state === "held" || queue.state === "error" ? "attention" : ""}`}
      aria-label="자동 실행 상태"
    >
      <details ref={disclosure}>
        <summary>
          <span className="eyebrow">{stale ? "서버 · 마지막 기록" : "서버 실행 상태"}</span>
          <strong>
            {queue.reason === "repository_import"
              ? "저장소 준비 대기"
              : queue.reason === "period_budget"
                ? "기간 예산 대기"
                : queue.reason === "development_pending"
                  ? "개발 실행 연결 대기"
                  : queueLabels[queue.state]}
          </strong>
          <span className="execution-toggle">상태 상세</span>
        </summary>
        <p>
          {gate.blocked
            ? `${gateLabels[gate.reason!] ?? "AI 계정 확인 필요"} · 제공자 재시도 시각 ${gate.retryAt ? dateTime(gate.retryAt) : "미제공"}`
            : queue.state === "disabled"
              ? "서버에 실행 설정을 연결하면 대기 작업을 순서대로 처리합니다."
              : queue.reason === "repository_import"
                ? "저장소 소스 준비가 끝나면 AI 작업을 이어갑니다."
                : queue.reason === "period_budget"
                  ? "실행 예산이 있는 작업을 기다립니다. 각 작업에서 대기 이유와 다음 확인 시각을 볼 수 있습니다."
                  : queue.reason === "development_pending"
                    ? "개발 작업을 시작하려면 해당 작업 공간의 컨테이너 실행과 테스트 설정이 필요합니다."
                    : queue.reason === "change_application_pending"
                      ? "이전 코드 반영 결과를 확인해야 합니다. 해당 작업에서 상태 확인을 요청해 주세요."
                      : queue.state === "held"
                        ? "종료가 확인되지 않은 실행을 먼저 확인해 주세요."
                        : queue.state === "error"
                          ? "실행기 상태 조회에 실패했습니다. 서버 기록을 확인해 주세요."
                          : "한 번에 하나의 작업을 처리합니다. 실행 기록에서 진행 상황을 확인하세요."}
        </p>
        {gate.blocked && gate.reason === "capacity" && gate.capacityState ? (
          <div className="capacity-summary" aria-label="계정 사용량 확인">
            <strong>
              계정 확인 {gate.capacityState.checks} / {gate.capacityState.policy.maxChecks}회
            </strong>
            {gate.capacityState.nextCheckAt ? (
              <span>다음 확인 가능 시각 {dateTime(gate.capacityState.nextCheckAt)}</span>
            ) : null}
            <span>
              {capacityReasons[gate.capacityState.reason] ?? "계정 확인 조건을 검토하고 있습니다."}
            </span>
            {!queue.capacityRecoveryEnabled ? (
              <span>현재 자동 한도 확인은 꺼져 있으며 저장된 제한은 유지됩니다.</span>
            ) : null}
          </div>
        ) : null}
        {queue.lastCheckedAt ? <small>실행기 확인 {dateTime(queue.lastCheckedAt)}</small> : null}
      </details>
    </section>
  );
}
