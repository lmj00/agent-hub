import type { DevelopmentEvidence } from "@agent-hub/contracts";
import { dateTime } from "./format.js";

export const developmentPhaseLabels: Record<DevelopmentEvidence["phase"], string> = {
  preparing: "개발 준비",
  developing: "개발",
  preparing_test: "테스트 준비",
  testing: "실제 테스트",
  reviewing: "독립 검토",
  needs_changes: "보완 필요",
  verified: "검증 완료",
  applying: "변경 반영 확인",
  applied: "변경 반영 완료",
};
const testLabels = {
  passed: "통과",
  failed: "실패",
  timed_out: "시간 초과",
  output_limit: "출력 한도 초과",
};
const changeLabels = { add: "추가", modify: "수정", delete: "삭제" };

export function DevelopmentEvidencePanel({ evidence }: { evidence: DevelopmentEvidence }) {
  return (
    <section className="development-evidence" aria-label="개발·검증 기록">
      <div className="section-heading">
        <h3>개발·검증 기록</h3>
        <span className="count">
          {evidence.rounds.length} / {evidence.maxRounds}회 수정
        </span>
      </div>
      <p className="subtle-note">
        각 수정 버전의 실제 테스트와 독립 검토를 기록합니다. 검증을 통과해도 변경 반영이 확인되기
        전에는 작업이 완료되지 않습니다.
      </p>
      <div className="development-check" aria-label="변경 반영 기록">
        <strong>
          {evidence.application?.status === "applied"
            ? "개발용 브랜치에 반영됨"
            : evidence.application
              ? "반영 완료 확인 필요"
              : "변경 반영 기록 없음"}
        </strong>
        {evidence.application ? (
          <>
            <p>
              {evidence.application.roundSequence}차 수정 · 반영 예약{" "}
              {dateTime(evidence.application.createdAt)}
              {evidence.application.appliedAt
                ? ` · 반영 확인 ${dateTime(evidence.application.appliedAt)}`
                : ""}
            </p>
            <p>
              {evidence.application.status === "applied"
                ? "이 코드가 다음 작업의 기준이 됩니다. 작업이 취소돼도 이미 반영된 코드는 자동으로 되돌리지 않습니다."
                : "완료 여부가 아직 확인되지 않았습니다. 상태 확인으로 저장된 기록과 실제 코드를 대조할 수 있습니다."}
            </p>
            <details>
              <summary>반영 버전 보기</summary>
              <p>
                기준 커밋{" "}
                <code className="application-revision">{evidence.application.baseRevision}</code>
              </p>
              <p>
                {evidence.application.status === "applied" ? "결과 커밋" : "반영 예정 커밋"}{" "}
                <code className="application-revision">{evidence.application.resultCommit}</code>
              </p>
              <p>
                검증한 후보{" "}
                <code className="application-revision">{evidence.application.candidateDigest}</code>
              </p>
            </details>
          </>
        ) : (
          <p>테스트와 검토를 통과했더라도 반영 기록 없이는 작업 완료로 처리하지 않습니다.</p>
        )}
      </div>
      {!evidence.rounds.length ? <p>저장된 개발 회차가 없습니다.</p> : null}
      {evidence.rounds.map((round, index) => (
        <details
          className="development-round"
          key={round.sequence}
          open={index === evidence.rounds.length - 1}
        >
          <summary>
            {round.sequence}차 수정 · {developmentPhaseLabels[round.phase]}
          </summary>
          <p className="subtle-note">
            준비 기록 {dateTime(round.createdAt)}
            {round.candidateDigest ? (
              <>
                {" "}
                · 후보 버전{" "}
                <code title={round.candidateDigest}>{round.candidateDigest.slice(0, 12)}</code>
              </>
            ) : null}
          </p>
          {round.candidateDigest ? (
            <details className="development-files">
              <summary>변경 파일 {round.changes.length}개</summary>
              {round.changes.length ? (
                <ul>
                  {round.changes.map((change) => (
                    <li key={change.path}>
                      <span>{changeLabels[change.action]}</span> <code>{change.path}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>개발 기준과 달라진 파일이 없습니다.</p>
              )}
            </details>
          ) : null}
          <div className="development-check">
            <strong>실제 테스트</strong>
            {round.test ? (
              <>
                <span
                  className={`status status-${round.test.status === "passed" ? "succeeded" : "failed"}`}
                >
                  {testLabels[round.test.status]}
                </span>
                <p>
                  종료 코드 {round.test.exitCode} · {(round.test.elapsedMs / 1000).toFixed(1)}초 ·
                  결과 저장 {dateTime(round.test.recordedAt)}
                </p>
                {round.test.oomKilled ? (
                  <p className="development-failure">메모리 한도를 초과해 종료됐습니다.</p>
                ) : null}
                <details>
                  <summary>테스트 출력</summary>
                  {round.test.output ? (
                    <pre className="analysis-result development-output">{round.test.output}</pre>
                  ) : (
                    <p>저장된 출력이 없습니다.</p>
                  )}
                </details>
              </>
            ) : (
              <p>
                {round.phase === "testing"
                  ? "결과가 아직 저장되지 않았습니다."
                  : "저장된 테스트 결과가 없습니다."}
              </p>
            )}
          </div>
          <div className="development-check">
            <strong>독립 검토</strong>
            {round.review ? (
              <>
                <span
                  className={`status status-${round.review.assessment.complete ? "succeeded" : "blocked"}`}
                >
                  {round.review.assessment.complete ? "승인" : "보완 필요"}
                </span>
                <p className="subtle-note">결과 저장 {dateTime(round.review.recordedAt)}</p>
                <pre className="analysis-result">{round.review.assessment.report}</pre>
                {round.review.assessment.unresolved.length ? (
                  <ul>
                    {round.review.assessment.unresolved.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                ) : null}
                {round.review.assessment.next ? (
                  <p>
                    <strong>다음 수정 제안</strong> {round.review.assessment.next.purpose}
                  </p>
                ) : !round.review.assessment.complete ? (
                  <p>후속 수정 제안이 없습니다. 진행에 필요한 정보를 확인해 주세요.</p>
                ) : null}
              </>
            ) : (
              <p>저장된 검토 결과가 없습니다.</p>
            )}
          </div>
        </details>
      ))}
    </section>
  );
}
