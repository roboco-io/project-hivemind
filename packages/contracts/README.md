# contracts

## Overview

이 디렉터리는 HIVEMIND의 공통 계약 패키지다. 직접 가진 소스 파일은 없고, 모든 코드는 `src` 하위 디렉터리에 있다. 중앙 core와 어댑터는 이 패키지의 타입과 스키마를 가져다 쓴다. 프로젝트 규칙에 따라 이 계약을 바꾸면 소비자, 테스트, 문서를 함께 갱신한다.

## Subdirectories & Boundaries

- src: [`./src/README.md`](./src/README.md) - 로컬 작업 계약(`Task`, `AgentAdapter`), Cloudflare 작업 계약(`CloudPort`, `CloudControl`), 워크플로 스키마(`workflowDraft`, `workflowView`)를 정의한다. 파일, 네트워크, 데이터베이스에 접근하지 않는다.

## Interface

- `[src/index.ts:Task]`, `[src/cloudflare.ts:CloudPort]`, `[src/workflow.ts:workflowDraft]`와 `[src/autonomous.ts:AutonomousTask]`가 기본·원격·워크플로·장기 작업 계약을 정의한다. 외부 행동·S3·대형 파일·native·도구 감사 타입은 하위 계약을 따른다.

## Invariants

- 런타임 검증은 명시된 스키마·검증 함수만 수행한다. 외부 profile 기본값은 비활성이다 `[src/autonomous-external.ts:DEFAULT_EXTERNAL_PROFILE_ENTRY]`.

## Side Effects

- 파일·네트워크·DB 접근은 없다. 스키마·상수를 구성하고 잘못된 입력에 예외를 던진다 `[src/workflow.ts:workflowDraft]`, `[src/autonomous.ts:validateAutonomousCapabilities]`.

## Verification

- 저장소 루트에서 `npm run check`를 실행한다. 타입 검사 후 루트 테스트를 실행한다.
