# core

## Overview

이 디렉터리는 HIVEMIND의 중앙 core 패키지다. 직접 가진 소스 파일은 없고, 모든 코드는 `src` 하위 디렉터리에 있다. 승인, 취소, 비용 정책과 작업 상태 전이는 이 패키지가 결정한다. 프로젝트 규칙은 UI와 모델 어댑터가 이 결정을 우회하지 못하게 한다.

## Subdirectories & Boundaries

- src: [`./src/README.md`](./src/README.md) - 로컬 작업 저장소 `HiveStore`, Cloudflare 작업 제어 `createCloudControl`, 워크플로 등록 제어 `createCloudWorkflowControl`, 장기 작업 `AutonomousEngine`, 외부 행동 `ExternalBroker`와 영속 저장·페이지 조회·도구 감사 계약을 제공한다. 상태는 SQLite에 저장하고, 원격 호출은 주입받은 `CloudPort`와 `CloudWorkflowPort`에 맡긴다.

## Interface

- [src](./src/README.md): 로컬 `HiveStore`, 원격 `createCloudControl`·`createCloudWorkflowControl`, 장기 작업 `AutonomousEngine`·`createAutonomousStore`, 외부 `ExternalBroker`·`createExternalSqlStore`, 감사 `createToolAuditStore`가 중앙 제어 경계다. [src/store.ts:`HiveStore`] [src/cloudflare-store.ts:`createCloudControl`] [src/cloud-workflow-store.ts:`createCloudWorkflowControl`] [src/autonomous.ts:`AutonomousEngine`] [src/autonomous-store.ts:`createAutonomousStore`] [src/autonomous-external.ts:`ExternalBroker`] [src/autonomous-external-sql.ts:`createExternalSqlStore`] [src/autonomous-tool-audit-sql.ts:`createToolAuditStore`]

## Invariants

- 실행 승인은 상태·고정 정책·revision과 대조한다. 워커 결과는 유효 lease나 신뢰된 외부 receipt 경로로만 반영한다. [src/store.ts:`HiveStore.running`] [src/autonomous.ts:`AutonomousEngine.authorize`] [src/autonomous-external.ts:`ExternalBroker.execute`, `ExternalBroker.accept`]
- 미대사 비용·행동·미정리 리소스를 완료로 숨기지 않는다. 외부 효과가 불확실하면 재실행 대신 조회·복구한다. [src/autonomous.ts:`AutonomousEngine.finalize`] [src/autonomous-external.ts:`ExternalBroker.recover`, `ExternalBroker.reconcile`]

## Side Effects

- 로컬 adapter는 SQLite 파일·테이블·이벤트·chunk를 저장한다. SQL port 구현은 로컬 SQLite와 Cloudflare storage 경로에서 재사용한다. 원격·외부 호출은 주입한 포트를 통해 실행한다. [src/autonomous-store.ts:`createAutonomousStore`] [src/autonomous-external-sql.ts:`ExternalSqlPort`, `createExternalSqlStore`] [src/cloudflare-store.ts:`dispatch`] [src/autonomous-external.ts:`ExternalBroker`]

## Verification

- 저장소 루트에서 `npm run check`를 실행한다. [../../package.json:`scripts.check`]
