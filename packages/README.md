# packages

## Overview

이 디렉터리는 HIVEMIND의 작업 계약·중앙 정책·실행 어댑터 세 패키지를 묶는다. 직접 가진 소스 파일은 없다. `contracts`는 다른 로컬 패키지를 가져오지 않는다. `core`와 `adapters`는 `contracts`를 가져온다. `core`는 계약의 `CloudPort`, `CloudWorkflowPort`를 주입받으며 어댑터 구현을 직접 가져오지 않는다. 외부 행동 어댑터는 `core`의 검증 함수와 SQL 포트 타입도 가져온다(`[adapters/src/autonomous-external.ts:externalParametersHash]`, `[adapters/src/autonomous-external-large-sql.ts:createExternalLargeRecordPort]`).

`adapters/src`의 Cloudflare 포트는 저장소 루트의 `cloudflare/backend/src` 모듈을 실행 시점에 동적으로 불러온다. 그 패키지는 이 디렉터리 밖에 있다.

## Subdirectories & Boundaries

- contracts: [`./contracts/README.md`](./contracts/README.md) - 작업, 실행 근거, 어댑터, Cloudflare 포트, 워크플로의 공통 타입과 `zod` 스키마. 부수 효과가 없다.
- core: [`./core/README.md`](./core/README.md) - 승인, 취소, 비용 정책과 상태 전이를 결정하고 SQLite에 저장하는 중앙 core.
- adapters: [`./adapters/README.md`](./adapters/README.md) - 에이전트 CLI 실행, Git worktree 관리, 원격 백엔드 호출을 수행하는 어댑터. 실행 근거를 반환하고, 근거의 수락 여부는 `core`가 판단한다.

## Interface

- `[contracts/src/index.ts:AgentAdapter]`와 `[contracts/src/cloudflare.ts:CloudPort]`는 소비자 계약, `[core/src/store.ts:HiveStore]`는 중앙 상태 저장, `[adapters/src/index.ts:getAdapter]`는 실행 어댑터 선택 경계다.

## Invariants

- 중앙 승인과 상태 변경을 UI·모델 어댑터가 대신 결정하지 않는다. 실행 근거는 중앙 저장소가 검증한다 `[core/src/store.ts:HiveStore.result]`.

## Side Effects

- 계약은 I/O가 없고, core는 영속 상태를 변경하며, 어댑터는 프로세스·worktree·원격 공급자를 호출한다 `[core/src/store.ts:HiveStore]`, `[adapters/src/process.ts:runProcess]`, `[adapters/src/autonomous-external.ts:createExternalProviderTransport]`.

## Verification

- 저장소 루트에서 `npm run check`를 실행한다. 타입 검사 후 루트 테스트를 실행한다.
