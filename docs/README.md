# 문서 길잡이

처음에는 **구조 요약과 진행 상태 두 문서**만 읽어도 됩니다. 설정이나 코드를 바꿀 때 필요한 상세 문서를 찾아보세요.

## 처음 읽을 때

1. [프로젝트 소개](../README.md): 어떤 문제를 해결하는 프로그램인가?
2. [구조와 동작 요약](01-architecture.md): 목표 하나를 맡기면 어떤 일이 일어나는가?
3. [진행 상태와 완료 기준](02-implementation-plan.md): 무엇이 끝났고 무엇이 남았는가?
4. [기술 선택과 대안](03-technology-decisions.md): 왜 이 방식으로 만드는가?

## 직접 실행하거나 설정할 때

| 하려는 일 | 안내 |
| --- | --- |
| 로컬 서버 실행, 테스트, DB 변경 | [로컬 개발](guides/local-development.md) |
| 로그인, 프로젝트·목표·예산 등록, 서비스 관측 | [관리 화면과 설정](guides/management.md) |
| Codex 인증, Docker, 자동 실행, 중단·재개 | [AI 실행과 복구](guides/agents.md) |
| 조치가 필요한 문제를 알림으로 받기 | [알림 설정과 전송 기록](guides/notifications.md) |
| Linux 서비스, HTTPS, 로그, 백업·복원 | [운영 절차](04-operations.md) |

## 코드를 구현하거나 검토할 때

| 확인할 규칙 | 상세 기준 |
| --- | --- |
| 다음 작업 생성, 목표 변경, 예산, 개발·검증·Git 반영 | [자율 개발 규칙](reference/autonomy.md) |
| API, 작업 상태, 취소·복구, 관측, 로그인 | [실행과 복구 규칙](reference/execution.md) |
| 용어, 코드 의존 관계, 배치, 실행 환경, effort | [코드와 실행 환경](reference/code-and-runtime.md) |
| 남은 운영 기능의 설계와 검증 조건 | [운영 구현 계획](plans/operations.md) |

요약은 이해를 돕고, 상세 기준은 구현 시 지켜야 할 조건을 설명합니다. 현재 완료 여부는 [진행 상태](02-implementation-plan.md)에서 확인합니다. 사람이 읽어도, AI가 구현할 때 찾아봐도 같은 기준을 사용합니다.

## 과거의 판단 근거를 찾을 때

- [이전 계획과 검증 기록](history/implementation-records.md): 단계별 검토·실험·발견한 문제.
- [기술 선택의 상세 기록](history/technology-decisions.md): 비교한 대안·감수한 단점·변경 이유.
- [자원 사용 기록](history/resource-measurements.md): 측정 환경·메모리·파일 증가량과 해석의 한계.
- [20분 지속 관리 시험](history/continuous-operation.md): 입력 변화·관측 실패·대기·앱 다시 열기에 따른 실제 AI 동작.

기록 안의 “현재”, “다음 단계”, 테스트 수는 **작성 당시 기준**입니다. 새 작업을 결정할 때는 현재 진행 문서를 먼저 확인합니다. 과거 소스 줄 번호를 최신 위치로 해석하지 않습니다.

## 문서를 수정할 때

동작 규칙은 `reference/`, 사용 명령은 `guides/`와 운영 절차, 완료 상태는 진행 문서에 반영합니다. 긴 검토 결과는 `history/`에 보존하고, 소개 문서에는 결과와 확인하지 못한 점만 요약합니다. 같은 사실을 여러 곳에 복사해 각각 갱신하지 않습니다.
