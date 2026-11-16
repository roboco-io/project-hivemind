# control-plane/src

## Overview

중앙 관제 서비스의 HTTP 서버다. Fastify 앱을 만들고, 운영자 API와 워커 API를 서로 다른 토큰으로 보호하며, 대시보드 정적 파일을 제공한다. 작업 상태 전이와 승인·취소 정책은 이 디렉터리에 없고 `packages/core/src/store.ts`의 `HiveStore`에 위임한다. Cloudflare 원격 실행과 워크플로는 `CloudControl`, `CloudWorkflowControl` 구현을 옵션으로 받았을 때만 라우트를 등록한다.

## Interface

- `[app.ts:buildApp]` - `AppOptions`를 받아 Fastify 인스턴스를 반환한다. 서버를 listen하지 않는다.
- `[app.ts:AppOptions]` - `dbPath`, `operatorToken`, `workerToken`, `now`, `repository`, `cloudflare`, `workflows`.
- `[cloudflare-config.ts:loadCloudflareConfig]` - `HIVEMIND_CLOUDFLARE_*` 환경 변수를 검증해 `CloudPortOptions`를 반환한다. 해당 변수가 하나도 없으면 `undefined`를 반환한다.
- `[cloudflare-config.ts:loadCloudWorkflowChecks]` - `HIVEMIND_CLOUDFLARE_WORKFLOW_CHECKS`를 `codex`, `claude`, `integration` 검사로 파싱한다. 변수가 없으면 `undefined`를 반환한다.
- `[cloudflare-config.ts:configurationScope]` - `controlToken`을 제외한 설정의 SHA-256 해시를 반환한다.
- `[cloudflare-config.ts:configurationGitEnvironment]` - 전역·시스템 Git 설정을 끈 최소 환경 변수 집합을 반환한다.
- `[main.ts]` - 실행 진입점. `HIVEMIND_HOST`, `HIVEMIND_PORT`, `HIVEMIND_OPERATOR_TOKEN`, `HIVEMIND_WORKER_TOKEN`, `HIVEMIND_REPO_PATH`, `HIVEMIND_TEST_COMMAND`, `HIVEMIND_DB`를 읽는다.

`[app.ts:buildApp]`이 등록하는 HTTP 라우트는 다음과 같다.

| 라우트 | 인증 | 등록 조건 |
| --- | --- | --- |
| `GET /health`, `GET /favicon.ico` | 없음 | 항상 |
| `GET /`, `/app.js`, `/styles.css`, `/brand/hivemind-logo.png`, `/brand/hivemind-bee.png` | 없음 | 항상 |
| `GET /api/capabilities`, `GET /api/state` | 운영자 토큰 | 항상 |
| `POST /api/tasks`, `POST /api/tasks/:id/decision`, `POST /api/tasks/:id/cancel` | 운영자 토큰 | 항상 |
| `POST /api/cloudflare/tasks`, `POST /api/cloudflare/tasks/:id/decision`, `POST /api/cloudflare/tasks/:id/cancel` | 운영자 토큰 | `options.cloudflare`가 있을 때 |
| `POST /api/cloudflare/workflows`, `GET /api/cloudflare/workflows`, `POST /api/cloudflare/workflows/:id/approve`, `GET /api/cloudflare/workflows/:id`, `GET /api/cloudflare/workflows/:id/result` | 운영자 토큰 | `options.workflows`가 있을 때 |
| `POST /api/workers/register`, `POST /api/workers/claim` | 워커 토큰 | 항상 |
| `POST /api/tasks/:id/heartbeat`, `POST /api/tasks/:id/result`, `POST /api/tasks/:id/fail` | 워커 토큰 | 항상 |

## Invariants

- 운영자 토큰과 워커 토큰은 비어 있지 않고 서로 달라야 한다. 위반하면 `[app.ts:buildApp]`이 예외를 던진다.
- 토큰 비교는 `equalSecret`으로 수행하고, 불일치하면 401 `Unauthorized`를 반환한다 `[app.ts:guard]`.
- `POST /api/cloudflare/workflows`를 제외한 라우트의 요청 본문 스키마는 `additionalProperties:false`이고 Ajv는 `coerceTypes:false`, `removeAdditional:false`로 동작한다. 정의하지 않은 필드나 타입이 다른 값은 거부한다 `[app.ts:body]`. `POST /api/cloudflare/workflows`는 스키마 없이 본문을 `workflows.draft`에 그대로 넘긴다.
- 워커 등록은 `runtime`이 `local`인 경우만 허용한다. `POST /api/cloudflare/tasks`는 `provider`가 `codex` 또는 `claude`이고 `runtime`이 `cloudflare`인 경우만 허용한다.
- `baseCommit`과 `headCommit`은 40자리 16진수여야 한다 `[app.ts:taskProperties]`, `[app.ts:executionProperties]`.
- 모든 응답에 `cache-control: no-store`, `x-content-type-options: nosniff`, `content-security-policy` 헤더를 붙인다 `[app.ts:buildApp]`의 `onRequest` 훅.
- `DomainError`와 상태 코드가 500 미만인 오류만 메시지를 그대로 반환한다. 그 밖의 오류는 `Internal server error`로 바꾼다.
- `POST /api/workers/claim`은 배정할 작업이 없으면 JSON `null`을 명시적으로 보낸다.
- loopback이 아닌 host에 바인딩하려면 두 토큰이 모두 24자 이상이고 개발용 기본값이 아니어야 한다 `[main.ts]`.
- `HIVEMIND_CLOUDFLARE_URL`은 경로·쿼리·인증 정보가 없는 `https:` 원점이어야 한다. `CONTROL_TOKEN`과 `SECRETS_FILE`은 정확히 하나만 지정해야 한다 `[cloudflare-config.ts:loadCloudflareConfig]`.
- 비밀 파일은 심볼릭 링크가 아닌 일반 파일이고 권한이 `0600`이며 64000바이트 이하여야 한다 `[cloudflare-config.ts:readControlToken]`.
- 검사는 1-4개이고 각 검사는 `id`, `argv`, `timeoutMs` 세 필드만 가진다. `id`는 중복될 수 없고 `argv`는 제어 토큰 값을 포함할 수 없다 `[cloudflare-config.ts:parseChecks]`.
- `WORKTREE_ROOT`는 절대 경로이고 `REPO_PATH`와 달라야 한다. Codex와 Claude의 credential ID는 서로 달라야 한다.
- 설정 오류는 원인과 무관하게 `Invalid Cloudflare dashboard configuration.` 한 가지 메시지로만 드러난다. `[main.ts]`는 `startupErrors`에 있는 메시지만 출력하고 나머지는 `Unable to start HIVEMIND dashboard.`로 바꾼다.

## Side Effects

- `HiveStore`로 SQLite 데이터베이스를 연다. `[app.ts:buildApp]`의 기본값은 `:memory:`이고 `[main.ts]`의 기본값은 `data/hivemind.sqlite`다. 앱을 닫을 때 `cloudflare`, `workflows`, `store` 순서로 닫는다.
- `apps/dashboard/public/`의 정적 파일을 요청마다 디스크에서 읽는다.
- `options.cloudflare`가 있으면 `onReady` 훅에서 `CloudControl.start()`를 호출한다.
- `[main.ts]`는 TCP 포트를 열고(기본 `127.0.0.1:4310`), `SIGINT`·`SIGTERM`에 앱을 닫으며, 시작에 실패하면 `process.exitCode`를 1로 설정한다.
- `[main.ts]`와 `[cloudflare-config.ts:loadCloudflareConfig]`는 `git rev-parse`를 자식 프로세스로 실행해 저장소 루트와 `HEAD` 커밋을 읽는다.
- `[cloudflare-config.ts:readControlToken]`은 비밀 파일을 읽는다.

## Verification

- Run: `npm run check` (저장소 루트에서 실행한다. 테스트는 루트 `tests/` 디렉터리에 있다.)
