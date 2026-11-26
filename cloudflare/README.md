# Project HIVEMIND — Cloudflare 실행 백엔드 (DEPRECATED / ARCHIVED)

> **폐기 고지 (2026-11-25):** Project HIVEMIND는 AWS 단일 실행 경로로 전환했으며 Cloudflare 실행 백엔드 사용안을 공식 폐기했다. 운영 계정의 `hivemind-*` Cloudflare Worker·Container·이미지·R2 리소스를 모두 정리했다. 이 디렉터리는 과거 검증 이력 보존용 아카이브이며 신규 개발·배포 대상으로 사용하지 않는다. 현행 계획은 [AWS 전환 마스터 플랜](../docs/plans/2026-11-25-realignment-aws-plan.md)과 [ADR-0008](../docs/adr/0008-aws-single-path-and-verified-draft-pr.md)을 따른다.

사람이 목표를 정하고 결과를 검토한다. 원격 컨테이너가 공식 Codex·Claude Code CLI와 별도 검증 작업을 실행한다.
이 폴더는 기존 로컬 관제 대시보드와 구분한 Cloudflare 구현이다.

- [실행 백엔드와 사용법](backend/README.md)
- [전체 아키텍처](ARCHITECTURE.md)
- [첫 구현 범위와 개발 계획](docs/plans/2026-11-10-cloudflare-backend.md)
- [실행·인증 경계 ADR](docs/adr/0001-cloudflare-first-runtime.md)
- [Claude 추가 격리](docs/adr/0002-claude-layered-sandbox.md) · [여러 턴 판정](docs/adr/0003-claude-terminal-turns.md) · [실행 버전 확인](docs/adr/0004-runtime-revision-fence.md)
- [최신 원격 수용 결과와 실제 diff](docs/verification/2026-11-10-cloudflare.md)
- [0단계 원격 검증 기록](docs/phase0/README.md)

## 현재 범위

인증된 작업 API, 불변 소스·결과 snapshot, 인증 스트림별 직렬화, 작업별 컨테이너,
인증 없는 별도 검증 컨테이너, 실제 실행 시간·출력·native subagent·MCP 증거, 로컬 결과 적용을 구현한다.
구독 인증을 API 과금 키로 바꾸지 않는다. CLI sandbox를 유지한다.

현재 계정에서 Codex·Claude의 동시 원격 실행과 별도 테스트를 통과했다.
두 제공자는 31,003ms 겹쳐 실행됐고, 제공자별 두 검증 보고서에서 각각 테스트 2건 통과를 확인했다.
원격 검증의 통과·실패와 배포 버전은 증거 문서로 구분한다.
Claude 호환 모드는 해당 계정의 파일·부모 프로세스·인증 경계 검증 후 활성화한다.
자신의 프로세스 상태를 읽는 것과 부모의 환경·명령·메모리·파일 별칭에 접근하는 것을 구분해 검증한다.

중앙 MCP·스킬과 보조 웹의 원격 API 연결은 [프로젝트 안내](../docs/codex-integration.md)를 따른다.
전체 장애·재개 수용, 외부 Queue와 고급 MCP compute 제출은 후속 범위다.
AWS는 Cloudflare 원격 수용 후 별도로 구현한다. 현재 AWS 리소스를 생성하거나 배포하지 않는다.

## Interface

`package.json:scripts.test`가 0단계 로컬 테스트를 제공한다. 실행 백엔드는 별도 `backend/package.json`으로 검사한다. 각 하위 계약은 실행·인증·비용의 경계를 구분한다.

### Subdirectories & System Boundaries

아래 절은 하위 폴더의 계약 문서를 색인한다. 현재 코드가 정의한 내용이며 원격 검증 상태는 위 절과 증거 문서를 따른다.

- backend: [./backend/README.md](./backend/README.md) - 실행 백엔드. Worker API, 스케줄러 Durable Object, 작업별 컨테이너 런타임, 운영자 스크립트, 벤치마크 과제를 포함한다.
- [장기 실행 공통 계약](./backend/src/runtime-shared/README.md)은 명시적 모델 고정과 도구·웹·외부 프로필 조합을 검사한다 (`backend/src/runtime-shared/autonomous.ts:validateAutonomousCapabilities`).
- scripts: [./scripts/README.md](./scripts/README.md) - 0단계 타당성 검증용 probe와 판정 로직. 세부 계약은 [./scripts/phase0/README.md](./scripts/phase0/README.md)에 있다.
- `tests/`, `docs/` - 0단계 테스트와 문서. 별도 계약 문서를 만들지 않는다.

## Invariants

- 구독 인증은 일반 소스 snapshot에 넣지 않는다. snapshot은 인증 파일과 비밀 설정 파일 경로를 제외한다. `[backend/src/snapshot.ts:excludedSourcePath]`
- 인증 하나는 한 번에 agent 작업 하나에만 배정한다. `[backend/src/scheduler.ts:Scheduler.dispatch]`
- 컨테이너 명령은 `setpriv`로 capability를 모두 제거하고 no-new-privileges를 설정해 실행한다. `[backend/src/cloudflare/worker.ts:RunnerDO.launch]`, `[scripts/phase0/cloudflare/worker.ts:Phase0Container]`
- 컨테이너는 `enableInternet:false`로 시작하고 외부 요청은 허용 호스트 목록을 거친다. `[backend/src/cloudflare/worker.ts:RunnerDO.ensure]`, `[scripts/phase0/cloudflare/outbound.ts:codexOutbound]`
- 장기 실행 컨테이너는 중앙의 목표·모델·도구·세션 승인을 대조하고 heartbeat 실패 시 실행을 중단한다. 웹·외부 action 권한은 승인 설정과 별도로 검증한다 (`backend/src/runtime/autonomous-authorize.ts:guardCanonicalNativePolicy`, `backend/src/runtime/autonomous-claude.ts:executeAutonomousClaude`).
- `scripts/phase0`의 일부 파일은 backend 런타임 이미지의 입력이다. 바꾸면 `backend/runtime-build.json`의 `digest`가 달라진다. `[backend/scripts/runtime-build.ts:RUNTIME_FIXED_INPUTS]`

## Side Effects

- Cloudflare Worker, Durable Object, Container, R2를 사용한다. 설정은 `backend/wrangler.json`과 `scripts/phase0/cloudflare/wrangler.json`에 있다.
- agent 작업과 0단계의 `codex`·`claude` probe는 사용자 구독 인증으로 실제 모델을 호출한다. `[backend/src/runtime/run.ts:executeRuntime]`, `[scripts/phase0/cloudflare/worker.ts:Phase0Container]`
- 운영자 스크립트 일부는 원격 백엔드에 비용이 드는 작업을 만든다. 항목은 [backend/scripts](./backend/scripts/README.md)에 있다.

## Verification

- Run: `npm test` (`cloudflare/`에서 실행. `node --test tests/*.test.ts`)
- Run: `npm test`, `npm run typecheck`, `npm run runtime:check` (`cloudflare/backend/`에서 실행)
