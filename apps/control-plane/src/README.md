# control-plane/src

## Overview

중앙 관제 서비스의 HTTP 서버다. Fastify 앱을 만들고, 운영자 API와 워커 API를 서로 다른 토큰으로 보호하며, 대시보드 정적 파일을 제공한다. 작업 상태 전이와 승인·취소 정책은 이 디렉터리에 없고 `packages/core/src/store.ts`의 `HiveStore`에 위임한다. Cloudflare 원격 실행과 워크플로는 `CloudControl`, `CloudWorkflowControl` 구현을 옵션으로 받았을 때만 라우트를 등록한다.

## Interface

- `[app.ts:buildApp]` - `AppOptions`를 받아 Fastify 인스턴스를 반환한다. 서버를 listen하지 않는다.
- `[app.ts:AppOptions]` - `dbPath`, `operatorToken`, `workerToken`, `nativeReporterToken`, `now`, `repository`, `cloudflare`, `workflows`, `autonomousCloudProxy`, `localExternalService`.
- `[cloudflare-config.ts:loadCloudflareConfig]` - `HIVEMIND_CLOUDFLARE_*` 환경 변수를 검증해 `CloudPortOptions`를 반환한다. 해당 변수가 하나도 없으면 `undefined`를 반환한다.
- `[cloudflare-config.ts:loadCloudWorkflowChecks]` - `HIVEMIND_CLOUDFLARE_WORKFLOW_CHECKS`를 `codex`, `claude`, `integration` 검사로 파싱한다. 변수가 없으면 `undefined`를 반환한다.
- `[cloudflare-config.ts:configurationScope]` - `controlToken`을 제외한 설정의 SHA-256 해시를 반환한다.
- `[cloudflare-config.ts:configurationGitEnvironment]` - 전역·시스템 Git 설정을 끈 최소 환경 변수 집합을 반환한다.
- `[main.ts]` - 실행 진입점. `HIVEMIND_HOST`, `HIVEMIND_PORT`, `HIVEMIND_OPERATOR_TOKEN`, `HIVEMIND_WORKER_TOKEN`, `HIVEMIND_REPO_PATH`, `HIVEMIND_TEST_COMMAND`, `HIVEMIND_DB`를 읽는다.

`[app.ts:buildApp]`이 등록하는 HTTP 라우트는 다음과 같다.

| 라우트 | 인증 | 등록 조건 |
| --- | --- | --- |
| `GET /health`, `GET /favicon.ico` | 없음 | 항상 |
| `GET /`, `/app.js`, `/tool-audit.js`, `/charts.js`, `/monitor.js`, `/styles.css`, `/brand/hivemind-logo.png`, `/brand/hivemind-bee.png` | 없음 | 항상 |
| `GET /api/capabilities`, `GET /api/state`, `GET /api/monitor/snapshot` | 운영자 토큰 | 항상 |
| `POST /api/tasks`, `POST /api/tasks/:id/decision`, `POST /api/tasks/:id/cancel` | 운영자 토큰 | 항상 |
| `POST /api/cloudflare/tasks`, `POST /api/cloudflare/tasks/:id/decision`, `POST /api/cloudflare/tasks/:id/cancel` | 운영자 토큰 | `options.cloudflare`가 있을 때 |
| `POST /api/cloudflare/workflows`, `GET /api/cloudflare/workflows`, `POST /api/cloudflare/workflows/:id/approve`, `GET /api/cloudflare/workflows/:id`, `GET /api/cloudflare/workflows/:id/result` | 운영자 토큰 | `options.workflows`가 있을 때 |
| `POST /api/workers/register`, `POST /api/workers/claim` | 워커 토큰 | 항상 |
| `POST /api/tasks/:id/heartbeat`, `POST /api/tasks/:id/result`, `POST /api/tasks/:id/fail` | 워커 토큰 | 항상 |

- `[autonomous-api.ts:AutonomousOperation]`, `[autonomous-api.ts:AutonomousApiService]`, `[autonomous-api.ts:AutonomousTransactionalStore]`, `[autonomous-api.ts:createAutonomousApiService]`, `[autonomous-api.ts:executeAutonomousOperation]`, `[autonomous-api.ts:handleAutonomousApi]` - Web Request 기반 장기 작업 API와 트랜잭션 안의 중앙 정책 호출 경계다. `/v1/autonomous-tasks`와 하위 조회·승인·개정·중단·메시지·claim·native·heartbeat·finish·예약·정산·대사·재개를 처리한다.
- `[autonomous-cloud-proxy.ts:AutonomousCloudProxy]`, `[autonomous-cloud-proxy.ts:createAutonomousCloudProxy]`, `[autonomous-cloud-proxy.ts:validateAutonomousCloudRequest]`, `[autonomous-cloud-proxy.ts:projectAutonomousCloudResponse]` - 운영자 Cloudflare 경로를 검증·전달하고 응답을 허용 목록으로 재투영한다.
- `[autonomous-external-api.ts:createAutonomousExternalService]`, `[autonomous-external-api.ts:AutonomousExternalService]`, `[autonomous-external-api.ts:ExternalBridgeOptions]`, `[autonomous-external-api.ts:handleAutonomousExternalApi]`, `[autonomous-external-api.ts:ExternalApiOptions]` - 중앙 예약과 외부 broker 원장을 연결한다. artifact 게시, profile 검토·승인, 행동 실행·조회·복구·정리·비용 확인을 제공한다.
- `[autonomous-external-api.ts:ExternalPublicAction]`, `[autonomous-external-api.ts:ApprovedExternalTarget]`, `[autonomous-external-api.ts:ExternalProfileMetadata]`, `[autonomous-external-api.ts:ExternalBillingAttestation]` - 공개 승인 근거와 인간 비용 확인 입력이다.
- `[autonomous-external-large-api.ts:ExternalLargeApiOptions]`, `[autonomous-external-large-api.ts:ExternalLargeAuthority]` - 주입한 저장소·한도·권한 검사·manifest 저장 포트다. `part`는 binary 본문과 `x-large-meta`, 나머지는 JSON을 사용한다.

## 장기 자율 작업 연결 (2026-11-21 후속)

- `[autonomous-api.ts]`의 연산 `stopExternalBudget`(비용 초과 중단)과 `toolAuditScope`(lease 확인)는 서버 내부 연산이다. 이 연산을 직접 지정하는 HTTP 경로는 없다. 도구 감사 처리기는 내부 서비스의 `toolAuditScope`를 호출한다.
- `[autonomous-tool-audit-api.ts:handleToolAuditApi]` - `GET`(운영자)과 `POST`(reporter) `/v1/autonomous-tasks/:id/tool-calls`를 처리한다. `[app.ts:buildApp]`은 `handleAutonomousApi`보다 먼저 호출하며, lease 확인은 서비스의 `toolAuditScope`를 쓴다. 이 경로는 가드 훅이 아니라 처리기 안에서 인증한다. 기록은 워커 보고이며 독립 증명이 아니다.
- `[autonomous-cloud-proxy.ts]`는 운영자 `GET /api/cloudflare/autonomous-tasks/:id/tool-calls`를 원격 같은 경로로 전달하고 응답을 허용 목록으로 투영한다. 선택 필드 `counts.workerToolCalls`와 S3·HF 공개 범위 표시 필드를 통과시킨다.
- `[autonomous-external-api.ts]`는 S3(`aws.s3.put`, `aws.s3.inspect`)와 `hf.model.lfs_commit` 매개변수를 검증한다. `approvedTarget`에 S3 bucket·prefix와 HF `visibility`를 넣고, profile 메타데이터에 `hfVisibilityDisplay`를 넣어 공개 commit을 승인 시점에 드러낸다. `largeStore`가 연결된 경우 취소·revise 때 큰 파일 업로드를 모두 중단한다.
- `[autonomous-external-large-api.ts:handleExternalLargeApi]` - `external-large/{begin,part,complete,abort,manifest}`를 처리한다. `[autonomous-external-api.ts:handleAutonomousExternalApi]`가 먼저 위임하며, 큰 파일 저장소(`ExternalApiOptions.large`)가 연결되지 않았으면 503이다. 로컬 `[app.ts:buildApp]`은 이를 연결하지 않으므로 로컬에서는 항상 503이다.

## Invariants

- 운영자 토큰과 워커 토큰은 비어 있지 않고 서로 달라야 한다. 위반하면 `[app.ts:buildApp]`이 예외를 던진다.
- 토큰 비교는 `equalSecret`으로 수행하고, 불일치하면 401 `Unauthorized`를 반환한다 `[app.ts:guard]`.
- 기본 작업·워커 라우트와 워크플로 승인 라우트의 요청 본문 스키마는 `additionalProperties:false`이고 Ajv는 `coerceTypes:false`, `removeAdditional:false`로 동작한다. 정의하지 않은 필드나 타입이 다른 값은 거부한다 `[app.ts:body]`. `POST /api/cloudflare/workflows`는 스키마 없이 본문을 `workflows.draft`에 그대로 넘긴다.
- 워커 등록은 `runtime`이 `local`인 경우만 허용한다. `POST /api/cloudflare/tasks`는 `provider`가 `codex` 또는 `claude`이고 `runtime`이 `cloudflare`인 경우만 허용한다.
- `baseCommit`과 `headCommit`은 40자리 16진수여야 한다 `[app.ts:taskProperties]`, `[app.ts:executionProperties]`.
- 모든 응답에 `cache-control: no-store`, `x-content-type-options: nosniff`, `content-security-policy` 헤더를 붙인다 `[app.ts:buildApp]`의 `onRequest` 훅.
- 기본 라우트는 `DomainError`와 상태 코드가 500 미만인 오류만 메시지를 그대로 반환한다. 그 밖의 오류는 `Internal server error`로 바꾼다. 장기 작업 경로는 별도의 일반 오류 문구를 사용한다 `[app.ts:buildApp]`.
- `POST /api/workers/claim`은 배정할 작업이 없으면 JSON `null`을 명시적으로 보낸다.
- loopback이 아닌 host에 바인딩하려면 두 토큰이 모두 24자 이상이고 개발용 기본값이 아니어야 한다 `[main.ts]`.
- `HIVEMIND_CLOUDFLARE_URL`은 경로·쿼리·인증 정보가 없는 `https:` 원점이어야 한다. `CONTROL_TOKEN`과 `SECRETS_FILE`은 정확히 하나만 지정해야 한다 `[cloudflare-config.ts:loadCloudflareConfig]`.
- 비밀 파일은 심볼릭 링크가 아닌 일반 파일이고 권한이 `0600`이며 64000바이트 이하여야 한다 `[cloudflare-config.ts:readControlToken]`.
- 검사는 1-4개이고 각 검사는 `id`, `argv`, `timeoutMs` 세 필드만 가진다. `id`는 중복될 수 없고 `argv`는 제어 토큰 값을 포함할 수 없다 `[cloudflare-config.ts:parseChecks]`.
- `WORKTREE_ROOT`는 절대 경로이고 `REPO_PATH`와 달라야 한다. Codex와 Claude의 credential ID는 서로 달라야 한다.
- 설정 오류는 원인과 무관하게 `Invalid Cloudflare dashboard configuration.` 한 가지 메시지로만 드러난다. `[main.ts]`는 `startupErrors`에 있는 메시지만 출력하고 나머지는 `Unable to start HIVEMIND dashboard.`로 바꾼다.

- `[autonomous-api.ts:handleAutonomousApi]`는 운영자·워커·native reporter 권한을 구분한다. 공개 결과에서 token·native runtime·receipt를 제거하고 checkpoint는 claim/native-start의 워커 응답에만 허용한다. 내부 외부 정산 연산은 HTTP에서 직접 호출할 수 없다.
- `[autonomous-cloud-proxy.ts:createAutonomousCloudProxy]`는 HTTPS 원점만 사용한다. 요청은 65536바이트, 응답은 2MiB, 제한 시간은 5초다. 원격 오류·헤더·비밀을 그대로 전달하지 않는다. proxy가 없으면 `[app.ts:buildApp]`은 503을 반환한다.
- `[autonomous-external-api.ts:createAutonomousExternalService]`는 승인 revision·profile hash·설정 fingerprint와 native lease를 대조한다. 취소·개정 전에 영속 admission fence를 기록한다. 공급자 결과가 불명확하거나 live resource·미확정 비용이 남으면 중앙 예약을 해제하지 않는다.
- `[autonomous-external-api.ts:handleAutonomousExternalApi]`의 artifact·action은 워커 권한, 승인·복구·정리·billing은 운영자 권한이다. billing은 알려진 결과와 확인된 자원 부재가 있어야 하며 `operator_attested`와 공급자 측정을 구분한다.
- `[autonomous-external-large-api.ts:handleExternalLargeApi]`는 업로드마다 현재 권한을 검증한다. manifest는 해당 소유자의 검증 완료 파일을 열어 확인한 뒤 digest로 저장한다.

## Side Effects

- `HiveStore`로 SQLite 데이터베이스를 연다. `[app.ts:buildApp]`의 기본값은 `:memory:`이고 `[main.ts]`의 기본값은 `data/hivemind.sqlite`다. 앱을 닫을 때 `cloudflare`, `workflows`, `store` 순서로 닫는다.
- `apps/dashboard/public/`의 정적 파일을 요청마다 디스크에서 읽는다.
- `options.cloudflare`가 있으면 `onReady` 훅에서 `CloudControl.start()`를 호출한다.
- `[main.ts]`는 TCP 포트를 열고(기본 `127.0.0.1:4310`), `SIGINT`·`SIGTERM`에 앱을 닫으며, 시작에 실패하면 `process.exitCode`를 1로 설정한다.
- `[main.ts]`와 `[cloudflare-config.ts:loadCloudflareConfig]`는 `git rev-parse`를 자식 프로세스로 실행해 저장소 루트와 `HEAD` 커밋을 읽는다.
- `[cloudflare-config.ts:readControlToken]`은 비밀 파일을 읽는다.

- `[app.ts:buildApp]`은 별도 장기 작업 SQLite와 도구 감사 SQLite를 연다. 파일 DB의 도구 감사 경로는 `<dbPath>.tool-audit`이며 close 훅에서 닫는다.
- `[autonomous-api.ts:createAutonomousApiService]`는 저장 트랜잭션을 수행한다. `[autonomous-cloud-proxy.ts:createAutonomousCloudProxy]`는 원격 HTTP를 호출한다.
- `[autonomous-external-api.ts:createAutonomousExternalService]`는 주입한 broker·artifact publisher·manifest store·대형 파일 저장소를 호출하고 외부 행동 journal·grant·승인 fingerprint를 기록한다. 실제 공급자 I/O는 주입한 어댑터의 책임이다.

## Verification

- Run: `npm run check` (저장소 루트에서 실행한다. 테스트는 루트 `tests/` 디렉터리에 있다.)
