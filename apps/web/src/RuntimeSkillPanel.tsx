import type { RunDetails, RuntimeSkillRole } from "@agent-hub/contracts";
import { dateTime } from "./format.js";

const roles: Record<RuntimeSkillRole, string> = {
  planner: "계획",
  developer: "개발",
  reviewer: "독립 검토",
  analyst: "분석",
};

export function RuntimeSkillPanel({ run }: { run: RunDetails }) {
  return (
    <section className="runtime-skills" aria-label="에이전트 지침 기록">
      <h3>에이전트 지침</h3>
      <p className="subtle-note">
        {run.runtimeSkillVersion === null
          ? "이 실행에는 지침 적용을 확인할 기록이 없습니다."
          : "실행기가 읽은 지침을 기록합니다. 작업 성공과 검증 결과는 별도로 확인하세요."}
      </p>
      {run.runtimeSkillVersion !== null && !run.steps.length ? (
        <p className="empty-list">저장된 AI 호출 단계가 없습니다.</p>
      ) : null}
      {run.steps.map((step) => {
        const skill = step.runtimeSkill;
        return (
          <details className="event-details" key={step.sequence}>
            <summary>
              {step.sequence}. {skill ? roles[skill.role] : (step.purpose ?? "AI 호출")} ·{" "}
              {skill?.loadedAt
                ? "지침 읽기 확인"
                : skill
                  ? "선택됨 · 읽기 미확인"
                  : "지침 기록 없음"}
            </summary>
            {skill ? (
              <>
                <p className="subtle-note">
                  gstack의 역할별 지침을 실행 환경에 맞게 적용했습니다. 전체 gstack 도구 실행을
                  의미하지 않습니다.
                </p>
                {!skill.loadedAt ? (
                  <p className="notice">
                    선택 기록만 있습니다. 실행기가 실제로 읽었는지는 확인되지 않았습니다.
                  </p>
                ) : null}
                <dl className="notice-facts">
                  <div>
                    <dt>지침</dt>
                    <dd>{skill.id}</dd>
                  </div>
                  <div>
                    <dt>버전</dt>
                    <dd>
                      제품용 {skill.version} · gstack {skill.upstreamVersion}
                    </dd>
                  </div>
                  <div>
                    <dt>선택 시각</dt>
                    <dd>{dateTime(skill.selectedAt)}</dd>
                  </div>
                  <div>
                    <dt>읽기 확인 시각</dt>
                    <dd>{skill.loadedAt ? dateTime(skill.loadedAt) : "미확인"}</dd>
                  </div>
                </dl>
                <details className="event-details">
                  <summary>버전 대조 정보</summary>
                  <dl className="notice-facts runtime-skill-identifiers">
                    <div>
                      <dt>적용 방식</dt>
                      <dd>{skill.mode}</dd>
                    </div>
                    <div>
                      <dt>내용 크기</dt>
                      <dd>{skill.bytes.toLocaleString()}바이트</dd>
                    </div>
                    <div>
                      <dt>원본 커밋</dt>
                      <dd>
                        <code>{skill.upstreamCommit}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>지침 SHA-256</dt>
                      <dd>
                        <code>{skill.digest}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>묶음 SHA-256</dt>
                      <dd>
                        <code>{skill.bundleDigest}</code>
                      </dd>
                    </div>
                  </dl>
                </details>
              </>
            ) : (
              <p className="subtle-note">
                저장된 선택·읽기 기록이 없어 지침 적용 여부를 확인할 수 없습니다.
              </p>
            )}
          </details>
        );
      })}
    </section>
  );
}
