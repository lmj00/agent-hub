import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { ServiceSnapshot } from "@agent-hub/contracts";
import { redactOutput } from "../execution/analysis.js";

export type CiApi = (path: string, method?: "GET" | "POST") => Promise<unknown>;
export type CiState = {
  head: string;
  status:
    | "unknown"
    | "unconfigured"
    | "pending"
    | "passed"
    | "retrying"
    | "code_failure"
    | "blocked";
  summary: string;
  blockedReason: "repair_limit" | null;
  checkedAt: string;
  lastSuccessAt: string | null;
  incident: { key: string; repairCommits: string[] } | null;
  retries: Record<string, { attempt: number; state: "reserved" | "requested" | "uncertain" }>;
};
const sha = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{40}$/.test(s);
function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "CI_INVALID_RESPONSE");
  return value as Record<string, unknown>;
}
function rows(value: unknown, key: string) {
  const data = object(value);
  assert.ok(
    Array.isArray(data[key]) && typeof data.total_count === "number",
    "CI_INVALID_RESPONSE",
  );
  assert.ok(
    data.total_count === data[key].length && data.total_count <= 100,
    "CI_RESPONSE_INCOMPLETE",
  );
  return data[key].map(object);
}
function id(value: unknown): number {
  assert.ok(Number.isSafeInteger(value) && (value as number) > 0, "CI_INVALID_RESPONSE");
  return value as number;
}
function label(value: unknown) {
  assert.equal(typeof value, "string", "CI_INVALID_RESPONSE");
  return cleanCiText(value as string).slice(0, 120);
}
export function cleanCiText(value: string) {
  return redactOutput(value)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|AKIA[A-Z0-9]{16})\b/g,
      "[REDACTED]",
    )
    .replace(/((?:password|secret|token|api[_-]?key)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}
export function classifyCiFailure(stepNames: string[], log: string) {
  if (
    /Assertion(?:Failed)?Error|(?:^|\n)Tests? failed(?:[.!]|\s+in\b|\s*$)|test failures|There were failing tests|\w+Test > .+ FAILED|\b\d+ tests? completed, [1-9]\d* failed\b|Compilation failed|error TS\d+|FAIL\s+\S|expected .+ to /i.test(
      log,
    )
  )
    return "code";
  if (
    stepNames.length > 0 &&
    stepNames.every((name) => /install|setup|set up|download|checkout/i.test(name)) &&
    /ECONNRESET|ETIMEDOUT|EAI_AGAIN|connection (?:reset|timed out)|(?:HTTP|status|code)\s*:?\s*50[234]|Bad Gateway|Service Unavailable/i.test(
      log,
    )
  )
    return "transient";
  return "unknown";
}
export function initialCiState(): CiState {
  return {
    head: "",
    status: "unknown",
    summary: "CI 확인 전",
    blockedReason: null,
    checkedAt: new Date(0).toISOString(),
    lastSuccessAt: null,
    incident: null,
    retries: {},
  };
}

// The caller owns a single-writer lock and atomically saves state before any remote mutation.
export async function observeCi({
  api,
  readLog,
  prefix,
  branch,
  workflowIds,
  head,
  previous,
  save,
  now = new Date(),
}: {
  api: CiApi;
  readLog: (jobId: number) => Promise<string>;
  prefix: string;
  branch: string;
  workflowIds: number[];
  head: string;
  previous: CiState;
  save: (state: CiState) => void;
  now?: Date;
}): Promise<CiState> {
  assert.match(prefix, /^\/repos\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/);
  assert.match(branch, /^agent-hub\/[a-z0-9-]+$/);
  assert.ok(sha(head));
  assert.ok(workflowIds.length <= 20 && new Set(workflowIds).size === workflowIds.length);
  workflowIds.forEach(id);
  const state = structuredClone(previous);
  state.head = head;
  state.checkedAt = now.toISOString();
  const finish = (
    status: CiState["status"],
    summary: string,
    blockedReason: CiState["blockedReason"] = null,
  ) => {
    state.status = status;
    state.blockedReason = blockedReason;
    state.summary = cleanCiText(summary).slice(0, 500);
    save(state);
    return state;
  };
  const currentHead = async () =>
    object(object(await api(`${prefix}/git/ref/heads/${branch}`)).object).sha;
  assert.equal(await currentHead(), head, "CI_HEAD_CHANGED");
  const workflows = rows(await api(`${prefix}/actions/workflows?per_page=100`), "workflows");
  if (!workflows.some((w) => w.state === "active")) {
    return state.incident || workflowIds.length > 0
      ? finish(
          "blocked",
          "필수 CI 또는 미해결 실패가 있는데 실행할 워크플로가 없습니다. 설정 확인이 필요합니다.",
        )
      : finish(
          "unconfigured",
          "GitHub Actions CI가 설정되지 않았습니다. CI 통과를 확인한 상태가 아닙니다.",
        );
  }
  const enabled = workflows.filter((w) => workflowIds.includes(id(w.id)) && w.state === "active");
  if (!workflowIds.length || enabled.length !== workflowIds.length)
    return finish(
      "blocked",
      "감시·재실행할 CI 워크플로를 명시적으로 지정해야 합니다. 배포 등 다른 워크플로는 자동 재실행하지 않습니다.",
    );
  const runs = rows(
    await api(`${prefix}/actions/runs?head_sha=${head}&per_page=100`),
    "workflow_runs",
  );
  const latest = new Map<string, Record<string, unknown>>();
  for (const run of runs) {
    assert.equal(run.head_sha, head, "CI_HEAD_MISMATCH");
    if (
      !workflowIds.includes(id(run.workflow_id)) ||
      run.head_branch !== branch ||
      !["push", "pull_request", "workflow_dispatch"].includes(String(run.event))
    )
      continue;
    const key = `${id(run.workflow_id)}:${run.event}`;
    id(run.id);
    id(run.run_attempt);
    if (!latest.has(key) || id(latest.get(key)!.id) < id(run.id)) latest.set(key, run);
  }
  const selected = [...latest.values()];
  if (
    workflowIds.some((workflowId) => !selected.some((r) => r.workflow_id === workflowId)) ||
    selected.some((r) => r.status !== "completed")
  )
    return finish("pending", "게시한 커밋의 CI 시작 또는 종료를 기다립니다.");
  assert.equal(await currentHead(), head, "CI_HEAD_CHANGED");
  if (selected.every((r) => r.conclusion === "success")) {
    state.incident = null;
    state.retries = {};
    state.lastSuccessAt = now.toISOString();
    return finish(
      "passed",
      `게시한 커밋 ${head.slice(0, 8)}의 관측된 CI ${selected.length}개가 통과했습니다.`,
    );
  }
  const failed = selected.filter((r) => r.conclusion !== "success");
  if (failed.some((r) => !["failure", "timed_out"].includes(String(r.conclusion))))
    return finish(
      "blocked",
      "취소·승인 대기·생략된 CI는 통과로 처리하거나 자동 재실행하지 않습니다.",
    );
  state.incident ??= {
    key: createHash("sha256")
      .update(
        `${prefix}:${head}:${failed
          .map((r) => r.workflow_id)
          .sort()
          .join(",")}`,
      )
      .digest("hex")
      .slice(0, 16),
    repairCommits: [],
  };
  const diagnostics: { run: Record<string, unknown>; kind: string; text: string }[] = [];
  for (const run of failed) {
    const jobs = rows(
      await api(
        `${prefix}/actions/runs/${id(run.id)}/attempts/${id(run.run_attempt)}/jobs?per_page=100`,
      ),
      "jobs",
    );
    const broken = jobs.filter((j) => ["failure", "timed_out"].includes(String(j.conclusion)));
    if (!broken.length) return finish("blocked", "CI 실패 작업의 근거를 가져오지 못했습니다.");
    for (const job of broken) {
      assert.equal(job.run_id, run.id, "CI_JOB_RUN_MISMATCH");
      assert.ok(Array.isArray(job.steps), "CI_INVALID_RESPONSE");
      const steps = job.steps
        .map(object)
        .filter((s) => ["failure", "timed_out"].includes(String(s.conclusion)))
        .map((s) => label(s.name));
      const log = cleanCiText(await readLog(id(job.id)));
      const kind = classifyCiFailure(steps, log);
      const lines = log
        .split(/\r?\n/)
        .map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, "").trim());
      const specific = lines.filter((line) =>
        /\w+Test > .+ FAILED|^FAIL(?:ED)?\s|Assertion(?:Failed)?Error|^(?:Expected|Received):|^Caused by:|^(?:[\w$]+\.)+[\w$]*(?:Exception|Error)\b|error TS\d+|:\s*error:/i.test(
          line,
        ),
      );
      // Build tools append generic failure footers after the actionable test/exception details.
      const excerpt = specific.length
        ? specific.slice(0, 3)
        : lines
            .filter((line) =>
              /error|fail|expected|ECONN|ETIMEDOUT|EAI_AGAIN|Bad Gateway|Unavailable/i.test(line),
            )
            .slice(-3);
      diagnostics.push({
        run,
        kind,
        text: `${label(job.name)} / ${steps.join(", ")}: ${(excerpt.join(" ") || "구체적인 원인 미확인").slice(0, 350)}`,
      });
    }
  }
  const marker = `CI:${state.incident.key}`;
  if (diagnostics.some((d) => d.kind === "unknown"))
    return finish(
      "blocked",
      `${marker} 실패 원인을 확정하지 못해 재실행을 보류합니다. ${diagnostics[0]?.text}`,
    );
  if (diagnostics.some((d) => d.kind === "code") && state.incident.repairCommits.length >= 2)
    return finish(
      "blocked",
      `${marker} 검증된 수정 게시 한도(2회)를 소진했습니다. 추가 원인 확인이 필요합니다.`,
      "repair_limit",
    );
  if (diagnostics.some((d) => d.kind === "code"))
    return finish(
      "code_failure",
      `${marker} 코드·테스트 수정 필요. ${diagnostics.map((d) => d.text).join(" | ")}`,
    );
  for (const run of failed) {
    const key = String(id(run.id)),
      attempt = id(run.run_attempt);
    if (attempt >= 2)
      return finish(
        "blocked",
        `${marker} 일시적 오류 재실행 한도(1회)를 소진했습니다. ${diagnostics[0]?.text}`,
      );
    if (state.retries[key]) {
      return finish(
        state.retries[key].state === "requested" ? "retrying" : "blocked",
        `${marker} 기존 재실행 요청의 반영을 확인 중입니다. 같은 요청을 중복 전송하지 않습니다.`,
      );
    }
  }
  for (const run of failed) {
    const key = String(id(run.id)),
      attempt = id(run.run_attempt);
    assert.equal(await currentHead(), head, "CI_HEAD_CHANGED");
    const fresh = object(await api(`${prefix}/actions/runs/${run.id}`));
    assert.equal(fresh.head_sha, head, "CI_HEAD_CHANGED");
    assert.equal(fresh.run_attempt, attempt, "CI_ATTEMPT_CHANGED");
    assert.equal(fresh.status, "completed", "CI_ATTEMPT_CHANGED");
    assert.equal(fresh.conclusion, run.conclusion, "CI_ATTEMPT_CHANGED");
    state.retries[key] = { attempt, state: "reserved" };
    finish(
      "retrying",
      `${marker} 설치·다운로드의 일시적 통신 오류를 확인해 실패 작업을 1회 재실행합니다.`,
    );
    try {
      await api(`${prefix}/actions/runs/${run.id}/rerun-failed-jobs`, "POST");
      state.retries[key]!.state = "requested";
      save(state);
    } catch {
      state.retries[key]!.state = "uncertain";
      return finish(
        "blocked",
        `${marker} 재실행 응답을 확인하지 못했습니다. 중복 요청 없이 GitHub 실행 상태를 다시 확인합니다.`,
      );
    }
  }
  return state;
}

export function reserveCiRepair(
  state: CiState,
  localCommit: string,
  evidence: string[],
  save: (state: CiState) => void,
) {
  if (state.status === "passed" || state.status === "unconfigured") return;
  assert.ok(sha(localCommit));
  const sameIncident =
    state.incident && evidence.some((e) => e.includes(`CI:${state.incident!.key}`));
  const existingReservation = sameIncident && state.incident!.repairCommits.includes(localCommit);
  if (
    existingReservation &&
    (state.status === "code_failure" ||
      (state.status === "blocked" && state.blockedReason === "repair_limit"))
  )
    return;
  assert.equal(state.status, "code_failure", "CI_NOT_READY_FOR_PUBLICATION");
  assert.ok(sameIncident && state.incident, "CI_REPAIR_EVIDENCE_REQUIRED");
  assert.ok(state.incident.repairCommits.length < 2, "CI_REPAIR_LIMIT");
  state.incident.repairCommits.push(localCommit);
  save(state);
}

export function ciServiceSnapshot(state: CiState, now = new Date()): ServiceSnapshot {
  const stale = now.getTime() - Date.parse(state.checkedAt) > 120000;
  return {
    observedAt: state.checkedAt,
    processState: "running",
    activityState:
      stale || state.status === "unknown" || state.status === "unconfigured"
        ? "unknown"
        : ["pending", "retrying"].includes(state.status)
          ? "working"
          : state.status === "passed"
            ? "waiting"
            : "degraded",
    lastSuccessAt: state.lastSuccessAt,
    nextExpectedAt: null,
    errorCount: ["code_failure", "blocked"].includes(state.status) ? 1 : 0,
    summary: stale ? "CI 관측이 오래되었습니다. 현재 상태는 미확인입니다." : state.summary,
  };
}

// A CI repair may follow other already verified local changes. Publish their final tree together.
export function ciPublicationIndex(state: CiState, candidates: { evidence: string[] }[]): number {
  if (state.status === "passed" || state.status === "unconfigured")
    return candidates.length ? 0 : -1;
  if (
    state.status !== "code_failure" ||
    !state.incident ||
    state.incident.repairCommits.length >= 2
  )
    return -1;
  return candidates.findIndex((candidate) =>
    candidate.evidence.some((evidence) => evidence.includes(`CI:${state.incident!.key}`)),
  );
}
