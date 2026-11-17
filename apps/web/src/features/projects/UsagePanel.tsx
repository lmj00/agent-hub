import { useCallback } from "react";
import { projectUsageSchema } from "@agent-hub/contracts";
import { api, errorMessage } from "../../shared/api.js";
import { usePolling } from "../../shared/use-polling.js";

const number = (value: number) => value.toLocaleString("ko-KR");
const money = (value: number | null) =>
  value === null
    ? "미산정"
    : `$${value.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 })}`;
export function UsagePanel({ projectId, onExpired }: { projectId: string; onExpired: () => void }) {
  const load = useCallback(
    (signal: AbortSignal) =>
      api.request(`/projects/${projectId}/usage`, projectUsageSchema, { signal }),
    [projectId],
  );
  const poll = usePolling(`usage:${projectId}`, load, onExpired, 10000);
  const usage = poll.data;
  return (
    <section aria-label="프로젝트 사용량" className="usage-panel">
      <div className="page-intro">
        <h2>사용량</h2>
        <p>이 프로젝트에서 보고된 누적 토큰입니다. 재시도와 검토도 포함합니다.</p>
      </div>
      {poll.error ? (
        <p role="alert" className="error-text">
          {errorMessage(poll.error)} 마지막 집계가 표시될 수 있습니다.
        </p>
      ) : null}
      {!usage && !poll.error ? <p role="status">사용량을 불러오는 중…</p> : null}
      {usage ? (
        <>
          <dl className="usage-totals">
            <div>
              <dt>보고된 토큰</dt>
              <dd>{number(usage.inputTokens + usage.outputTokens)}</dd>
            </div>
            <div>
              <dt>API 단가 환산 · USD</dt>
              <dd>{money(usage.referenceCostUsd)}</dd>
            </div>
            <div>
              <dt>사용량 확인</dt>
              <dd>
                {number(usage.reportedSteps)}
                <small>단계</small>
              </dd>
            </div>
          </dl>
          <p className="subtle-note">
            토큰 미집계 {number(usage.unreportedSteps)}단계 · 진행/종료 확인 중{" "}
            {number(usage.pendingSteps)}단계 · 단가 미등록 {number(usage.unpricedSteps)}단계
          </p>
          <p className="subtle-note">
            미보고·복구 근거 부족·진행 중인 사용량은 합계에 포함되지 않습니다. 캐시 입력은 입력
            토큰에 포함되며 중복해서 더하지 않습니다.
          </p>
          {usage.models.length ? (
            <div
              className="usage-table-scroll"
              role="region"
              aria-label="모델별 사용량"
              tabIndex={0}
            >
              <table className="usage-table">
                <caption>모델별 누적 사용량</caption>
                <thead>
                  <tr>
                    <th scope="col">모델</th>
                    <th scope="col">입력</th>
                    <th scope="col">캐시 입력</th>
                    <th scope="col">출력</th>
                    <th scope="col">환산 비용</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.models.map((row) => (
                    <tr key={row.model}>
                      <th scope="row">{row.model}</th>
                      <td>{number(row.inputTokens)}</td>
                      <td>{number(row.cachedInputTokens)}</td>
                      <td>{number(row.outputTokens)}</td>
                      <td>{money(row.referenceCostUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>아직 기록된 AI 실행 단계가 없습니다.</p>
          )}
          <p className="subtle-note">
            실제 청구액이나 구독 사용량이 아닙니다.{" "}
            <a href={usage.pricing.source} target="_blank" rel="noreferrer">
              {usage.pricing.date} API Standard 단가
            </a>
            로 보고된 토큰만 환산했습니다. 장문 요금·도구 사용료·서비스 등급 차이는 제외합니다.
            단가가 없는 모델의 비용은 미산정입니다.
          </p>
        </>
      ) : null}
    </section>
  );
}
