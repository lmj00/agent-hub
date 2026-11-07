# 개발에 참여하기

프로젝트 목적과 현재 기능은 [README](README.md), 동작 규칙은 [구조 요약](docs/01-architecture.md)에서 시작합니다. AI 작업 지침은 [AGENTS.md](AGENTS.md)에 있습니다.

## 처음 실행하기

루트 `.nvmrc`의 Node와 `package.json`의 pnpm 버전을 사용합니다. 의존성 설치는 `pnpm install --frozen-lockfile`, 실행은 [로컬 개발 안내](docs/guides/local-development.md)를 따릅니다. 일반 개발·자동 테스트에는 개인 AI 인증이 필요하지 않습니다.

## 코드를 둘 위치

| 변경 내용 | 위치 |
| --- | --- |
| 서버의 프로젝트·목표·작업·실행 기능 | `apps/server/src/modules/`의 해당 기능 |
| 서버 구성과 기능 연결 | `apps/server/src/app.ts` |
| 관리 화면 | `apps/web/src/features/`의 해당 기능, 공통 API·표시는 `shared/` |
| 서버와 화면이 주고받는 자료 형식 | `packages/contracts/src/` |
| DB 테이블·변경 이력 | `apps/server/src/db/`, `apps/server/migrations/` |
| 운영 설정·검증 명령 | `ops/`, `scripts/` |

함께 변경되는 코드와 테스트를 가까운 기능으로 묶습니다. 서버 파일은 `kebab-case.ts`, React 컴포넌트는 `PascalCase.tsx`, 테스트는 `*.test.ts` 또는 브라우저용 `*.spec.ts`로 이름 짓습니다. 파일 길이보다 맡은 책임을 기준으로 분리합니다.

상태·예산·취소 규칙은 담당 모듈의 함수를 재사용합니다. 다른 모듈의 내부 저장 처리를 직접 가져오기 전에 기존 호출 지점과 트랜잭션 범위를 확인합니다. 여러 상태를 함께 저장하는 처리를 단순히 파일별 호출로 쪼개지 않습니다. 상세 기준은 [코드 구조 규칙](docs/reference/code-and-runtime.md#코드를-나누고-연결하는-기준)에 있습니다.

## 변경 확인하기

저장소 루트에서 실행합니다.

```sh
pnpm format
pnpm check
pnpm typecheck
pnpm test
pnpm build
```

`format`은 코드 형식을 수정하고, `check`는 형식과 기본 오류 규칙을 수정 없이 검사합니다. `lint`와 `format:check`로 각각 실행할 수도 있습니다. Biome은 `biome.json`에 명시한 기본 오류를 검사하고, TypeScript 타입 검사는 `tsc`가 담당합니다. 자동 검사만으로 코드 리뷰를 대체하지 않습니다.

화면을 변경하면 `pnpm test:browser`도 실행합니다. Docker가 필요한 실제 실행 격리 검사는 [로컬 개발 안내](docs/guides/local-development.md)를 따릅니다. 로컬 기본 테스트에서 제외된 컨테이너 검사와 Linux 서비스 검사는 CI 결과까지 확인합니다.

설정·라이브러리는 정확한 버전을 고정하고 잠금 파일을 함께 변경합니다. DB 변경은 SQL 마이그레이션을 생성·검토하며 이미 적용된 이력을 수정하지 않습니다.

## 리뷰할 변경 만들기

- 하나의 변경에는 하나의 목적을 둡니다. 형식 정리·파일 이동과 동작 변경은 별도 커밋으로 구분합니다.
- PR에는 해결한 문제, 바뀐 동작, 실제 실행한 검증과 미확인 항목을 적습니다.
- 바뀐 기능의 실패·취소·재시작 경로를 확인합니다. 기존 테스트를 통과시키기 위해 기준을 낮추지 않습니다.
- 인증 파일·키·개인 서버 주소·작업 DB·AI 출력은 커밋하지 않습니다. 설정 예시는 가상 값으로 작성합니다.

포맷 대상은 직접 관리하는 코드와 설정입니다. 생성된 DB 이력, 외부 지침, 이전 실행기 호환성 등을 재현하는 테스트 자료는 자동 포맷에서 제외합니다. 이 자료의 동작 검사는 기존 테스트로 유지합니다.
