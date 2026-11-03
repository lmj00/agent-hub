import {
  parseResponse,
  sessionSchema,
  errorSchema,
  type Static,
  type TSchema,
} from "@agent-hub/contracts";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}
export function createApiClient(fetcher: typeof fetch = fetch) {
  let csrfToken = "";
  let sessionRequest: Promise<Static<typeof sessionSchema>> | undefined;
  async function request<T extends TSchema>(
    path: string,
    schema: T,
    options: {
      method?: "GET" | "POST" | "PATCH" | "PUT";
      body?: unknown;
      signal?: AbortSignal;
    } = {},
  ): Promise<Static<T>> {
    const response = await fetcher(path, {
      method: options.method ?? "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
      headers:
        options.method === "POST" || options.method === "PATCH" || options.method === "PUT"
          ? { "Content-Type": "application/json", "X-CSRF-Token": csrfToken }
          : {},
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
    if (!response.ok) {
      let code = "HTTP_ERROR";
      try {
        code = parseResponse(errorSchema, await response.json()).error;
      } catch {
        /* 응답 원문을 오류 안내에 노출하지 않습니다. */
      }
      throw new ApiError(response.status, code);
    }
    try {
      return parseResponse(schema, await response.json());
    } catch {
      throw new ApiError(response.status, "INVALID_RESPONSE");
    }
  }
  return {
    request,
    session() {
      sessionRequest ??= request("/auth/session", sessionSchema)
        .then((value) => {
          csrfToken = value.csrfToken;
          return value;
        })
        .finally(() => {
          sessionRequest = undefined;
        });
      return sessionRequest;
    },
    async login(password: string) {
      const value = await request("/auth/login", sessionSchema, {
        method: "POST",
        body: { password },
      });
      csrfToken = value.csrfToken;
      return value;
    },
    async logout() {
      const response = await fetcher("/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "X-CSRF-Token": csrfToken },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new ApiError(response.status, "LOGOUT_FAILED");
      csrfToken = "";
    },
  };
}
export const api = createApiClient();

const messages: Record<string, string> = {
  INVALID_BUDGET: "예산 기간·호출 횟수·실행 시간을 확인해 주세요.",
  BUDGET_VERSION_CHANGED: "예산 설정이 바뀌었습니다. 최신 설정을 다시 열어 확인해 주세요.",
  PERIOD_BUDGET_EXHAUSTED: "이번 기간의 실행 예산을 다 썼습니다. 표시된 다음 기간까지 기다려 주세요.",
  INVALID_GOAL: "목표와 완료 기준, 허용 경로·제외 경로, 예산 범위를 확인해 주세요.",
  GOAL_VERSION_CHANGED: "목표 기준이 바뀌었습니다. 최신 버전과 작업 범위를 다시 확인해야 합니다.",
  GOAL_PAUSED: "연결된 목표가 일시정지되어 새 실행을 시작할 수 없습니다.",
  GOAL_BINDING_INVALID: "작업에 연결된 목표와 기준 버전을 확인해야 합니다.",
  GOAL_COMPLETED: "완료된 목표를 수정하거나 연결된 작업을 다시 실행할 수 없습니다.",
  INVALID_CREDENTIALS: "비밀번호를 확인해 주세요.",
  TOO_MANY_REQUESTS: "로그인 시도가 많습니다. 잠시 후 다시 시도해 주세요.",
  ORIGIN_NOT_ALLOWED:
    "접속 주소가 서버에 등록한 주소와 다릅니다. 설정한 주소로 접속해 주세요.",
  INVALID_RESPONSE:
    "서버 응답을 읽을 수 없습니다. 새로고침 후에도 같으면 서버 버전을 확인해 주세요.",
  STALE_RUN:
    "더 최근의 실행이 있습니다. 최신 기록을 확인한 뒤 다시 요청해 주세요.",
  GATE_CHANGED:
    "실행 제한 상태가 바뀌었습니다. 최신 상태를 확인한 뒤 다시 요청해 주세요.",
  RECOVERY_LIMIT_REACHED:
    "작업 또는 계정의 재시도·누적 시간 상한에 도달했습니다. 실행 기록과 정책을 검토해 주세요.",
  RETRY_TOO_EARLY: "아직 다시 시도할 수 있는 시각이 아닙니다.",
  PROVIDER_CHECK_RESERVED: "이미 실행 제한을 확인하는 작업이 예약돼 있습니다.",
  TASK_CANCELLED:
    "취소한 작업은 재개할 수 없습니다. 필요하면 새 작업을 등록해 주세요.",
  TASK_ALREADY_COMPLETED: "이미 완료된 작업입니다.",
  TASK_ALREADY_QUEUED: "이미 실행 대기 중입니다.",
  RUN_ACTIVE: "현재 실행 중입니다. 중단하려면 취소를 요청해 주세요.",
  RECOVERY_IN_PROGRESS:
    "이 작업의 상태를 확인하고 있습니다. 잠시 후 결과를 확인해 주세요.",
  TERMINATION_UNCONFIRMED:
    "이전 실행이 끝났는지 확인하지 못했습니다. 실행 환경을 확인한 뒤 다시 요청해 주세요.",
  TERMINATION_TRACKING_REQUIRED:
    "현재 실행 설정은 종료 확인을 지원하지 않습니다. 컨테이너 실행 설정이 필요합니다.",
  UNKNOWN_STOP_REASON:
    "이전 기록의 중단 이유를 알 수 없어 재개하지 않았습니다.",
  UNRESOLVED_RUN:
    "종료가 확인되지 않은 다른 실행이 있습니다. 해당 실행부터 확인해 주세요.",
  EXECUTION_DISABLED: "서버의 자동 실행 설정이 꺼져 있습니다.",
  REQUEST_KEY_CONFLICT:
    "같은 요청 키에 다른 내용이 사용됐습니다. 목록을 확인한 뒤 새 요청을 보내 주세요.",
};
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError)
    return (
      messages[error.code] ??
      (error.status === 401
        ? "로그인이 만료됐습니다. 다시 로그인해 주세요."
        : error.status === 403
          ? "세션이 바뀌었거나 요청이 거부됐습니다. 새로고침 후 다시 시도해 주세요."
          : "요청을 처리하지 못했습니다. 현재 목록과 서버 상태를 확인해 주세요.")
    );
  return "서버에 연결하지 못했습니다. 마지막으로 확인한 기록을 표시합니다.";
}
