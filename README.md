# Project HIVEMIND

**One Vision. Many Agents.**

사람이 개발 목표와 방향을 정하고, 중앙 관제 시스템이 작업을 분배하며,
여러 저비용 원격 AI 워커가 개발을 수행하는 플랫폼이다.
사람은 작업 과정, 승인, 비용과 Git 변경 제안을 한곳에서 확인한다.
HIVEMIND는 임시 개발 코드명이다. 공개 제품명은 아직 정하지 않았다.
소스와 문서는 [Apache License 2.0](LICENSE)으로 제공한다.

현재 버전은 **로컬에서 실행하는 최소 골격**이다. 작업 등록부터 실행 승인,
별도 워커 실행, 결과 검토와 수락까지 한 흐름으로 연결한다.
실제 AI 모델·클라우드·Git 저장소를 호출하지 않는다.
비용은 모의 값이고, diff는 합성 예시다.

## 빠른 시작

Node.js 24 이상과 npm이 필요하다. 프로젝트 루트에서 실행한다.

```sh
git clone https://github.com/roboco-io/project-hivemind.git
cd project-hivemind
npm ci
cp .env.example .env
npm run build
npm start
```

[로컬 관제실](http://127.0.0.1:4310)을 연다. 별도 터미널에서 같은 디렉터리로 이동한 뒤 실행한다.

```sh
npm run worker
```

1. 관제실에서 작업 제목, 목표와 완료 조건, 예산을 입력한다.
2. 결정 사유를 적고 **실행 승인**을 누른다.
3. 워커가 작업을 가져와 모의 결과를 보고한다.
4. 합성 diff와 모의 비용을 확인하고 **결과 수락** 또는 **반려**를 누른다.

결과 수락은 수락 이력만 기록한다. 파일 적용, Git 커밋·병합과 배포를 실행하지 않는다.
실행 중에는 사유를 적어 **작업 중단**을 누를 수 있다.

워커를 한 번만 실행하거나 여러 개 실행할 수 있다. 워커마다 다른 ID를 사용한다.

```sh
npm run worker:once
HIVEMIND_WORKER_ID=worker-local-2 npm run worker
```

`worker:once`는 승인된 작업을 최대 하나 처리한다. 작업이 없으면 정상 종료한다.
서버와 상시 워커는 각 터미널에서 `Ctrl+C`로 종료한다.

## 구현 상태

| 항목 | 현재 동작 |
|---|---|
| 사람 중심 관제 | 작업 등록·실행 승인·결과 수락·반려·중단, 2초 간격 조회 |
| 중앙 오케스트레이션 | 승인된 작업의 선입선출 분배, 원자적 claim과 실행 권한 만료 |
| 여러 워커 | 별도 Node 프로세스가 HTTP로 작업을 가져옴 |
| 이력 | SQLite에 작업, 실행 ID, 승인 사유, 비용, diff, 이벤트 저장 |
| 비용 | 정수 USD micros 사용. 모의 예상·보고 비용은 1,000 micros = $0.001 |
| 실행 제공자 | `mock`만 구현. Codex·Claude는 공통 어댑터 계약만 마련 |
| 실행 환경 | `local`만 구현. ECS·Cloudflare는 후속 런타임 경계와 설계 |
| Git 변경 | 합성 diff 문자열 저장·표시. 저장소 checkout·실제 diff 수집은 후속 |
| ChatGPT 연결 | 공통 중앙 API를 사용하는 MCP 연결 설계. MCP 서버는 후속 |

자연어 목표 분해와 모델별 비용 최적화도 후속 개발 범위다.
지원하지 않는 제공자·실행 환경은 실행 요청 단계에서 거절한다.

## 설정

`.env.example`을 복사한 `.env`는 서버와 워커 시작 시 읽힌다.

| 변수 | 기본값 | 용도 |
|---|---|---|
| `HIVEMIND_HOST` | `127.0.0.1` | 서버 수신 주소 |
| `HIVEMIND_PORT` | `4310` | 서버 포트 |
| `HIVEMIND_DB` | `data/hivemind.sqlite` | 중앙 상태 파일 |
| `HIVEMIND_OPERATOR_TOKEN` | `local-development-only` | 관제 조회·승인 권한 |
| `HIVEMIND_WORKER_TOKEN` | `local-worker-only` | 워커 등록·작업 실행 보고 권한 |
| `HIVEMIND_API_URL` | `http://127.0.0.1:4310` | 워커가 연결할 중앙 API |
| `HIVEMIND_WORKER_ID` | `worker-local-1` | 워커 식별자 |

운영자 토큰을 바꾸면 관제실의 **관제 연결 설정**에도 같은 값을 입력한다.
기본 토큰은 로컬 개발용이다. 루프백 외 주소로 서버를 시작하려면 서로 다른 충분히 긴 토큰을 설정해야 한다.
현재 인증은 단일 운영자용이며 사용자 계정·조직별 권한은 제공하지 않는다.

데이터는 서버 재시작 후 유지된다. `.env`, `data/`, `node_modules/`, `dist/`는 버전 관리에서 제외한다.
초기화하려면 서버와 워커를 종료하고 상태 파일을 별도로 백업한 뒤 `data/`를 비운다.

## 프로젝트 구조와 검증

```text
apps/control-plane/  중앙 HTTP API와 시작점
apps/dashboard/      독립 관제 Web UI
apps/worker/         HTTP 워커와 실행 루프
packages/contracts/  작업·실행·이벤트·어댑터 계약
packages/core/       상태 전이, SQLite 저장과 승인 정책
packages/adapters/   모의 AI 실행 어댑터
infra/               컨테이너 실행 구성과 후속 클라우드 경계
tests/              상태·권한·워커·통합 검증
docs/               아키텍처, ADR, MVP와 개발 계획
```

```sh
npm run check
```

타입 검사, 빌드와 자동 테스트를 실행한다. 자세한 검증 범위는 테스트와 개발 계획을 함께 확인한다.

- [아키텍처와 API](docs/architecture.md)
- [MVP 범위와 완료 조건](docs/mvp.md)
- [개발 로드맵](docs/roadmap.md)
- [외부 도구·클라우드 통합 설계](docs/integrations.md)
- [초기 개발 계획](docs/plans/2026-11-09-bootstrap.md)
- [주요 설계 결정](docs/adr/0001-independent-control-plane.md)
- [로컬 컨테이너 실행](infra/README.md)
- [검증 결과와 한계](docs/verification.md)

공개 저장소: [roboco-io/project-hivemind](https://github.com/roboco-io/project-hivemind).
클라우드 배포 대상은 설정하지 않았다. 이 골격은 외부 배포를 수행하지 않는다.

## 라이선스

Copyright 2026 Project HIVEMIND contributors.

이 프로젝트의 소스와 문서는 Apache-2.0으로 제공한다.
재배포 시에는 [LICENSE](LICENSE)와 해당 [NOTICE](NOTICE)의 고지를 유지한다.
외부 의존성에는 각 의존성의 라이선스가 적용된다.
