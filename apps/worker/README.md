# worker

## Overview

로컬 워커 앱이다. 관제 서비스에서 승인된 작업을 가져와 어댑터로 실행하고 결과를 보고한다. 소스는 `src/` 한 곳에 있다.

## Subdirectories & Boundaries

- src: [./src/README.md](./src/README.md) - 한 번의 등록·작업 가져오기·실행·보고를 수행하는 `runOnce`, 환경 변수 로더 `loadWorkerSettings`, 실행 진입점. 관제 서비스와는 워커 토큰으로 인증하는 HTTP API로만 통신한다.

## Interface

- `[src/worker.ts:runOnce]`는 로컬 작업 한 건을 처리한다. `[src/autonomous-mock.ts:runAutonomousMockDemo]`는 별도 합성 장기 예제다.

## Invariants

- 실행 제공자는 워커·배정 작업·어댑터 사이에 일치해야 한다 `[src/worker.ts:runOnce]`. 합성 executor는 mock만 허용한다 `[src/autonomous-mock.ts:mockAutonomousExecutor]`.

## Side Effects

- 워커 HTTP와 어댑터 실행을 수행한다. 합성 예제도 초안·승인 상태를 기록한다 `[src/worker.ts:runOnce]`, `[src/autonomous-mock.ts:runAutonomousMockDemo]`.

## Verification

- 저장소 루트에서 `npm run check`를 실행한다. 타입 검사 후 루트 테스트를 실행한다.
