# control-plane

## Overview

중앙 관제 서비스 앱이다. 운영자 API, 워커 API, 대시보드 정적 파일을 하나의 HTTP 서버로 제공한다. 소스는 `src/` 한 곳에 있다.

## Subdirectories & Boundaries

- src: [./src/README.md](./src/README.md) - Fastify 앱(`buildApp`), Cloudflare 설정 로더(`loadCloudflareConfig`, `loadCloudWorkflowChecks`), 실행 진입점. 운영자 토큰과 워커 토큰으로 API를 분리하고, 상태 전이는 `packages/core`의 `HiveStore`에 위임한다.
