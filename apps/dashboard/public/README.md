# dashboard/public

## Overview

운영자가 브라우저에서 쓰는 관제실의 정적 자산이다. 빌드 단계 없이 제공되며, `monitor.js`가 AWS 단일 경로(SW 전달, Model Factory, 중앙 비용 원장, 병렬 협업)의 실시간 상태·비용 모니터링과 명시적 사유 기반 운영 제어를 담당한다. `app.js`와 `tool-audit.js`는 로컬·레거시 작업과 도구 감사 패널을 담당한다. 승인·취소·비용 정책과 상태 전이는 중앙 서버가 판단하고, 브라우저 스크립트는 서버 응답을 표시·전달만 한다. `index.html`은 세 스크립트의 DOM 접점과 로드 순서(`tool-audit.js` → `app.js` → `monitor.js`)를 정의한다.

## Interface

- `[monitor.js:hivemindMonitor]` - IIFE 내부에서 실행되어 `app.js`와 전역 식별자가 충돌하지 않으며, `state`, `refresh`, `switchTab`, `selectDelivery`, `selectMfJob`, `selectCollab`, `querySpotPlacement`, `formatUsd`를 노출한다.
- `[monitor.js:refresh]` - `GET /api/monitor/snapshot`(단일 요청 집계 API, 미지원 시 순차 폴백)을 조회해 개요 KPI, 저장소 백엔드, 예산 사용률 막대, 비용 원장 테이블, 스팟 배치 현황, 최근 이벤트와 각 탭 상세를 갱신한다.
- `[monitor.js]`의 운영자 제어 핸들러 - 명시적 사유 입력과 `approvalFingerprint`를 포함해 SW 전달(`/api/delivery/reconcile`, `/approve`, `/cancel`, `/human-decision`), Model Factory(`/api/model-factory/sweep-expired`, `/approve-training`, `/wake`, `/dispatch-verifier`, `/approve-release`, `/cancel`), 병렬 협업(`/reconcile`, `/complete`, `/messages`) API를 호출한다.
- `[app.js:api]`, `[app.js:refresh]`, `[app.js:render]` - 로컬·레거시 작업(`/api/state`, `/api/capabilities`, `/api/tasks`, `/api/cloudflare/tasks`)을 조회·표시·제어한다.
- `[tool-audit.js:renderToolAudit]`, `[tool-audit.js:loadToolAudit]` - 장기 작업 상세에서 `GET /api/cloudflare/autonomous-tasks/:id/tool-calls?limit=20`을 읽어 워커 도구 호출 기록을 표시한다.

## Invariants

- 서버에서 받은 값은 `textContent`로만 표시하며 `innerHTML`을 쓰지 않는다 `[monitor.js:el]`, `[app.js:node]`.
- 외부 링크(Draft PR, HF 공개 URL)는 `https:` 프로토콜을 검증한 경우에만 `rel="noopener noreferrer"` 앵커로 렌더링한다 `[monitor.js:safeHttpsLink]`.
- 운영자 토큰과 비밀 패턴(`Bearer`, `sk-ant-`, `AKIA/ASIA`, `hf_`, `ghp_/ghs_`)은 표시 텍스트와 오류 배너에서 `[REDACTED]`로 가린다 `[monitor.js:safeText]`, `[app.js:autonomousText]`.
- 운영자 토큰은 `#operator-token` 입력값에서 요청마다 읽으며 `localStorage`나 쿠키에 저장하지 않는다. 초기 로드 시 URL 프래그먼트(`#token=...`)만 한 번 읽어 메모리에 채우고 `history.replaceState`로 주소창에서 즉시 제거하며, 서버로 전송되는 쿼리 문자열(`?token=...`)은 무시한다 `[monitor.js:consumeHashToken]`.
- SW 전달과 Model Factory 승인 요청은 현재 검토 중인 `approvalFingerprint`를 그대로 전달하며, 폴링 중 지문이 바뀌면 입력 중인 사유를 비우고 재검토를 요구한다.
- Model Factory의 `reservedMicros`(예약 상한), `settledMicros`(실행 시간×시간당 상한가 추정치, `null`이면 `미정산`)와 SW 전달의 미확정 모델·Fargate 비용을 실제 청구서와 명확히 구분한다.
- Model Factory 배포 검증의 `attestationSource`가 `operator_self_reported`이면 비독립 경고와 면책 문구를 표시한다.
- 목록 버튼 요소는 재사용해 주기적 갱신이 키보드 포커스를 끊지 않게 한다.

## Side Effects

- 같은 원점의 `/health`, `/api/*` 경로로 네트워크 요청을 보낸다.
- 문서가 보이는 동안 `monitor.js`는 3초 간격(일시정지 토글 가능), `app.js`는 2초 간격으로 갱신한다.
- DOM을 직접 수정하며, 승인·중단·정리·메시지 게시는 명시적 사용자 클릭·폼 제출로만 호출한다.

## Verification

- Run: `npm run check` (저장소 루트에서 실행한다. 테스트는 `tests/monitor-dashboard.test.ts`, `tests/cloudflare-dashboard.test.ts`, `tests/autonomous-dashboard.test.ts`, `tests/autonomous-tool-audit-dashboard.test.ts`, `tests/api.test.ts`에 있다.)
