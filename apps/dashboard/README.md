# dashboard

## Overview

운영자용 상시 모니터링 HUD 및 안전 운영 제어 웹 관제실이다. 빌드 단계가 없는 정적 자산이며, `apps/control-plane/src/app.ts`의 `buildApp`이 `public/`의 파일을 그대로 제공한다. 좌측 사이드바, 우측 슬라이드 상세 드로어, 다크/라이트·컴팩트 밀도 전환, 순수 SVG 비용 차트와 기존 로컬·레거시 관제 화면을 함께 제공한다.

## Subdirectories & Boundaries

- public: [./public/README.md](./public/README.md) - 브라우저 스크립트 `charts.js`(순수 SVG 비용 추이·분포 차트 및 파이프라인 스테퍼), `monitor.js`(AWS 단일 경로 HUD·승인 인박스·비용 분석·상세 드로어·운영 제어), `app.js`(로컬·레거시 작업), `tool-audit.js`(워커 도구 호출 기록 패널).

## Interface

- `[public/charts.js:hivemindCharts]`가 순수 DOM API(`createElementNS`) 기반 SVG 비용 추이·분포 차트와 파이프라인 스테퍼를 렌더링한다.
- `[public/monitor.js:hivemindMonitor]`가 개요 HUD, Live 스트립, 승인 인박스, 비용 분석, 우측 상세 드로어, 통합 이벤트 검색·필터, 테마·밀도·주기 설정 및 명시적 사유 기반 승인·중단·정리를 담당한다.
- `[public/app.js:render]`, `[public/app.js:renderAutonomous]`, `[public/tool-audit.js:renderToolAudit]`가 로컬·레거시 작업과 도구 기록을 표시한다.

## Invariants

- 모든 HTML과 SVG는 `createElement`/`createElementNS`와 `textContent`로만 생성하며 `innerHTML`을 쓰지 않는다.
- 운영자 토큰은 현재 탭 `sessionStorage`에만 보관하고, `localStorage`에는 비비밀 UI 설정(`theme`, `density`, `pollIntervalMs`, `notificationsEnabled`)만 저장한다.
- 원장의 예약 상한과 정산 추정치를 실제 AWS·모델 청구서와 구분해 표시한다.

## Side Effects

- 운영자 API를 조회·변경하고 DOM·SVG를 갱신한다 `[public/monitor.js:monitorApi]`, `[public/app.js:api]`.

## Verification

- 저장소 루트에서 `npm run check`를 실행한다. 타입 검사 후 루트 테스트를 실행한다.
