# worker/src

## Overview

로컬 워커 프로세스다. 관제 서비스에 자신을 등록하고, 승인된 작업을 하나 가져와 `AgentAdapter`로 실행한 뒤 결과나 실패를 보고한다. 관제 서비스와는 워커 토큰으로 인증하는 HTTP API로만 통신하며, 중앙 SQLite 파일을 열지 않는다. 실제 모델 실행은 `packages/adapters/src/index.ts`의 `getAdapter`가 반환하는 어댑터가 담당한다.

## Interface

- `[worker.ts:runOnce]` - 등록, 작업 가져오기, 실행, 보고를 한 번 수행한다. 작업을 처리했으면 `true`, 가져올 작업이 없으면 `false`를 반환한다.
- `[worker.ts:WorkerConfig]` - `apiUrl`, `workerId`, `workerToken`, `fetchImpl`, `heartbeatMs`, `adapter`, `provider`, `repositoryId`.
- `[config.ts:loadWorkerSettings]` - 환경 변수에서 `WorkerSettings`를 만든다.
- `[config.ts:WorkerSettings]`, `[config.ts:LocalWorkerSettings]` - 워커 설정과 `codex`·`claude` 제공자용 로컬 실행 설정.
- `[main.ts]` - 실행 진입점. `--once` 인자가 있으면 한 번만 실행하고, 없으면 2초 간격으로 반복한다.

`[config.ts:loadWorkerSettings]`가 읽는 환경 변수는 `HIVEMIND_PROVIDER`, `HIVEMIND_API_URL`, `HIVEMIND_WORKER_ID`, `HIVEMIND_WORKER_TOKEN`, `HIVEMIND_REPO_PATH`, `HIVEMIND_WORKTREE_ROOT`, `HIVEMIND_CODEX_BIN`, `HIVEMIND_CLAUDE_BIN`, `HIVEMIND_CODEX_MODEL`, `HIVEMIND_CLAUDE_MODEL`, `HIVEMIND_TEST_COMMAND`, `HIVEMIND_SETUP_COMMAND`, `HIVEMIND_CODEX_TIMEOUT_MS`, `HIVEMIND_CLAUDE_TIMEOUT_MS`, `HIVEMIND_TEST_TIMEOUT_MS`다. `mock`이면 `HIVEMIND_PROVIDER`, `HIVEMIND_API_URL`, `HIVEMIND_WORKER_ID`, `HIVEMIND_WORKER_TOKEN`만 읽는다. `codex`·`claude`이면 선택한 제공자의 `HIVEMIND_CODEX_*` 또는 `HIVEMIND_CLAUDE_*` 변수만 읽는다.

`[worker.ts:runOnce]`가 호출하는 관제 API는 `POST /api/workers/register`, `POST /api/workers/claim`, `POST /api/tasks/:id/heartbeat`, `POST /api/tasks/:id/result`, `POST /api/tasks/:id/fail`이다.

## Invariants

- `HIVEMIND_PROVIDER`는 `mock`, `codex`, `claude` 중 하나여야 하고 기본값은 `mock`이다 `[config.ts:loadWorkerSettings]`.
- `codex`·`claude` 워커는 `HIVEMIND_REPO_PATH`가 필요하다. `repositoryId`는 `local`로 고정된다.
- 명령 환경 변수는 JSON argv 배열이어야 한다. 항목은 1-32개이고 각 항목은 비어 있지 않은 1000자 이하 문자열이다 `[config.ts:command]`.
- 제한 시간은 1000-3600000 밀리초의 정수여야 한다 `[config.ts:timeout]`.
- `mock`이 아닌 제공자는 어댑터가 설정되어 있어야 한다. 설정된 어댑터의 `provider`는 워커의 `provider`와 같아야 하고, 배정된 작업의 `provider`와도 같아야 한다 `[worker.ts:runOnce]`.
- API URL은 `http:` 또는 `https:`여야 한다.
- 워커는 `runtime`을 항상 `local`로 등록한다.
- 작업을 실행하는 동안 `heartbeatMs`(기본 5000) 간격으로 heartbeat를 보낸다. heartbeat가 거부되거나 실패하면 실행을 중단한다 `[worker.ts:runOnce]`.
- 결과는 heartbeat 루프가 끝나고 중단 신호가 없을 때만 보고한다. 중단된 실행은 결과도 실패도 보고하지 않는다.
- 실패 보고는 최선 노력이다. 실패 메시지는 2000자로 자르며, 보고 요청이 거부되어도 원래 오류를 다시 던진다.

## Side Effects

- 관제 서비스로 HTTP `POST` 요청을 보낸다. 각 요청의 제한 시간은 15초다 `[worker.ts:runOnce]`.
- `adapter.execute`를 호출한다. 어댑터가 일으키는 부수 효과(worktree 생성, 모델 CLI 실행, 테스트 실행)는 `packages/adapters`의 계약에 속한다.
- `[main.ts]`는 진행 상황을 stdout·stderr에 쓰고, `SIGINT`·`SIGTERM`에 실행을 중단한다. `--once` 실행이 실패하면 `process.exitCode`를 1로 설정한다.

## Verification

- Run: `npm run check` (저장소 루트에서 실행한다. 테스트는 루트 `tests/` 디렉터리에 있다.)
