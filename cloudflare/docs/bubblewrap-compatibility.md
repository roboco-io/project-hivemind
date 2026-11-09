# Bubblewrap의 nested proc 호환 빌드

격리된 PID 공간과 기존 procfs를 함께 사용하는 경우, Bubblewrap 0.8.0은
자식에게 초기화 완료를 알리기 전에 `namespace_ids_read(pid)`를 호출한다.
이 조회는 다른 PID 공간의 `/proc`에서 자식을 찾다가 실패할 수 있다.
패치는 `--info-fd` 또는 `--json-status-fd`가 요청한 경우에만 해당 메타데이터를 조회한다.
두 출력을 요청한 경로의 동작은 유지한다.

패치는 이 조건문 한 곳만 바꾼다. namespace 생성, mount, 권한 검사,
파일·통신 규칙과 seccomp 필터는 유지한다.
공식 Codex CLI, Claude Code CLI와 sandbox-runtime 패키지는 수정하지 않는다.
원격 원인과 수정 효과는 [검증 기록](verification/2026-11-10-cloudflare.md)에서 확인한다.
다른 실행 환경에서는 같은 경계 검증을 다시 수행한 뒤 활성화한다.

`claudeGuardEnvironment`만 `/opt/hivemind/compat-bin`을 `PATH` 앞에 붙인다.
Codex 주 워커와 `/usr/bin/bwrap`은 기존 실행 경로를 사용한다.
호환 실행 파일은 root 소유이며 권한은 `0755`다. setuid로 설치하지 않는다.

## 빌드

두 Dockerfile은 공통 빌드 스크립트를 사용한다. Debian의 `deb-src`를 켜고
서명된 APT 목록에서 정확한 소스 패키지 `bubblewrap=0.8.0-2+deb12u1`을 받는다.
Debian 패치 다음에 `backend/native/bubblewrap-nested-proc.patch`를 fuzz 없이 적용한다.
SELinux 지원과 Debian의 PIE·bindnow 강화 옵션을 유지한다.
지정한 소스 버전이나 의존성을 받을 수 없으면 빌드를 중단한다.

```sh
docker build --target bubblewrap-compat-build -f backend/Dockerfile .
docker build --target bubblewrap-compat-build -f scripts/phase0/Dockerfile .
```

## 소스와 라이선스

이미지의 `/usr/share/hivemind/bubblewrap-source`에 다음 자료를 포함한다.

- `downloads/`: 원본 `.dsc`, upstream 소스와 Debian 소스 압축 파일.
- `modified-source.tar.xz`: 수정한 전체 소스, Debian 패키징과 모든 패치.
- `debian-patches/`, `bubblewrap-nested-proc.patch`: 개별 변경 파일.
- `rebuild.sh`, `build-files/`, `build-input/`: 빌드 스크립트, Dockerfile과 정확한 입력 파일.
- `licenses/`: 원본 COPYING, Debian 저작권, LGPL-2와 GPL-2 전문.
- `BINARY.sha256`, `SHA256SUMS`: 실행 파일과 소스 묶음의 체크섬.

수정한 실행 파일을 재배포할 때 소스 묶음과 고지를 함께 제공한다.
개별 라이선스는 [고지](../backend/native/BUBBLEWRAP-NOTICE.md)를 확인한다.

추출한 묶음으로 빌드하려면 새 Debian bookworm 컨테이너에서 `deb-src`를 켜고
`build-essential`, `meson`, `ninja-build`, `pkg-config`, `libcap-dev`,
`libselinux1-dev`, `dpkg-dev`, `patch`, `xz-utils`를 설치한다.
묶음이 `/bundle`에 있고 `/build`가 비어 있을 때 다음을 실행한다.

```sh
sh /bundle/rebuild.sh /build /artifacts /bundle/build-input
```

실행 파일과 소스 묶음은 `/artifacts`에 생성된다.
`tar -xJf modified-source.tar.xz`로 수정 소스를 추출한다.
묶음 폴더에서 `sha256sum -c SHA256SUMS`를 실행해 자료를 확인한다.
실행 이미지에서는 같은 폴더의 `sha256sum -c BINARY.sha256`으로 설치 파일을 확인한다.
