# agent-hub용 gstack 지침

이 디렉터리의 네 역할 지침은 [gstack](https://github.com/garrytan/gstack)의
일부 지침을 agent-hub 실행 환경에 맞게 수정한 것입니다.

- 원본: gstack `1.93.11.0`, 커밋 `24a47db3d9e12a1f6ead6919306ef0da3b5696d9`
- 원본 저작권: Copyright (c) 2026 Garry Tan
- 라이선스: 함께 배포하는 [LICENSE](LICENSE)의 MIT License
- 제품용 지침 버전: `1`
- 적용 모드: `adapted_instructions`

| 파일 | 원본에서 가져온 판단 기준 |
| --- | --- |
| `planner.md` | `plan-eng-review/sections/review-sections.md`의 Architecture, Code quality, Test, Performance review |
| `developer.md` | `verify/SKILL.md`의 검증·검사 약화 금지, `investigate/SKILL.md`의 Iron Law와 How to work |
| `reviewer.md` | `review/checklist.md`의 데이터·동시성·신뢰 경계·값 처리·검증 무결성·완료 기준 |
| `analyst.md` | 같은 리뷰 체크리스트를 요청 범위의 읽기 전용 분석에 적용 |

원본 파일 전체의 SHA-256은 `manifest.json`의 `sources`에 기록합니다. 로컬
gstack 설치의 수정본이나 최신 브랜치를 원본으로 사용하지 않습니다.

변경 내용: 역할별로 필요한 판단 기준을 요약·재작성하고 agent-hub의 출력
형식과 권한 경계를 추가했습니다. 원본의 대화형 질문, 호스트 경로, 실행
명령, 자동 업그레이드, 텔레메트리, 브라우저, 외부 모델 호출, 커밋·푸시·배포
절차는 포함하지 않았습니다. 테스트 실행·취소·예산·변경 반영은 서버가
담당합니다. 원본 CLI·전체 스킬 절차의 실행 또는 품질 향상을 보증하지 않습니다.

원본 NOTICE는 관련 검토·설계·조사 원칙에 pstack(Lauren Tan)과
tstack(Theo Browne)의 아이디어를 참고했음을 밝힙니다. 이 표시는 해당
출처를 보존하기 위한 것이며, 이 묶음은 두 프로젝트의 스크립트나 도구를
포함하지 않습니다. 원본 NOTICE:
https://github.com/garrytan/gstack/blob/24a47db3d9e12a1f6ead6919306ef0da3b5696d9/NOTICE.md

지침을 바꿀 때에는 제품용 버전과 manifest의 해시, 로더의 manifest 해시를
함께 갱신하고 실제 서버·컨테이너에서 검증합니다. 파일 해시는 배포 누락과
버전 혼합을 감지하기 위한 것입니다. 서버 코드와 해시를 함께 수정할 수
있는 관리자의 변경까지 차단하는 서명이나 보안 경계는 아닙니다.
