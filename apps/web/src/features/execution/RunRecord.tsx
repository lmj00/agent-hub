import { useId } from "react";
import type { DevelopmentEvidence, RunDetails } from "@agent-hub/contracts";
import { dateTime, elapsed, Status, statusLabels } from "../../shared/format.js";
import { PlanningEvidencePanel } from "./PlanningEvidencePanel.js";
import { RuntimeSkillPanel } from "./RuntimeSkillPanel.js";
import { DevelopmentEvidencePanel, developmentPhaseLabels } from "./DevelopmentEvidencePanel.js";
import { GoalVerificationPanel, goalVerificationPhaseLabels } from "./GoalVerificationPanel.js";
import { ReportContent } from "../../shared/ReportContent.js";
import { stopReasons, runErrors } from "./run-labels.js";

const developmentStage: Record<DevelopmentEvidence["phase"], string> = {
  preparing: "준비",
  developing: "개발",
  needs_changes: "개발",
  preparing_test: "테스트",
  testing: "테스트",
  reviewing: "검토",
  verified: "검토",
  applying: "반영",
  applied: "반영",
};

export function RunAttention({ run, viewingLatest }: { run: RunDetails; viewingLatest: boolean }) {
  if (!run.stopReason && !run.errorCode) return null;
  const assessment = run.steps.findLast((step) => step.assessment)?.assessment;
  const incomplete = run.errorCode === "analysis_incomplete";
  const continuing = run.errorCode === "development_continue";
  const finding = incomplete ? (assessment?.unresolved[0] ?? assessment?.report) : null;
  return (
    <section className="run-attention" aria-label="실행 보류 사유">
      {!viewingLatest ? (
        <p>이전 실행의 기록입니다. 아래 작업 제어는 최신 실행에 적용됩니다.</p>
      ) : null}
      <div className="section-heading">
        <h3>
          {run.stopReason
            ? stopReasons[run.stopReason]
            : incomplete
              ? "확인이 필요한 내용"
              : continuing
                ? "후속 수정 대기"
                : "실행 확인 필요"}
        </h3>
        <span className="attention-mark" aria-hidden="true">
          {continuing ? "↻" : "!"}
        </span>
      </div>
      <p>
        {finding
          ? finding.length > 160
            ? `${finding.slice(0, 160)}…`
            : finding
          : run.errorCode
            ? (runErrors[run.errorCode] ??
              "실행 중 문제가 기록됐습니다. 상세 기록을 확인해 주세요.")
            : "실행 중단 요청이 기록됐습니다."}
      </p>
      {incomplete ? (
        <p className="attention-next">
          아래 확인 내용을 읽고 원인을 해결한 뒤 재개하세요. 같은 지시로 다시 실행하며, 답변 입력은
          지원하지 않습니다.
        </p>
      ) : null}
      {incomplete && assessment && (assessment.unresolved.length > 0 || assessment.report) ? (
        <details className="attention-findings">
          <summary>
            확인할 내용 보기
            {assessment.unresolved.length ? ` · ${assessment.unresolved.length}건` : ""}
          </summary>
          {assessment.unresolved.length ? (
            <ul className="unresolved-list">
              {assessment.unresolved.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          ) : (
            <p className="blocker-report">{assessment.report}</p>
          )}
        </details>
      ) : null}
      <details className="attention-technical">
        <summary>오류 코드와 종료 기록</summary>
        {run.errorCode ? <code>{run.errorCode}</code> : null}
        <p>종료 확인 {dateTime(run.terminationConfirmedAt)}</p>
        {run.retryAt ? <p>재시도 시각 {dateTime(run.retryAt)}</p> : null}
      </details>
    </section>
  );
}

export function RunActivity({
  run,
  live,
  checkedAt,
  disconnected,
  taskKind,
}: {
  run: RunDetails;
  live: boolean;
  checkedAt: Date | null;
  disconnected: boolean;
  taskKind?: "planning" | "work";
}) {
  const current =
    live && !disconnected && run.status === "running" && !run.finishedAt && !run.stopRequestedAt;
  const phase = run.goalVerification
    ? goalVerificationPhaseLabels[run.goalVerification.phase]
    : run.developmentEvidence
      ? developmentPhaseLabels[run.developmentEvidence.phase]
      : taskKind === "planning"
        ? "다음 작업 계획"
        : run.steps.length
          ? `분석 · 단계 ${run.steps.at(-1)!.sequence}`
          : "실행 준비";
  return (
    <section
      className={`run-activity ${current ? "is-current" : ""}`}
      aria-label="실행 흐름과 최근 활동"
    >
      <div className="run-activity-heading">
        <div>
          <span className="run-activity-label">
            {disconnected
              ? "연결 끊김 · 마지막 기록"
              : current
                ? "진행 중인 단계"
                : "마지막 실행 단계"}
          </span>
          <strong>{phase}</strong>
        </div>
        <span className="run-duration">
          {run.finishedAt ? "실행 시간" : current ? "시작 후" : "기록된 경과"}{" "}
          {elapsed(
            run.startedAt,
            run.finishedAt ??
              (current ? (checkedAt?.toISOString() ?? run.lastActivityAt) : run.lastActivityAt),
          )}
        </span>
      </div>
      {run.developmentEvidence ? (
        <ol className="run-track" aria-label="개발 작업 흐름">
          {["준비", "개발", "테스트", "검토", "반영"].map((stage) => (
            <li
              key={stage}
              aria-current={
                developmentStage[run.developmentEvidence!.phase] === stage ? "step" : undefined
              }
            >
              <span aria-hidden="true" />
              {stage}
            </li>
          ))}
        </ol>
      ) : taskKind === "planning" && !run.goalVerification ? (
        <ol className="run-track" aria-label="목표에서 다음 작업으로">
          {["목표", "계획", "다음 작업"].map((stage) => (
            <li key={stage} aria-current={stage === "계획" ? "step" : undefined}>
              <span aria-hidden="true" />
              {stage}
            </li>
          ))}
        </ol>
      ) : null}
      <p className="run-last-activity">
        <span>최근 활동 기록</span>
        <time dateTime={run.lastActivityAt}>{dateTime(run.lastActivityAt)}</time>
        <span className="run-activity-note">저장된 이벤트 기준</span>
      </p>
    </section>
  );
}

export type RunView = "result" | "evidence" | "history";

export function RunRecord({
  run,
  view,
  onView,
  viewingLatest,
  checkedAt,
  disconnected,
}: {
  run: RunDetails;
  view: RunView;
  onView: (value: RunView) => void;
  viewingLatest: boolean;
  checkedAt: Date | null;
  disconnected: boolean;
}) {
  const tabId = useId();
  const hasEvidence = !!(run.planningEvidence || run.developmentEvidence || run.goalVerification);
  const tab = view === "evidence" && !hasEvidence ? "result" : view;
  const tabs: { value: RunView; label: string }[] = [
    { value: "result", label: "결과" },
    ...(hasEvidence
      ? [{ value: "evidence" as const, label: run.planningEvidence ? "판단 근거" : "변경·검증" }]
      : []),
    { value: "history", label: "실행 기록" },
  ];
  return (
    <div className="run-record">
      {!viewingLatest ? (
        <p className="notice">
          이전 실행 기록입니다. 위 작업 제어는 현재 작업의 최신 실행에 적용됩니다.
        </p>
      ) : null}
      <div className="run-tabs" role="tablist" aria-label="실행 상세 보기">
        {tabs.map((item, index) => (
          <button
            key={item.value}
            role="tab"
            id={`${tabId}-${item.value}`}
            aria-controls={`${tabId}-${item.value}-panel`}
            aria-selected={tab === item.value}
            tabIndex={tab === item.value ? 0 : -1}
            onClick={() => onView(item.value)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % tabs.length
                  : event.key === "ArrowLeft"
                    ? (index + tabs.length - 1) % tabs.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? tabs.length - 1
                        : null;
              if (next === null) return;
              event.preventDefault();
              const selected = tabs[next]!;
              onView(selected.value);
              document.getElementById(`${tabId}-${selected.value}`)?.focus();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        className="run-panel run-result"
        role="tabpanel"
        id={`${tabId}-result-panel`}
        aria-labelledby={`${tabId}-result`}
        hidden={tab !== "result"}
        tabIndex={0}
      >
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
        {run.result ? (
          <ReportContent text={run.result} />
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
        {!run.result && hasEvidence ? (
          <button className="secondary evidence-shortcut" onClick={() => onView("evidence")}>
            {run.planningEvidence ? "판단 근거 보기" : "변경·검증 보기"}
          </button>
        ) : null}
      </div>
      {hasEvidence ? (
        <div
          className="run-panel"
          role="tabpanel"
          id={`${tabId}-evidence-panel`}
          aria-labelledby={`${tabId}-evidence`}
          hidden={tab !== "evidence"}
          tabIndex={0}
        >
          {run.planningEvidence ? (
            <details className="planning-context">
              <summary>계획에 사용한 자료</summary>
              <PlanningEvidencePanel evidence={run.planningEvidence} />
            </details>
          ) : null}
          {run.developmentEvidence ? (
            <DevelopmentEvidencePanel evidence={run.developmentEvidence} />
          ) : null}
          {run.goalVerification ? <GoalVerificationPanel evidence={run.goalVerification} /> : null}
        </div>
      ) : null}
      <div
        className="run-panel"
        role="tabpanel"
        id={`${tabId}-history-panel`}
        aria-labelledby={`${tabId}-history`}
        hidden={tab !== "history"}
        tabIndex={0}
      >
        <details className="run-metadata">
          <summary>
            실행 정보
            <span>
              {elapsed(
                run.startedAt,
                run.finishedAt ??
                  (disconnected ? (checkedAt?.toISOString() ?? run.lastActivityAt) : null),
              )}
            </span>
          </summary>
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
          </dl>
          <p className="subtle-note">
            최근 활동은 마지막으로 기록한 이벤트 시각입니다. 현재 프로세스의 생존이나 작업 진척을
            보장하지 않습니다.
          </p>
        </details>
        <details className="run-technical">
          <summary>모델과 추론 설정</summary>
          <dl className="run-facts">
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
        </details>
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
                    <ReportContent text={step.assessment.report} />
                    {step.assessment.evidence.length ? (
                      <p>
                        <strong>근거</strong> {step.assessment.evidence.join(" · ")}
                      </p>
                    ) : null}
                    {step.assessment.unresolved.length ? (
                      <p>
                        <strong>미해결 사항</strong> {step.assessment.unresolved.join(" · ")}
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
                    제공된 토큰: 입력 {step.usage.inputTokens} · 캐시 {step.usage.cachedInputTokens}{" "}
                    · 출력 {step.usage.outputTokens}
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
    </div>
  );
}
