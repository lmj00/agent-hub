import { useCallback } from "react";
import { servicesSchema, type Service } from "@agent-hub/contracts";
import { api, errorMessage } from "./api.js";
import { dateTime } from "./format.js";
import { usePolling } from "./use-polling.js";

import { serviceStateLabels as labels, serviceReasons as reasons } from "./service-format.js";

export function ServicePanel({
  projectId,
  onExpired,
}: {
  projectId: string;
  onExpired: () => void;
}) {
  const load = useCallback(
    (signal: AbortSignal) =>
      api.request(`/projects/${projectId}/services`, servicesSchema, {
        signal,
      }),
    [projectId],
  );
  const result = usePolling(projectId, load, onExpired);
  if (!result.error && !result.data?.services.length) return null;
  return (
    <section className="services-panel" aria-label="연결한 서비스 상태">
      <div className="section-heading">
        <h2>연결한 서비스</h2>
        <span className="small-tag">상태 조회만 수행</span>
      </div>
      <p className="services-intro">
        서비스가 보고한 프로세스·업무 상태를 확인합니다. 상태 수집과 업무 성공은 다릅니다.
      </p>
      {result.error ? (
        <div className="notice error" role="alert">
          {errorMessage(result.error)}
          <small>화면에서 마지막 확인 {dateTime(result.checkedAt)}</small>
        </div>
      ) : null}
      <div className="service-list">
        {result.data?.services.map((service) => (
          <ServiceCard key={service.key} service={service} disconnected={!!result.error} />
        ))}
      </div>
    </section>
  );
}

function ServiceCard({ service, disconnected }: { service: Service; disconnected: boolean }) {
  const state = disconnected ? "unknown" : service.state;
  const current = service.latest?.success ? service.latest : null;
  const record = current ?? service.lastSuccessful;
  const historical =
    disconnected || !current || ["stale", "unknown", "unavailable"].includes(service.state);
  const snapshot = record?.snapshot;
  return (
    <article className="service-card">
      <div className="service-heading">
        <div>
          <h3>{service.name}</h3>
          <small>
            {service.enabled ? `수집 간격 최소 ${service.intervalMs / 1000}초` : "관측 꺼짐"}
          </small>
        </div>
        <span className={`service-state service-${state}`}>
          <span className="status-dot" aria-hidden="true" />
          {disconnected ? "조회 실패" : labels[state]}
        </span>
      </div>
      <p className="service-reason">
        {disconnected
          ? "아래 내용은 마지막 화면 조회 때의 기록입니다."
          : (reasons[service.reason] ?? "상태를 확인하지 못했습니다.")}
      </p>
      <div className="service-observed">
        <span>마지막 수집 시도 {dateTime(service.latest?.receivedAt)}</span>
        <span>다음 수집 예정 {dateTime(service.nextCheckAt)}</span>
      </div>
      {snapshot ? (
        <div className={`service-evidence ${historical ? "historical" : ""}`}>
          <p className="eyebrow">
            {historical ? "이전 수집 기록 · 현재 정상의 근거가 아닙니다" : "수집한 업무 상태"}
          </p>
          {snapshot.summary ? <p className="service-summary">{snapshot.summary}</p> : null}
          <dl className="service-facts">
            <div>
              <dt>서비스 보고 시각</dt>
              <dd>{dateTime(snapshot.observedAt)}</dd>
            </div>
            <div>
              <dt>최근 업무 성공</dt>
              <dd>{dateTime(snapshot.lastSuccessAt)}</dd>
            </div>
            <div>
              <dt>다음 업무 예정</dt>
              <dd>{dateTime(snapshot.nextExpectedAt)}</dd>
            </div>
            <div>
              <dt>서비스가 보고한 오류 수</dt>
              <dd>{snapshot.errorCount.toLocaleString()}</dd>
            </div>
          </dl>
        </div>
      ) : (
        <p className="service-no-evidence">아직 확인할 업무 기록이 없습니다.</p>
      )}
    </article>
  );
}
