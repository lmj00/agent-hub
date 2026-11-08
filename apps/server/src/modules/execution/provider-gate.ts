import { capacityCheckAt, type CapacityPolicy } from "./capacity-policy.js";
import { eq } from "drizzle-orm";
import type { openDatabase } from "../../db/connection.js";
import { providerGates } from "../../db/schema.js";
import type { RunCompletion } from "./run-task.js";

// 단일 계정 단계에서는 인증 경로·계정 변경으로 차단을 우회하지 않도록 넓게 묶습니다.
export const providerScope = "openai:chatgpt";
type GateDb = Pick<ReturnType<typeof openDatabase>["db"], "select" | "insert" | "update">;
export type ProviderGateView = Omit<typeof providerGates.$inferSelect, "scope">;

export function readProviderGate(db: GateDb) {
  return db.select().from(providerGates).where(eq(providerGates.scope, providerScope)).get();
}

export function providerGateView(db: GateDb): ProviderGateView {
  const gate = readProviderGate(db);
  if (!gate)
    return {
      version: 0,
      blocked: false,
      reason: null,
      blockedAt: null,
      retryAt: null,
      sourceRunId: null,
      probeTaskId: null,
      probeRunId: null,
      capacityState: null,
    };
  const { scope: _scope, ...view } = gate;
  return view;
}

export class ProviderGateError extends Error {
  constructor(
    public readonly code:
      | "GATE_CHANGED"
      | "PROVIDER_CHECK_RESERVED"
      | "RETRY_TOO_EARLY"
      | "RECOVERY_LIMIT_REACHED",
  ) {
    super(code);
  }
}

// 호출자는 실행 소유권·작업 상태·종료 근거를 같은 트랜잭션에서 먼저 검사합니다.
export function reserveProviderCheck(
  db: GateDb,
  taskId: string,
  expectedVersion: number,
  now = new Date(),
) {
  const gate = readProviderGate(db);
  if (!gate?.blocked || gate.version !== expectedVersion)
    throw new ProviderGateError("GATE_CHANGED");
  if (gate.retryAt && gate.retryAt > now) throw new ProviderGateError("RETRY_TOO_EARLY");
  if (gate.reason === "capacity" && gate.capacityState) {
    if (gate.capacityState.checks >= gate.capacityState.policy.maxChecks)
      throw new ProviderGateError("RECOVERY_LIMIT_REACHED");
    if (
      gate.capacityState.nextCheckAt &&
      Date.parse(gate.capacityState.nextCheckAt) > now.getTime()
    )
      throw new ProviderGateError("RETRY_TOO_EARLY");
  }
  if (gate.probeTaskId || gate.probeRunId) throw new ProviderGateError("PROVIDER_CHECK_RESERVED");
  db.update(providerGates)
    .set({ probeTaskId: taskId })
    .where(eq(providerGates.scope, providerScope))
    .run();
}

function capacityAfterOutcome(
  gate: ReturnType<typeof readProviderGate>,
  version: number,
  now: Date,
  retryAt: Date | null,
  policy?: CapacityPolicy,
) {
  const previous = gate?.capacityState;
  const savedPolicy = previous?.policy ?? policy;
  if (!savedPolicy) return null;
  const checks = previous?.checks ?? 0;
  return {
    policy: savedPolicy,
    checks,
    decisionVersion: version,
    nextCheckAt:
      checks >= savedPolicy.maxChecks
        ? null
        : capacityCheckAt(savedPolicy, checks, now, retryAt, Math.random()),
    reason: checks >= savedPolicy.maxChecks ? "check_limit" : "waiting",
  };
}

export function recordProviderOutcome(
  db: GateDb,
  run: { id: string; providerGateVersion: number | null },
  completion: RunCompletion,
  now: Date,
  capacityPolicy?: CapacityPolicy,
) {
  const gate = readProviderGate(db);
  // 옛 확인 실행의 늦은 응답은 새 차단이나 새 예약을 변경하지 못합니다.
  if (
    run.providerGateVersion !== null &&
    (!gate?.blocked || gate.version !== run.providerGateVersion || gate.probeRunId !== run.id)
  )
    return;
  // 종료 미확인 확인 실행은 예약과 버전을 보존합니다. 종료 대조 뒤 같은 결과를 확정합니다.
  if (run.providerGateVersion !== null && !completion.terminationConfirmedAt) return;
  const reason =
    completion.errorCode === "capacity"
      ? "capacity"
      : completion.errorCode === "authentication"
        ? "authentication"
        : completion.errorCode === "unsupported_settings"
          ? "configuration"
          : null;
  if (reason) {
    const next: Omit<typeof providerGates.$inferInsert, "scope"> = {
      version: (gate?.version ?? 0) + 1,
      blocked: true,
      reason,
      blockedAt: now,
      retryAt: reason === "capacity" ? (completion.retryAt ?? null) : null,
      sourceRunId: run.id,
      probeTaskId: null,
      probeRunId: null,
      capacityState:
        reason === "capacity"
          ? capacityAfterOutcome(
              gate,
              (gate?.version ?? 0) + 1,
              now,
              completion.retryAt ?? null,
              capacityPolicy,
            )
          : (gate?.capacityState ?? null),
    };
    db.insert(providerGates)
      .values({ scope: providerScope, ...next })
      .onConflictDoUpdate({ target: providerGates.scope, set: next })
      .run();
  } else if (gate && run.providerGateVersion !== null) {
    const recovered =
      completion.status === "succeeded" && completion.terminationConfirmedAt != null;
    db.update(providerGates)
      .set({
        version: gate.version + 1,
        blocked: !recovered,
        reason: recovered ? null : gate.reason,
        retryAt: recovered ? null : gate.retryAt,
        blockedAt: recovered ? null : gate.blockedAt,
        probeTaskId: null,
        probeRunId: null,
        capacityState: recovered
          ? null
          : gate.reason === "capacity"
            ? capacityAfterOutcome(gate, gate.version + 1, now, gate.retryAt)
            : gate.capacityState,
      })
      .where(eq(providerGates.scope, providerScope))
      .run();
  }
}
