# adapters

## Overview

이 디렉터리는 HIVEMIND의 어댑터 패키지다. 직접 가진 소스 파일은 없고, 모든 코드는 `src` 하위 디렉터리에 있다. 어댑터는 계약 패키지의 인터페이스를 구현해 에이전트 CLI와 원격 백엔드를 실행한다. 승인과 상태 전이는 결정하지 않는다.

## Subdirectories & Boundaries

- src: [`./src/README.md`](./src/README.md) - 로컬 실행 어댑터(`getAdapter`, `createCodexAdapter`, `createClaudeAdapter`), Cloudflare 포트(`createCloudPort`, `createCloudWorkflowPort`), 프로세스 실행과 Git worktree 도구(`runProcess`, `createWorkspace`)를 제공한다. 자식 프로세스 실행, worktree 생성, 원격 HTTP 호출을 수행한다.
