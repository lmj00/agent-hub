import type { ServiceState } from "@agent-hub/contracts";

export const serviceStateLabels: Record<ServiceState, string> = {
  healthy: "업무 처리 중",
  waiting: "정상 대기",
  degraded: "업무 확인 필요",
  stopped: "종료 보고",
  stale: "오래된 정보",
  unavailable: "관측 실패",
  unknown: "상태 미확인",
};
export const serviceReasons: Record<string, string> = {
  not_observed: "아직 수집한 상태가 없습니다.",
  observer_disabled: "이 서버의 서비스 관측이 꺼져 있습니다.",
  observer_error: "관측 결과를 저장하지 못했습니다. 서버 기록을 확인해 주세요.",
  reported_working: "서비스가 업무를 처리 중이라고 보고했습니다.",
  reported_waiting:
    "서비스가 입력을 기다리고 있으며, 허용한 정상 대기 조건입니다.",
  process_stopped: "상태 API가 대상 프로세스의 종료를 보고했습니다.",
  reported_degraded: "서비스가 업무 처리 문제를 보고했습니다.",
  signals_missing: "상태를 판단하는 데 필요한 신호가 부족합니다.",
  progress_time_missing:
    "최근 업무 성공 시각을 제공하지 않아 처리 간격을 판단할 수 없습니다.",
  progress_overdue: "최근 업무 성공 후 설정한 허용 시간이 지났습니다.",
  scheduled_work_overdue: "다음 업무 예정 시각과 관측 유효 기간이 지났습니다.",
  waiting_not_allowed:
    "업무 대기가 보고됐지만 이 서비스의 정상 대기 조건으로 허용하지 않았습니다.",
  observation_stale:
    "상태의 유효 기간이 지났습니다. 과거 기록으로 현재 정상을 판단하지 않습니다.",
  clock_skew:
    "수집 시각이나 서비스 보고 시각이 미래입니다. 시계 설정을 확인해 주세요.",
  timeout: "정해진 시간 안에 상태 응답을 받지 못했습니다.",
  request_failed:
    "상태 API에 연결하지 못했습니다. 서비스 종료 여부는 미확인입니다.",
  http_error:
    "상태 API가 실패 응답을 보냈습니다. 서비스 종료 여부는 미확인입니다.",
  invalid_payload: "상태 API의 응답 형식이나 시각을 확인해 주세요.",
  response_too_large: "상태 응답이 허용한 크기를 초과했습니다.",
  redirect_refused:
    "상태 API가 다른 주소로 이동을 요청했습니다. 등록한 주소를 확인해 주세요.",
};
