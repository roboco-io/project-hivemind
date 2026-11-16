# contracts

## Overview

이 디렉터리는 HIVEMIND의 공통 계약 패키지다. 직접 가진 소스 파일은 없고, 모든 코드는 `src` 하위 디렉터리에 있다. 중앙 core와 어댑터는 이 패키지의 타입과 스키마를 가져다 쓴다. 프로젝트 규칙에 따라 이 계약을 바꾸면 소비자, 테스트, 문서를 함께 갱신한다.

## Subdirectories & Boundaries

- src: [`./src/README.md`](./src/README.md) - 로컬 작업 계약(`Task`, `AgentAdapter`), Cloudflare 작업 계약(`CloudPort`, `CloudControl`), 워크플로 스키마(`workflowDraft`, `workflowView`)를 정의한다. 파일, 네트워크, 데이터베이스에 접근하지 않는다.
