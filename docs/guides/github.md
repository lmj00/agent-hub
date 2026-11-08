# GitHub 저장소 연결

**현재 지원:** 본인 개인 계정의 허용한 저장소를 가져오거나, 새 비공개 저장소를 만들어 프로젝트로 등록합니다. 개발 환경과 목표를 설정해야 AI 개발이 시작됩니다. 자동 테스트는 외부 응답 대역을 사용하므로 실제 계정의 설치·생성·가져오기는 별도로 확인해야 합니다.

관리 화면 로그인과 GitHub 저장소 권한은 별개입니다. 관리 화면은 기존 비밀번호·세션을 사용합니다. GitHub 키는 서버의 비공개 파일에 두고, 브라우저나 AI 작업 폴더에 전달하지 않습니다.

## 1. 개인 GitHub App 준비

GitHub의 **Settings → Developer settings → GitHub Apps → New GitHub App**에서 본인 계정용 앱을 만듭니다.

| 설정 | 현재 필요한 값 |
| --- | --- |
| 설치 대상 | Only on this account |
| Homepage URL | 자신의 프로젝트 소개 또는 저장소 주소 |
| Webhook Active | 끔 |
| OAuth during installation · Device Flow | 사용하지 않음 |
| Repository permissions | Metadata 읽기, 가져오기에는 Contents 읽기 추가. 새 저장소 생성에는 Repository creation 쓰기 추가. Administration은 필요 없음 |
| 설치 저장소 | Only select repositories에서 직접 선택 |

앱의 App ID를 기록하고 **Generate a private key**로 PEM 파일을 발급받습니다. **Install App**에서 본인 개인 계정에 설치합니다. 설치 설정 주소의 마지막 숫자가 Installation ID입니다. `https://api.github.com/users/YOUR_ACCOUNT`의 `id`가 계정의 숫자 ID이며, 로그인 이름과 다릅니다.

앱 설치 계정 ID·App ID·Installation ID가 설정과 다르거나, 설치가 중지됐거나, 전체 저장소 접근으로 설치했다면 서버는 조회를 거부합니다. 현재 연결은 조직 계정 설치를 지원하지 않습니다. [공식 앱 등록 안내](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)를 참고하세요.

## 2. 서버의 비공개 설정

PEM 파일을 서버의 비공개 설정 디렉터리에 전달합니다. 아래 `.local/` 예시는 agent-hub 저장소에서 실행하는 로컬 설정입니다. 실제 AI가 분석하는 프로젝트 폴더 안에는 두지 않습니다.

```sh
mkdir -p .local
chmod 700 .local
chmod 600 .local/github-app.pem
```

다음 코드의 세 숫자를 실제 값으로 바꿔 실행합니다. 키 내용을 터미널에 출력하지 않고 새 설정 파일에 기록합니다. 기존 파일은 덮어쓰지 않습니다.

```sh
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const config = {
  version: 1,
  appId: 1001,
  installationId: 2002,
  ownerId: 3003,
  privateKey: readFileSync('.local/github-app.pem', 'utf8'),
};
writeFileSync('.local/github.json', JSON.stringify(config), { mode: 0o600, flag: 'wx' });
JS
```

로그인 설정을 함께 지정해 서버를 시작합니다. systemd 운영에서는 같은 환경 변수의 절대 경로를 서비스 설정에 넣고 재시작합니다.

```sh
pnpm build
AUTH_CONFIG=.local/auth.json GITHUB_CONFIG=.local/github.json pnpm start
```

`GITHUB_CONFIG`는 선택 설정입니다. 지정하지 않으면 기존 기능은 그대로 동작하고 화면에 설정 안내를 표시합니다. 지정했다면 잘못된 키·파일 권한은 시작 오류가 됩니다. 인증 없는 로컬 API 모드에서는 GitHub 연결을 켤 수 없습니다. 실행 설정에 GitHub 설정 파일을 포함하는 작업 폴더가 있으면 AI 실행을 거부합니다.

## 3. 화면에서 확인

**전체 현황 → GitHub 저장소 연결 → 연결 확인 및 저장소 조회**를 누릅니다. 계정 이름·공개 여부·보관 여부를 확인할 수 있습니다. 목록은 30개씩 표시하며 자동으로 반복 조회하지 않습니다.

서버는 먼저 설치 계정을 검증하고, Metadata 읽기 권한만 있는 임시 토큰으로 목록을 조회합니다. 이 토큰은 DB·화면·Git 주소에 저장하지 않습니다. GitHub의 [설치 인증 방식](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)과 [토큰 권한 제한](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)을 따릅니다.

다시 조회하다 실패하면 이전 목록을 지웁니다. 이전 목록이 지금도 접근 가능하다는 뜻으로 남지 않게 하기 위함입니다. 권한은 GitHub에서 변경한 뒤 다시 조회합니다. 목록 확인만으로 실제 소스 가져오기나 AI 실행이 검증된 것은 아닙니다.

| 문제 | 확인할 것 |
| --- | --- |
| 설치 계정 불일치 | 숫자 ownerId와 개인 계정 설치 여부 |
| 선택한 저장소 필요 | 설치 설정의 Only select repositories |
| 키·설치·권한 확인 필요 | 키 폐기 여부, 앱 삭제·중지, 설치 권한 |
| 요청 한도 | 잠시 기다린 뒤 직접 재조회 |
| 연결 실패 | 서버의 외부 HTTPS 연결과 시각 동기화 |

키를 바꾸려면 새 비공개 설정 파일을 준비해 `GITHUB_CONFIG`를 변경하고 서버를 재시작합니다. GitHub에서 이전 키도 폐기합니다. GitHub 키 폐기는 관리 화면의 로그인 세션 폐기와 별개입니다.

## 4. 가져오기 환경 준비

서버의 비공개 실행 설정에 `importProfiles`를 추가합니다. [AI 실행 설정](agents.md)의 Codex 인증·개발 컨테이너 설정이 먼저 필요합니다. 아래는 기존 실행 설정에 추가할 부분입니다. 이미지는 서버에 준비한 실제 검증 이미지로 바꿉니다.

```json
{
  "importProfiles": {
    "node-tests": {
      "image": "project-tests:local",
      "command": ["node", "--test"],
      "timeoutMs": 60000
    }
  }
}
```

검증 환경은 **운영자가 지정한 이미지와 테스트 명령**입니다. 브라우저에서는 환경 이름만 선택하며 저장소가 서버 명령을 정하지 않습니다. 의존성이나 빌드 도구가 필요한 프로젝트는 해당 도구가 준비된 이미지와 명령을 설정해야 합니다. `containerImage` 없이 가져오기 환경만 지정하면 서버가 시작을 거부합니다.

```sh
AUTH_CONFIG=.local/auth.json GITHUB_CONFIG=.local/github.json \
EXECUTION_CONFIG=.local/execution.json pnpm start
```

`EXECUTION_CONFIG` 경로는 실제 실행 설정 경로로 맞춥니다. `workspaces`가 비어 있어도 가져온 프로젝트가 실행 중인 서버에 연결됩니다.

## 5. 저장소를 프로젝트로 가져오기

1. 목록에서 **가져오기 선택**을 누릅니다. 보관된 저장소는 가져올 수 없습니다.
2. 프로젝트 이름과 검증 환경을 선택하고 **이 저장소 가져오기**를 누릅니다.
3. 대기·소스 준비·완료 상태를 확인합니다. 완료되면 **프로젝트 열기**에서 목표와 허용 파일 범위를 설정합니다.

기본 브랜치의 특정 커밋 소스를 서버의 비공개 `<DB 파일명>.sources` 폴더에 준비합니다. 원본 GitHub 커밋 번호를 기록하고, 준비한 소스에 별도 로컬 Git 기준 커밋을 만듭니다. 과거 Git 이력 복제·GitHub 변경의 자동 동기화·원격 푸시는 수행하지 않습니다. 이후 검증한 개발 변경은 기존의 별도 개발 Git에 누적됩니다.

같은 저장소를 다시 제출해도 같은 가져오기 기록과 프로젝트를 반환합니다. 다른 이름으로 재제출해도 기존 프로젝트를 복제하지 않습니다. 가져오기 대기·진행 중에는 취소할 수 있고, 실패·취소 후에는 최대 5번까지 시도할 수 있습니다. 서버가 준비 도중 중단되면 다음 시작에서 실패로 기록하므로 화면에서 명시적으로 다시 시도합니다. 중간 파일은 새 시도에서 재사용하지 않으며 비공개 폴더에 남겨 둡니다.

완료된 소스는 재시작 시 DB와 대조합니다. 파일을 직접 바꾸거나 지우거나 검증 환경 설정을 제거하면 실행을 거부합니다. [백업·복원](../04-operations.md#db개발-코드-백업과-복원)은 가져온 소스도 포함하지만 이미지·인증·실행 설정은 별도로 보존해야 합니다.

| 제한 | 기준 |
| --- | --- |
| 가져오기 동시 실행 / 대기 포함 기록 | 1개 / 최대 20개 |
| 한 시도 제한 시간 | 다운로드와 준비 전체 120초 |
| 압축 / 압축 해제 크기 | 최대 16MiB / 64MiB |
| 파일 하나 / 항목 수 / 경로 깊이 | 16MiB / 10,000개 / 원본 최상위 폴더 제외 32단계 |
| 디스크 여유 | 시작 시 최소 1GiB |
| 거부하는 항목 | 링크·특수 파일·중복/대소문자 충돌 경로·`.git`·`.codex`·`.gitmodules` |

Git LFS 파일은 포인터로 남고 하위 모듈은 지원하지 않습니다. 큰 저장소가 가져와졌더라도 개별 목표의 준비 입력은 기존 한도인 파일 500개·총 8MiB·파일당 1MiB에 맞게 허용 범위를 좁혀야 합니다.

화면은 로컬 가져오기 상태를 3초 간격으로 확인합니다. GitHub 저장소 목록은 자동 반복 조회하지 않습니다. 가져오기 토큰은 해당 저장소 ID 하나에 읽기 권한만 주며, 압축 다운로드 호스트에 인증 헤더를 전달하지 않습니다.

## 6. 새 비공개 프로젝트 만들기

GitHub App에 **Repository creation: write** 권한을 추가하고 설치 계정에서 변경된 권한을 승인합니다. 기존 비공개 GitHub 설정 파일에 `"allowRepositoryCreation": true`를 추가한 뒤 서버를 재시작합니다. 기본값은 꺼짐이며 가져오기 환경도 필요합니다. [GitHub의 생성 권한 안내](https://github.blog/changelog/2026-10-13-github-app-improvements-for-least-privilege-and-management/)와 [개인 저장소 생성 API](https://docs.github.com/en/rest/repos/repos#create-a-repository-for-the-authenticated-user)를 따릅니다. 더 넓은 Administration 권한으로 자동 전환하지 않습니다.

1. **새 프로젝트 만들기**에서 저장소 이름·표시 이름·검증 환경을 입력합니다.
2. **비공개 저장소 만들기**를 누르면 본인 계정에 README가 있는 비공개 저장소를 만듭니다. 공개 저장소 생성 옵션은 없습니다.
3. 생성 후 아래 **프로젝트 가져오기**에서 준비 상태를 확인합니다. 완료되면 프로젝트를 열고 원하는 앱과 완료 기준을 목표로 입력합니다. 처음 생성한 README만으로 앱이 완성되는 것은 아닙니다.

서버는 생성 의도를 먼저 DB에 저장하고, 생성된 저장소 번호를 보존한 뒤 기존 가져오기로 연결합니다. 같은 요청을 다시 제출하면 기존 기록을 반환합니다. 같은 저장소 이름은 대소문자를 구분하지 않고 예약하므로 다른 요청으로 중복 생성할 수 없습니다.

| 상태 | 의미와 조치 |
| --- | --- |
| 생성 대기 | 원격 생성 전입니다. 대기를 취소할 수 있습니다. |
| 권한 확인·생성 중 | 요청 결과를 기다립니다. 이 단계에서 취소를 저장소 삭제로 처리하지 않습니다. |
| 생성 요청 실패 | 요청 전 실패 또는 GitHub의 명시적인 거절입니다. 이름·권한을 확인한 뒤 최대 5회까지 직접 다시 요청할 수 있습니다. |
| GitHub에서 생성 여부 확인 필요 | 요청 후 응답 유실·서버 중단 등으로 결과가 불확실합니다. 자동 재요청하지 않습니다. GitHub에서 확인하고 저장소가 있다면 기존 목록에서 선택해 가져오세요. |
| 저장소 생성 완료 · 가져오기 연결 실패 | 저장소는 보존됩니다. 연결만 재시도하며 저장소를 다시 만들지 않습니다. |
| 가져오기 요청 완료 | 아래 가져오기 기록에서 실패·취소·완료를 확인합니다. 가져오기를 취소해도 GitHub 저장소는 남습니다. |

한 번에 생성 작업 하나를 처리하며 준비 중인 기록은 최대 20개입니다. 생성 요청은 권한 확인을 포함해 30초로 제한합니다. 실제 원격 생성 결과가 불확실한 기록은 재시작 뒤에도 유지합니다. 작업 중 창을 닫아도 서버가 기록된 요청을 처리합니다.

다른 GitHub 통신이 진행 중이면 생성·가져오기 작업은 시도 횟수를 소비하지 않고 기다립니다. 대기 중 서버 설정을 바꿔 선택한 검증 환경이 사라졌다면 저장소를 만들기 전에 실패로 기록합니다.

백업·복원은 생성 대기·권한 확인·생성 중인 기록이 있으면 거부합니다. 먼저 대기를 취소하거나 결과를 정리하고 백업합니다. 이전 DB 상태를 복원하면서 원격 생성 요청을 반복하는 일을 막기 위한 기준입니다. 생성 기능을 다시 끄면 신규 요청은 받지 않으며 남은 기록은 보존합니다.

## API

모든 요청은 기존 관리 화면 인증이 필요합니다. POST는 세션 쿠키와 CSRF 토큰도 필요합니다.

| API | 동작 |
| --- | --- |
| `GET /integrations/github` | 설정 존재 여부. GitHub 접속 성공을 뜻하지 않음 |
| `POST /integrations/github/repositories` | JSON `{ "page": 1 }`. 허용 범위 1~1000, 한 번에 30개. 계정 검증 후 조회 |
| `GET /integrations/github/imports` | 설정 여부·검증 환경 이름·최근 가져오기 20개. 진행 중 기록 우선 |
| `POST /integrations/github/imports` | UUID `requestKey`, 숫자 `repositoryId`, `name`, `profile`로 등록. 202는 접수이며 완료를 뜻하지 않음 |
| `POST /integrations/github/imports/:id` | `{ "action": "cancel" }` 또는 `{ "action": "retry" }` |
| `GET /integrations/github/creations` | 생성 허용 여부·검증 환경·최근 생성 기록 20개. 진행·확인 필요 기록 우선 |
| `POST /integrations/github/creations` | UUID `requestKey`, `repositoryName`, 표시 `name`, `profile`. 202는 접수이며 완료를 뜻하지 않음 |
| `POST /integrations/github/creations/:id` | `{ "action": "cancel" }` 또는 `{ "action": "retry" }`. 불확실한 생성은 재요청하지 않음 |

조회·가져오기·생성의 GitHub 통신은 동시에 하나이며, 목록 조회에는 전체 8초 제한을 적용합니다. 응답 본문은 요청당 최대 2MiB입니다. 연결 오류는 외부 응답 원문이나 인증 헤더 없이 안전한 오류 코드로만 반환합니다.
