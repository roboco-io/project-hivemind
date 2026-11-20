# EGM Drift Report: cloudflare (2026-11-16)

이 보고서는 2026-11-16에 `egm-bootstrap`으로 생성하거나 보완한 `cloudflare/` 아래 README 계약 문서와 같은 날 작업 트리의 소스 코드를 비교한 결과다. 비교한 소스에는 아직 커밋하지 않은 파일이 포함된다.
README를 작성한 에이전트와 별개의 검토 에이전트가 불일치만 기록했다. 각 항목의 `파일:줄`은 검토 시점의 코드 위치다.
README 문장이 코드와 다르게 적힌 항목은 보고서 작성 후 해당 README에서 고쳤다. README에 빠진 항목은 고치지 않았다.

## cloudflare/backend/src/README.md

- 불완전한 불변 조건: README는 large artifact 읽기가 "실행 중인 compute 작업의 `id`·`attempt`가 권한과 같고 만료 전일 때"만 허용된다고 쓴다. 코드는 이에 더해 상태가 `STARTING` 또는 `RUNNING`이고, `containerStopped`가 거짓이고, `cancellationRequested`가 없고, `now<job.deadline`이고, 요청한 digest가 `job.largeArtifacts`에 있어야 한다 (`large-artifact.ts:28-31`).
- README에 없는 제한: `validateLargeArtifacts`는 참조를 1-2개로 제한한다. `name`은 중복될 수 없고, `expandedBytes` 합계는 14GiB 이하여야 한다 (`large-artifact.ts:22-27`).
- README에 없는 제한: `format:'file'`은 `maxFiles===1`이고 `expandedBytes===sizeBytes`여야 한다 (`large-artifact.ts:19`).
- README에 없는 제한: `LargeArtifactStore`의 업로드 레코드는 `expiresAt=now+86400000`(24시간)에 만료된다 (`large-artifact-store.ts:25`).
- `Scheduler.dispatch`는 `executionGroup.concurrency`를 넘는 활성 작업을 건너뛴다. README는 전역 상한(agent 2개, compute 4개)만 쓰고 이 그룹별 상한은 적지 않았다 (`scheduler.ts:87-91`).
- README는 Codex 인증의 허용 조건을 `auth_mode==='chatgpt'`이고 `OPENAI_API_KEY`가 없는 경우로만 쓴다. 코드는 `tokens.access_token`과 `tokens.refresh_token`이 비어 있지 않은 문자열이어야 하고 전체 길이가 64000자 이하여야 한다고 요구한다 (`crypto.ts:8`, `crypto.ts:12`).
- Gemini 게이트웨이의 동작 중 README에 없는 것이 있다. 키가 없거나 `2026-12-01T00:00:00Z` 이후이면 503을 반환한다. `x-goog-api-key`가 `^hmb_[a-f0-9]{64}$` 형식이어야 한다. 경로에 `?alt=sse`가 붙어야 한다. 전체 deadline은 1,200,000ms, idle은 기본 270,000ms다. 스트림은 16MiB, 이벤트는 1MiB까지 허용한다 (`carbon-gateway.ts:65-66`, `carbon-gateway.ts:161-164`, `carbon-gateway.ts:173`, `carbon-gateway.ts:177`).
- Terra 게이트웨이는 `Authorization: Bearer hmb_...` 형식을 요구하고, 만료되었거나 없는 credential이면 503을 반환한다. 요청 본문은 `model==='gpt-6.1-terra'`, `reasoning.effort==='medium'`, `stream===true`, `store===false`여야 한다. `content-encoding`이 있으면 400이다. 상류는 `https://chatgpt.com/backend-api/codex/responses` 하나다. README의 "8MiB 이하와 POST" 설명에는 이 조건이 없다 (`terra-gateway.ts:49-76`, `terra-gateway.ts:104`).
- README에 없는 export:
  - `contracts.ts`의 `RalphCheckRecord`(`contracts.ts:28`)와 `ClaudeResultMetrics`(`contracts.ts:58`).
  - `carbon-benchmark.ts`의 `carbonModel`, `terraSizingOrder`, `terraCachePairOrder`와 `CarbonRun`, `CarbonCampaign` 등의 타입(`carbon-benchmark.ts:2-9`).
  - `carbon-gateway.ts`의 `CarbonStreamError`(`carbon-gateway.ts:68`).
  - `terra-gateway.ts`의 `terraModel`, `terraOrigin`, `terraEndpoint`(`terra-gateway.ts:5-7`).
  - `terra-latency.ts`의 `latencyPrompt`, `latencySystemPrompt`, `latencyExpected`, `latencySequenceTurns`, `TerraLatencyMode`(`terra-latency.ts:2-4`, `terra-latency.ts:38-39`).
  - `duckdb-build-cache.ts`의 `duckdbCacheOrigin`, `duckdbCachePath`, `duckdbCacheOutputChars`, `duckdbCacheMaxBytes`. 마지막 값은 96MiB 상한이다(`duckdb-build-cache.ts:13-16`).
  - `npm-cache-object.ts`의 `npmCacheOrigin`, `npmCachePath`. `npmCacheMaxBytes`는 README에 이름만 있고 값(90MiB)이 없다(`npm-cache-object.ts:1-4`).
  - `large-artifact-store.ts`의 `ArtifactStoreError`, `UploadRecord`(`large-artifact-store.ts:3`, `large-artifact-store.ts:5`).
  - `crypto.ts`의 `StoredCredential`(`crypto.ts:3`).
- 운영자 CLI 세부 사항이 README에 없다. `snapshot --out`, `result --out`, `workflow-result --out`은 `flag:'wx'`로 쓰므로 파일이 이미 있으면 실패하고, 모드는 0600이다. `workflow-result`는 `--out`이 필수다. 서버 URL은 경로가 `/`이고 credentials, search, hash가 없어야 한다. 토큰은 4096자 이하여야 한다. 요청 timeout은 30초이고 응답 상한은 16MiB다 (`client.ts:73`, `client.ts:78-80`, `client.ts:84`, `client.ts:117`, `client.ts:134-136`, `client.ts:145`).
- 운영자 CLI는 `submit`, `workflow-draft`에서 로컬 JSON 파일(`JOB-SPEC.json`, `PLAN.json`)도 읽는다. Side Effects의 파일 항목에는 이 읽기가 없다 (`client.ts:125`, `client.ts:141`).
- workflow의 워커별 `writes`는 1-32개여야 하고 `concurrency`는 1 또는 2, `instance`는 3종 중 하나여야 한다. README의 workflow 불변 조건에는 이 수치가 없다 (`workflow.ts:45-46`, `workflow.ts:52-54`).

## cloudflare/backend/src/cloudflare/README.md

- 불완전한 불변 조건: README는 `runtimeRevision`이 고정한 값 또는 `runtime-build.json`의 `digest`와 같아야 `prepare`와 `launch`를 수행한다고 쓴다. 코드에는 legacy 경로가 있다. 메타데이터에 `runtimeRevision`이 없는데 이미 `prepared` 또는 `launchIssued`인 경우 `/health`의 `ok===true`만 보고 ready로 판정하고, revision 비교를 건너뛴다. `SchedulerDO.advance`는 이때 `prepare`와 `launch`를 호출하지 않는다 (`worker.ts:188-191`, `worker.ts:203`, `worker.ts:547`, `worker.ts:583`).
- README에 없는 outbound 동작: `ResourceComputeOutbound`는 가상 origin 두 개를 처리한다. `https://hivemind-duckdb-cache.invalid/v1/cache`는 GET/PUT이다. 이 경로는 `Bearer hma_` 토큰을 `SchedulerDO.duckdbCacheGrant`로 확인한 뒤 R2 `ARTIFACTS`를 읽고 쓴다. 쓰기는 `etagDoesNotMatch:'*'`로 한 번만 허용하고, 이미 있으면 409다. 상한은 `duckdbCacheMaxBytes`다. `https://hivemind-artifacts.invalid/{sha256}`는 GET이다. 이 경로는 `SchedulerDO.artifactRead`로 권한을 확인한 뒤 large artifact를 반환한다. README의 `ResourceComputeOutbound` 설명은 "의존성 설치 경로를 추가로 허용"뿐이다 (`worker.ts:50-98`, `worker.ts:265-280`).
- `CarbonOutbound`의 가상 origin과 처리 흐름 중 README에 없는 것: `hivemind-npm-cache.invalid/v1/archive`는 `Bearer hmb_` 토큰으로 `SchedulerDO.npmCacheGrant`를 거쳐 R2를 GET/PUT한다(상한 `npmCacheMaxBytes`). `hivemind-carbon-probe.invalid`는 합성 Gemini 스트림이다. Terra 프로브는 `x-hivemind-terra-probe: 1` 헤더가 있을 때 합성 스트림을 쓴다 (`worker.ts:105-160`).
- 메서드 제한이 README에 없다. `Resource*Outbound`(`dependencyOutbound`)와 `CarbonOutbound`의 기본 경로는 GET과 HEAD만 허용한다. 예외는 `github.com`의 `.../git-upload-pack`에 대한 POST다. 그 밖의 메서드는 403이다. README의 outbound 불변 조건은 https, 호스트, userinfo, 포트, redirect 조건만 적는다 (`worker.ts:43-49`, `worker.ts:161`).
- `Resource*Outbound`와 `CarbonOutbound`가 허용하는 호스트가 `ComputeOutbound`보다 많다. `binaries.prisma.sh`, `raw.githubusercontent.com`, `realworld-docs.netlify.app`이 추가된다. README는 "npm·GitHub 호스트"로만 적었다 (`worker.ts:39`, `worker.ts:41-42`, `worker.ts:162-163`).
- `SchedulerDO`의 RPC 메서드가 README에 없다. `artifactRead`, `duckdbCacheGrant`, `npmCacheGrant`, `reserveCarbon`, `settleCarbon`이다. 이들은 outbound 클래스가 호출하며, 작업별 capability 토큰을 `hma_`와 `hmb_` 접두 키로 Durable Object storage(`large-cap:`, `carbon-cap:`, `carbon-reservation:`)에 두고 확인한다 (`worker.ts:265-280`, `worker.ts:447-488`).
- alarm 설명이 일부만 맞다. README는 "활성 작업 최대 2개, workflow는 하나"라고 쓴다. 코드는 같은 alarm에서 모든 compute group(`advanceComputeGroup`)과 carbon campaign(`advanceCarbon`)도 매번 진행한다. 하드 데드라인은 `deadline+10000`ms이고, 취소된 경우 `cancelAt`에 10000ms를 더한다 (`worker.ts:517`, `worker.ts:530-531`).
- 오류 매핑 규칙이 README에 없다. `statusCode`가 400, 404, 409, 413, 422, 503이 아니면 500이고 본문은 `Service is unavailable`이다 (`api.ts:119`).
- `worker.ts` 기본 처리기의 `SCHEDULER` 호출이 실패하면 503 `Service is unavailable`을 반환한다. README의 `worker.ts:default` 설명에는 이 실패 처리가 없다 (`worker.ts:746`).
- `GET /health`의 근거가 엇갈린다. `handleApi`는 `{ok,service}`만 반환한다 (`api.ts:60`). README가 적은 `workerVersion`과 `expectedRuntimeRevision`은 `worker.ts`의 기본 처리기가 반환한다 (`worker.ts:746`). 기본 처리기가 `/health`를 먼저 처리하므로 `api.ts`의 `/health`는 Worker 경유로는 도달하지 않는다. README는 `[api.ts:handleApi]`가 `/health`를 처리한다고 쓰면서 표에서는 `[worker.ts:default]`를 근거로 든다.

## cloudflare/backend/src/runtime/README.md

- Invariants의 "agent 실행은 ... 때만 진행한다"는 범위가 좁다. 경계 검사는 모드와 무관하게 실행된다. `executeRuntime`이 `options.boundaryCheck`를 모드 분기 이전에 호출하고(`run.ts:91`), `runFromFile`은 기본값으로 `readRuntimeBoundary`를 넘긴다(`run.ts:248`). 따라서 compute 작업도 `verified`가 아니면 `Linux capability boundary failed`로 중단된다. `boundaryCheck`를 넘기지 않고 `executeRuntime`을 직접 호출하면 검사를 건너뛴다.
- 환경 필터 설명에 빠진 항목이 있다. 접두 목록에 `CF_API_`가 없고, 제외 이름에 `AUTH_WRAP_KEY`, `PROBE_TOKEN`, `NODE_PATH`, `LD_LIBRARY_PATH`, `BASH_ENV`, `ENV`가 있다(`claude-guard-policy.ts:7,9`). `claudeGuardEnvironment`는 PATH 앞에 `/opt/hivemind/compat-bin`을 붙이고 `TMPDIR=/tmp`, `CODEX_HOME=<home>/.codex-guard`를 설정한다(`claude-guard-policy.ts:11-15`). README에는 이 내용이 없다.
- `claudeGuardSandboxArgs`가 만드는 인자가 README와 다르다. README는 `codex sandbox -P hivemind -- /opt/hivemind/bin/namespace-guard -- <command>`라고 쓴다. 실제 반환값은 `codex` 없이 `sandbox`로 시작하고, 운영용 `-c` 설정들과 `-c <hivemind 프로필 + deny/read 추가분 + network enabled>`가 `-P hivemind` 앞에 붙는다(`claude-command-guard.ts:32-37`).
- `claude-command-guard.ts`에 README에 없는 부수 효과가 있다. `HIVEMIND_GUARD_TRACE=1`이면 `/workspace/.hivemind-guard-trace.jsonl`(최대 8192바이트)과 `.lock` 파일을 쓴다(`claude-command-guard.ts:10,18-29`). README에 없는 export는 `guardTraceMetadata`, `CODEX_SANDBOX_EXECUTABLE`, `claudeGuardHome`이다(`claude-command-guard.ts:8-11`).
- `runProcess`의 `captureDirectory` 옵션이 Side Effects에 없다. 이 옵션을 쓰면 `stdout.log`와 `stderr.log`를 `O_EXCL`로 만든다(`process.ts:15-17`). `executeRuntime`은 compute에서 `<runtime>/compute-output`을 넘긴다(`run.ts:140`).
- `/runtime` 파일 목록이 불완전하다. `compute-output/`과 `compute-home/`(`run.ts:102,140`), `result.pending.json`(`run.ts:249`)이 빠져 있다. 홈과 `/tmp` 아래 임시 디렉터리도 README에 없다. 생성 위치는 `hivemind-compute-*`, `hivemind-inputs-*`, `hivemind-duckdb-inputs`(`run.ts:101,112,115`)와 `/tmp/hivemind-ccache-dir-*`(`run.ts:128`)이다. Claude agent는 `<home>/.hivemind-phase0`에 `claude-agents.jsonl`, `settings.json`, `mcp.json`도 쓴다(`run.ts:154-156`).
- `run.ts`를 직접 실행하면 `runFromFile()`을 호출하는데, 이 진입점이 README에 없다(`run.ts:251`).
- bootstrap 서버의 응답 동작이 일부만 적혀 있다.
  - `GET /health`는 `{ok, runtimeRevision}`을 반환한다(`bootstrap.ts:14`).
  - `POST /prepare`는 JSON 오류 시 400, 신규 저장 시 201을 반환한다(`bootstrap.ts:18,22`).
  - `GET /result`는 8MiB를 넘으면 500을 반환한다(`bootstrap.ts:55`).
  - Ralph 경로는 checkpoint가 없으면 404, 피드백 본문이 12000자를 넘으면 413, 불일치하면 409를 반환한다(`bootstrap.ts:30,33,37`).
- Side Effects의 `/proc/self/status`, `/proc/self/cgroup`, `/sys/fs/cgroup` 목록에서 `/proc/<pid>/status` 전체 순회가 빠졌다. cgroup 메모리를 읽지 못하면 RSS 합계로 대체한다(`benchmark-resources.ts:38-41`).
- `terra-transport.mjs`의 "읽은 뒤 삭제" 설명은 `NODE_OPTIONS`에 맞지 않는다. `NODE_OPTIONS`는 읽지 않고 삭제만 한다(`terra-transport.mjs:3-7`). 이 모듈의 핵심 부수 효과도 빠져 있다. `https://hivemind-terra.invalid/codex/responses` 요청에 `Bearer <capability>`를 붙이고, `chatgpt-account-id`를 제거하며, zstd 본문을 최대 8MiB까지 풀어 `fetch`를 가로챈다(`terra-transport.mjs:9-26`).
- 벤치마크 부수 효과 설명이 일부 빠졌다.
  - 실행 프로세스 목록에 `codex sandbox`가 없다(`carbon-run.ts:37`).
  - 채점 서버가 `127.0.0.1`의 임시 포트를 열어 수신하는데, 네트워크 항목은 포트 3000만 적었다(`carbon-run.ts:44-50,64-66`).
  - `/home/node/hivemind-carbon-*`, `/home/node/realworld-*` 작업 디렉터리와 `os.tmpdir()`의 세션·pi 설정 디렉터리를 만든다(`carbon-run.ts:170,239,336-337,365`).
- README에 없는 export가 있다.
  - `providers.ts`의 `ProviderPaths`, `ProviderFailureReason`, `TrailingEventKind`, `ClaudeResultShape`.
  - `carbon-run.ts`의 `CarbonRuntimeInput`, `CarbonScore`, `CarbonRoundTiming`, `CarbonEvidence`.
  - `claude-bash-hook.ts`의 `MAX_HOOK_BYTES`, `MAX_COMMAND_BYTES`, `GUARD`, `shellQuote`.
  - `bash-diagnostic.ts`의 `bashCategories`, `BashCategory`, `BashDiagnostic`.
  - `terra-wire-replay.ts`의 `WireReplayTiming`.
  - `process.ts`의 `RunOptions`.
  - `large-artifacts.ts`의 `ArtifactRef`, `ArtifactPreparationOptions`, `ArchiveReceipt`, `PreparedArtifactReceipt`, `PreparedArtifacts`.

## cloudflare/scripts/phase0/README.md

- Invariants의 "Node 24.14 이상"은 코드와 다르다. 코드는 메이저가 정확히 24이고 마이너가 14 이상일 때만 통과시킨다(`collect.ts:49-50`). Node 25 이상은 `local-tools`가 FAIL이다.
- `local.ts`의 동작이 일부 빠져 있다. `--backend`가 cloudflare 또는 aws가 아니면 종료 코드 1을 반환한다(`local.ts:11-14`). aws일 때만 `--profile`은 `roboco`, `--region`은 `ap-northeast-2`가 기본값이다(`local.ts:18-19`). 각 조회 명령은 15초 제한을 갖고 실패 시 출력을 버린다(`local.ts:22-30`).
- `assessClaudeFixture` 설명이 불완전하다. README는 "CLI 성공, 파일, MCP nonce, 병렬 subagent 기준"이라고 쓴다. 코드는 `sandboxVerified`(경계 Bash 명령, 감사 receipt 해시, `CLAUDE_SANDBOX_BOUNDARIES_VERIFIED` 출력)와 `nativeGuardVerified`(병렬 두 agent 각각의 guard receipt)도 `passed` 조건에 넣는다(`assess-claude.ts:30-34,57-58`).
- `claude-probe.ts` 설명이 맞지 않는다. README는 "홈 디렉터리에 인증·설정 파일을 쓴다"고 하지만, 이 스크립트는 인증 파일을 쓰지 않고 토큰을 환경 변수로 넘긴다(`claude-probe.ts:36`). 실제로는 `settings.json`, `mcp.json`, `claude-agents.jsonl`, `bash-guards.jsonl`, `/home/node/phase0-claude-outside.txt`, `/runtime/input.json` 더미 파일을 쓴다(`claude-probe.ts:17-24`). README에 없는 환경 변수 `HIVEMIND_CLAUDE_SINGLE`과 `HIVEMIND_GUARD_TRACE=1` 설정도 있다(`claude-probe.ts:27,36`).
- `codex-boundary-probe.ts`를 직접 실행할 때의 `--builtin-control` 인자가 README에 없다(`codex-boundary-probe.ts:141`). README에 없는 export는 `codexBoundaryArgs`, `parseCodexBoundaryObservation`이다(`codex-boundary-probe.ts:50,58`).
- `request-claude.ts`의 URL 제어가 빠져 있다. 환경 변수 `HIVEMIND_PROBE_URL`을 읽지만 값이 코드에 고정된 probe Worker 주소가 아니면 거부한다(`request-claude.ts:11-12`). `request-codex.ts`의 요청 주소는 코드에 고정되어 있다(`request-codex.ts:18`).
- README에 없는 export가 있다.
  - `claude-codex-layer-probe.ts`: `assessNativeNamespaceProbe`, `claudeCodexLayerSettings`, `claudeCodexLayerEnvironment`, `claudeCodexLayerArgs`, `claudeCodexLayerCommand`(`claude-codex-layer-probe.ts:24,35,38,72,76`).
  - `compute-stdio-probe.ts`: `computeStdioArgs`, `computeStdioTestSource`(`compute-stdio-probe.ts:8,11`).
  - `claude-command-concurrency-probe.ts`: `claudeCommandConcurrencyEnvironment`, `collectConcurrencyDiagnostics`, `collectConcurrencyWaitState`, `nestedBwrapCauseArgs`, `warmupNestedBwrapPid`, `assessNestedBwrapCause`, `nestedBwrapCauseScript`, `concurrencyBashCommand`, `claudeCommandConcurrencyArgs`(`claude-command-concurrency-probe.ts:23-122`).
  - `rollout-receipts.ts`의 `RolloutReceipt`(`rollout-receipts.ts:1`)와 `native-thread-receipts.ts`의 `NativeThreadReceipt`(`native-thread-receipts.ts:4`).

## cloudflare/scripts/phase0/cloudflare/README.md

- `Phase0Container`가 컨테이너를 `instance:'standard-1'`, `entrypoint:['sleep','120']`로 시작하는데 README에 없다(`worker.ts:59-64`).
- `outbound` 가로채기는 `codex`와 `claude` probe일 때만 설정된다(`worker.ts:66-73`). 다른 probe는 가로채기 없이 `enableInternet:false`만 적용된다. README는 이 구분을 쓰지 않았다.
- `codex-boundary` probe는 `codex-boundary-probe.ts --builtin-control`로 실행된다(`worker.ts:85`). README에는 인자가 없다.
- 응답 처리에 README에 없는 항목이 있다.
  - Worker 응답은 각 probe 결과에 `workerVersion`을 붙이고, 헤더 `X-Hivemind-Probe-Revision: boundary-20261110-r3`을 추가한다(`worker.ts:138-139`).
  - 컨테이너 종료 후 `containerStopped`를 붙인다(`worker.ts:117,121,128`).
  - codex 또는 claude fixture가 비정상 종료하면 `Subscription fixture failed before encrypted auth return`을 던져 502가 된다(`worker.ts:118-119`).
- Durable Object는 probe 종류별로 `phase0-${kind}-v1` 이름으로 얻는다(`worker.ts:138`). 일회 실행 표시 키는 `codex-probe-v4-used`와 `claude-probe-v5-used`이다(`worker.ts:42,51`). README는 "Durable Object마다 한 번"이라고만 쓴다.
- outbound 전달은 `fetch(request,{redirect:'manual'})`이다(`worker.ts:16,22`). README에는 redirect 처리 방식이 없다.

## cloudflare/scripts/README.md

No drift detected

## cloudflare/backend/README.md (추가한 절만)

- Invariants의 "런타임은 Linux에서 ... agent를 실행한다"는 compute에도 적용된다. 근거는 runtime README 첫 항목과 같다(`src/runtime/run.ts:91,248`).
- native 항목에서 `namespace-guard`의 seccomp 설명이 불완전하다. `clone3`은 `EPERM`이 아니라 `ENOSYS`를 반환한다(`native/namespace-guard.c:106`). 네이티브가 아닌 arch와 x32 syscall은 `SECCOMP_RET_KILL_PROCESS`로 프로세스를 종료한다(`native/namespace-guard.c:78-90`). README는 `EPERM`과 `clone` 거부만 적었다.
- `namespace-guard`의 추가 동작이 README에 없다.
  - 환경 변수 `HIVEMIND_NAMESPACE_GUARD=seccomp-v1`을 설정한다(`native/namespace-guard.c:130`).
  - `HIVEMIND_GUARD_TRACE=1`이면 `/workspace/.hivemind-guard-trace.jsonl`에 추적 한 줄을 쓰고 `.lock` 파일을 만들었다 지운다(`native/namespace-guard.c:133-161`).
- `proc-guard`의 조건과 부수 효과 중 README에 없는 것이 있다.
  - 프로세스가 단일 스레드(`Threads: 1`)여야 한다(`native/proc-guard.c:74-83`).
  - 읽기·실행 허용 경로는 `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/etc`, `/dev`, `/sys`, `/opt/hivemind`이다(`native/proc-guard.c:148`).
  - 환경 변수 `HIVEMIND_FS_GUARD_ABI=<abi>`를 설정한다(`native/proc-guard.c:130`).
- `build-bubblewrap-compat.sh`는 `INPUT_ROOT`에 `bubblewrap-nested-proc.patch`, `BUBBLEWRAP-NOTICE.md`뿐 아니라 `bubblewrap-compatibility.md`, `Dockerfile.backend`, `Dockerfile.phase0`, 자기 자신도 있어야 한다(`native/build-bubblewrap-compat.sh:32-37`). 앞의 두 파일은 `native/`에 있지만 나머지 셋은 `native/` 밖에서 복사된다(`Dockerfile:3-6`). README는 이 선행 조건을 쓰지 않았다.

## cloudflare/README.md (추가한 절만)

No drift detected

## cloudflare/backend/scripts/README.md

- 코드는 `backend/src`와 `backend/native` 트리를 걸을 때 이름이 `.`로 시작하는 항목과 `node_modules`, `work`, `scratch`, `tmp`, `dist`, `coverage` 폴더를 건너뛴다. 깊이는 8단계, 방문 항목은 2048개로 제한하고, 경로 길이는 512자 이하여야 한다 (`runtime-build.ts:13`, `runtime-build.ts:24-26`, `runtime-build.ts:34`). README Invariants에는 이 제외 규칙과 제한이 없다. 그래서 `backend/src/**/tmp/` 같은 폴더의 변경은 `digest`에 반영되지 않는데, README는 이를 알리지 않는다.
- `remote-smoke.ts`의 통과 조건이 README 설명보다 많다. README는 "check 2개와 native subagent 2개의 겹침"만 적었다. 코드는 아래 조건도 요구한다.
  - 모든 job의 `authSynced`가 true여야 한다 (`remote-smoke.ts:52`).
  - Node 테스트 결과에서 `tests 2`, `pass 2`, `fail 0`이 확인되어야 한다 (`remote-smoke.ts:55`).
  - `math.test.mjs`와 `verify.mjs`가 수정되지 않아야 한다 (`remote-smoke.ts:54`).
  - `phase0_probe` MCP 응답의 nonce와 marker `hivemind-phase0-mcp-v1`이 일치해야 한다 (`remote-smoke.ts:58`).
  - 두 provider를 함께 돌리면 provider 프로세스끼리도 겹쳐야 한다 (`remote-smoke.ts:62`).
- `remote-smoke.ts`는 `collect` 모드에서 job을 만들지 않고 `submitted.json`을 읽어 GET만 한다 (`remote-smoke.ts:30-31`). README Side Effects는 모든 모드에서 job을 만든다고 읽힌다. 제출 모드에서는 같은 spec을 POST해 같은 id가 오는지 보고, 내용이 다른 spec은 409가 오는지 확인한다 (`remote-smoke.ts:37`). 이 동작과 12분 폴링 한도(`remote-smoke.ts:43`)도 README에 없다. 네 번째 인자 providers의 허용값은 `codex`, `claude`, `codex,claude`뿐인데 (`remote-smoke.ts:11`) README는 `[providers]`라고만 적었다.

## cloudflare/backend/scripts/auth/README.md

- `withKeychain`은 600000ms가 지나면 helper를 강제 종료한다 (`pi-oauth.ts:59`). 토큰 갱신 요청의 제한은 30000ms다 (`pi-oauth.ts:33`). README에는 두 시간 제한이 모두 없다.
- `export`는 대상 파일의 부모 폴더를 `0o700`으로 만든다 (`pi-oauth.ts:130`). `getPiAccess`와 `login`은 `HIVEMIND_PI_PACKAGE_ROOT` 또는 기본 경로 아래 pi 패키지의 `openai-codex.js`를 동적으로 import해 실행한다 (`pi-oauth.ts:77-79`). README Side Effects는 제공자 요청만 적고 이 코드 로드는 적지 않았다.
- Keychain 항목의 service는 `io.roboco.hivemind.pi-openai-oauth`, account는 `operator`다. 접근 속성은 `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`다 (`keychain.swift:20-23`, `keychain.swift:53`). README는 "generic password 항목 하나"라고만 적었다.

## cloudflare/backend/scripts/large-artifacts/README.md

- README는 `local-proof.ts`의 통과 조건을 "파일 수, 해제 크기, data SHA-256, 요청 2건"으로 적었다. 코드는 추가로 아래를 요구한다 (`local-proof.ts:113-115`).
  - 요청마다 serve한 byte 수와 SHA-256이 기대값과 같아야 한다.
  - chunk는 64KiB 이하여야 한다.
  - 동시 read는 1개여야 한다.
  - 스트림이 닫혀 있어야 한다.
  - 준비 단계의 receipt가 파일 수와 해제 크기와 일치해야 한다.
- README는 "임시 작업 폴더와 `receipt.json`을 만든다"고만 적었다. 실제로는 `work` 폴더를 마지막에 `rm -r`로 지우고, 실패해도 `receipt.json`을 쓴다 (`local-proof.ts:120-123`). 전체 제한 시간 1,800,000ms, 준비 단계 제한 1,200,000ms, SIGINT/SIGTERM 중단 처리(`local-proof.ts:96-97`, `local-proof.ts:106`)도 README에 없다.

## cloudflare/backend/scripts/resource-validation/README.md

- `usage.ts`는 환경 변수 `EXTRA_ACCOUNTING_GROUPS`와 `EXTRA_ACCOUNTING_JOBS`를 읽는다 (`usage.ts:29`). README Interface는 `usage.ts`의 환경 변수를 하나도 적지 않았다. 또 `usage.ts`는 GraphQL 호출 전에 백엔드 `/v1/jobs`를 조회하고 (`usage.ts:35`) `observed-usage.json`을 쓴다 (`usage.ts:63`). Side Effects는 이 둘을 적지 않았다.
- `experiment.ts`는 `local-prefix` 하위 명령을 처리한다. 이 명령은 첫 cloud 조건에서 멈춘다 (`experiment.ts:146`). README는 이 명령의 의미를 설명하지 않는다. 로컬 조건은 snapshot을 복원한 작업 폴더에서 `node run-shard.mjs`를 자식 프로세스로 실행하고 (`experiment.ts:60-66`, `experiment.ts:109-110`), `init`은 `git rev-parse`를 실행한다 (`experiment.ts:107`). README Side Effects는 이 자식 프로세스 실행을 적지 않았다.
- `validFixtureReceipt`는 샤드별 기대 file/request 수를 `[3,49]`, `[3,44]`, `[3,27]`, `[4,34]`로 고정한다 (`experiment.ts:57`). README는 전체 13파일·154요청만 적었다.
- `host-metrics.ts`는 `/sbin/route -n get default`로 기본 네트워크 인터페이스를 찾고 (`host-metrics.ts:45`), 표본마다 `node -e` 프로세스를 실행한다 (`host-metrics.ts:41`). README Side Effects의 명령 목록은 `ps`, `git status`, `sysctl`, `vm_stat`, `memory_pressure`, `netstat`이고 이 둘이 빠져 있다.
- `suite.ts`는 `CODEX_BIN`과 `CLAUDE_BIN`이 절대 경로가 아니면 시작하지 않는다 (`suite.ts:38`). 또 `suite.lock`을 배타적으로 만든다 (`suite.ts:40`). README는 두 변수를 "읽는다"고만 적었고 잠금 파일을 적지 않았다.
- `workflow.ts`의 `disconnect` 모드는 300000ms 동안 연결을 끊은 상태로 대기한다 (`workflow.ts:171-174`). 관찰 제한 시간이 지나면 살아 있는 하위 job마다 `POST /v1/jobs/{id}/cancel`을 보낸다 (`workflow.ts:196`). 로컬 모드는 `git init`과 `codex`/`claude`/`node --version` 실행도 한다 (`workflow.ts:55`, `workflow.ts:64`). README Side Effects는 이 세 가지를 적지 않았다.
- `observer.ts`는 `/v1/workflows/{id}`를 GET하고, workflow id는 `/^[a-zA-Z0-9_-]{1,128}$/`와 일치해야 한다 (`observer.ts:3`, `observer.ts:6`). README에는 인자 형식만 있고 이 호출과 id 규칙이 없다.

## cloudflare/backend/scripts/duckdb-pilot/remote/README.md

- README는 경계 probe 통과 조건을 source 쓰기·삭제와 runtime input 읽기 차단(data가 있으면 data 쓰기·삭제 차단 포함)만으로 적었다. 코드의 `passed`는 아래도 요구한다 (`runner.mjs:58`).
  - `credentialsAbsent`
  - `scratchWritable`
  - `sourceUnchanged`
  - data 전후 해시 일치
  - source tree의 파일 수가 정확히 14010개
- `runner.mjs`는 `/proc/self/root/runtime/input.json` 읽기도 시도한다 (`runner.mjs:48`). README는 `/runtime/input.json`만 적었다.
- ccache 모드는 `config.jemallocOff === true`와 `/`로 시작하는 `HIVEMIND_CCACHE_DIR`도 요구한다 (`runner.mjs:28-29`). README Invariants에는 phase와 profile 조건만 있다. ccache 모드는 `/tmp/hivemind-duckdb-ccache`를 고정 scratch로 만든다 (`runner.mjs:32-33`). 이 폴더가 이미 있으면 실패하고, `HIVEMIND_CCACHE_DIR` 내용을 쓴다. README Side Effects는 "임시 작업 폴더를 만들고 지운다"고만 적었다.
- 테스트 통과 판정은 로그에 `All tests passed (N assertions in 16 test cases)`가 있어야 한다 (`runner.mjs:121`). README는 테스트 목록 일치만 적었다.
- `runner.mjs`는 `inventory.py`를 `resolve('inventory.py')`로 실행한다 (`runner.mjs:114`). 이 파일은 `remote/`가 아니라 상위 폴더에서 `remote.ts`가 snapshot에 복사한다 (`remote.ts:87`). README는 `runner.mjs`가 이 파일을 쓴다는 점을 적지 않았다.

## cloudflare/backend/scripts/duckdb-pilot/README.md (추가한 절만)

- README는 `remote.ts`의 동시 실행 수가 1·2·4라고 적었다. 실제로 `[CONCURRENCY]` 인자는 `matrix`, `jemalloc-off`에서만 쓰인다. `boundary`, `build`, `boundary-then-build`는 항상 1이고 인자를 무시한다 (`remote.ts:61-62`).
- `remote.ts`는 아래 조건을 강제하는데 README에 없다.
  - 고정 `SOURCE_SHA` (`remote.ts:14`, `remote.ts:70`)
  - `/health`의 `expectedRuntimeRevision` (`remote.ts:73-75`)
  - `build` 단계는 같은 binding의 boundary 결과가 먼저 통과해야 한다 (`remote.ts:77-80`).
  - `jemalloc-off`와 `ccache-*`는 data 자리에 도구 artifact ref가 필수다 (`remote.ts:71`).
  - 관찰 기한이 지나면 `/cancel`을 호출한다 (`remote.ts:111`).
  - 이전 `operator.lock`이 같은 host의 죽은 PID이면 지우고 다시 잡는다 (`remote.ts:44-50`).
- 환경 변수 요구가 README와 다르다.
  - `ccache-campaign.py`는 `DUCKDB_MATRIX_RUNTIME`을 `env[...]`로 반드시 읽고 (`ccache-campaign.py:23`), `DUCKDB_CACHE_CAMPAIGN`을 `ccache-20261116-v1`로 고정한다 (`ccache-campaign.py:14`).
  - `ccache-campaign.py`는 `ccache/tools-ref.json`이 필요하고 `campaign.lock`을 만든다 (`ccache-campaign.py:16`, `ccache-campaign.py:22`).
  - `main-matrix.py`는 `main-inventory-gate/build/result.json`의 `validation.passed`가 true여야 시작한다 (`main-matrix.py:15-17`). 로컬 조건에는 macOS SDK 경로 `/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk`를 하드코딩한다 (`main-matrix.py:53`). 이 둘도 README에 없다.
  - ccache 모드의 `build-ccache-batch`는 Darwin, 명시한 SDK(`DUCKDB_PILOT_OSX_SYSROOT`), `DUCKDB_SKIP_JEMALLOC=1`을 모두 요구한다 (`pilot.ts:122`). README는 `DUCKDB_SKIP_JEMALLOC`만 필수라고 적었다.
  - `build-ccache-batch`는 `C3`, `C4`, 동시 실행 2, jobs 4로 고정된다 (`pilot.ts:258`).
- README는 `report-ccache.mjs`, `report-matrix.py`, `summarize.py`가 "결과 폴더를 읽어 요약을 쓴다"고만 적었다. 인자와 쓰기 위치가 README와 다르다.
  - `summarize.py`는 `--root DIR --output DIR`을 받는다 (`summarize.py:244`).
  - `report-matrix.py`는 `ROOT [REPORT]`를 받는다. 쓰는 위치는 `ROOT/main-matrix/summary.json`과 `report.md`다 (`report-matrix.py:100-104`).
  - `report-ccache.mjs`는 `ROOT [REPORT]`를 받고 `ROOT/ccache/cache-comparison.json`과 `.md`를 쓴다 (`report-ccache.mjs:97-99`). 클라우드 실행 폴더 안에도 `{c3,c4}-ninja-actions.json`을 쓴다 (`report-ccache.mjs:50`).
  - 그래서 Side Effects의 "지정한 출력 폴더에 요약 파일을 쓴다"와 맞지 않는다.
- `query_output.py`의 빈 출력 해석에 쓰는 "고정값"은 코드에 고정된 값이 아니다. 실행 폴더의 `memory-batch-settings.json`에 기록된 `querySourceSha256`를 쓴다 (`query_output.py:52-58`). 이 파일의 `sourceCommit`만 코드 상수와 대조한다.
- `pilot.ts`가 실행하는 `git init`과 `python3`는 README Side Effects의 명령 목록에 없다 (`pilot.ts:35`, `pilot.ts:44`, `pilot.ts:52`).

## cloudflare/backend/benchmark/README.md (추가한 절만)

- `build-fixture.mjs`는 `manifest.json`, `build-fixture.mjs`, `README.md`를 복사 대상에서 제외한다 (`resource-validation/build-fixture.mjs:12`). README는 "fixture를 복사하고"라고만 적었다. 그래서 복사본에는 이 세 파일이 없고, `manifest.json`은 새로 생성한 것이다. 이 생성 manifest는 `source`와 `sourceSnapshot` 필드를 가진다 (`resource-validation/build-fixture.mjs:26`). 반면 폴더에 체크인된 `manifest.json`은 `README.md`와 `build-fixture.mjs`를 포함하고 `source` 필드는 없다. README는 둘의 차이를 구분하지 않았다.
- `run-shard.mjs`의 `HURL_BIN` 기본값은 macOS에서 개발자 개인 홈 디렉터리 아래 `.local/bin/hurl`의 절대 경로이고, 그 밖에서는 `/usr/bin/hurl`이다 (`resource-validation/run-shard.mjs:14`). Interface는 `HURL_BIN`을 읽는다고만 적었고 기본값이 없다. Verification의 "Hurl 8.0.1 필요"는 코드에서 확인하지 않는 조건이다.
- `fixture-runtime.mjs`는 README가 적은 5개 외에 `fixtureRoot`도 export한다 (`resource-validation/fixture-runtime.mjs:17`). `run-shard.mjs`와 `integration.mjs`가 이를 쓴다.
- `integration.mjs`는 자식 프로세스에 `process.env` 전체를 넘긴다 (`resource-validation/integration.mjs:4`). README의 "허용한 변수만 받는다"는 문장은 `prepare`에만 해당한다. 이 문장이 `integration.mjs`가 띄우는 자식에는 적용되지 않는다는 점은 README에 없다.
