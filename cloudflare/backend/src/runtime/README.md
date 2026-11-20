# src/runtime

## Overview

이 폴더는 작업 컨테이너 안에서 실행하는 Linux 런타임이다.
`bootstrap.ts`는 컨테이너의 HTTP 서버로, Worker가 보낸 입력을 `/runtime`에 저장하고 상태와 결과를 돌려준다. `run.ts`는 입력을 읽어 snapshot을 복원하고 compute 명령 또는 공식 Codex·Claude Code CLI를 실행한 뒤 결과 파일을 쓴다.
나머지 파일은 실행 경계(sandbox 인자, Claude Bash 훅), 큰 입력과 캐시의 준비, 벤치마크 실행과 계측을 담당한다.
이 문서는 현재 코드가 정의한 내용을 기록한다. 원격 Linux에서의 실제 차단 여부는 별도 검증 문서로 확인한다.

## Interface

### 런타임 서버와 실행

- `[bootstrap.ts:createBootstrap]` - 런타임 HTTP 서버를 만든다. 경로는 `GET /health`, `POST /prepare`, `GET /state`, `GET /result`, `POST /cancel`, `GET /ralph/checkpoint`, `POST /ralph/feedback`이다.
- `bootstrap.ts` - 직접 실행하면 `createBootstrap()`의 서버가 `0.0.0.0:3000`에서 수신한다.
- `[run.ts:runFromFile]` - `input.json`을 읽고 `started.json`을 배타적으로 만든 뒤 실행하고 `result.json`을 쓴다. 이미 시작된 경우 `null`을 반환한다.
- `[run.ts:executeRuntime]` - 입력을 검증하고 compute 또는 agent 모드를 실행해 `RuntimeResult`를 반환한다.
- `[run.ts:checkRuntimeBoundary]`, `[run.ts:readRuntimeBoundary]` - `/proc/self/status`에서 권한 상태(`Cap*`, `NoNewPrivs`)를 읽어 판정한다.
- `[run.ts:RuntimeOptions]`, `[run.ts:RuntimeBoundary]` - 실행 옵션과 경계 판정 결과의 타입.
- `[providers.ts:validateRuntimeInput]` - agent·compute 입력의 허용 필드를 검증한다.
- `[providers.ts:providerArgs]` - Codex 또는 Claude CLI의 인자 목록을 만든다.
- `[providers.ts:claudeSettings]`, `[providers.ts:buildEnv]` - Claude 설정과 자식 프로세스의 허용 환경을 만든다.
- `[providers.ts:parseProviderResult]` - CLI의 JSON 출력을 성공 여부, 요약, 세션 ID, 사용량, receipt로 해석한다.
- `[process.ts:runProcess]` - 셸 없이 자식 프로세스를 별도 프로세스 그룹으로 실행하고 출력·시간을 제한한다.
- `[process-diagnostic.ts:sanitizeProcessStderr]`, `[process-diagnostic.ts:processDiagnostic]` - stderr를 정해진 오류 문구, 바이트 수, SHA-256으로 줄인다.
- `[ralph.ts:writeCheckpoint]`, `[ralph.ts:waitForFeedback]` - 반복 실행(Ralph)의 checkpoint를 쓰고 검증 feedback 파일을 기다린다.

### 실행 경계

- `[compute-sandbox.ts:computeSandboxArgs]` - compute 명령 앞에 붙이는 `codex sandbox` 인자를 만든다.
- `[claude-bash-hook.ts:bashHookReply]`, `[claude-bash-hook.ts:auditedBashHookReply]` - Claude의 PreToolUse Bash 이벤트를 검증하고 명령을 guard 경유로 바꾼다.
- `[claude-bash-hook.ts:sandboxReceipt]`, `[claude-bash-hook.ts:parseSandboxReceipts]` - 명령 해시를 담은 receipt를 만들고 감사 JSONL을 해석한다.
- `claude-bash-hook.ts` - 직접 실행하면 stdin의 JSON을 읽어 stdout에 응답을 쓴다. 실패하면 종료 코드 2다.
- `[claude-command-guard.ts:claudeGuardSandboxArgs]` - `sandbox`로 시작하고 운영용 `-c` 설정과 hivemind 프로필 `-c` 설정을 앞에 붙인 뒤 `-P hivemind -- /opt/hivemind/bin/namespace-guard -- <command>`가 이어지는 인자를 만든다. `codex` 실행 파일 이름은 포함하지 않는다.
- `claude-command-guard.ts` - 직접 실행할 때 인자는 `-- <command...>` 형식이다. 실패하면 종료 코드 125다.
- `[claude-guard-policy.ts:CLAUDE_GUARD_PATHS]`, `[claude-guard-policy.ts:claudeOuterSandboxSettings]`, `[claude-guard-policy.ts:filteredEnvironment]`, `[claude-guard-policy.ts:claudeGuardEnvironment]` - guard 경로, 바깥 sandbox 설정, 환경 변수 필터.

### 큰 입력과 캐시

- `[large-artifacts.ts:prepareLargeArtifacts]` - large artifact를 내려받아 길이와 SHA-256을 확인하고 `<directory>/ready`에 준비한다.
- `[large-artifacts.ts:extractTarArchive]` - `safe-tar.py`로 tar.gz를 새 디렉터리에 해제한다.
- `[safe-tar.py:main]` - 인자는 `--archive`, `--destination`, `--max-bytes`, `--max-files`, `--strip-components`, `--owner-token`이다. JSON 집계를 출력한다.
- `[duckdb-cache.ts:prepareDuckdbCache]` - `seed`·`cold`·`warm` 모드에 따라 컴파일 캐시 디렉터리를 준비한다.
- `[duckdb-cache-pack.py:main]` - 인자는 `cache archive compressed_limit expanded_limit entry_limit`이다. `{sizeBytes, sha256}`을 출력한다.
- `[npm-cache-archive.ts:archiveNpmCache]`, `[npm-cache-archive.ts:restoreNpmCache]`, `[npm-cache-archive.ts:downloadNpmCache]`, `[npm-cache-archive.ts:uploadNpmCache]` - npm `_cacache`를 `HVNC1` 형식으로 묶고 복원·전송한다.

### 벤치마크와 계측

- `[carbon-run.ts:runCarbon]` - `input.latency` 값에 따라 요청 재생, 캐시 재생, 고정 명령 재실행 또는 전체 벤치마크를 실행한다.
- `[carbon-run.ts:runNativeTerraBenchmark]`, `[carbon-run.ts:runNativeRealWorldReplay]`, `[carbon-run.ts:replayRealWorldCache]` - 컨테이너 밖 실행과 재생 경로.
- `[benchmark-resources.ts:measureBenchmarkResources]` - cgroup의 CPU 사용·스로틀링과 메모리 피크를 측정한다.
- `[bash-diagnostic.ts:classifyBash]`, `[bash-diagnostic.ts:bashDiagnostic]`, `[bash-diagnostic.ts:validBashDiagnostic]` - Bash 명령을 종류로 분류하고 실패를 정해진 문구로 요약한다.
- `[npm-benchmark-timing.ts:parseNpmBenchmarkTiming]`, `[npm-benchmark-timing.ts:readNpmBenchmarkTimings]` - npm timing 파일과 로그를 설치·빌드·타입 검사 시간으로 해석한다.
- `[terra-wire-replay.ts:replayTerraWire]`, `[terra-wire-replay.ts:wireReplayTurns]` - 고정 요청 26개를 SSE로 재생하고 턴별 시간과 토큰을 기록한다.
- `[pi-latency.mjs:piLatency]`, `[pi-tool-timing.mjs:piToolTiming]` - pi 확장(default export). 요청·도구 시간을 stderr의 `HIVEMIND_PI_*` 줄로 기록한다.
- `terra-transport.mjs` - export가 없는 preload 모듈. `globalThis.fetch`를 감싼다.

## Invariants

- 런타임 입력은 알 수 없는 필드를 거부한다. `version`은 1, `timeoutMs`는 1 이상 3,600,000 이하다. `[providers.ts:validateRuntimeInput]`
- compute 모드는 `provider`, `auth`, `instructions`를 받지 않는다. agent 모드는 `argv`를 받지 않는다. `[providers.ts:validateRuntimeInput]`
- agent와 compute 실행은 모두 Linux에서 모든 `Cap*` 값이 0이고 `NoNewPrivs`가 1일 때만 진행한다. `executeRuntime`을 `boundaryCheck` 없이 직접 호출하면 이 검사를 건너뛴다. `[run.ts:checkRuntimeBoundary]`, `[run.ts:executeRuntime]`
- `started.json`이 이미 있으면 다시 실행하지 않는다. `[run.ts:runFromFile]`
- compute 모드는 인증 환경 변수나 인증 파일이 있으면 중단한다. `[run.ts:executeRuntime]`
- 입력 snapshot에 인증 문자열이 들어 있으면 agent 입력을 거부한다. 결과의 인증·권한 문자열은 `[REDACTED]`로 바꾼다. `[run.ts:executeRuntime]`
- 반복 실행은 `maxRounds`(최대 4)를 넘지 않는다. 승인된 쓰기 경로 밖의 변경을 거부한다. `[providers.ts:validateRuntimeInput]`, `[run.ts:executeRuntime]`
- 자식 프로세스는 `shell:false`로 실행한다. 시간 초과·중단·출력 초과 시 SIGTERM을 보내고 1,500ms 후 SIGKILL을 보낸다. `[process.ts:runProcess]`
- `POST /prepare` 본문은 8MiB 이하다. 같은 입력의 재전송은 200, 다른 입력은 409다. `[bootstrap.ts:createBootstrap]`
- Ralph 경로는 `x-hivemind-ralph` 헤더가 준비된 토큰과 같아야 한다. 아니면 403이다. `[bootstrap.ts:createBootstrap]`
- Bash 훅은 `tool_name`이 `Bash`이고 명령이 65,536바이트 이하이며 `dangerouslyDisableSandbox`가 없거나 false일 때만 응답한다. `[claude-bash-hook.ts:bashHookReply]`
- guard 명령은 인자 1-64개, 합계 262,144바이트 이하다. `[claude-command-guard.ts:claudeGuardSandboxArgs]`
- 환경 필터는 `CLAUDE_CODE_OAUTH_TOKEN`, `CONTROL_TOKEN`, `AUTH_STORAGE_KEY`, `AUTH_RETURN_PRIVATE_KEY`, `NODE_OPTIONS`, `LD_PRELOAD` 등과 `OPENAI_`, `ANTHROPIC_`, `CLOUDFLARE_`, `AWS_`, `CODEX_` 접두 변수를 제거한다. `[claude-guard-policy.ts:filteredEnvironment]`
- sandbox 경로는 절대 경로이고 `..`가 없으며 중복이 없어야 한다. `[compute-sandbox.ts:computeSandboxArgs]`
- large artifact 다운로드는 상태 200, `content-length`와 선언 크기의 일치, SHA-256 일치를 요구한다. `[large-artifacts.ts:prepareLargeArtifacts]`
- tar 해제는 일반 파일과 디렉터리만 받는다. 링크·장치, 경로 탈출, 대소문자만 다른 중복 경로를 거부한다. 상한은 2GiB, 100,000파일이다. `[safe-tar.py:extract]`, `[safe-tar.py:safe_path]`
- DuckDB 캐시의 공개는 `seed` 모드에서만 허용한다. `[duckdb-cache.ts:prepareDuckdbCache]`
- npm 캐시 묶음은 `HVNC1`로 시작하고 항목 4,096개 이하이며 모든 항목을 쓰기 전에 검증한다. `[npm-cache-archive.ts:restoreNpmCache]`
- 요청 재생은 본문 26개가 정확히 있어야 한다. `[terra-wire-replay.ts:replayTerraWire]`

## Side Effects

- 파일: `/runtime`에 `input.json`, `started.json`, `result.json`, `ralph.json`, feedback 파일, `cancel` 파일을 읽고 쓴다. `[bootstrap.ts:createBootstrap]`, `[run.ts:runFromFile]`, `[ralph.ts:writeCheckpoint]`
- 파일: snapshot을 `/workspace`에 복원한다. 홈 디렉터리에 CLI 인증 파일과 설정 파일을 쓴다. `[run.ts:executeRuntime]`
- 파일: Bash 훅이 감사 기록 `bash-guards.jsonl`에 추가한다. `[claude-bash-hook.ts:appendAudit]`
- 프로세스: `codex`, `claude`, compute 명령, `python3`(`safe-tar.py`, `duckdb-cache-pack.py`)를 실행한다. `[run.ts:executeRuntime]`, `[large-artifacts.ts:extractTarArchive]`, `[duckdb-cache.ts:prepareDuckdbCache]`
- 프로세스: 벤치마크가 `git`, `npm`, `node`, `pi`, `hurl`, `bwrap`를 실행하고 채점용 서버를 시작·종료한다. `[carbon-run.ts:runCarbon]`
- 프로세스: guard가 `execve`로 `/usr/local/bin/codex`를 실행한다. `claude-command-guard.ts`
- 네트워크: 런타임 서버가 포트 3000을 연다. `[bootstrap.ts:createBootstrap]`
- 네트워크: large artifact, DuckDB 캐시, npm 캐시를 bearer 권한으로 요청한다. 대상은 Worker의 outbound 진입점이 처리하는 `.invalid` 원점이다. `[large-artifacts.ts:prepareLargeArtifacts]`, `[duckdb-cache.ts:prepareDuckdbCache]`, `[npm-cache-archive.ts:downloadNpmCache]`, `[npm-cache-archive.ts:uploadNpmCache]`
- 네트워크: 벤치마크가 모델 게이트웨이, GitHub, npm registry를 호출한다. `[carbon-run.ts:runCarbon]`, `[terra-wire-replay.ts:replayTerraWire]`
- 환경: `terra-transport.mjs`가 `HIVEMIND_TERRA_CAPABILITY`, `HIVEMIND_TERRA_PROBE`를 읽은 뒤 삭제하고, `NODE_OPTIONS`는 읽지 않고 삭제만 한다.
- 시스템 읽기: `/proc/self/status`, `/proc/self/cgroup`, `/sys/fs/cgroup`을 읽는다. `[run.ts:readRuntimeBoundary]`, `[benchmark-resources.ts:measureBenchmarkResources]`

## Verification

- Run: `npm test` (`cloudflare/backend/`에서 실행. `node --test test/*.test.ts`)
- Run: `npm run typecheck` (`cloudflare/backend/`에서 실행. `tsc --noEmit`)
- 이 폴더의 `.ts`, `.mjs`, `.py` 파일을 바꾸면 `runtime-build.json`의 `digest`가 달라진다. `npm run runtime:check`로 확인한다.
