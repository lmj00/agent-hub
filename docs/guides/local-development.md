# 로컬 개발과 검사

저장소 루트에서 실행하는 개발 명령입니다. AI 실행 설정은 별도 안내를 따릅니다.

[문서 길잡이](../README.md)

- [로컬 실행](#로컬-실행)
- [로컬 DB와 테이블 변경](#로컬-db와-테이블-변경)

## 로컬 실행

저장소 루트에서 실행합니다. Node.js는 [`.nvmrc`](../../.nvmrc)의 24.22.1, pnpm은 [`package.json`](../../package.json)의 12.16.1을 준비합니다. [nvm](https://github.com/nvm-sh/nvm)을 사용한다면 다음과 같이 맞출 수 있습니다.

```sh
nvm install
nvm use
npm install --global pnpm@12.16.1
```

의존성을 설치하고 개발 서버를 실행합니다. `pnpm dev`는 소스가 바뀌면 서버를 다시 시작합니다.

```sh
pnpm install --frozen-lockfile
LOCAL_API_ONLY=1 pnpm dev
```

다른 터미널에서 응답을 확인합니다.

```sh
curl http://127.0.0.1:3000/health/live
curl http://127.0.0.1:3000/health/ready
```

위 명령은 인증 없는 로컬 API 개발 모드를 명시적으로 켭니다. 사용 안내의 curl 예제는 이 모드를 기준으로 합니다. 로그인 기능은 [로그인 설정](management.md#단일-사용자-로그인-설정)의 `AUTH_CONFIG` 방식으로 실행하며, 데이터 API에는 로그인 세션이 필요합니다. `/health/live`는 공개하고, `/health/ready`는 [전용 점검 인증값](../04-operations.md#외부에서-서버-상태-점검하기)도 허용합니다. 둘 중 하나의 접근 모드를 정하지 않은 서버는 시작하지 않습니다.

서버 응답 확인(`/health/live`) 예시:

```json
{"status":"ok","checkedAt":"2026-10-29T00:00:00.000Z"}
```

DB 준비 상태(`/health/ready`) 예시:

```json
{"status":"ok","database":"ok","checkedAt":"2026-10-29T00:00:00.000Z"}
```

| API | 확인하는 범위 |
| --- | --- |
| `/health/live` | 서버가 HTTP 요청에 응답하는지 확인 |
| `/health/ready` | 서버가 사용하는 DB 테이블을 조회할 수 있는지 확인. 성공하면 200, 실패하면 503. AI 작업 진척을 뜻하지 않음 |

두 응답 모두 `checkedAt`에 UTC 관측 시각을 담고 `Cache-Control: no-store`를 지정합니다. 실행 중 DB 조회가 실패해도 서버 응답 여부는 별도로 확인할 수 있습니다. DB 준비 상태는 조회 기준입니다. AI 실행 설정과 대기열 상태는 별도로 확인합니다.

현재 서버는 같은 컴퓨터에서 접속하는 `127.0.0.1`에 바인딩합니다. 포트의 기본값은 3000이며, `LOCAL_API_ONLY=1 PORT=4000 pnpm dev`처럼 셸 환경 변수로 바꿀 수 있습니다. `PORT`는 1~65535의 정수여야 합니다. 종료할 때는 `Ctrl+C`를 누릅니다.

| 명령 | 하는 일 |
| --- | --- |
| `pnpm dev` | TypeScript 소스로 개발 서버 실행·변경 감지. AUTH_CONFIG 또는 LOCAL_API_ONLY 지정 필요 |
| `pnpm dev:web` | 화면 변경을 감지해 다시 빌드. 별도 터미널에서 개발 서버 실행 필요 |
| `pnpm format` | 관리하는 소스와 설정의 코드 형식 정리 |
| `pnpm check` | 코드 형식·기본 오류·모듈 참조 방향 검사 |
| `pnpm check:boundaries` | 모듈 참조 방향만 검사 |
| `pnpm typecheck` | 공통 계약·서버·화면 코드와 테스트의 타입 검사 |
| `pnpm test` | 자동 테스트 한 번 실행 |
| `pnpm test:browser` | 빌드 후 Chromium에서 임시 DB·가짜 AI로 주요 화면 흐름 검증 |
| `pnpm build` | 공통 계약·서버·화면을 각 패키지의 `dist`에 빌드 |
| `pnpm start` | 빌드한 서버 실행. 먼저 `pnpm build` 및 접근 모드 설정 필요 |
| `pnpm auth:setup --config .local/auth.json --origin http://127.0.0.1:3000` | 비공개 로그인 설정과 무작위 비밀번호 생성 |
| `pnpm backup` | 서버를 중지한 뒤 DB·개발 Git·입력을 백업·검사·복원. [조건과 인자](../04-operations.md#db개발-코드-백업과-복원) 확인 |
| `pnpm db:generate --name=변경이름` | 스키마와 이전 기록을 비교해 SQL 마이그레이션 생성 |
| `pnpm task:run --task 작업ID --config 설정파일절대경로` | 등록된 대기 작업 한 건을 실제 Codex로 분석하고 결과 저장 |

서버는 `apps/server`, 화면은 `apps/web`, 공통 요청·응답 형식은 `packages/contracts`에 있습니다. 서버의 `main.ts`는 시작·종료, `app.ts`는 DB와 기능 연결, `config.ts`는 환경 변수 확인을 담당합니다. DB 코드는 `db/`, 기능별 코드는 `modules/`에 둡니다. `run-task-cli.ts`는 분석 실행의 CLI 진입점입니다. 루트 실행 명령은 필요한 공통 패키지를 먼저 빌드합니다.

### GitHub 자동 검사

[`CI`](../../.github/workflows/ci.yml)는 `main` 푸시와 PR마다 Ubuntu 22.04·24.04에서 잠금 파일을 유지한 설치·타입 검사·빌드·테스트를 실행합니다. Node.js와 pnpm 버전은 저장소 설정을 읽습니다. Docker 종료·권한 제한 테스트와 Chromium 화면 테스트도 포함합니다. 실패한 화면의 추적 자료는 7일간 보관합니다.

GitHub가 제공하는 임시 실행 서버에서 합성 인증과 가짜 AI 실행기를 사용하며, 개인 Codex 인증·실제 모델 호출·배포는 연결하지 않습니다. 로컬 전체 검증은 다음 순서로 실행합니다. 자동 검사의 성공 여부는 저장소의 Actions에서 해당 커밋 결과를 확인합니다.

```sh
docker build -f docker/operations-check.Dockerfile -t agent-hub-operations-test:local .
RUN_CONTAINER_TESTS=1 pnpm test
pnpm test:browser
```

기본 Docker 정책에서는 Codex의 중첩 샌드박스 생성이 거부될 수 있어 전용 seccomp·AppArmor 정책을 적용합니다. 정책의 근거와 설치 방법은 [컨테이너 실행 안내](agents.md#컨테이너로-실행-종료-확인하기)에 있습니다. 초기화 실패는 설정 문제로 보류하며, 샌드박스를 끄거나 실패한 분석을 성공으로 표시하지 않습니다.

## 로컬 DB와 테이블 변경

기본 DB 파일은 저장소 루트의 `data/agent-hub.sqlite`입니다. 서버 시작 시 디렉터리와 DB를 만들고, `apps/server/migrations/`의 SQL 중 아직 적용하지 않은 변경을 순서대로 적용합니다. 성공해야 HTTP 요청을 받으며, DB 열기나 마이그레이션에 실패하면 시작을 중단하고 오류를 기록합니다. 정상 종료 시 DB 연결도 닫습니다.

다른 DB 파일을 사용하려면 셸 환경 변수로 경로를 전달합니다. 상대 경로는 개발 실행·빌드 실행 모두 저장소 루트를 기준으로 해석하고, 절대 경로도 사용할 수 있습니다.

```sh
LOCAL_API_ONLY=1 DATABASE_PATH=data/dev.sqlite pnpm dev
```

기본 `data/` 디렉터리, `*.sqlite`·`*.db` 파일과 그에 붙는 SQLite 임시·로그 파일은 Git에서 제외합니다. 테스트는 별도의 임시 디렉터리에 DB를 만들어 사용합니다.

DB에는 비공개 작업 지시·분석 결과·로그인 세션이 저장됩니다. 새 DB 폴더는 소유자만 접근하는 `0700`, DB 파일은 소유자만 읽고 쓰는 `0600`으로 만듭니다. 기존 DB와 WAL·SHM·journal 보조 파일도 소유자를 확인한 뒤 `0600`으로 제한하며 데이터는 유지합니다. 다른 계정이 파일을 바꿔치기할 수 있는 쓰기 가능한 폴더, 다른 소유자의 파일, 심볼릭 링크·하드 링크는 거부합니다. 기존 상위 폴더의 권한은 자동으로 바꾸지 않습니다. 이 보호는 같은 운영 계정으로 실행되는 프로그램이나 관리자까지 차단하는 기능은 아닙니다.

테이블을 바꿀 때는 다음 순서를 따릅니다.

1. `apps/server/src/db/schema.ts`에서 테이블 정의를 수정합니다.
2. `pnpm db:generate --name=변경이름`으로 SQL과 변경 기록을 생성합니다.
3. 생성된 SQL을 검토하고, 빈 DB 적용·기존 데이터 보존·실패 시 되돌리기를 테스트합니다.
4. 스키마와 `migrations/`를 함께 커밋합니다. 검토한 변경은 다음 서버 시작 때 적용됩니다.

이미 적용한 마이그레이션은 수정하지 않고 새 변경을 추가합니다. 빌드한 서버를 실행할 때도 `apps/server/migrations/`가 함께 있어야 합니다. `0000_projects.sql`은 프로젝트, `0001_tasks.sql`은 작업과 등록 중복 방지 조건을 생성합니다. `0002_execution.sql`은 기존 작업을 보존하며 상태를 확장하고 실행·호출 단계·이벤트 테이블을 추가합니다. `0003_execution_queue.sql`은 실행 소유권 테이블과 대기 작업 선택용 인덱스를 추가합니다.

`0004_execution_stop_evidence.sql`은 중단 요청 사유·시각과 종료 확인 시각을 추가합니다. 기존 실행 이력을 유지하며, 예전 `cancel_requested`는 사유가 불명확한 `unknown`으로 옮기고 실제 요청·종료 시각은 추정하지 않습니다.

`0005_execution_identity.sql`은 비공개 실행 식별 정보를 추가합니다. 기존 실행에는 식별자를 만들어 넣지 않으며 API에도 컨테이너 ID·실행 토큰을 노출하지 않습니다.

`0006_provider_gate.sql`은 제공자 차단·확인 실행 예약과 재시도 시각을 추가합니다. 기존 한도·인증·설정 보류도 차단 기록으로 옮기며, 과거 이력은 보존합니다. 실행 자리의 유일성 조건은 현재 실행과 종료 미확인 보류에 적용합니다.

`0007_completion_states.sql`은 취소 상태와 실행 시도 번호를 추가합니다. 기존 작업을 참조하는 Run·Step·이벤트·차단 기록을 보존하며, 마지막 외래 키 검사에 실패하면 테이블 변경과 마이그레이션 기록을 함께 취소합니다.

`0020_task_goal_review.sql`은 기존 Task·Run·복구 기록을 유지하며 작업의 최근 목표 범위 검사 근거를 추가합니다. 이전 작업의 값은 `null`이며 검사하지 않은 작업을 확인 완료로 표시하지 않습니다.
