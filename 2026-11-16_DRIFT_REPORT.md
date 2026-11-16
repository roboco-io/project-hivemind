# EGM Drift Report (2026-11-16)

이 보고서는 2026-11-16에 `egm-bootstrap`으로 생성하거나 보완한 README 계약 문서와 같은 날의 소스 코드를 비교한 결과다. 대상은 `apps/`, `packages/`, `scripts/`의 README와 루트 `README.md`의 EGM 절이다.
README를 작성한 에이전트와 별개의 검토 에이전트가 각 README와 같은 디렉터리의 소스를 읽고 불일치만 기록했다. 일치하는 내용은 적지 않았다. 각 항목의 `파일:줄`은 검토 시점의 코드 위치다.
불일치는 두 종류다. README 문장이 코드와 다르게 적힌 항목은 보고서 작성 후 해당 README에서 고쳤다. README에 빠진 기본값, 한도, export, 부수 효과는 고치지 않았고, README에 어디까지 적을지는 사람이 정한다.

## apps/control-plane/src/README.md

- `POST /api/cloudflare/workflows`는 요청 본문 스키마가 없다 (`app.ts:76`). README는 "요청 본문 스키마는 `additionalProperties:false`"라고 일반화하지만, 이 라우트는 Ajv 검증 없이 `workflows.draft(request.body)`로 본문을 그대로 넘긴다.
- `GET /api/cloudflare/workflows/:id/result`의 쿼리 `?diff=1`이 README 라우트 표에 없다. 이 값이 `workflows.read(id,true,true)`로 diff 포함 여부를 정한다 (`app.ts:83-84`).
- `GET /health`가 `{status:'ok', mode}`를 반환하고 mode는 `hybrid-workers`, `cloudflare-bridge`, `local-workers`, `mock-local` 중 하나다 (`app.ts:54`). README는 응답 내용을 적지 않았다.
- `loadCloudflareConfig`의 기본값과 범위가 README에 없다.
  - `HIVEMIND_CLOUDFLARE_TIMEOUT_MS`는 기본 600000이고 범위는 1000-3600000이다 (`cloudflare-config.ts:29`, `cloudflare-config.ts:111`).
  - `CODEX_CREDENTIAL`과 `CLAUDE_CREDENTIAL`의 기본값은 각각 `codex-remote`와 `claude-remote`이고, 형식은 `^[A-Za-z0-9_-]{1,120}$`다 (`cloudflare-config.ts:107-108`).
  - `CHECKS`는 필수이고 JSON이어야 한다 (`cloudflare-config.ts:105`).
  - 환경 변수 값은 64000자 이하이고 `\0`, `\r`, `\n`을 포함할 수 없다 (`cloudflare-config.ts:25`).
  - 제어 토큰은 4096자 이하이고 공백·제어 문자를 포함할 수 없다 (`cloudflare-config.ts:88`).
- `loadCloudWorkflowChecks`는 변수가 있는데 `config`가 `undefined`이면 `undefined`를 반환하지 않고 예외를 던진다 (`cloudflare-config.ts:68-69`). 값은 키가 정확히 3개(`codex`, `claude`, `integration`)인 JSON 객체여야 하고, `codex`와 `claude`는 각각 1-4개 검사 배열이다. `integration`은 검사 1개이며 `parseChecks([...])[0]`으로 파싱한다 (`cloudflare-config.ts:72-75`). README는 "변수가 없으면 undefined"만 적었다.
- `loadCloudflareConfig`가 "변수가 하나도 없으면 undefined"를 반환하는 기준은 9개 이름(`URL`..`TIMEOUT_MS`)이다. `WORKFLOW_CHECKS`는 이 목록에 없다 (`cloudflare-config.ts:9`, `cloudflare-config.ts:81`). `WORKFLOW_CHECKS`만 설정하면 설정 로더는 `undefined`를 반환하고, 이어서 `loadCloudWorkflowChecks`가 예외를 던진다.
- 워크플로 제어는 `config`와 `checks`가 모두 있을 때만 만들어진다 (`main.ts:51-53`). README는 이 조건 대신 "`options.workflows`가 있을 때"만 적었다.
- `[main.ts]`는 `createCloudControl`, `createCloudWorkflowControl`로 같은 `dbPath`에 추가 저장소를 열고 `createCloudPort`, `createCloudWorkflowPort`를 만든다 (`main.ts:49-53`). README의 Side Effects에는 이 부분이 없다.
- `[main.ts]`는 `HIVEMIND_CLOUDFLARE_*` 환경 변수도 `loadCloudflareConfig`를 통해 읽는다 (`main.ts:48`). 그런데 README의 `[main.ts]` 항목은 읽는 변수로 `HIVEMIND_HOST` 등 7개만 나열한다.

## apps/dashboard/public/README.md

- `renderWorkers`는 `lastSeenAt`이 15000ms 이내이면 "연결됨", 아니면 "응답 확인 필요"로 표시한다 (`app.js:90-93`). 이 15초 기준이 README에 없다.
- `renderSelected`의 이벤트 목록이 README에 없다. 선택한 작업의 `state.events`를 `sequence` 내림차순으로 `JSON.stringify(event.data)`와 함께 표시한다 (`app.js:251-267`). 작업 목록 상단의 작업 수, 승인 대기 수, 확인된 비용 합계 표시(`app.js:52-57`)와 `connection-form` submit 핸들러(`app.js:301`)도 README에 없다.

## apps/mcp-server/src/README.md

- 토큰 파일 형식이 README에 없다. 파일은 JSON 객체여야 하고 문자열 `OPERATOR_TOKEN` 키가 필요하며 아니면 설정 오류다 (`server.ts:34-36`).
- `HIVEMIND_API_URL`의 기본값은 `http://127.0.0.1:4310`이고, 토큰이 없으면 `local-development-only`로 대체된다 (`server.ts:39-40`). README는 이를 적지 않았다.
- `redact` 키 목록이 README와 다르다. README는 "`token`·`api_key`·`password`·`secret` 형태의 키"라고 적었다. 실제 정규식은 `access_token`, `refresh_token`, `api_key`, `control_token`, `operator_token`, `authorization`, `password`, `secret`만 가린다 (`server.ts:70`). 접두사 없는 `token` 키는 가리지 않는다.
- 표의 `hivemind_get_workflow`는 `GET /api/cloudflare/workflows/:id`와 `/result`를 항상 호출하는 것처럼 보인다. 실제로 `/result`는 상태가 `SUCCEEDED` 또는 `FAILED`일 때만 호출하고, 그 외에는 첫 응답을 그대로 쓴다 (`server.ts:205-206`). `includeDiff`가 참이면 `?diff=1`을 붙인다.
- `hivemind_create_task`는 서버 capabilities의 `providers`에 요청한 provider가 없으면 실패한다 (`server.ts:162`). README의 실패 조건 목록에 이 조건이 없다.
- 입력과 출력 한도가 README에 없다.
  - `hivemind_list_tasks`의 `limit`은 1-20이고 기본값은 20이다 (`server.ts:155`).
  - `maxChars`는 1-20000이고 기본값은 12000이다 (`server.ts:170`, `server.ts:200-201`).
  - `reason`은 1-2000자다 (`server.ts:145`).
  - `hivemind_create_task`의 `instructions`는 10000자 이하이고 `title`은 160자 이하다 (`server.ts:160`).
  - stdio 전송은 `maxBufferSize: 64000`이고 `maxToolInputElements`는 128이다 (`main.ts:7`, `server.ts:79`).

## apps/worker/src/README.md

- 기본값이 README에 없다 (`config.ts:36-57`).
  - `HIVEMIND_API_URL`은 `http://127.0.0.1:4310`이다.
  - `HIVEMIND_WORKER_TOKEN`은 `local-worker-only`다.
  - `HIVEMIND_WORKER_ID`는 mock이면 `worker-local-1`, 아니면 `worker-<provider>-1`이다.
  - `HIVEMIND_WORKTREE_ROOT`는 `data/worktrees`다.
  - `HIVEMIND_TEST_COMMAND`는 `["npm","run","check"]`다.
  - `HIVEMIND_CODEX_BIN`은 `codex`, `HIVEMIND_CLAUDE_BIN`은 `claude`다.
  - `*_TIMEOUT_MS`는 600000, `HIVEMIND_TEST_TIMEOUT_MS`는 120000이다.
- README는 `HIVEMIND_CODEX_*`, `HIVEMIND_CLAUDE_*`를 모두 읽는다고 나열한다. 실제로는 선택된 provider의 접두사 변수만 읽는다 (`config.ts:47-56`). `mock`이면 `HIVEMIND_REPO_PATH`를 포함한 로컬 설정 변수를 전혀 읽지 않고 즉시 반환한다 (`config.ts:44`).
- 비어 있는 `HIVEMIND_TEST_COMMAND`와 `HIVEMIND_SETUP_COMMAND` 처리가 README에 없다. 빈 문자열이면 fallback을 쓰거나 무시한다 (`config.ts:25`, `config.ts:55`).
- `runOnce`는 `provider`가 `mock`이 아닐 때만 등록 본문에 `repositoryId`(기본 `local`)를 넣는다 (`worker.ts:36-39`). README에는 이 동작이 없다.

## apps/README.md

No drift detected

## apps/control-plane/README.md

No drift detected

## apps/dashboard/README.md

No drift detected

## apps/mcp-server/README.md

No drift detected

## apps/worker/README.md

No drift detected

## README.md (루트, EGM 절만)

- `Global Invariants` 첫 항목은 상태를 바꾸는 연산이 모두 `BEGIN IMMEDIATE` 트랜잭션에서 실행된다고 썼다. 그러나 `HiveStore.register`는 트랜잭션 없이 `workers`에 직접 쓴다 (`packages/core/src/store.ts:159-171`). `createCloudWorkflowControl.draft`의 `INSERT OR IGNORE`도 트랜잭션 밖이다 (`packages/core/src/cloud-workflow-store.ts:42`). 이 항목은 보고서 작성 후 루트 README에서 고쳤다.
- `Subdirectories & System Boundaries`의 packages 항목은 adapters가 contracts만 가져온다고 썼다. 정적 import는 맞다. 그러나 `createCloudPort`와 `createCloudWorkflowPort`는 `cloudflare/backend/src`의 모듈을 실행 시점에 동적으로 import한다 (`packages/adapters/src/cloudflare.ts:41-44`, `packages/adapters/src/cloud-workflow.ts:54`). 이 항목도 루트 README에서 고쳤다.

## packages/contracts/src/README.md

- `CloudPoll` 필드를 `terminal`, `success`, `cancelled`, `evidence`, `diff`로 나열한다. 실제 인터페이스에는 `phase`, `summary`, `diffTruncated`도 있고 `diff`는 `string | null`이다 (`cloudflare.ts:29-32`).
- `CloudTask`를 `provider`, `runtime`, `execution` 제약만 가진 `Task`로 설명한다. 실제로는 `remote: CloudEvidence`, `worktreePath`, `diffTruncated` 필드가 추가된다 (`cloudflare.ts:12-15`).

## packages/core/src/README.md

- README는 취소를 요청한 작업이 폴링 결과가 종료 상태이고 `containerStopped`가 참일 때만 `cancelled`가 된다고 쓴다. 코드에는 다른 경로가 있다.
  - 제출 전이고 `running`이 아닌 작업은 `cancel()`이 즉시 `cancelled`/`CANCELLED`로 바꾼다 (`cloudflare-store.ts:193-194`).
  - `prepare` 직후 `cancelRequested`이면 폴링 없이 `cancelled`가 된다 (`cloudflare-store.ts:117`).
  - `retryable: false`로 준비에 실패해도 `cancelRequested`이면 `cancelled`가 된다 (`cloudflare-store.ts:105`).
- README는 `verified`가 거짓이면 `failed`가 된다고 쓴다. 그러나 취소 요청이 없는 종료 폴링에서 `poll.cancelled && containerStopped`이면 `verified` 검사 전에 `cancelled`로 전이한다 (`cloudflare-store.ts:146`). `verified`는 `poll.success`와 `poll.phase === 'SUCCEEDED'`도 요구하는데 (`cloudflare-store.ts:28`) README의 조건 목록에는 없다.
- README는 상태를 바꾸는 모든 연산이 `HiveStore.tx` 안에서 실행된다고 쓴다. `register`는 `tx`를 쓰지 않는다 (`store.ts:159-171`). 입력 검증을 하는 `create`도 `tx` 밖에서 검증한 뒤 `tx`로 들어간다 (`store.ts:120-133`).
- README는 원격 멱등 키가 `scope`와 `requestId`의 SHA-256 해시라고 쓴다. 실제 키는 해시 앞에 `mcp-` 접두사가 붙는다 (`cloud-workflow-store.ts:38`).
- README는 `start`가 타이머만 등록한다고 쓴다. `start`는 즉시 `tick()`을 한 번 실행하고, 끝난 뒤에 타이머를 건다 (`cloudflare-store.ts:198`).
- `CONFIGURATION_CHANGED` 상태에서 설정이 원래대로 돌아오면 `errorCode`를 지우고 `remote.configuration_restored` 이벤트를 남기는 동작이 README에 없다 (`cloudflare-store.ts:93-95`).
- `assertPrivateSubmission`이 `spec`, `worktreePath`, `snapshot`이 없는 제출도 거부한다는 조건이 README에 없다 (`cloudflare-store.ts:40`).

## packages/adapters/src/README.md

- README는 `safeError`로 포트의 모든 실패가 같은 일반 메시지로 바뀐다고 쓴다. 생성자 검증 실패는 다른 메시지 `Invalid Cloudflare port configuration.`을 던진다 (`cloudflare.ts:38`). `connection()`은 던지지 않고 `unavailable`과 다른 메시지를 반환한다 (`cloudflare.ts:81`).
- README의 `read` 설명은 `SUCCEEDED`인데 통합 검증 근거가 불완전하면 오류를 던진다고만 쓴다. 이 검증과 diff 생성은 `result === true`이고 워크플로 상태가 `SUCCEEDED` 또는 `FAILED`일 때만 실행된다. 그 외에는 `resultReady: false`를 반환한다 (`cloud-workflow.ts:121`).
- Cloudflare 포트 Side Effects에는 `prepare`가 `worktreeRoot/<task.id>`에 worktree를 만들고 `.artifacts/<id>/home`을 만드는 동작이 없다 (`cloudflare.ts:90`, `cloudflare.ts:64`).
- `createCloudWorkflowPort`는 `cloudflare/backend/src`의 `client`, `files`, `snapshot` 모듈을 동적으로 import한다 (`cloud-workflow.ts:54`). README는 이 동적 import를 `createCloudPort`에서만 설명한다.
- Claude 어댑터 설명에는 아래 동작이 빠져 있다.
  - 출력이 1,000,000바이트를 넘어 `truncated`이면 `error`로 처리한다 (`claude.ts:32`).
  - JSON이 아니거나 결과 객체가 없어도 `error`로 처리한다 (`claude.ts:35-36`).
  - 플래그에 `--restricted`, `--safe-mode`, `--permission-mode acceptEdits`가 있다 (`claude.ts:28`).

## scripts/README.md

- README는 기존 TOML의 테이블 헤더나 키를 해석할 수 없으면 `Cannot safely inspect existing Codex configuration.` 오류로 실패한다고 쓴다. 이 오류는 테이블 헤더를 해석하지 못할 때만 난다 (`configure-hivemind-mcp.ts:57-58`). 할당문 키를 해석하지 못하면 `continue`로 건너뛴다 (`configure-hivemind-mcp.ts:61`).

## scripts/experiments/README.md

- `summarize_context_continuity.py`가 `evidence.json`에 `model` `claude-haiku-4-5-20251001`, `cli` `2.1.321`, `node` `24.14.0`, `order_seed` 20261111을 코드에 고정해 기록한다 (`summarize_context_continuity.py:208-221`). README는 `evidence.json`을 쓴다고만 쓰고 이 고정값을 적지 않았다. 이 값은 실제 실행 환경에서 읽은 값이 아니다.
- `context_continuity.py`는 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`을 세션 환경에 추가한다 (`context_continuity.py:79`). README의 환경 설명에는 환경 변수 제거만 있다.
- 조건 `C`의 네 세션은 `ThreadPoolExecutor(2)`로 최대 2개씩 동시에 실행된다 (`context_continuity.py:242`). README는 이 동시성을 적지 않았다.

## packages/README.md

No drift detected

## packages/contracts/README.md

No drift detected

## packages/core/README.md

No drift detected

## packages/adapters/README.md

No drift detected
