# worker

## Overview

로컬 워커 앱이다. 관제 서비스에서 승인된 작업을 가져와 어댑터로 실행하고 결과를 보고한다. 소스는 `src/` 한 곳에 있다.

## Subdirectories & Boundaries

- src: [./src/README.md](./src/README.md) - 한 번의 등록·작업 가져오기·실행·보고를 수행하는 `runOnce`, 환경 변수 로더 `loadWorkerSettings`, 실행 진입점. 관제 서비스와는 워커 토큰으로 인증하는 HTTP API로만 통신한다.
