export const stopReasons = {
  scope_changed: "목표의 허용 범위 축소",
  budget_limit: "기간 실행 예산 소진",
  user_cancel: "사용자 취소 요청",
  server_shutdown: "서버 종료",
  timeout: "제한 시간 초과",
  unknown: "중단 이유 미확인",
};
export const runErrors: Record<string, string> = {
  scope_changed:
    "목표에서 허용한 경로가 줄어 실행 중단을 요청했습니다. 종료 확인 후 범위 변경에 따른 취소로 기록합니다.",
  verification_required:
    "목표 완료 제안은 받았지만 실제 코드와 테스트의 검증 근거가 없어 완료로 반영하지 않았습니다.",
  work_unresolved:
    "진행·종료 확인·복구 중인 작업이 있거나 기존 작업의 범위를 확인할 수 없어 새 계획을 보류했습니다.",
  planning_no_progress:
    "중복·재생성이 차단된 작업 또는 미완료인 목표의 완료 제안이 세 번 이어져 계획을 보류했습니다.",
  input_unavailable:
    "분석 자료를 준비하지 못했습니다. 원본 저장소의 미커밋 변경, 허용 경로와 파일·목표 입력의 크기 제한을 확인해 주세요.",
  input_changed:
    "분석 중 원본 코드가 바뀌어 결과를 반영하지 않았습니다. 최신 코드를 기준으로 다시 확인해야 합니다.",
  goal_changed: "목표의 상태나 버전이 바뀌어 이전 기준의 실행을 보류했습니다.",
  budget_limit:
    "프로젝트 또는 목표의 기간 예산을 다 썼습니다. 기존 결과를 보존하고 다음 기간에 실행 조건을 다시 확인합니다.",
  termination_unconfirmed: "결과가 있어도 전체 실행 종료를 확인하기 전까지 새 실행은 보류합니다.",
  owner_lost: "실행을 관리하던 서버가 중단됐습니다. 이전 실행의 종료를 확인해 주세요.",
  timeout: "정해진 실행 시간을 초과했습니다.",
  transient: "AI 서비스와의 연결에 일시적인 오류가 발생했습니다.",
  server_shutdown: "서버 종료로 멈췄습니다. 종료 확인 후 재개할 수 있습니다.",
  cancel_requested: "취소 요청을 기록했습니다. 종료가 확인되면 취소가 완료됩니다.",
  capacity: "AI 계정의 사용량 제한으로 실행을 보류했습니다.",
  authentication: "AI 계정 로그인을 확인해 주세요.",
  configuration: "AI 실행 설정을 확인해 주세요.",
  invalid_plan: "다음 단계의 제안 형식이 올바르지 않아 분석을 보류했습니다.",
  invalid_change: "수정 내용이 허용 범위·파일 종류·크기 제한에 맞지 않아 변경을 보류했습니다.",
  development_incomplete: "개발 작업의 테스트·검토·변경 반영이 확인되지 않아 완료를 보류했습니다.",
  development_continue:
    "추가 수정이 남아 이번 실행을 마쳤습니다. 자동 복구가 켜져 있으면 실행 조건을 확인한 뒤 저장된 변경과 검토 의견에서 이어갑니다.",
  workflow_limit:
    "호출 수 또는 전달할 맥락의 상한에 도달했습니다. 저장된 단계 결과를 확인해 주세요.",
  analysis_incomplete:
    "에이전트가 완료를 승인하지 못했습니다. 아래에 기록된 보류 사유를 확인해 주세요.",
};
