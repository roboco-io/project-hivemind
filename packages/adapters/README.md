# adapters

## Overview

이 디렉터리는 HIVEMIND의 어댑터 패키지다. 직접 가진 소스 파일은 없고, 모든 코드는 `src` 하위 디렉터리에 있다. 어댑터는 계약 패키지의 인터페이스를 구현해 에이전트 CLI와 원격 백엔드를 실행한다. 승인과 상태 전이는 결정하지 않는다.

## Subdirectories & Boundaries

- src: [`./src/README.md`](./src/README.md) - 로컬 실행 어댑터(`getAdapter`, `createCodexAdapter`, `createClaudeAdapter`), Cloudflare 포트(`createCloudPort`, `createCloudWorkflowPort`), 프로세스 실행과 Git worktree 도구(`runProcess`, `createWorkspace`)를 제공한다. 자식 프로세스 실행, worktree 생성, 원격 HTTP 호출을 수행한다.

## Interface

- `[src/index.ts:getAdapter]`, `[src/cloudflare.ts:createCloudPort]`, `[src/cloud-workflow.ts:createCloudWorkflowPort]`가 기본 실행을 제공한다. `[src/autonomous-runner.ts:runAutonomousIteration]`과 `[src/autonomous-external.ts:createExternalProviderTransport]`는 장기 실행과 외부 행동을 담당한다.

## Invariants

- 실행은 고정 정책·lease·대상·세션에 결속하며 최종 상태·승인은 중앙 core가 정한다 `[src/local-execution.ts:executeLocalTask]`, `[src/autonomous-runner.ts:runAutonomousIteration]`.

## Side Effects

- 자식 프로세스·Git worktree·암호화 파일·원격 HTTP·외부 공급자 변경·주입한 저장소 I/O가 있다. 실제 모델·외부 변경은 별도 승인된 실행에서만 수행한다 `[src/process.ts:runProcess]`, `[src/autonomous-external.ts:createExternalProviderTransport]`.

## Verification

- 저장소 루트에서 `npm run check`를 실행한다. 타입 검사 후 루트 테스트를 실행한다.
