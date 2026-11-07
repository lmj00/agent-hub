import type { GoalVerificationEvidence } from "@agent-hub/contracts";
import { dateTime } from "./format.js";

export const goalVerificationPhaseLabels = {
  testing: "목표 전체 테스트",
  reviewing: "목표 전체 독립 검토",
  verified: "목표 검증 통과",
  needs_changes: "목표 보완 필요",
};
const testLabels = {
  passed: "통과",
  failed: "실패",
  timed_out: "시간 초과",
  output_limit: "출력 한도 초과",
};

export function GoalVerificationPanel({ evidence }: { evidence: GoalVerificationEvidence }) {
  return (
    <section className="development-evidence" aria-label="목표 전체 검증 기록">
      <div className="section-heading">
        <h3>목표 전체 검증 기록</h3>
      </div>
      <p className="subtle-note">
        마지막 작업뿐 아니라 목표의 모든 완료 기준을 실제 테스트와 별도 검토로 확인합니다.
      </p>
      <div className="development-check">
        <strong>
          {evidence.completionApplied
            ? "목표 완료 기록됨"
            : goalVerificationPhaseLabels[evidence.phase]}
        </strong>
        <p>
          {evidence.completionApplied
            ? "이 검증을 근거로 목표 완료와 이력을 함께 저장했습니다."
            : evidence.phase === "needs_changes"
              ? "이 실행에서는 목표 완료를 기록하지 않았습니다. 아래 미완료 항목을 다음 계획의 근거로 남겼습니다."
              : "이 실행에서 목표 완료가 저장된 기록은 아직 없습니다."}
        </p>
        <p>검증 시작 {dateTime(evidence.startedAt)}</p>
      </div>
      <div className="development-check" aria-label="목표 테스트 결과">
        <h4>실제 테스트</h4>
        {evidence.test ? (
          <>
            <p>
              {testLabels[evidence.test.status]} · 종료 코드 {evidence.test.exitCode} ·{" "}
              {evidence.test.elapsedMs}ms
            </p>
            {evidence.test.oomKilled ? <p>메모리 한도로 실행이 종료됐습니다.</p> : null}
            <details>
              <summary>테스트 출력 보기</summary>
              <pre className="development-output">{evidence.test.output || "출력 없음"}</pre>
            </details>
          </>
        ) : (
          <p>저장된 테스트 결과가 없습니다.</p>
        )}
      </div>
      <div className="development-check" aria-label="목표 독립 검토 결과">
        <h4>독립 검토</h4>
        {evidence.review ? (
          <>
            <p>{evidence.review.assessment.report}</p>
            {evidence.review.assessment.evidence.length ? (
              <ul>
                {evidence.review.assessment.evidence.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            ) : null}
            {evidence.review.assessment.unresolved.length ? (
              <>
                <h4>미완료 항목</h4>
                <ul>
                  {evidence.review.assessment.unresolved.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </>
            ) : null}
            <p className="subtle-note">기록 {dateTime(evidence.review.recordedAt)}</p>
          </>
        ) : (
          <p>저장된 독립 검토 결과가 없습니다.</p>
        )}
      </div>
      <details>
        <summary>검증한 코드 버전 보기</summary>
        <p>
          커밋 <code className="application-revision">{evidence.sourceRevision}</code>
        </p>
        <p>
          검증 자료 <code className="application-revision">{evidence.inputDigest}</code>
        </p>
      </details>
    </section>
  );
}
