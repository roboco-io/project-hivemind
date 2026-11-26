# dashboard

## Overview

운영자용 웹 대시보드다. 빌드 단계가 없는 정적 자산이며, `apps/control-plane/src/app.ts`의 `buildApp`이 `public/`의 파일을 그대로 제공한다.

## Subdirectories & Boundaries

- public: [./public/README.md](./public/README.md) - 브라우저 스크립트 `app.js`와 `tool-audit.js`(워커 도구 호출 기록 패널). 운영자 API를 호출해 작업·워커·실행 근거를 표시하고, 작업 등록과 승인·반려·중단 요청을 보낸다. 서버 값은 `textContent`로만 표시한다.

## Interface

- `[public/app.js:render]`, `[public/app.js:renderAutonomous]`, `[public/tool-audit.js:renderToolAudit]`가 기본·장기 작업·도구 기록을 표시한다.

## Invariants

- 서버 값을 `textContent`로 표시하고 승인 정책은 HTTP 서버에 맡긴다 `[public/app.js:node]`, `[public/tool-audit.js:renderToolAudit]`.

## Side Effects

- 운영자 API를 조회·변경하고 DOM을 갱신한다 `[public/app.js:api]`, `[public/app.js:autonomousApi]`.

## Verification

- 저장소 루트에서 `npm run check`를 실행한다. 타입 검사 후 루트 테스트를 실행한다.
