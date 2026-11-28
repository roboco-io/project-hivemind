# dashboard/public

## Overview

운영자가 브라우저에서 쓰는 멀티 프로젝트 호스트 상시 모니터링 HUD 웹 관제실의 정적 자산이다. 빌드 단계 없이 제공되며, `charts.js`가 순수 SVG 비용 추이·분포 차트와 파이프라인 스테퍼를, `monitor.js`가 AWS 멀티 프로젝트 호스트 단일 경로(상단 프로젝트 필터 `#project-filter`, 개요 HUD, 프로젝트 관리, Live 스트립, 승인 인박스, SW 전달, Spot 컴퓨팅, 병렬 협업, 비용 분석, 우측 상세 드로어) 모니터링과 명시적 사유 기반 운영 제어를 담당한다. `app.js`와 `tool-audit.js`는 하단 보조 진입점(`로컬 · 레거시 도구`)의 로컬·레거시 작업과 도구 감사 패널을 담당한다. `index.html`은 네 스크립트의 로드 순서(`tool-audit.js` → `app.js` → `charts.js` → `monitor.js`)를 정의한다.

## Interface

- `[charts.js:hivemindCharts]` - `renderCostTrendChart`, `renderBreakdownBars`, `renderStepper`, `deliverySteps`, `computeSteps`, `collabSteps`를 노출한다.
- `[monitor.js:hivemindMonitor]` - `state`, `refresh`, `switchTab`, `selectDelivery`, `selectComputeJob`, `selectCollab`, `openDrawer`, `closeDrawer`, `querySpotPlacement`, `handleKeydown`, `formatUsd`를 노출한다.
- `[monitor.js:refresh]` - `GET /api/monitor/snapshot`(단일 요청 집계 API, 미지원 시 순차 폴백)을 조회해 프로젝트 목록·필터, Live 스트립, 승인 인박스, 개요 KPI, 예산 미터·SVG 차트, 프로젝트/워크로드/리전/인스턴스별 비용 분포, 실행 중 EC2 실시간 추정·TTL, 통합 이벤트 타임라인, 우측 상세 드로어, 브라우저 탭 제목 배지를 갱신한다.
- `[monitor.js]`의 운영자 제어 핸들러 - 프로젝트 등록·상태 전환·토큰 발급/폐기(`/api/projects/*`), 명시적 사유 입력과 `approvalFingerprint`를 포함한 SW 전달(`/api/delivery/reconcile`, `/approve`, `/cancel`, `/human-decision`), Spot 컴퓨팅(`/api/compute/sweep-expired`, `/approve`, `/wake`, `/dispatch-verifier`, `/approve-release`, `/publish-release`, `/cancel`), 병렬 협업(`/reconcile`, `/complete`, `/messages`) API를 호출한다.
- `[app.js:api]`, `[app.js:refresh]`, `[app.js:render]` - 로컬·레거시 작업(`/api/state`, `/api/capabilities`, `/api/tasks`, `/api/cloudflare/tasks`)을 조회·표시·제어한다.
- `[tool-audit.js:renderToolAudit]`, `[tool-audit.js:loadToolAudit]` - 장기 작업 상세에서 `GET /api/cloudflare/autonomous-tasks/:id/tool-calls?limit=20`을 읽어 워커 도구 호출 기록을 표시한다.

## Invariants

- 서버에서 받은 값은 HTML/SVG 모두 `textContent`로만 표시하며 `innerHTML`을 쓰지 않는다 `[charts.js:svgEl]`, `[monitor.js:el]`, `[app.js:node]`.
- 외부 링크(Draft PR, HF 공개 URL)는 `https:` 프로토콜을 검증한 경우에만 `rel="noopener noreferrer"` 앵커로 렌더링한다 `[monitor.js:safeHttpsLink]`.
- 운영자 토큰과 비밀 패턴(`Bearer`, `sk-ant-`, `AKIA/ASIA`, `hf_`, `ghp_/ghs_`)은 표시 텍스트와 오류 배너에서 `[REDACTED]`로 가린다 `[monitor.js:safeText]`, `[app.js:autonomousText]`.
- 운영자 토큰은 현재 탭의 `sessionStorage`(`hivemind.operatorToken`)와 `#operator-token` 입력값에만 보관하며 `localStorage`나 쿠키에 절대 저장하지 않는다. `localStorage`(`hivemind.uiPrefs`)에는 비비밀 UI 환경설정(`theme`, `density`, `pollIntervalMs`, `notificationsEnabled`)만 저장한다. 초기 로드 시 URL 프래그먼트(`#token=...`)만 한 번 읽어 보관하고 `history.replaceState`로 주소창에서 즉시 제거하며, 쿼리 문자열(`?token=...`)은 무시한다 `[monitor.js:consumeHashToken]`, `[monitor.js:restoreTabToken]`.
- SW 전달과 Model Factory 승인 요청은 현재 검토 중인 `approvalFingerprint`를 그대로 전달하며, 폴링 중 지문이 바뀌면 입력 중인 사유를 비우고 재검토를 요구한다.
- Model Factory의 `reservedMicros`(예약 상한), `settledMicros`(실행 시간×시간당 상한가 추정치, `null`이면 `미정산`), 실행 중 EC2 경과 추정치와 SW 전달의 미확정 모델·Fargate 비용을 실제 청구서와 명확히 구분한다.
- Model Factory 배포 검증의 `attestationSource`가 `operator_self_reported`이면 비독립 경고와 면책 문구를 표시한다.

## Side Effects

- 같은 원점의 `/health`, `/api/*` 경로로 네트워크 요청을 보낸다.
- 문서가 보이는 동안 `monitor.js`는 선택한 주기(기본 15초, 30초/60초/일시정지 선택 가능), `app.js`는 레거시 탭이 열려 있을 때 2초 간격으로 갱신한다.
- 사용자가 알림 버튼을 명시적으로 켠 경우에만 브라우저 데스크톱 알림 권한을 요청하고 신규 승인 대기·실패를 알린다.

## Verification

- Run: `npm run check` (저장소 루트에서 실행한다. 테스트는 `tests/monitor-dashboard.test.ts`, `tests/cloudflare-dashboard.test.ts`, `tests/autonomous-dashboard.test.ts`, `tests/autonomous-tool-audit-dashboard.test.ts`, `tests/api.test.ts`에 있다.)
