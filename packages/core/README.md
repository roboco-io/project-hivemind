# core

## Overview

이 디렉터리는 HIVEMIND의 중앙 core 패키지다. 직접 가진 소스 파일은 없고, 모든 코드는 `src` 하위 디렉터리에 있다. 승인, 취소, 비용 정책과 작업 상태 전이는 이 패키지가 결정한다. 프로젝트 규칙은 UI와 모델 어댑터가 이 결정을 우회하지 못하게 한다.

## Subdirectories & Boundaries

- src: [`./src/README.md`](./src/README.md) - 로컬 작업 저장소 `HiveStore`, Cloudflare 작업 제어 `createCloudControl`, 워크플로 등록 제어 `createCloudWorkflowControl`을 제공한다. 상태는 SQLite에 저장하고, 원격 호출은 주입받은 `CloudPort`와 `CloudWorkflowPort`에 맡긴다.
