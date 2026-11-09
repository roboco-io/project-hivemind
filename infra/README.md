# 실행 환경 경계

현재 제공하는 실행 환경은 로컬 Node 프로세스와 로컬 컨테이너 예시다.
이 디렉터리는 AWS/Cloudflare 배포 구성이 아니다. 계정·리전·네트워크·저장소를 임의로 선택하지 않는다.

## 로컬 컨테이너 실행

Docker Compose가 설치된 환경에서 프로젝트 루트에서 실행한다.
아래 토큰은 각자 생성한다. 브라우저에는 operator token만 입력한다.

```sh
export HIVEMIND_OPERATOR_TOKEN="$(openssl rand -hex 24)"
export HIVEMIND_WORKER_TOKEN="$(openssl rand -hex 24)"
docker compose up --build
```

대시보드: http://127.0.0.1:4310 . 컨테이너 간에는 내부 HTTP를 사용한다.
데이터는 `hivemind-data` volume에 남는다. `docker compose down`으로 중지한다.
Docker 빌드/Compose 실행 검증 여부는 `docs/verification.md`를 참조한다.

## 후속 런타임

- ECS: Git checkout, 빌드/테스트, 네트워크 정책이 필요한 워커를 작업 단위 컨테이너로 실행하는 첫 대상.
- Cloudflare Containers: 호환성·유휴 비용·작업 시간·파일 보존을 검증한 뒤 경량 작업 배치 후보로 추가.
- 공급자별 시작/종료 API는 `RuntimeDriver` 계약을 구현한다. 현재 드라이버 구현은 없다.
- 실제 연결 전 필요한 결정: 계정/리전, 이미지 저장소, 단기 worker 자격증명,
  TLS 경로, 작업별 스토리지, 최소 IAM, egress 정책, 과금 수집, 중단 확인.

실제 공급자 실행과 로컬 모의 실행을 동일한 성공 표시로 처리하지 않는다.
