# GitHub 저장소 연결

**현재 지원:** GitHub App을 설치한 개인 계정이 본인 계정인지 확인하고, 허용한 저장소 목록을 관리 화면에서 조회합니다. 저장소 복제·프로젝트 등록·새 저장소 생성은 후속 단계입니다. 이 문서의 설정만으로 AI 개발이 시작되지는 않습니다.

관리 화면 로그인과 GitHub 저장소 권한은 별개입니다. 관리 화면은 기존 비밀번호·세션을 사용합니다. GitHub 키는 서버의 비공개 파일에 두고, 브라우저나 AI 작업 폴더에 전달하지 않습니다.

## 1. 개인 GitHub App 준비

GitHub의 **Settings → Developer settings → GitHub Apps → New GitHub App**에서 본인 계정용 앱을 만듭니다.

| 설정 | 현재 필요한 값 |
| --- | --- |
| 설치 대상 | Only on this account |
| Homepage URL | 자신의 프로젝트 소개 또는 저장소 주소 |
| Webhook Active | 끔 |
| OAuth during installation · Device Flow | 사용하지 않음 |
| Repository permissions | Metadata 읽기 권한. 목록 조회에 Contents 쓰기·Administration 권한은 필요 없음 |
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

다시 조회하다 실패하면 이전 목록을 지웁니다. 이전 목록이 지금도 접근 가능하다는 뜻으로 남지 않게 하기 위함입니다. 권한은 GitHub에서 변경한 뒤 다시 조회합니다. 목록 확인이 저장소 복제나 실제 AI 실행 검증을 대신하지는 않습니다.

| 문제 | 확인할 것 |
| --- | --- |
| 설치 계정 불일치 | 숫자 ownerId와 개인 계정 설치 여부 |
| 선택한 저장소 필요 | 설치 설정의 Only select repositories |
| 키·설치·권한 확인 필요 | 키 폐기 여부, 앱 삭제·중지, 설치 권한 |
| 요청 한도 | 잠시 기다린 뒤 직접 재조회 |
| 연결 실패 | 서버의 외부 HTTPS 연결과 시각 동기화 |

키를 바꾸려면 새 비공개 설정 파일을 준비해 `GITHUB_CONFIG`를 변경하고 서버를 재시작합니다. GitHub에서 이전 키도 폐기합니다. GitHub 키 폐기는 관리 화면의 로그인 세션 폐기와 별개입니다.

## API

모든 요청은 기존 관리 화면 인증이 필요합니다. POST는 세션 쿠키와 CSRF 토큰도 필요합니다.

| API | 동작 |
| --- | --- |
| `GET /integrations/github` | 설정 존재 여부. GitHub 접속 성공을 뜻하지 않음 |
| `POST /integrations/github/repositories` | JSON `{ "page": 1 }`. 허용 범위 1~1000, 한 번에 30개. 계정 검증 후 조회 |

동시 조회는 하나이며, 전체 외부 요청에 8초 제한을 적용합니다. 응답 본문은 요청당 최대 2MiB입니다. 연결 오류는 외부 응답 원문이나 인증 헤더 없이 안전한 오류 코드로만 반환합니다.
