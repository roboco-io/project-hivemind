# control-plane

## Overview

중앙 관제 서비스 앱이다. 운영자 API, 워커 API, 대시보드 정적 파일을 하나의 HTTP 서버로 제공한다. 소스는 `src/` 한 곳에 있다.

## Subdirectories & Boundaries

- src: [./src/README.md](./src/README.md) - Fastify 앱(`buildApp`), Cloudflare 설정 로더(`loadCloudflareConfig`, `loadCloudWorkflowChecks`), 실행 진입점. 운영자 토큰과 워커 토큰으로 API를 분리하고, 상태 전이는 `packages/core`의 `HiveStore`에 위임한다.

## Interface

- `[src/app.ts:buildApp]`과 `[src/autonomous-api.ts:handleAutonomousApi]`가 기본 작업·장기 작업의 HTTP 경계를 제공한다. `[src/autonomous-cloud-proxy.ts:createAutonomousCloudProxy]`는 원격 운영자 경로를 연결한다.

## Invariants

- 역할별 인증과 요청 검증은 앱 경계에, 승인·상태 정책은 주입한 중앙 서비스에 둔다 `[src/app.ts:buildApp]`.

## Side Effects

- SQLite·정적 파일 접근, TCP listen과 원격 HTTP 전달을 수행한다 `[src/app.ts:buildApp]`, `[src/main.ts:app.listen]`.

## Verification

- 저장소 루트에서 `npm run check`를 실행한다. 타입 검사 후 루트 테스트를 실행한다.
