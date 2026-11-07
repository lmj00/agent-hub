# 운영 준비와 확인 절차

이 문서는 설치할 파일과 운영자가 확인할 순서를 정리합니다. **실제 AWS 설치와 원격 24시간 운영은 아직 수행하지 않았습니다.** 백업·알림·장기 관측은 [구현 계획의 O1~O4](plans/operations.md#implementation-tasks--운영-준비)에서 따로 관리합니다.

## 필요한 절차 찾기

| 하려는 일 | 읽을 곳 |
| --- | --- |
| 처음 설치 | [설치 전 준비](#설치-전-준비) → [비공개 설정](#비공개-설정-준비) → [서비스·HTTPS](#서비스https로그-적용) |
| 서버 상태 확인·중지·업데이트 | [운영 명령](#상태-확인중지업데이트) |
| 서버 밖에서 HTTPS·DB 상태 확인 | [외부 점검](#외부에서-서버-상태-점검하기) |
| 작업 데이터와 개발 코드 보존 | [백업·복원](#db개발-코드-백업과-복원) |
| 실제로 검사한 범위 확인 | [저장소에서 재현하는 검사](#저장소에서-재현하는-검사) |

설치 명령은 운영자가 대상 Linux 서버에서 실행합니다. 이 문서를 읽거나 로컬 테스트를 실행하는 것만으로 원격 서버가 설치되지는 않습니다.

## 서버 구성과 저장 위치

브라우저는 Caddy의 HTTPS 주소에 접속합니다. Caddy는 같은 서버의 `127.0.0.1:3000`으로 요청을 전달하고, Node 서버는 로그인과 작업 처리를 담당합니다. systemd는 Node 종료를 감지해 제한된 횟수로 재시작합니다. 개발·테스트는 기존 Docker 실행기를 사용합니다.

| 위치 | 내용과 권한 |
| --- | --- |
| `/opt/agent-hub` | 검증한 코드·잠금 파일·Linux용 의존성·빌드. 운영 계정이 임의로 바꾸지 못하도록 배포 계정이 관리 |
| `/etc/agent-hub` | 비공개 설정. 디렉터리 `0700`, 파일 `0600`, 소유자 `agent-hub` |
| `/var/lib/agent-hub/state` | SQLite와 같은 부모에 생기는 `.development-*` Git 저장소·`.prepared-*` 입력. 숨김 디렉터리도 보존 |
| `/var/lib/agent-hub/codex` | 이 서비스 전용 ChatGPT 로그인. 다른 개인 Codex 설정을 복사하지 않음 |
| `/var/lib/agent-hub/workspaces` | 비밀 없는 개발용 원본 사본. 실행 중인 트레이딩 서비스 디렉터리를 직접 지정하지 않음 |

상태·인증·개발 사본은 `agent-hub` 소유의 비공개 경로입니다. DB 절대 경로는 개발 Git·입력 경로 계산에 쓰이므로 임의로 바꾸지 않습니다. 코드 배포 파일과 상태 파일을 함께 삭제하거나 SQLite 파일 하나만 복사해 복원이 된 것으로 판단하지 않습니다.

서버는 Docker 데몬을 제어하는 신뢰된 프로그램입니다. 이 구성의 `docker` 그룹 권한은 호스트 관리자 수준이므로 systemd의 파일 제한이 Docker를 통한 호스트 접근까지 막는다고 해석하면 안 됩니다. AI 컨테이너에는 Docker 소켓을 전달하지 않습니다. [Docker 권한 설명](https://docs.docker.com/engine/install/linux-postinstall/)

## 설치 전 준비

운영 대상은 systemd가 PID 1로 실행되는 전용 Linux 서버입니다. 아래 명령은 **운영자가 대상 서버에서 적용하는 절차**이며 저장소를 읽거나 테스트하는 것만으로 설치되지 않습니다.

1. `.nvmrc`의 Node 버전을 `/usr/local/bin/node`에 준비하고 `node --version`을 확인합니다. 서비스는 로그인 셸이나 nvm 초기화에 의존하지 않습니다. pnpm은 루트 `package.json`의 `packageManager`와 맞춥니다.
2. **호스트 Git CLI**, 로컬 Docker Engine·CLI와 Caddy를 준비합니다. 개발용 Git 준비·반영은 호스트에서 실행하므로 이미지 안의 Git만으로는 부족합니다. Docker 소켓을 네트워크로 공개하지 않습니다. Caddy 검사 버전은 `2.11.9`이며 운영 패키지도 설치 후 `caddy version`을 기록합니다.
3. 전용 `agent-hub` 일반 계정과 그룹을 준비합니다. UID 0으로 서버를 실행하지 않습니다. 서비스의 `SupplementaryGroups=docker`와 실제 그룹·소켓 소유권을 대조합니다.
4. `/opt/agent-hub`에 검토한 버전을 준비하고 그 Linux 환경에서 다음을 실행합니다. macOS의 `node_modules`는 복사하지 않습니다.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
sudo -u agent-hub git --version
docker build -f docker/analysis-runner.Dockerfile -t agent-hub-analysis:local .
docker build -f docker/verification-node.Dockerfile -t agent-hub-verification-node:local .
```

`apps/server/dist`, `migrations`, `security`, `runtime`, `skills/gstack`, `apps/web/dist`, 공통 패키지와 의존성을 함께 보존합니다. AppArmor가 켜진 Docker 호스트에서는 [전용 프로필](guides/agents.md#컨테이너로-실행-종료-확인하기)도 먼저 설치합니다. 실제 프로젝트의 테스트 도구·의존성은 해당 테스트 이미지에 미리 넣습니다.

## 비공개 설정 준비

다음은 새 설치의 경로 준비 예시입니다. 기존 경로가 있다면 소유권·내용부터 확인합니다.

```sh
sudo install -d -o agent-hub -g agent-hub -m 0700 /etc/agent-hub
sudo install -d -o agent-hub -g agent-hub -m 0700 /var/lib/agent-hub
sudo -u agent-hub mkdir -m 0700 /var/lib/agent-hub/state /var/lib/agent-hub/codex /var/lib/agent-hub/workspaces
sudo install -o agent-hub -g agent-hub -m 0600 ops/server.env.example /etc/agent-hub/server.env
```

`server.env`는 systemd가 읽는 `이름=값` 형식입니다. `export`나 셸 명령을 넣지 않습니다. `LOCAL_API_ONLY`는 운영 설정에 추가하지 않습니다. `PORT`를 바꾸면 Caddy의 전달 포트도 함께 바꿉니다.

로그인 설정은 빌드한 CLI로 생성합니다. 예시 도메인을 실제 도메인으로 바꾸고 출력되는 비밀번호는 비공개로 보관합니다. 공유 로그 환경에서는 `--password-stdin`으로 비밀번호 관리 도구의 출력을 전달합니다. CLI는 기존 파일을 덮어쓰지 않습니다.

```sh
sudo -u agent-hub /usr/local/bin/node /opt/agent-hub/apps/server/dist/auth-setup-cli.js \
  --config /etc/agent-hub/auth.json --origin https://agent-hub.example.com
```

전용 Codex 로그인은 README의 인증 준비 절차에 따라 `/var/lib/agent-hub/codex`에 준비합니다. `/etc/agent-hub/execution.json`은 `0600`으로 저장합니다. 아래는 의존성 없는 예제 프로젝트를 준비한 뒤 수정해서 쓰는 형식 예시입니다. 디렉터리와 고정 테스트가 실제로 존재해야 합니다.

```json
{
  "model": "gpt-6.1-sol",
  "codexHome": "/var/lib/agent-hub/codex",
  "containerImage": "agent-hub-analysis:local",
  "timeoutMs": 300000,
  "workspaces": {
    "example-project": "/var/lib/agent-hub/workspaces/example-project"
  },
  "verification": {
    "example-project": {
      "image": "agent-hub-verification-node:local",
      "command": ["node", "--test", "tests/calculation.test.mjs"],
      "timeoutMs": 60000
    }
  },
  "automaticRecovery": {}
}
```

`automaticRecovery: {}`는 [기존 기본 정책](guides/agents.md#자동-복구-켜기)을 켭니다. 별도로 목표·프로젝트의 기간 예산과 실행 허용 범위를 정합니다. 서비스 읽기 관측이 필요하면 비공개 `SERVICE_CONFIG`를 준비한 뒤 환경 파일의 해당 줄을 켭니다.

## 서비스·HTTPS·로그 적용

[서비스 파일](../ops/agent-hub.service)은 인증·실행 설정·화면 빌드가 없으면 시작하지 않습니다. 실패 시 5초 후 재시작하며 5분 내 시작 횟수를 5회로 제한합니다. `systemctl stop`에 의한 종료는 자동 재시작하지 않습니다. 종료가 확인되지 않은 AI 컨테이너는 기존 복구 정책에 따라 보류됩니다. 재시작 설정이 성공이나 종료 확인을 대신하지 않습니다. [systemd 서비스 정책](https://www.freedesktop.org/software/systemd/man/259/systemd.service.html)

```sh
sudo install -m 0644 ops/agent-hub.service /etc/systemd/system/agent-hub.service
sudo install -d -m 0755 /etc/systemd/journald@agent-hub.conf.d
sudo install -m 0644 ops/journald-agent-hub.conf /etc/systemd/journald@agent-hub.conf.d/60-limits.conf
sudo systemd-analyze verify /etc/systemd/system/agent-hub.service
sudo systemctl daemon-reload
```

[전용 로그 설정](../ops/journald-agent-hub.conf)은 `agent-hub` namespace에만 적용합니다. 초기 정책은 디스크 256MiB, 메모리 로그 64MiB, 보존 7일입니다.

용량 보장이나 측정한 서버 사양은 아닙니다. 전역 journald 설정과 다른 서비스의 로그는 변경하지 않습니다.

이미 namespace가 실행 중이면 해당 `systemd-journald@agent-hub.service`만 재시작해 설정을 다시 읽습니다. DB의 업무 이력과 Docker 실행 파일 보존은 이 정책과 별개입니다.

[journald namespace 설정](https://www.freedesktop.org/software/systemd/man/latest/journald.conf.html)

[Caddyfile](../ops/Caddyfile)의 도메인을 바꾸고 `auth.json`의 HTTPS origin과 일치시킵니다. 기존 Caddy를 공유한다면 기존 사이트를 덮어쓰지 않고 사이트 블록을 추가합니다. Caddy의 인증서 저장 경로는 서비스 계정이 쓰고 재시작 후에도 보존할 수 있어야 합니다.

```sh
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl enable --now agent-hub.service
sudo systemctl reload caddy.service
```

새 Caddy 설치는 `reload` 전에 배포 패키지의 서비스 시작 절차를 따릅니다. DNS가 해당 서버를 가리키고 인증서 발급에 필요한 80·443 포트가 연결되어야 합니다. Node의 3000 포트는 외부에 공개하지 않습니다. 로컬 검사에서 만든 CA는 공인 인증서가 아닙니다. [Caddy 자동 HTTPS](https://caddyserver.com/docs/automatic-https)

## 상태 확인·중지·업데이트

```sh
sudo systemctl status agent-hub.service --no-pager
sudo journalctl --namespace=agent-hub -u agent-hub.service -n 100 --no-pager
curl --fail https://agent-hub.example.com/health/live
```

생존 확인은 HTTP 응답 여부만 뜻합니다. 브라우저로 로그인한 뒤 `/health/ready`와 관리 화면의 실행 상태·최근 활동·보류 이유를 함께 확인합니다. `/health/ready`는 로그인이나 아래 전용 점검 인증값 없이 요청하면 `401`이 정상입니다. 긴 AI 실행 중 대기열의 마지막 확인 시각이 오래됐다는 이유만으로 프로세스가 죽었다고 판단하지 않습니다.

중지는 `sudo systemctl stop agent-hub.service`를 사용합니다. 설정 오류를 고친 뒤 시작 횟수 제한이 남았다면 `sudo systemctl reset-failed agent-hub.service` 후 다시 시작합니다. 원인을 확인하지 않고 반복해서 제한을 초기화하지 않습니다.

업데이트 순서는 **서버 중지 → 실행·반영의 종료 확인 → 일관된 백업 → 검증한 빌드와 이미지 교체 → 시작 → 로그인·DB·실행 상태 확인**입니다. 백업·복원은 아래 명령을 사용합니다. 복원에는 백업을 만든 버전과 호환되는 실행 파일·마이그레이션이 필요합니다. 마이그레이션 이후 옛 실행 파일만 복원하는 방법은 롤백으로 보장하지 않습니다.

## 외부에서 서버 상태 점검하기

점검 명령은 HTTPS 연결과 DB 준비 상태를 확인합니다. 한 번 실행하고 결과를 JSON으로 출력하므로 외부 감시 프로그램이나 스케줄러에서 반복 실행할 수 있습니다. **AI 작업의 진척·결과 품질을 판정하는 명령은 아닙니다.** 정상 대기나 긴 실행은 그 자체로 장애가 아닙니다.

먼저 서버 쪽에서 기존 로그인 설정으로 전용 점검 파일을 만듭니다. 아래는 저장소 루트의 개발 설정 예시입니다.

```sh
pnpm monitor setup --auth-config .local/auth.json --destination .local/monitor.json
pnpm monitor check --config .local/monitor.json
```

생성 파일은 소유자만 읽을 수 있는 `600` 권한이며 기존 파일을 덮어쓰지 않습니다. 화면 비밀번호·세션 서명 키는 포함하지 않고, `GET /health/ready`에서만 사용할 수 있는 인증값을 담습니다. 프로젝트 조회·변경 권한은 없습니다. 파일은 Git과 AI 작업 폴더 밖에 보관합니다.

별도 호스트에 같은 빌드를 준비하고 **점검 파일만 안전하게 전달**합니다. 운영 주소는 HTTPS여야 하며 파일의 `origin`은 서버 로그인 설정과 같아야 합니다. HTTP는 같은 컴퓨터의 루프백 주소에서 개발할 때만 허용합니다.

```sh
node /opt/agent-hub/apps/server/dist/monitor-cli.js check --config /etc/agent-hub/monitor.json
```

| 종료 코드 | 뜻 |
| --- | --- |
| `0` | HTTPS/HTTP 응답과 DB 준비 상태가 정상 |
| `1` | 인증 실패, 연결 실패, DB 준비 실패, 응답 오류 또는 제한 시간 초과 |
| `2` | 설정·명령 인자·파일 권한 문제 |

결과의 `reason`으로 원인을 구분합니다. 주소·인증값·원격 응답 원문은 출력하지 않습니다. 기본 제한 시간은 3초이며 설정의 `timeoutMs`로 100~10,000ms를 지정합니다. 리다이렉트를 따라가지 않고, 응답은 4KiB까지 읽습니다. TLS 인증서 검증을 끄지 않습니다.

점검 인증값은 로그인 설정의 서명 키·접속 주소와 별도 용도 문자열로부터 계산합니다. 같은 설정에서 다시 발급하면 같은 값입니다. 폐기하려면 새 로그인 설정으로 서버를 재시작하고 점검 파일도 다시 발급합니다. 이때 기존 브라우저 세션도 무효가 됩니다. 점검 인증값만 독립적으로 폐기하는 기능은 현재 없습니다.

서버 내부에서만 점검하면 서버 전체 중단을 놓칠 수 있으므로 운영 감시는 별도 호스트에서 실행합니다. 알림 수신처·전송 기록은 O3의 다음 구현 단위이며, 실제 외부 호스트 설치와 수신처 적용은 아직 수행하지 않았습니다.

## DB·개발 코드 백업과 복원

백업은 **서버와 수동 실행을 모두 중지하고, 실행 종료·변경 반영을 확인한 상태**에서 수행합니다. 실행 소유권이 남아 있거나 `running`·종료 미확정 실행·반영 대기 기록이 있으면 거부합니다. 기존 복구 절차로 먼저 대조하며, 백업을 위해 이 기록을 임의로 삭제하지 않습니다. API 전용 서버는 실행 소유권을 잡지 않으므로 명령이 모든 서버의 중지를 자동 증명하지는 않습니다.

백업은 SQLite의 Backup API로 WAL에 저장된 확정 변경까지 포함하고, 같은 상태 폴더의 `.development-*`·`.prepared-*`를 묶습니다. 파일 해시와 실제 Git 커밋을 DB의 반영 이력과 대조합니다. 새 임시 폴더에서 검사를 끝내고 이름을 바꾸어 게시하므로 부분 복사 결과를 완료된 백업으로 사용하지 않습니다. 실패하면 자신이 만든 임시 결과만 정리합니다. [SQLite Backup API](https://www.sqlite.org/backup.html)

DB 부모와 백업 부모는 서비스 계정 소유의 실제 절대 경로·`0700`이어야 합니다. 링크·다른 계정 소유 파일·하드 링크·다른 사용자의 쓰기를 허용한 하위 폴더는 거부합니다. 백업은 DB 상태 폴더 밖에 저장하고, 같은 이름이 있으면 새 이름을 선택합니다. 다음 경로는 운영 예시이며 실제 날짜와 보관 정책에 맞춥니다.

```sh
sudo systemctl stop agent-hub.service
sudo install -d -o agent-hub -g agent-hub -m 0700 /var/lib/agent-hub/backups
sudo -u agent-hub /usr/local/bin/node /opt/agent-hub/apps/server/dist/backup-cli.js create \
  --database /var/lib/agent-hub/state/agent-hub.sqlite \
  --destination /var/lib/agent-hub/backups/before-update-001
sudo -u agent-hub /usr/local/bin/node /opt/agent-hub/apps/server/dist/backup-cli.js inspect \
  --backup /var/lib/agent-hub/backups/before-update-001
```

개발 환경에서는 같은 인자를 `pnpm backup create`, `pnpm backup inspect`, `pnpm backup restore`로 전달할 수 있습니다. 성공하면 요약 JSON과 종료 코드 `0`, 실패하면 오류와 종료 코드 `1`을 반환합니다. 요약에는 원래 DB 경로가 있으므로 출력도 비공개로 관리합니다. 원본 로그·AI 응답·인증 내용은 출력하지 않습니다. 10분의 중단 신호와 Ctrl+C를 처리하지만 동기 SQLite 검사까지 정확히 10분에 강제 종료한다는 보장은 아닙니다.

복원은 **원래 DB 절대 경로**에만 허용합니다. 원래 상태 디렉터리가 이미 있으면 빈 폴더여도 거부합니다. 운영자가 서비스를 중지한 뒤 기존 `state`를 별도 보존 위치로 이동해야 하며, 명령은 기존 데이터를 삭제하지 않습니다. 아래는 그 준비가 끝난 뒤의 순서입니다.

```sh
# 검사·미리보기만 수행. state 디렉터리를 만들지 않습니다.
sudo -u agent-hub /usr/local/bin/node /opt/agent-hub/apps/server/dist/backup-cli.js restore \
  --backup /var/lib/agent-hub/backups/before-update-001 \
  --database /var/lib/agent-hub/state/agent-hub.sqlite
# 같은 검사를 다시 수행하고 새 state 디렉터리를 게시합니다.
sudo -u agent-hub /usr/local/bin/node /opt/agent-hub/apps/server/dist/backup-cli.js restore \
  --backup /var/lib/agent-hub/backups/before-update-001 \
  --database /var/lib/agent-hub/state/agent-hub.sqlite --apply
```

복원 후 서비스 시작 전에 설정과 원본 작업 폴더의 경로·기준 커밋, 실행 이미지를 대조합니다. 시작 후 로그인·프로젝트와 작업 이력·개발 Git 상태·실행 보류 이유를 확인합니다. DB와 Git이 어긋나면 성공으로 바꾸지 않습니다.

**포함하지 않는 것:** `/etc/agent-hub`의 설정, Codex 인증, 원본 작업 폴더, Docker 이미지, 로그는 별도로 보존·재준비해야 합니다. 백업 자체에도 작업 내용과 세션 등이 있으므로 공개 저장소에 넣지 않습니다. 현재 검사한 DB 스키마·마이그레이션과 정확히 일치해야 복원할 수 있으므로 앱 업그레이드 후에는 해당 백업과 호환되는 앱 버전도 함께 준비합니다. 현재 지원은 로컬 파일 시스템·같은 경로 복원이며, 온라인 Git 변경 중 백업·임의 경로 이동·호스트 전체 복구를 보장하지 않습니다. 해시는 손상을 확인하는 수단이며 백업 작성자의 신원을 증명하는 서명은 아닙니다.

파일은 나누어 읽고 최대 50,000개 항목·16MiB 목록을 허용합니다. 초과하면 실패하며 일부만 보존하지 않습니다. 충분한 디스크와 별도 보관 위치를 준비해야 합니다. 같은 디스크의 사본만으로 디스크 고장에 대비했다고 판단하지 않습니다.

## 저장소에서 재현하는 검사

Docker가 준비된 개발 환경에서 실행합니다. 첫 명령은 공개 소스로 검사 이미지를 미리 빌드합니다. 테스트도 캐시를 재사용해 현재 소스로 다시 빌드하므로 오래된 이미지로 통과하지 않습니다. 실제 검사는 외부 네트워크·호스트 경로·Docker 소켓 없는 컨테이너 안에서 수행합니다.

```sh
docker build -f docker/operations-check.Dockerfile -t agent-hub-operations-test:local .
RUN_CONTAINER_TESTS=1 pnpm --filter @agent-hub/server exec vitest run tests/operations.test.ts
```

검사 범위는 실제 `systemd-analyze`의 서비스 파일 해석, Caddy 설정 검증, 누락 설정 거부, 로컬 CA를 명시적으로 신뢰한 HTTPS 로그인·접근 차단·프로젝트 저장, Node 종료 후 재시작의 데이터·세션 보존입니다. 테스트 계정과 빈 실행 설정만 사용하며 모델 호출은 없습니다. 인증서 검증을 끄지 않습니다.

컨테이너의 `docker.service`는 의존 관계 해석용 빈 fixture입니다. **systemd가 PID 1로 재시작하는 동작, 실제 Docker 작업 복구, 공인 인증서 발급, AWS 방화벽·외부 점검·24시간 자율 운영은 이 검사의 범위가 아닙니다.** O4와 실제 운영 기록에서 확인합니다.
