# core/src

## Overview

이 디렉터리는 HIVEMIND의 중앙 core다. 승인, 취소, 비용 정책과 작업 상태 전이를 이곳에서 결정하고 SQLite(`node:sqlite`의 `DatabaseSync`)에 저장한다. 프로젝트 규칙은 UI와 모델 어댑터가 이 정책을 우회하지 못하게 하고, 워커가 SQLite 파일을 직접 열지 않고 HTTP API만 쓰도록 정한다.

파일은 실행 경로별로 나뉜다. `store.ts`는 로컬 워커가 claim하는 작업을 관리한다. `cloudflare-store.ts`는 Cloudflare 런타임으로 보내는 작업을 관리하고, 원격 호출은 주입받은 `CloudPort`에 맡긴다. `cloud-workflow-store.ts`는 Codex와 Claude가 함께 수행하는 워크플로의 등록 정보를 관리하고, 원격 호출은 주입받은 `CloudWorkflowPort`에 맡긴다. 계약 타입은 [`../../contracts/src/README.md`](../../contracts/src/README.md)에 있다.

## Interface

`store.ts`:

- `[store.ts:DomainError]`: `statusCode`(기본값 409)를 가진 오류. 검증 실패와 상태 충돌을 호출자에게 알린다.
- `[store.ts:ESTIMATE_MICROS]`: mock 작업의 예상 비용 상수 `1000`.
- `[store.ts:text]`, `[store.ts:money]`: 문자열과 금액 검증 함수. 실패하면 `DomainError`(400)를 던진다. `money`는 0 이상 1,000,000,000 이하의 안전한 정수만 허용한다.
- `[store.ts:equalSecret]`: `timingSafeEqual`로 두 비밀 값을 비교한다.
- `[store.ts:HiveStore]`: 로컬 작업 저장소. 생성자 인자는 `path`(기본값 `:memory:`), `now`, `repository`다.
  - `create(input)`: 작업을 `awaiting_execution_approval` 상태로 만든다.
  - `decision(id, decision, reason)`: `approve` 또는 `reject`를 기록한다.
  - `register(id, provider, runtime, repositoryId)`: 워커를 등록하거나 갱신한다.
  - `claim(id)`: 워커에게 `queued` 작업 하나를 배정하고 `Lease`를 반환한다. 배정할 작업이 없으면 `null`을 반환한다.
  - `heartbeat(id, worker, token)`, `result(id, worker, token, result)`, `fail(id, worker, token, message)`: 유효한 lease를 가진 워커만 호출할 수 있다.
  - `cancel(id, reason)`, `expire()`, `state()`, `close()`.

`cloudflare-store.ts`:

- `[cloudflare-store.ts:CloudControlOptions]`: `dbPath`, `policy`, `port`, `pollIntervalMs`(기본값 2000), `executionScope`.
- `[cloudflare-store.ts:createCloudControl]`: `CloudControl`을 반환한다. `capabilities`, `state`, `create`, `decision`, `cancel`, `tick`, `start`, `close`를 제공한다.

`cloud-workflow-store.ts`:

- `[cloud-workflow-store.ts:createCloudWorkflowControl]`: `(dbPath, scope, port)`를 받아 `CloudWorkflowControl`을 반환한다. `draft`, `approve`, `list`, `read`, `close`를 제공한다.

## Invariants

로컬 작업 (`store.ts`):

- 상태를 바꾸는 연산은 `register`를 제외하고 `[store.ts:HiveStore.tx]`의 `BEGIN IMMEDIATE` 트랜잭션 안에서 실행한다. `register`는 트랜잭션 없이 `workers`에 쓰고, `create`는 입력 검증을 트랜잭션 밖에서 한다. 오류가 나면 `ROLLBACK`한다.
- `[store.ts:HiveStore.create]`는 `runtime`이 `local`일 때만 작업을 만든다. `codex`와 `claude` 작업은 `repositoryId`, `baseCommit`, `testProfile`이 생성자에 전달된 `RepositoryPolicy`와 모두 같아야 한다. mock 작업은 저장소를 선택할 수 없고, 예산이 `ESTIMATE_MICROS` 이상이어야 한다.
- `[store.ts:HiveStore.decision]`은 `awaiting_execution_approval` 또는 `awaiting_review` 상태에서만 동작한다. `reject`는 `rejected`로, 실행 승인은 `queued`로, 검토 승인은 `completed`로 전이한다.
- `[store.ts:HiveStore.claim]`은 lease를 30000ms로 설정한다. 이미 `running` 작업을 가진 워커에게는 새 작업을 주지 않는다. 워커의 `provider`, `runtime`, `repositoryId`가 작업과 맞아야 한다.
- `[store.ts:HiveStore.running]`은 작업이 `running`이고, lease가 만료되지 않았고, `workerId`가 같고, `lease_token`이 `equalSecret` 비교를 통과할 때만 작업을 반환한다.
- `[store.ts:HiveStore.expire]`는 lease가 만료된 `running` 작업을 `failed`로 바꾼다. 자동 재시도는 하지 않으며 요약에 수동 재제출이 필요하다고 기록한다.
- `[store.ts:HiveStore.result]`에서 `codex`와 `claude` 작업의 `actualCostMicros`는 반드시 `null`이다. 실행 근거의 `repositoryId`, `baseCommit`, `tests.command`가 승인된 작업의 값과 같아야 한다. 근거가 `succeeded`인데 에이전트, 설정, 테스트 프로세스가 모두 통과하지 않았거나 `headCommit`이 `baseCommit`과 다르면 거부한다.
- `[store.ts:HiveStore.result]`에서 mock 작업은 실제 실행 근거를 포함할 수 없다. 비용이 `budgetMicros`를 넘으면 `failed`로 전이하고 `budget.exceeded` 이벤트를 남긴다.
- `[store.ts:processStatus]`는 상태와 `exitCode`가 모순되면 거부한다. `passed`는 `exitCode`가 0이어야 하고, `failed`는 0이 아닌 값이어야 하고, `not_run`은 `null`이어야 한다.
- `[store.ts:HiveStore.cancel]`은 `completed`, `rejected`, `cancelled`, `failed` 상태의 작업을 취소하지 않는다.
- `[store.ts:HiveStore.register]`는 `running` 작업을 가진 워커의 `provider`, `runtime`, `repositoryId` 변경을 거부한다.

Cloudflare 작업 (`cloudflare-store.ts`):

- `[cloudflare-store.ts:createCloudControl]`의 `create`는 연결 상태가 `ready`일 때만 동작한다. 허용 목록 `[cloudflare-store.ts:allowedInput]`에 없는 필드가 있으면 거부한다. `provider`는 `codex` 또는 `claude`, `runtime`은 `cloudflare`여야 하며, 저장소 값은 `policy`와 같아야 한다.
- `executionScope`는 `policy`의 SHA-256 해시(기본값)다. 작업을 만든 뒤 이 값이 바뀌면 `decision`은 실행 승인을 거부하고, `[cloudflare-store.ts:dispatch]`는 `errorCode`를 `CONFIGURATION_CHANGED`로 기록한다. 아직 제출하지 않은 작업은 `failed`로 전이한다.
- `[cloudflare-store.ts:assertPrivateSubmission]`은 `port.prepare`가 반환한 제출 데이터에 `authorization`, `headers`, `controlToken`, `access_token`, `refresh_token`, `apiKey`, `password`, `secret`, `credentials` 키가 있으면 재시도 불가 오류로 거부한다. 자격 증명의 ID만 저장할 수 있다.
- `[cloudflare-store.ts:dispatch]`는 제출 데이터를 먼저 저장한 다음 `port.submit`을 호출한다. 전달 여부가 불확실하면 저장된 제출 데이터를 그대로 다시 보낸다.
- `[cloudflare-store.ts:verified]`가 참일 때만 작업이 `awaiting_review`로 전이한다. 조건은 `phase`가 `SUCCEEDED`, `authSynced`와 `containerStopped`가 참, 에이전트 프로세스가 `passed`이고 `exitCode`가 0, 검사가 1개 이상이며 모든 검사가 통과하고 `credentialsAbsent`와 `sourceUnchanged`가 `true`인 것이다. 그렇지 않으면 `failed`다. 단 취소 요청이 없는 종료 폴링에서 `poll.cancelled`이고 `containerStopped`가 참이면 `verified`를 확인하기 전에 `cancelled`가 된다.
- 제출 이후 취소를 요청한 작업은 폴링 결과가 종료 상태이고 `containerStopped`가 참일 때 `cancelled`가 된다. 그 전에는 `running` 상태와 `CANCELLING` 단계를 유지한다. 제출 전이고 `running`이 아닌 작업은 `cancel()`이 즉시 `cancelled`로 바꾸고, `port.prepare` 직후 또는 `retryable:false` 준비 실패 때 `cancelRequested`이면 폴링 없이 `cancelled`가 된다.
- `[cloudflare-store.ts:safe]`는 저장하기 전에 `Bearer` 토큰과 `api_key`, `password`, `secret` 같은 키의 값을 `[REDACTED]`로 바꾼다. `diff`는 180000자, `summary`는 12000자로 자른다.
- `[cloudflare-store.ts:cycle]`은 `ready` 확인 결과를 프로세스 메모리에만 30000ms 동안 보관한다. 서버를 다시 시작하면 저장된 `ready` 상태가 있어도 연결을 다시 확인한다.
- `[cloudflare-store.ts:tick]`은 진행 중인 주기가 있으면 같은 Promise를 반환한다. `close`는 진행 중인 주기가 끝난 뒤 데이터베이스를 닫는다.

워크플로 (`cloud-workflow-store.ts`):

- `draft`는 `workflowDraft` 검증에 실패하면 400을 던진다. 같은 `scope`와 `requestId`로 내용이 다른 초안을 보내면 409를 던진다. 내용이 같으면 원격에 새로 만들지 않고 저장된 등록 정보와 현재 상태를 반환한다.
- `draft`는 원격 멱등 키를 `mcp-` 접두사에 `scope`와 `requestId`의 SHA-256 해시를 붙여 만든다.
- `approve`는 요청의 `contractHash`가 등록된 값과 다르면 409를 던진다.
- `[cloud-workflow-store.ts:find]`는 현재 `scope`에 등록된 워크플로만 찾는다. 다른 `scope`의 워크플로는 404다. `list`는 최대 20건을 반환한다.

## Side Effects

- `[store.ts:HiveStore]` 생성자는 `path`의 상위 디렉터리를 만들고 SQLite 파일을 연다. `journal_mode=WAL`과 `busy_timeout=5000`을 설정하고 `tasks`, `workers`, `events` 테이블을 만든다.
- `[cloudflare-store.ts:createCloudControl]`은 `dbPath`의 상위 디렉터리를 만들고, 파일 권한을 `0o600`으로 바꾸고, `cloud_tasks`, `cloud_events`, `cloud_metadata` 테이블을 만든다. `cloud_tasks`에 `execution_scope` 열이 없으면 `ALTER TABLE`로 추가한다.
- `[cloud-workflow-store.ts:createCloudWorkflowControl]`은 `dbPath`의 SQLite 파일을 열고 `cloud_workflows` 테이블을 만든다.
- `[cloudflare-store.ts:dispatch]`는 주입받은 `CloudPort`의 `prepare`, `submit`, `poll`, `cancel`을 호출한다. 실제 네트워크 호출과 worktree 작업은 포트 구현이 수행한다. 구현은 [`../../adapters/src/README.md`](../../adapters/src/README.md)에 있다.
- `[cloudflare-store.ts:createCloudControl]`의 `start`는 `pollIntervalMs` 간격의 `setTimeout` 타이머를 등록한다. 타이머는 `unref`되어 프로세스 종료를 막지 않는다.
- `cloud-workflow-store.ts`의 `draft`, `approve`, `read`는 주입받은 `CloudWorkflowPort`를 호출한다.
- 이벤트 조회(`[store.ts:HiveStore.state]`와 `CloudControl.state`)는 최근 200건만 반환한다.

## Verification

- Run: `npm run check` (저장소 루트에서 실행한다. `tsc --noEmit` 다음에 `npm test`를 실행한다. 테스트는 루트의 `tests/` 디렉터리에 있다.)

## 장기 자율 작업 정책

`autonomous.ts`의 AutonomousEngine은 주입한 시각으로 승인·기간·예산·lease·대기·정리를 검사한다. `autonomous-store.ts`는 별도 SQLite 테이블의 트랜잭션으로 상태를 보존한다. 비공개 snapshot은 공개 응답에 쓰지 않는다. 원격 상태는 Cloudflare Durable Object에만 보존하며 기존 모델 스케줄러에 자동 제출하지 않는다. [실행 경계와 API](../../../docs/autonomous-tasks.md)를 참고한다.

`nativeStart`는 유효한 native lease를 runtime 하나에 결속하고 정규 정책·체크포인트·deadline을 반환한다. 같은 lease를 다른 runtime에서 시작할 수 없다. native 작업 간 credential ID가 겹치면 lease 또는 미대사 실행이 남은 동안 claim을 차단한다. 비용이 null인 계속 실행 결과는 비용 대사 후 명시적으로 재개해야 한다. complete·failed는 stopping에서 종료 의도를 보존하고 비용·행동·정리 대사 후 추가 실행 없이 종료한다.
