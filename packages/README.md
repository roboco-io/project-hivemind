# packages

## Overview

이 디렉터리는 HIVEMIND의 로컬 실행 경로를 이루는 세 패키지를 묶는다. 직접 가진 소스 파일은 없다. 의존 방향은 한쪽으로만 흐른다. `contracts`는 다른 패키지를 가져오지 않는다. `core`와 `adapters`는 각각 `contracts`를 가져온다. `core`와 `adapters`는 서로를 가져오지 않으며, `core`는 `contracts`에 정의된 포트 인터페이스(`CloudPort`, `CloudWorkflowPort`)를 주입받아 `adapters`의 구현을 호출한다.

`adapters/src`의 Cloudflare 포트는 저장소 루트의 `cloudflare/backend/src` 모듈을 실행 시점에 동적으로 불러온다. 그 패키지는 이 디렉터리 밖에 있다.

## Subdirectories & Boundaries

- contracts: [`./contracts/README.md`](./contracts/README.md) - 작업, 실행 근거, 어댑터, Cloudflare 포트, 워크플로의 공통 타입과 `zod` 스키마. 부수 효과가 없다.
- core: [`./core/README.md`](./core/README.md) - 승인, 취소, 비용 정책과 상태 전이를 결정하고 SQLite에 저장하는 중앙 core.
- adapters: [`./adapters/README.md`](./adapters/README.md) - 에이전트 CLI 실행, Git worktree 관리, 원격 백엔드 호출을 수행하는 어댑터. 실행 근거를 반환하고, 근거의 수락 여부는 `core`가 판단한다.
