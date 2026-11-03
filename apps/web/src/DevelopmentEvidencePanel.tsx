import type { DevelopmentEvidence } from "@agent-hub/contracts";
import { dateTime } from "./format.js";

export const developmentPhaseLabels: Record<
  DevelopmentEvidence["phase"],
  string
> = {
  preparing: "개발 준비",
  developing: "개발",
  preparing_test: "테스트 준비",
  testing: "실제 테스트",
  reviewing: "독립 검토",
  needs_changes: "보완 필요",
  verified: "검증 완료 · 변경 반영 대기",
};
const testLabels = {
  passed: "통과",
  failed: "실패",
  timed_out: "시간 초과",
  output_limit: "출력 한도 초과",
};
const changeLabels = { add: "추가", modify: "수정", delete: "삭제" };

export function DevelopmentEvidencePanel({
  evidence,
}: {
  evidence: DevelopmentEvidence;
}) {
  return (
    <section className="development-evidence" aria-label="개발·검증 기록">
      <div className="section-heading">
        <h3>개발·검증 기록</h3>
        <span className="count">
          {evidence.rounds.length} / {evidence.maxRounds}회 수정
        </span>
      </div>
      <p className="subtle-note">
        각 수정 버전의 실제 테스트와 독립 검토를 기록합니다. 검증을 통과해도
        변경 반영이 확인되기 전에는 작업이 완료되지 않습니다.
      </p>
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
                <code title={round.candidateDigest}>
                  {round.candidateDigest.slice(0, 12)}
                </code>
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
                      <span>{changeLabels[change.action]}</span>{" "}
                      <code>{change.path}</code>
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
                  종료 코드 {round.test.exitCode} ·{" "}
                  {(round.test.elapsedMs / 1000).toFixed(1)}초 · 결과 저장{" "}
                  {dateTime(round.test.recordedAt)}
                </p>
                {round.test.oomKilled ? (
                  <p className="development-failure">
                    메모리 한도를 초과해 종료됐습니다.
                  </p>
                ) : null}
                <details>
                  <summary>테스트 출력</summary>
                  {round.test.output ? (
                    <pre className="analysis-result development-output">
                      {round.test.output}
                    </pre>
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
                <p className="subtle-note">
                  결과 저장 {dateTime(round.review.recordedAt)}
                </p>
                <pre className="analysis-result">
                  {round.review.assessment.report}
                </pre>
                {round.review.assessment.unresolved.length ? (
                  <ul>
                    {round.review.assessment.unresolved.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                ) : null}
                {round.review.assessment.next ? (
                  <p>
                    <strong>다음 수정 제안</strong>{" "}
                    {round.review.assessment.next.purpose}
                  </p>
                ) : !round.review.assessment.complete ? (
                  <p>
                    후속 수정 제안이 없습니다. 진행에 필요한 정보를 확인해
                    주세요.
                  </p>
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
