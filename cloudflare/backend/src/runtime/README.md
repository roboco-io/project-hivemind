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

### 장기 실행과 승인 연결

- `autonomous-bootstrap.ts:createAutonomousBootstrap`은 bearer 인증을 검사하는 `POST /iteration` 서버를 만든다. 기본 listen 주소는 loopback이며 직접 실행 시 `HIVEMIND_AUTONOMOUS_RUNTIME_*` 설정을 사용한다.
- `autonomous-bootstrap-routes.ts:handleAutonomousBootstrap`은 기존 서버에 `/autonomous/prepare`, `/autonomous/state`, `/autonomous/result`, `/autonomous/cancel`을 연결한다. `HIVEMIND_NATIVE_GATE_TOKEN`과 `x-hivemind-native`를 비교한다.
- `autonomous-from-file.ts:NATIVE_FILES`, `readNativePrivate`, `writeNativePrivate`, `nativeResultReady`, `runAutonomousFromFile`은 배타적 실행 시작과 불변 결과 파일·완료 marker를 관리한다.
- `autonomous-authorize.ts:NativeAuthorizer`, `nativeExecutionLease`, `guardCanonicalNativePolicy`, `createNativeHttpAuthorizer`, `nativeAuthorizerFromEnvironment`는 중앙의 `native-start`·heartbeat와 요청의 승인 정책을 대조한다.
- `autonomous-reporter.ts:NativeReporter`, `createNativeHttpReporter`, `nativeReporterFromEnvironment`는 `native-ready`·`native-receipt`를 별도 reporter 토큰으로 보낸다.
- `autonomous-claude.ts:verifyAutonomousPrerequisiteFiles`, `executeAutonomousClaude`는 관리 훅·CLI 설치 경계 확인 후 한 반복을 실행한다. 물리 경로·프로세스 대체는 신뢰된 합성 테스트 옵션이다.
- `autonomous-session.ts:AutonomousSessionBundle`, `validateAutonomousSession`, `collectAutonomousSession`, `restoreAutonomousSession`, `autonomousProjectDirectory`, `sessionUUID`, `rejectSessionSecrets`는 작업 snapshot과 부모·자식 transcript를 비공개 세션 묶음으로 처리한다.
- `autonomous-tool-hook.ts:AUTONOMOUS_POLICY`, `validateAutonomousPolicy`, `loadAutonomousPolicy`, `autonomousToolGate`는 고정 모델·도구·웹 호스트·외부 프로필 정책을 읽고 도구 입력을 검사한다.
- `autonomous-quota.ts:parseClaudeQuota`는 구조화된 `rate_limit_event`를 현재 세션·종료 시각과 대조한다. 이 함수만으로 재시도를 승인하지 않는다.
- `autonomous-web.ts:validateWebHosts`, `approveAutonomousWeb`, `dispatchAutonomousWeb`, `validateAutonomousWebGrant`는 서버 상한 안의 웹 허용 범위를 검사한다. `autonomous-web-transport.ts:createAutonomousWebTransport`는 DNS-over-HTTPS 확인 후 검증된 IP에 TLS로 직접 연결한다.
- `autonomous-boundary-probe.ts:runAutonomousBoundaryProbe`, `runBoundaryProbeChild`, `boundaryProbeArgs`, `boundaryParentAuthAbsent`, `boundaryProbeEnvironment`, `boundaryProbeCanaryEnvironment`, `cleanupBoundaryFixtures`는 실제 인증 전달 전 고정 무모델 경계 검사를 수행하고 직접 만든 fixture만 정리한다.
- `autonomous-action-mcp.ts:readActionPrivateInput`, `createActionTool`, `createActionMcpServer`, `createAutonomousActionMcpConfig`, `startActionMcpStdio`, `main`은 비공개 입력과 모델용 `action` 도구를 분리한다. `main` 인자는 `--private-input PATH`다.

### 실행 경계

- `claude-command-guard.ts:guardTraceMetadata`는 명령 해시·프로세스·환경변수 이름의 제한된 진단 metadata를 만든다. 선택적 trace 기록은 guard 판정을 바꾸지 않는다.
- `[compute-sandbox.ts:computeSandboxArgs]` - compute 명령 앞에 붙이는 `codex sandbox` 인자를 만든다.
- `[claude-bash-hook.ts:bashHookReply]`, `[claude-bash-hook.ts:auditedBashHookReply]` - Claude의 PreToolUse Bash 이벤트를 검증하고 명령을 guard 경유로 바꾼다.
- `[claude-bash-hook.ts:sandboxReceipt]`, `[claude-bash-hook.ts:parseSandboxReceipts]` - 명령 해시를 담은 receipt를 만들고 감사 JSONL을 해석한다.
- `claude-bash-hook.ts` - 직접 실행하면 stdin의 JSON을 읽어 stdout에 응답을 쓴다. 실패하면 종료 코드 2다.
- `[claude-command-guard.ts:claudeGuardSandboxArgs]` - `sandbox`로 시작하고 운영용 `-c` 설정과 hivemind 프로필 `-c` 설정을 앞에 붙인 뒤 `-P hivemind -- /opt/hivemind/bin/namespace-guard -- <command>`가 이어지는 인자를 만든다. `codex` 실행 파일 이름은 포함하지 않는다.
- `claude-command-guard.ts` - 직접 실행할 때 인자는 `-- <command...>` 형식이다. 실패하면 종료 코드 125다.
- `[claude-guard-policy.ts:CLAUDE_GUARD_PATHS]`, `[claude-guard-policy.ts:claudeOuterSandboxSettings]`, `[claude-guard-policy.ts:filteredEnvironment]`, `[claude-guard-policy.ts:claudeGuardEnvironment]` - guard 경로, 바깥 sandbox 설정, 환경 변수 필터.

### 자율 작업의 도구 호출 기록과 대형 업로드

- `[tool-audit-hook.ts:recordToolAuditEvent]` - `PreToolUse`, `PostToolUse`, `PostToolUseFailure` 이벤트를 spool 한 줄로 바꿔 추가한다. 이벤트 이름은 `argv[2]`로 받는다. `PreToolUse`는 spool을 쓸 수 없으면 실패해 도구를 막고, Post 이벤트는 도구를 막지 않는다.
- `[tool-audit-spool.ts:foldToolAuditSpool]`, `[tool-audit-redact.ts:summarizeToolInput]` - spool을 레코드로 접고, 입력을 가린 요약과 가리기 전 입력의 digest로 줄인다.
- `tool-audit-redact.ts:TOOL_AUDIT_LIMITS`, `ToolAuditRecord`, `redactText`, `truncateSummary`는 기록 한도·형태·비밀 가리기·UTF-8 요약 절단을 정의한다. `tool-audit-hook.ts:secretsFromEnvironment`는 이름 패턴에 맞는 환경값을 반환하며 자체 기록하지 않는다.
- `tool-audit-spool.ts:appendToolAuditLine`은 시작·종료·drop 줄을 추가한다. `tool-audit-reporter.ts:ToolAuditSequenceError`는 서버가 알려 준 다음 sequence를 전달한다.
- `[tool-audit-reporter.ts:shipToolAudit]` - 레코드를 묶어 `POST /v1/autonomous-tasks/{id}/tool-calls`로 보낸다. 토큰은 reporter 토큰이다.
- `[autonomous-claude.ts:executeAutonomousClaude]` - heartbeat마다 그리고 최종 receipt 전에 spool을 읽어 보낸다. 구독 작업과 비구독 작업 모두 해당한다. 아직 `allowed`이고 `durationMs`가 null인 레코드는 다음 전송까지 보류하고 그 뒤 sequence도 함께 보류한다. 최종 전송은 모두 보낸다. spool은 줄이거나 다시 쓰지 않는다. 전송 실패는 반복을 실패시키지 않는다.
- `[autonomous-action-mcp.ts:createActionTool]` - `aws.s3.put`, `aws.s3.inspect`, `hf.model.lfs_commit`을 추가로 받는다. `hf.model.lfs_commit`은 `largeArtifact.paths`(작업 공간 안 상대 경로)와 `parameters.manifestDigest` 중 정확히 하나를 받는다. 결과에는 S3 객체 위치를 싣지 않는다.
- `[autonomous-large-upload.ts:uploadWorkspaceFiles]` - 파일을 8MiB part로 나눠 올리고 manifest digest를 반환한다. part 번호는 1부터다. 저장된 part는 건너뛰어 재개한다.
- `[autonomous-large-upload.ts:createLargePost]` - 위 업로드의 HTTP 연결부. JSON 단계는 본문에 lease, runtimeId, profileId를 싣고, part 요청은 같은 값을 `x-large-meta` 헤더의 JSON으로 싣는다.

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
- large artifact 다운로드는 상태 200, 실제 길이·SHA-256과 선언값의 일치를 요구한다. `content-length`가 있으면 그 값도 선언 크기와 같아야 한다. `[large-artifacts.ts:prepareLargeArtifacts]`
- tar 해제는 일반 파일과 디렉터리만 받는다. 링크·장치, 경로 탈출, 대소문자만 다른 중복 경로를 거부한다. 상한은 2GiB, 100,000파일이다. `[safe-tar.py:extract]`, `[safe-tar.py:safe_path]`
- DuckDB 캐시의 공개는 `seed` 모드에서만 허용한다. `[duckdb-cache.ts:prepareDuckdbCache]`
- npm 캐시 묶음은 `HVNC1`로 시작하고 항목 4,096개 이하이며 모든 항목을 쓰기 전에 검증한다. `[npm-cache-archive.ts:restoreNpmCache]`
- 요청 재생은 본문 26개가 정확히 있어야 한다. `[terra-wire-replay.ts:replayTerraWire]`

- 도구 호출 기록의 spool은 `/home/node/.hivemind-phase0/tool-audit.jsonl`이고 상한은 8MiB다. 가득 차면 버린 수를 기록하고 도구는 계속 실행한다. 이 기록은 워커가 보고한 값이며 독립 증명이 아니다. `[tool-audit-spool.ts:appendToolAuditLine]`
- 대형 업로드는 상대 경로만 받고 symlink, hard link, 작업 공간 밖 경로, 빈 파일을 거부한다. 한 번의 도구 호출이 시간 제한에 걸리면 같은 호출을 다시 보내 이어서 올린다. `[autonomous-large-upload.ts:uploadWorkspaceFiles]`

### 장기 실행 불변식

- `autonomous-from-file.ts:runAutonomousFromFile`은 기존 시작 파일을 재실행하지 않는다. 결과를 fsync한 뒤 빈 0600 완료 marker를 만들며 공개키는 RSA 2048비트 이상이어야 한다. `readNativePrivate`는 단일 링크·0600 일반 파일과 읽는 동안의 파일 identity를 검사한다.
- `autonomous-authorize.ts:guardCanonicalNativePolicy`는 목표·모델·도구·웹·프로필·세션 sequence와 중앙 승인의 일치를 요구한다. `autonomous-claude.ts:executeAutonomousClaude`는 5초 heartbeat 실패 시 실행을 중단하고 결과 sequence를 정확히 하나 늘린다.
- `autonomous-claude.ts:verifyAutonomousPrerequisiteFiles`는 관리 설정의 manifest 해시, root 소유·쓰기 제한, 고정 CLI 위치와 관리 훅을 검사한다. 모델 wire 입력에서 이 검사를 대체하지 못한다.
- `autonomous-session.ts:collectAutonomousSession`은 부모 transcript와 최대 64개 자식 transcript를 묶는다. CLI의 정규 metadata JSON은 제외하고 전체 transcript 4MiB·묶음 11MiB 한도를 적용한다. symlink·hardlink·수집 중 변경과 비밀 포함을 거부한다.
- `autonomous-tool-hook.ts:autonomousToolGate`는 `Agent`의 `worker` 종류·foreground 실행과 허용 입력 필드를 검사하며 모델 override를 거부한다. `WebFetch`는 승인된 HTTPS 호스트만 허용한다.
- `autonomous-claude.ts:executeAutonomousClaude`의 quota 대기는 서버 옵션과 reporter 양쪽의 명시적 지원을 요구한다. 구조화된 거부·세션·실제 CLI 종료·사용량 근거를 확인한 뒤에만 wait receipt를 보낸다. 미측정 0은 `usageUnavailable`로 구분한다.
- `autonomous-web.ts:dispatchAutonomousWeb`는 GET·HEAD만 허용하고 redirect를 거부한다. `autonomous-web-transport.ts:createAutonomousWebTransport`는 DNS alias 체인과 공개 IP를 검증하고, 두 번째 DNS 조회 없이 첫 검증 IP 하나로만 연결한다. 기본 timeout은 10초, 최대 30초이며 응답 body는 1MiB다.
- `autonomous-action-mcp.ts:createActionTool`은 승인된 profile·deadline을 검사하고 매 action을 중앙 API로 보낸다. lease·runtime·제어 토큰은 모델 응답에서 제외한다. LFS 입력은 파일 목록 또는 기존 manifest digest 중 하나만 받는다.
- `carbon-run.ts:runBenchmark`의 상한은 20분·30회다. 완료 marker와 Hurl 13파일·154요청의 최초 채점·독립 재검증 두 번을 확인한다. 잠금 조건에서는 고정 의존성과 lockfile 근거도 확인한다.

## Side Effects

- 파일: `/runtime`에 `input.json`, `started.json`, `result.json`, `ralph.json`, feedback 파일, `cancel` 파일을 읽고 쓴다. `[bootstrap.ts:createBootstrap]`, `[run.ts:runFromFile]`, `[ralph.ts:writeCheckpoint]`
- 파일: snapshot을 `/workspace`에 복원한다. 홈 디렉터리에 CLI 인증 파일과 설정 파일을 쓴다. `[run.ts:executeRuntime]`
- 파일: Bash 훅이 감사 기록 `bash-guards.jsonl`에 추가한다. `[claude-bash-hook.ts:appendAudit]`
- 파일: 도구 호출 기록 훅이 `tool-audit.jsonl`에 추가한다. `[tool-audit-hook.ts:recordToolAuditEvent]`
- 프로세스: `codex`, `claude`, compute 명령, `python3`(`safe-tar.py`, `duckdb-cache-pack.py`)를 실행한다. `[run.ts:executeRuntime]`, `[large-artifacts.ts:extractTarArchive]`, `[duckdb-cache.ts:prepareDuckdbCache]`
- 프로세스: 벤치마크가 `git`, `npm`, `node`, `pi`, `hurl`, `bwrap`를 실행하고 채점용 서버를 시작·종료한다. `[carbon-run.ts:runCarbon]`
- 프로세스: guard가 `execve`로 `/usr/local/bin/codex`를 실행한다. `claude-command-guard.ts`
- 네트워크: 런타임 서버가 포트 3000을 연다. `[bootstrap.ts:createBootstrap]`
- 네트워크: large artifact, DuckDB 캐시, npm 캐시를 bearer 권한으로 요청한다. 대상은 Worker의 outbound 진입점이 처리하는 `.invalid` 원점이다. `[large-artifacts.ts:prepareLargeArtifacts]`, `[duckdb-cache.ts:prepareDuckdbCache]`, `[npm-cache-archive.ts:downloadNpmCache]`, `[npm-cache-archive.ts:uploadNpmCache]`
- 네트워크: 자율 작업이 통제 원점으로 `tool-calls`(reporter 토큰)와 `external-large/*`(worker 토큰)를 보낸다. `[tool-audit-reporter.ts:shipToolAudit]`, `[autonomous-large-upload.ts:createLargePost]`
- 네트워크: 벤치마크가 모델 게이트웨이, GitHub, npm registry를 호출한다. `[carbon-run.ts:runCarbon]`, `[terra-wire-replay.ts:replayTerraWire]`
- 환경: `terra-transport.mjs`가 `HIVEMIND_TERRA_CAPABILITY`, `HIVEMIND_TERRA_PROBE`를 읽은 뒤 삭제하고, `NODE_OPTIONS`는 읽지 않고 삭제만 한다.
- 시스템 읽기: `/proc/self/status`, `/proc/self/cgroup`, `/sys/fs/cgroup`을 읽는다. `[run.ts:readRuntimeBoundary]`, `[benchmark-resources.ts:measureBenchmarkResources]`

- 장기 실행은 비공개 세션 transcript·snapshot·정책·MCP 설정·일회 시작·완료 marker를 읽고 쓴다 (`autonomous-session.ts:collectAutonomousSession`, `restoreAutonomousSession`, `autonomous-from-file.ts:runAutonomousFromFile`).
- 장기 실행은 승인·heartbeat·reporter HTTP와 선택적으로 웹 DNS-over-HTTPS·TLS, 외부 action API를 호출한다 (`autonomous-authorize.ts:createNativeHttpAuthorizer`, `autonomous-reporter.ts:createNativeHttpReporter`, `autonomous-web-transport.ts:createAutonomousWebTransport`, `autonomous-action-mcp.ts:createActionTool`).
- `autonomous-boundary-probe.ts:runAutonomousBoundaryProbe`는 실제 Linux sandbox 자식을 실행하고 전용 canary 파일을 만든다. 정리가 실패하면 통과하지 않는다. 기본 오프라인 테스트 목록에 probe 직접 실행은 포함하지 않는다.

## Verification

- Run: `npm test` (`cloudflare/backend/`에서 실행. `node --test test/*.test.ts`)
- Run: `npm run typecheck` (`cloudflare/backend/`에서 실행. `tsc --noEmit`)
- 이 폴더의 `.ts`, `.mjs`, `.py` 파일을 바꾸면 `runtime-build.json`의 `digest`가 달라진다. `npm run runtime:check`로 확인한다.
