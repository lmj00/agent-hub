import type {
  PlanningEvidence,
  ServiceObservation,
} from "@agent-hub/contracts";
import { dateTime } from "./format.js";
import { serviceStateLabels, serviceReasons } from "./service-format.js";

export function PlanningEvidencePanel({
  evidence,
}: {
  evidence: PlanningEvidence;
}) {
  return (
    <section className="notice" aria-label="계획에 사용한 관측">
      <strong>계획에 사용한 관측</strong>
      <p>
        자료 확인 {dateTime(evidence.capturedAt)} · 당시 기록이며 현재 상태는
        서비스 화면에서 확인하세요.
      </p>
      <p>
        서비스 {evidence.counts.services.included} /{" "}
        {evidence.counts.services.total}개 · 과거 작업{" "}
        {evidence.counts.history.included} / {evidence.counts.history.total}개 ·
        재생성 억제 {evidence.counts.suppressedWork.included} /{" "}
        {evidence.counts.suppressedWork.total}개 · 파일 목록{" "}
        {evidence.counts.files.included} / {evidence.counts.files.total}개
      </p>
      <small>
        생략된 자료는 정상이거나 없다는 뜻이 아닙니다. 서비스 상태만으로 전략
        성능을 판단하지 않습니다.
      </small>
      {evidence.services.map((service) => (
        <details key={service.key}>
          <summary>
            {service.name} · {serviceStateLabels[service.state]}
          </summary>
          <p>
            {serviceReasons[service.reason] ??
              "저장된 판단 근거를 확인해 주세요."}
          </p>
          {service.latest ? (
            <Observation label="당시 최신 수집" value={service.latest} />
          ) : (
            <p>수집 기록이 없습니다.</p>
          )}
          {service.lastSuccessful &&
          service.lastSuccessful.id !== service.latest?.id ? (
            <Observation
              label="과거 수집 성공 · 최신 상태를 대신하지 않습니다"
              value={service.lastSuccessful}
            />
          ) : null}
        </details>
      ))}
    </section>
  );
}

function Observation({
  label,
  value,
}: {
  label: string;
  value: ServiceObservation;
}) {
  return (
    <div>
      <p>
        {label} · {dateTime(value.receivedAt)} ·{" "}
        {value.success ? "수집 성공" : "수집 실패"}
      </p>
      <small>관측 ID {value.id}</small>
      {value.snapshot ? <p>{value.snapshot.summary}</p> : null}
    </div>
  );
}
