# dashboard

## Overview

운영자용 웹 관제실이다. 빌드 단계가 없는 정적 자산이며, `apps/control-plane/src/app.ts`의 `buildApp`이 `public/`의 파일을 그대로 제공한다. AWS 단일 경로의 동작 상태·비용 원장 모니터링과 기존 로컬·레거시 관제 화면을 함께 제공한다.

## Subdirectories & Boundaries

- public: [./public/README.md](./public/README.md) - 브라우저 스크립트 `monitor.js`(AWS 단일 경로 상태·비용 모니터링 및 안전 운영 제어), `app.js`(로컬·레거시 작업), `tool-audit.js`(워커 도구 호출 기록 패널). 운영자 API를 호출해 상태·비용·실행 근거를 표시하며, 서버 값은 `textContent`로만 표시한다.

## Interface

- `[public/monitor.js:hivemindMonitor]`가 개요·비용 원장, SW 전달, Model Factory, 병렬 협업 모니터링과 명시적 사유 기반 승인·중단·정리를 담당한다.
- `[public/app.js:render]`, `[public/app.js:renderAutonomous]`, `[public/tool-audit.js:renderToolAudit]`가 로컬·레거시 작업과 도구 기록을 표시한다.

## Invariants

- 서버 값을 `textContent`로만 표시하고 승인·비용 정책은 중앙 HTTP 서버에 맡긴다 `[public/monitor.js:el]`, `[public/app.js:node]`, `[public/tool-audit.js:renderToolAudit]`.
- 원장의 예약 상한과 정산 추정치를 실제 AWS·모델 청구서와 구분해 표시한다.

## Side Effects

- 운영자 API를 조회·변경하고 DOM을 갱신한다 `[public/monitor.js:monitorApi]`, `[public/app.js:api]`, `[public/app.js:autonomousApi]`.

## Verification

- 저장소 루트에서 `npm run check`를 실행한다. 타입 검사 후 루트 테스트를 실행한다.
