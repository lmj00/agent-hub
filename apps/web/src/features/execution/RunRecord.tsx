import type { RunDetails } from "@agent-hub/contracts";
import { dateTime, elapsed, Status, statusLabels } from "../../shared/format.js";
import { PlanningEvidencePanel } from "./PlanningEvidencePanel.js";
import { RuntimeSkillPanel } from "./RuntimeSkillPanel.js";
import { DevelopmentEvidencePanel, developmentPhaseLabels } from "./DevelopmentEvidencePanel.js";
import { GoalVerificationPanel, goalVerificationPhaseLabels } from "./GoalVerificationPanel.js";
import { stopReasons, runErrors } from "./run-labels.js";

export function RunRecord({
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
          이전 실행 기록입니다. 위 작업 제어는 현재 작업의 최신 실행에 적용됩니다.
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
                (disconnected ? (checkedAt?.toISOString() ?? run.lastActivityAt) : null),
            )}
          </dd>
        </div>
        <div>
          <dt>
            {(run.developmentEvidence || run.goalVerification) && run.finishedAt
              ? "마지막 단계"
              : "현재 단계"}
          </dt>
          <dd>
            {run.goalVerification
              ? goalVerificationPhaseLabels[run.goalVerification.phase]
              : run.developmentEvidence
                ? developmentPhaseLabels[run.developmentEvidence.phase]
                : run.steps.length
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
        최근 활동은 마지막으로 기록한 이벤트 시각입니다. 현재 프로세스의 생존이나 작업 진척을
        보장하지 않습니다.
      </p>
      {run.stopReason || run.errorCode ? (
        <div className="notice attention">
          <strong>{run.stopReason ? stopReasons[run.stopReason] : "실행 확인 필요"}</strong>
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
            {run.retryAt ||
            (run.status === "waiting_capacity" && run.errorCode !== "budget_limit") ? (
              <div>
                <dt>재시도 시각</dt>
                <dd>{dateTime(run.retryAt)}</dd>
              </div>
            ) : null}
          </dl>
        </div>
      ) : null}
      <div className="section-heading report-heading">
        <h3>
          {run.goalVerification
            ? "목표 검토 결과"
            : run.developmentEvidence
              ? "개발 결과"
              : "분석 결과"}
        </h3>
        {run.finishedAt ? <small>{dateTime(run.finishedAt)}</small> : null}
      </div>
      {run.planningEvidence ? <PlanningEvidencePanel evidence={run.planningEvidence} /> : null}
      {run.developmentEvidence ? (
        <DevelopmentEvidencePanel evidence={run.developmentEvidence} />
      ) : null}
      {run.goalVerification ? <GoalVerificationPanel evidence={run.goalVerification} /> : null}
      {run.result ? (
        <pre className="analysis-result">{run.result}</pre>
      ) : (
        <p className="empty-list">
          {run.developmentEvidence
            ? run.developmentEvidence.phase === "verified"
              ? "검증을 통과했습니다. 변경 반영은 아직 확인되지 않았습니다."
              : run.status === "running"
                ? "개발·검증이 진행 중입니다. 저장된 단계별 기록을 확인할 수 있습니다."
                : "저장된 개발 완료 결과가 없습니다."
            : run.status === "running"
              ? "분석이 진행 중입니다. 결과가 저장되면 여기에 표시됩니다."
              : "저장된 분석 결과가 없습니다."}
        </p>
      )}
      <RuntimeSkillPanel run={run} />
      {run.steps.some((step) => step.purpose) ? (
        <section
          className="step-history"
          aria-label={run.developmentEvidence ? "AI 호출 기록" : "단계별 분석 기록"}
        >
          <div className="section-heading">
            <h3>{run.developmentEvidence ? "AI 호출 기록" : "단계별 분석 기록"}</h3>
            <span className="count">{run.steps.length}</span>
          </div>
          {run.steps.map((step) => (
            <details key={step.sequence} className="event-details">
              <summary>
                {step.sequence}. {step.purpose ?? "분석"} · {step.effort ?? run.effort} ·{" "}
                {statusLabels[step.status]}
              </summary>
              <p className="subtle-note">
                {step.effortReason} · {elapsed(step.startedAt, step.finishedAt)} ·{" "}
                {step.model ?? run.model}
              </p>
              {step.assessment ? (
                <>
                  <pre className="analysis-result">{step.assessment.report}</pre>
                  {step.assessment.evidence.length ? (
                    <p>
                      <strong>근거</strong> {step.assessment.evidence.join(" · ")}
                    </p>
                  ) : null}
                  {step.assessment.unresolved.length ? (
                    <p>
                      <strong>남은 질문</strong> {step.assessment.unresolved.join(" · ")}
                    </p>
                  ) : null}
                  {step.assessment.next ? (
                    <p>
                      <strong>다음 단계 제안</strong> {step.assessment.next.purpose} ·{" "}
                      {step.assessment.next.effort}: {step.assessment.next.reason}
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="empty-list">이 호출의 결과가 아직 저장되지 않았습니다.</p>
              )}
              {step.usage ? (
                <p className="subtle-note">
                  제공된 토큰: 입력 {step.usage.inputTokens} · 캐시 {step.usage.cachedInputTokens} ·
                  출력 {step.usage.outputTokens}
                </p>
              ) : null}
            </details>
          ))}
        </section>
      ) : null}
      <details className="event-details">
        <summary>
          활동 기록 <span>{run.events.length}건</span>
        </summary>
        <ol className="event-list">
          {run.events.map((event) => (
            <li key={event.sequence}>
              <span className="event-index">{event.sequence}</span>
              <code>{event.kind}</code>
              <time dateTime={event.createdAt}>{dateTime(event.createdAt)}</time>
            </li>
          ))}
        </ol>
        {!run.events.length ? <p className="muted">기록된 이벤트가 없습니다.</p> : null}
      </details>
    </div>
  );
}
