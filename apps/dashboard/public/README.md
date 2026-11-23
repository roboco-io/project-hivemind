# dashboard/public

## Overview

운영자가 브라우저에서 쓰는 대시보드의 정적 자산이다. `app.js`는 빌드 단계 없이 그대로 제공되는 스크립트이며, 관제 서비스의 운영자 API를 호출해 작업 목록, 워커 상태, 실행 근거를 표시하고 작업 등록·승인·반려·중단 요청을 보낸다. 승인 정책과 상태 전이는 서버가 판단하고, 이 스크립트는 서버 응답을 표시만 한다. `index.html`은 두 스크립트의 DOM 접점과 로드 순서를 정의한다. `styles.css`와 이미지 전용 `brand/`에는 별도 코드 계약을 만들지 않는다.

## Interface

`app.js`는 모듈로 내보내는 심볼이 없다. 외부와의 접점은 호출하는 HTTP 경로와 `index.html`의 DOM 요소 ID다.

- `[app.js:api]` - `Authorization: Bearer` 헤더에 `#operator-token` 입력값을 넣어 `fetch`를 호출한다. 본문이 있으면 `POST`, 없으면 `GET`이다.
- `[app.js:refresh]` - `GET /api/state`와 `GET /api/capabilities`를 함께 호출해 `state`를 갱신한다.
- `[app.js]`의 `create-form` submit 핸들러 - `POST /api/tasks` 또는 `POST /api/cloudflare/tasks`로 작업을 등록한다.
- `[app.js]`의 `decision-form` submit 핸들러 - `/api/tasks/:id/decision`, `/api/tasks/:id/cancel` 또는 같은 이름의 `/api/cloudflare/tasks/:id/...` 경로를 호출한다.
- `[app.js:render]` - `renderProvider`, `renderTasks`, `renderWorkers`, `renderSelected`를 차례로 호출한다. `renderSelected`는 `renderExecution`(로컬 실행 근거)과 `renderRemote`(Cloudflare 실행 근거)를 호출한다.
- `[tool-audit.js:renderToolAudit]`, `[tool-audit.js:loadToolAudit]` - 장기 작업 상세에서 `GET /api/cloudflare/autonomous-tasks/:id/tool-calls?limit=20`을 읽어 워커 도구 호출 기록을 표시한다. `index.html`이 `app.js`보다 먼저 불러오며, `app.js`의 `showAutonomousToolAudit`이 호출한다. 패널은 워커 보고이며 독립 증명이 아니라고 표시한다. 서버 값은 `textContent`로만 넣는다.
- `[app.js:statuses]`, `[app.js:cloudStatuses]`, `[app.js:processStatuses]` - 서버 상태 값을 한국어 표시 문구로 바꾸는 표.

- `[app.js:loadAutonomousTask]`, `[app.js:refreshAutonomous]`, `[app.js:renderAutonomous]` - 기존 작업과 별도 상태로 장기 작업 summary, 실행 이력·외부 행동 페이지, profile metadata를 조회·표시한다.
- `[app.js:autonomousProfileHashes]`, `[app.js:applyAutonomousDetail]`, `[app.js:autonomousR9Metadata]`, `[app.js:showAutonomousToolAudit]` - 승인 대상 hash 결속, 오래된 상세 응답 방지, 제한된 행동 근거와 도구 기록 표시를 담당한다.
- `[index.html:autonomous-decision-form]`과 `[app.js:autonomousPath]` - `/api/cloudflare/autonomous-tasks/:id/{approve,cancel,message,resume}` 운영자 요청의 DOM·HTTP 경계다.

## Invariants

- 서버에서 받은 값은 `textContent`로만 표시한다. `[app.js:node]`가 요소를 만들며 `innerHTML`을 쓰지 않는다.
- `state.busy`가 참이면 작업 선택, 등록, 결정 요청을 다시 시작하지 않는다 `[app.js:selectTask]`와 두 submit 핸들러.
- `state.refreshing`이 참이면 `[app.js:refresh]`가 중복 실행되지 않는다.
- 결정 요청은 사유가 비어 있으면 보내지 않는다. `decision` 값은 `approve`, `reject`, `cancel` 중 하나여야 한다.
- `mock` 제공자의 예산은 1000 마이크로달러 이상이어야 등록 요청을 보낸다. `codex`·`claude` 제공자는 0 이상이면 된다.
- `codex`·`claude` 작업을 등록할 때는 `/api/capabilities`가 알려준 `repository.id`, `repository.baseCommit`, `repository.testProfile`을 그대로 전송한다.
- Cloudflare 작업은 연결 상태가 `ready`일 때만 등록할 수 있다 `[app.js:cloudReady]`.
- 숫자가 아닌 비용은 `미확정`으로 표시한다 `[app.js:usd]`. `mock` 제공자의 diff는 `합성 예시`로 표시해 실제 변경과 구분한다 `[app.js:renderSelected]`.
- 작업 목록의 버튼 요소는 재사용한다. 주기적 갱신이 키보드 포커스를 가진 요소를 제거하지 않게 하기 위해서다 `[app.js:renderTasks]`.

- `[app.js:autonomousApi]`는 Cloudflare 장기 작업 경로만 허용하고 리다이렉트를 거부한다. 로컬 장기 API로 우회하지 않는다.
- `[app.js:applyAutonomousDetail]`과 `autonomous-decision-form` 핸들러는 revision·profile hash 변경 시 사유를 비우고 재검토를 요구한다. 승인·재개 직전에 현재 범위를 다시 읽으며 409에서 자동으로 재승인하지 않는다.
- `[app.js:autonomousR9Metadata]`는 행동 매개변수 중 `lifetimeMs`, `startActionId`, `artifactDigest`, `expectedHead`만 표시한다. `autonomousApprovedTarget`은 S3·HF 공개 대상도 제한된 필드로 표시한다.
- `[app.js:renderAutonomous]`는 예약 상한·원장 비용·미확정 청구·사용량 placeholder를 구분한다. 한 페이지에 자원이 없다는 사실을 정리 완료로 표시하지 않는다.
- `[app.js:selectAutonomousTask]`, `[app.js:showAutonomousToolAudit]`는 epoch·sequence와 선택한 ID를 대조해 오래된 응답이 다른 작업의 패널을 덮지 않게 한다.

## Side Effects

- 같은 원점의 `/api/*` 경로로 네트워크 요청을 보낸다. 각 요청의 제한 시간은 10초다 `[app.js:api]`.
- 문서가 보이는 동안 2초마다, 그리고 `visibilitychange` 이벤트에서 `[app.js:refresh]`를 호출한다.
- DOM을 직접 수정한다. 운영자 토큰은 `#operator-token` 입력 요소에서 요청마다 읽으며, 스크립트는 토큰을 `localStorage`나 쿠키에 저장하지 않는다.

- `[app.js:refreshAutonomous]`는 장기 목록·선택한 작업을 별도로 조회한다. 문서가 보이는 동안 2초 간격 타이머로 실행한다. 승인·중단·재개·메시지는 명시적인 폼 제출로만 요청한다.

## Verification

- Run: `npm run check` (저장소 루트에서 실행한다. 테스트는 루트 `tests/` 디렉터리에 있다.)
