# Codex 컨테이너의 시스템 호출 제한

`codex-seccomp.json`은 Docker 엔진의 기본 설정과 관계없이 실행마다 지정하는 seccomp 정책입니다. 명시한 정책 파일이 없거나 적용할 수 없으면 실행을 시작하지 않습니다. 서버를 배포할 때 `dist/`와 함께 이 `security/` 폴더를 보관해야 합니다.

기준은 [Moby 기본 프로필](https://github.com/moby/profiles/blob/6fe7deb1b9fb7c0397a4593480d7d22b9ee8caef/seccomp/default.json)입니다. Apache-2.0 라이선스 원문은 `LICENSE.moby`에 있습니다. 원본의 기본 거부 동작과 기존 규칙을 유지하고, 고정 Codex CLI 0.166.0의 bubblewrap에서 관측한 다음 호출을 끝에 추가했습니다.

| 추가한 호출 | 범위와 이유 |
| --- | --- |
| `clone` | amd64·arm64에서 `NEWNS + NEWIPC + NEWUSER + NEWPID + NEWNET + SIGCHLD`와 정확히 일치하는 플래그만 허용. 사용자·파일·프로세스·네트워크 공간을 함께 생성 |
| `unshare` | `CLONE_NEWUSER` 값만 허용. bubblewrap의 중첩 사용자 공간 준비 |
| `mount`, `umount2`, `pivot_root` | 새 사용자·마운트 공간에서 읽기 전용 파일 트리 구성. 바깥 컨테이너에는 capability를 주지 않으며 커널의 권한 검사도 계속 적용 |

`CAP_SYS_ADMIN`, 특권 컨테이너, 호스트 PID, `seccomp=unconfined`를 사용하지 않습니다. 기본 프로필의 다른 차단 규칙은 유지합니다. 네임스페이스를 지원하는 커널이 필요하고, AppArmor 같은 별도 호스트 정책의 허용 여부는 따로 확인해야 합니다. 이 파일이 모든 Linux 호스트에서의 실행을 보장하지는 않습니다.

변경 시 `RUN_CONTAINER_TESTS=1 pnpm test`로 실제 프로세스 종료, 외부 seccomp 적용·capability 제거, 지정 파일 읽기와 쓰기·인증·폴더 밖 읽기·네트워크 거부를 검사합니다. SDK를 업데이트할 때 필요한 호출이 바뀌는지 다시 관측하며, 실패를 피하기 위해 필터 전체를 해제하지 않습니다.


## AppArmor가 활성화된 Linux 호스트

`agent-hub-codex.apparmor`는 [Moby AppArmor 템플릿](https://github.com/moby/profiles/blob/a21872828a8e5745d79e2fc1a07ee6dad8aedffa/apparmor/template.go)을 바탕으로 `agent-hub-codex-v1` 이름을 고정하고, 중첩 파일 트리에 필요한 `mount`·`pivot_root`를 허용했습니다. 원본의 `/proc`·`/sys` 보호, 신호·프로세스 추적 범위, 사용하지 않는 네트워크 종류의 차단을 유지합니다. Moby와 같은 ABI 3.0을 지정합니다. `capability` 규칙은 capability를 부여하지 않으며 Docker가 제거한 권한은 그대로 없습니다.

agent-hub를 시작하기 전 운영자가 `sudo apparmor_parser -r apps/server/security/agent-hub-codex.apparmor`로 설치합니다. 실행기가 Docker 엔진의 AppArmor 지원 여부를 조회해 해당 프로필을 지정하며, 설치되지 않은 경우 임의의 다른 프로필로 대체하지 않습니다. 정책 갱신은 실행을 멈춘 상태에서 수행하고, 기존 실행과 호환되지 않는 정책에는 새로운 프로필 이름을 사용해야 합니다. 전역 AppArmor·seccomp를 해제하는 설정은 포함하지 않습니다.
