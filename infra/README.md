# 실행 환경 경계

현재는 로컬 Node 프로세스의 모의 워커와 실제 Codex·Claude 워커를 지원한다.
이 디렉터리는 AWS/Cloudflare 배포 구성이 아니다. 계정·리전·네트워크·이미지 저장소를 임의로 선택하지 않는다.

## 기본 로컬 컨테이너: 모의 실행

제공한 Dockerfile과 Compose는 **모의 실행 예시**다.
Git·Codex·Claude CLI나 로그인 자격증명을 번들하지 않으며 호스트 저장소를 마운트하지 않는다.
실제 실행은 README의 [Codex](../README.md#실제-codex-실행) 또는
[Claude](../README.md#실제-claude-code-실행) 호스트 실행 절차를 따른다.

Docker Compose가 설치된 환경에서 프로젝트 루트에서 실행한다.
각 토큰을 생성하고 브라우저에는 운영자 토큰만 입력한다.

```sh
export HIVEMIND_OPERATOR_TOKEN="$(openssl rand -hex 24)"
export HIVEMIND_WORKER_TOKEN="$(openssl rand -hex 24)"
docker compose up --build
```

관제실: http://127.0.0.1:4310 . 컨테이너 간에는 내부 HTTP를 사용한다.
데이터는 `hivemind-data` volume에 남는다. `docker compose down`으로 중지한다.
초기 컨테이너 검증 기록은 [검증 문서](../docs/verification.md)를 참조한다.

## 실제 로컬 Codex·Claude 실행

서버와 워커에 같은 `HIVEMIND_REPO_PATH`, `HIVEMIND_TEST_COMMAND`를 설정한다.
서버가 저장소 정책을 노출한다. `HIVEMIND_PROVIDER=codex` 또는 `HIVEMIND_PROVIDER=claude`로
시작한 워커가 자신의 제공자 작업만 실행한다. 두 워커의 ID는 다르게 지정한다.
필요한 준비 argv는 워커의 `HIVEMIND_SETUP_COMMAND`로 지정한다.
worktree는 기본적으로 워커 작업 디렉터리의 `data/worktrees`에 보존한다.

worktree는 파일 변경 격리다. 준비·테스트 코드는 호스트에서 실행하며 별도 보안 컨테이너로 격리하지 않는다.
운영자가 신뢰하는 저장소만 지정한다. 관제 토큰과 각 제공자의 인증을 테스트 환경에 넘기지 않는다.

## 후속 원격 런타임

- ECS: 작업당 컨테이너에서 Git·선택한 CLI·빌드·테스트를 실행하는 첫 대상.
- Cloudflare Containers: 작업 시간·파일 보존·도구·네트워크·비용을 검증한 뒤 경량 작업에 추가.
- `RuntimeDriver`는 공급자별 시작·종료의 경계다. 현재 구현체는 없다.
- 실제 연결 전 결정할 항목: 계정·리전, 이미지 저장소, 단기 워커 인증,
  TLS, 저장소별 권한, 임시 스토리지, 최소 IAM, egress, 과금 수집과 종료·정리 확인.

로컬 실제 워커 지원이 실제 원격 격리나 클라우드 운영 준비를 뜻하지는 않는다.
