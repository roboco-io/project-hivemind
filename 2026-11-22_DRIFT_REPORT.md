# 변경 README 드리프트 보고서

대상: 2026-11-22 EGM 부트스트랩에서 변경·생성한 README 37개. 현재 작업 트리의 미커밋 소스를 기준으로 대조했다.

차이는 동작·문서·빌드 경계 7건과 공개 선언 색인 누락으로 구분한다. 공개 선언 누락은 해당 디렉터리 README에 이름이 없는 직접 export 선언 158개(10개 README)이며, 기능 미구현이라는 뜻은 아니다. 상위 색인은 하위 계약으로 위임하는 것을 허용했다. 외부 실증 이력·제공자 동작은 이번 정적 대조의 검증 범위 밖이다.

## README.md

- 입력 snapshot을 일괄 읽기 전용으로 제공한다는 설명은 일반 agent/compute 경로와 다르다. `cloudflare/backend/src/files.ts:writeExclusive`는 0644/0755로 복원하고 `runtime/compute-sandbox.ts:computeSandboxArgs`는 workspace 쓰기를 허용한다. `runtime/run.ts:executeRuntime`은 일반 compute의 변경을 실행 후 `sourceUnchanged`로 거부하며, 읽기 전용 grant는 별도 large artifact에 적용한다. 설명을 일반 snapshot의 사후 무결성 검사와 large artifact의 읽기 전용 경계로 나눠야 한다.

## apps/README.md

No drift detected.

## apps/control-plane/README.md

No drift detected.

## apps/control-plane/src/README.md

- [동작 불일치] 공개 HF LFS의 명시적 동의 `allowPublicLarge:true`가 Cloudflare proxy를 통과하지 않는다. `autonomous-external-api.ts:approvedTarget`은 이 필드를 내보내지만 `autonomous-cloud-proxy.ts`의 `profile` 투영은 필드를 버리고 `publicValue`의 approvedTarget 검증은 4필드 HF 대상을 거부한다. `apps/mcp-server/src/autonomous.ts:profileMetadata`는 공개 LFS에서 이 동의를 필수로 요구하므로 문서의 승인 범위 검토·승인 연결이 성립하지 않는다. 무네트워크 재현: profile 응답은 200이지만 동의 필드 소실, 같은 approvedTarget의 action 응답은 503. proxy의 HF 공개 범위 전달 계약과 구현을 함께 맞춰야 한다.

- [공개 선언 색인 누락] 아래 직접 export 선언은 코드에 있으나 이 README의 이름 색인에는 없다. 사용 타입·오류·설정·상수의 계약 추적이 빠져 있다.

  - `apps/control-plane/src/autonomous-external-api.ts`: `ExternalWorkerRequest` (L17), `ExternalArtifactRequest` (L18), `ExternalHfVisibilityDisplay` (L42), `ExternalActionPage` (L44).
  - `apps/control-plane/src/autonomous-cloud-proxy.ts`: `AutonomousCloudProxyConfig` (L3), `AutonomousCloudProxyOptions` (L4).

## apps/dashboard/README.md

No drift detected.

## apps/dashboard/public/README.md

No drift detected.

## apps/mcp-server/README.md

No drift detected.

## apps/mcp-server/src/README.md

- [공개 선언 색인 누락] 아래 직접 export 선언은 코드에 있으나 이 README의 이름 색인에는 없다. 사용 타입·오류·설정·상수의 계약 추적이 빠져 있다.

  - `apps/mcp-server/src/autonomous.ts`: `AutonomousOperatorOptions` (L30).
  - `apps/mcp-server/src/autonomous-tool-audit.ts`: `ToolAuditMcpOptions` (L12).

## apps/worker/README.md

No drift detected.

## apps/worker/src/README.md

No drift detected.

## cloudflare/README.md

No drift detected.

## cloudflare/backend/README.md

- [문서 노후화] 원격 UI 연결을 후속 작업으로 설명하지만 `apps/control-plane/src/app.ts:buildApp`은 `/api/cloudflare/tasks`와 원격 운영자 proxy를 제공하고 `apps/dashboard/public/app.js`는 Cloudflare 작업 생성·상태·결과를 표시한다. 초기 슬라이스 설명과 현재 구현 경계를 갱신해야 한다.

- [인증 계약 불일치] API 절은 모든 `/v1/` 경로에 CONTROL_TOKEN을 요구한다고 적지만 `src/cloudflare/api.ts:authorizeAutonomousRoute`는 자율 작업의 worker/reporter 경로를 별도 토큰으로 인증한다. `src/cloudflare/worker.ts` 기본 fetch도 이 분기를 사용한다. 운영자 전용 경로와 자율 작업 역할별 경로를 구분해야 한다.

## cloudflare/backend/benchmark/README.md

- [고정 입력 불일치] `resource-validation/manifest.json`의 44개 파일 기록 중 2개가 현재 파일과 다르다. README.md는 선언 2201바이트/실제 2152바이트, run-shard.mjs는 선언 1755바이트/실제 1680바이트이며 SHA-256도 각각 불일치한다. 현재 `build-fixture.mjs:walk`는 README.md를 제외하지만 기존 manifest에는 README.md가 들어 있다. 고정 입력 계약을 일관되게 재생성하거나 기존 고정 바이트를 복원해야 한다. 이 2개 파일에는 이번 부트스트랩의 Git diff가 없다.

## cloudflare/backend/scripts/README.md

- [공개 선언 색인 누락] 아래 직접 export 선언은 코드에 있으나 이 README의 이름 색인에는 없다. 사용 타입·오류·설정·상수의 계약 추적이 빠져 있다.

  - `cloudflare/backend/scripts/autonomous-readiness.ts`: `FetchReadiness` (L22), `ReadinessOptions` (L23).

## cloudflare/backend/scripts/duckdb-pilot/README.md

- [공개 선언 색인 누락] 아래 직접 export 선언은 코드에 있으나 이 README의 이름 색인에는 없다. 사용 타입·오류·설정·상수의 계약 추적이 빠져 있다.

  - `cloudflare/backend/scripts/duckdb-pilot/metrics.ts`: `GuardSample` (L6).
  - `cloudflare/backend/scripts/duckdb-pilot/local-ccache.ts`: `CacheCondition` (L7).
  - `cloudflare/backend/scripts/duckdb-pilot/memory-batch.ts`: `ShardQuery` (L14).

## cloudflare/backend/scripts/resource-validation/README.md

No drift detected.

## cloudflare/backend/src/README.md

- [공개 선언 색인 누락] 아래 직접 export 선언은 코드에 있으나 이 README의 이름 색인에는 없다. 사용 타입·오류·설정·상수의 계약 추적이 빠져 있다.

  - `cloudflare/backend/src/duckdb-build-cache.ts`: `DuckdbCacheMode` (L4), `CacheArchiveEvidence` (L5), `DuckdbCacheEvidence` (L6), `duckdbCacheOrigin` (L13), `duckdbCachePath` (L14), `duckdbCacheOutputChars` (L15), `duckdbCacheMaxBytes` (L16).
  - `cloudflare/backend/src/client.ts`: `PublicRuntimeResult` (L21), `ClientCheckResult` (L22), `ClientJobResult` (L23).
  - `cloudflare/backend/src/terra-latency.ts`: `latencyPrompt` (L2), `latencySystemPrompt` (L3), `latencyExpected` (L4), `TerraGatewayTiming` (L6), `TerraClientTiming` (L14), `TerraLatencyMode` (L38), `latencySequenceTurns` (L39), `TerraSequenceTiming` (L54), `PiBenchmarkTurn` (L81), `PiBenchmarkTool` (L95), `PiBenchmarkProfile` (L96).
  - `cloudflare/backend/src/terra-gateway.ts`: `terraModel` (L5), `terraOrigin` (L6), `TerraCredential` (L8).
  - `cloudflare/backend/src/crypto.ts`: `StoredCredential` (L3).
  - `cloudflare/backend/src/npm-cache-object.ts`: `npmCacheOrigin` (L1), `npmCachePath` (L4).
  - `cloudflare/backend/src/carbon-gateway.ts`: `CarbonAdmission` (L6), `CarbonStreamError` (L68), `MeterReading` (L70).
  - `cloudflare/backend/src/large-artifact-store.ts`: `UploadRecord` (L3), `ArtifactStoreError` (L5).
  - `cloudflare/backend/src/contracts.ts`: `RalphCheckRecord` (L28), `ClaudeResultMetrics` (L60).
  - `cloudflare/backend/src/carbon-benchmark.ts`: `carbonModel` (L2), `BenchmarkInstance` (L5), `terraSizingOrder` (L6), `NpmCacheMode` (L7), `terraCachePairOrder` (L8), `CarbonEffort` (L9), `CarbonUsage` (L11), `CarbonRun` (L13), `CarbonCampaign` (L28), `CarbonOutcome` (L43).
  - `cloudflare/backend/src/evidence.ts`: `ParallelEvidence` (L3).
  - `cloudflare/backend/src/large-artifact.ts`: `LargeArtifactRef` (L1), `ArtifactReadGrant` (L4).

## cloudflare/backend/src/cloudflare/README.md

No drift detected.

## cloudflare/backend/src/runtime-shared/README.md

- [공개 선언 색인 누락] 아래 직접 export 선언은 코드에 있으나 이 README의 이름 색인에는 없다. 사용 타입·오류·설정·상수의 계약 추적이 빠져 있다.

  - `cloudflare/backend/src/runtime-shared/autonomous.ts`: `AutonomousOperatorBillingEvidence` (L6), `AutonomousCloudExecution` (L7), `AutonomousStatus` (L20), `AutonomousCheckpoint` (L22), `AutonomousNativeAuthorization` (L23), `AutonomousUsage` (L24), `AutonomousQuotaProof` (L25), `AutonomousWorkerState` (L27), `AutonomousActionRequest` (L35), `AutonomousAction` (L36), `AutonomousResource` (L40), `AutonomousIntervention` (L49).

## cloudflare/backend/src/runtime/README.md

- [공개 선언 색인 누락] 아래 직접 export 선언은 코드에 있으나 이 README의 이름 색인에는 없다. 사용 타입·오류·설정·상수의 계약 추적이 빠져 있다.

  - `cloudflare/backend/src/runtime/autonomous-from-file.ts`: `AutonomousFromFileOptions` (L68).
  - `cloudflare/backend/src/runtime/autonomous-boundary-probe.ts`: `BoundaryProbeReport` (L7), `OwnedBoundaryPath` (L31).
  - `cloudflare/backend/src/runtime/bash-diagnostic.ts`: `bashCategories` (L1), `BashCategory` (L2), `BashDiagnostic` (L20).
  - `cloudflare/backend/src/runtime/autonomous-action-mcp.ts`: `ACTION_MCP_SERVER_NAME` (L17), `ACTION_MCP_TOOL_NAME` (L18), `ACTION_MODEL_TOOL_NAME` (L19), `ACTION_MAX_BYTES` (L20), `ACTION_ARTIFACT_MAX_BYTES` (L21), `ACTION_TRANSPORT_MAX_BYTES` (L22), `ACTION_ERROR` (L23), `ActionModelRequest` (L46), `ActionPrivateInput` (L47), `ActionToolOptions` (L63), `ActionTool` (L64), `ActionMcpConfigOptions` (L260).
  - `cloudflare/backend/src/runtime/large-artifacts.ts`: `ArtifactRef` (L9), `ArtifactPreparationOptions` (L10), `ArchiveReceipt` (L11), `PreparedArtifactReceipt` (L12), `PreparedArtifacts` (L13).
  - `cloudflare/backend/src/runtime/tool-audit-spool.ts`: `SpoolStart` (L5), `SpoolEnd` (L6), `SpoolDrop` (L7).
  - `cloudflare/backend/src/runtime/terra-wire-replay.ts`: `WireReplayTiming` (L9).
  - `cloudflare/backend/src/runtime/npm-benchmark-timing.ts`: `NpmBenchmarkTiming` (L4).
  - `cloudflare/backend/src/runtime/autonomous-web-transport.ts`: `AutonomousWebSocket` (L3), `AutonomousWebConnector` (L11).
  - `cloudflare/backend/src/runtime/carbon-run.ts`: `CarbonRuntimeInput` (L20), `CarbonScore` (L21), `CarbonRoundTiming` (L23), `CarbonEvidence` (L31).
  - `cloudflare/backend/src/runtime/autonomous-tool-hook.ts`: `AutonomousPolicy` (L6).
  - `cloudflare/backend/src/runtime/providers.ts`: `ProviderPaths` (L9), `ProviderFailureReason` (L130), `TrailingEventKind` (L131), `ClaudeResultShape` (L132).
  - `cloudflare/backend/src/runtime/autonomous-large-upload.ts`: `LARGE_PART_BYTES` (L11), `LargeFileSpec` (L16), `LargeUploadedFile` (L17), `LargeBeginResult` (L19), `LargePost` (L20).
  - `cloudflare/backend/src/runtime/autonomous-bootstrap.ts`: `AutonomousBootstrapOptions` (L6).
  - `cloudflare/backend/src/runtime/claude-bash-hook.ts`: `MAX_HOOK_BYTES` (L6), `MAX_COMMAND_BYTES` (L7), `GUARD` (L8), `SandboxReceipt` (L9), `shellQuote` (L36).
  - `cloudflare/backend/src/runtime/process.ts`: `RunOptions` (L8).
  - `cloudflare/backend/src/runtime/autonomous-authorize.ts`: `NativeAuthorization` (L5).
  - `cloudflare/backend/src/runtime/tool-audit-hook.ts`: `TOOL_AUDIT_SPOOL` (L7), `ToolAuditEventName` (L10), `ToolAuditHookOptions` (L11).
  - `cloudflare/backend/src/runtime/autonomous-session.ts`: `AutonomousSessionPaths` (L8).
  - `cloudflare/backend/src/runtime/autonomous-web.ts`: `AutonomousWebPolicy` (L2), `AutonomousWebEnv` (L3), `AutonomousWebTransport` (L4), `AutonomousWebGrant` (L58).
  - `cloudflare/backend/src/runtime/autonomous-claude.ts`: `AutonomousClaudeOptions` (L21), `PrerequisiteFiles` (L50).
  - `cloudflare/backend/src/runtime/claude-guard-policy.ts`: `GuardPaths` (L1), `claudeGuardHome` (L3).
  - `cloudflare/backend/src/runtime/benchmark-resources.ts`: `BenchmarkResources` (L5).
  - `cloudflare/backend/src/runtime/claude-command-guard.ts`: `CODEX_SANDBOX_EXECUTABLE` (L9).

## cloudflare/scripts/README.md

No drift detected.

## cloudflare/scripts/phase0/README.md

- [공개 선언 색인 누락] 아래 직접 export 선언은 코드에 있으나 이 README의 이름 색인에는 없다. 사용 타입·오류·설정·상수의 계약 추적이 빠져 있다.

  - `cloudflare/scripts/phase0/collect.ts`: `CommandResult` (L3), `Runner` (L4), `Options` (L5).
  - `cloudflare/scripts/phase0/claude-receipts.ts`: `ClaudeAgentReceipt` (L1).
  - `cloudflare/scripts/phase0/rollout-receipts.ts`: `RolloutReceipt` (L1).
  - `cloudflare/scripts/phase0/gate.ts`: `Backend` (L1), `Check` (L23).
  - `cloudflare/scripts/phase0/native-thread-receipts.ts`: `NativeThreadReceipt` (L4).

## cloudflare/scripts/phase0/cloudflare/README.md

No drift detected.

## infrastructure/README.md

No drift detected.

## infrastructure/aws-external-guard/README.md

No drift detected.

## infrastructure/aws-external-guard/bin/README.md

No drift detected.

## infrastructure/aws-external-guard/lambda/README.md

No drift detected.

## infrastructure/aws-external-guard/lib/README.md

- [부수 효과 누락] `guard-stack.ts:AwsExternalGuardStack`의 `lambda.Code.fromAsset('../lambda', {exclude:['test_*.py','__pycache__','*.pyc']})`는 Markdown을 제외하지 않는다. 따라서 새 `../lambda/README.md`가 Lambda 배포 자산에 포함된다. 같은 제외 규칙의 로컬 `AssetStaging` 재현 결과는 `[README.md, guard.py]`다. README 변경도 asset hash와 이후 배포 ZIP/CodeSha256에 영향을 줄 수 있으므로 문서 계약에 이 경계를 명시해야 한다.

## packages/README.md

No drift detected.

## packages/adapters/README.md

No drift detected.

## packages/adapters/src/README.md

- [공개 선언 색인 누락] 아래 직접 export 선언은 코드에 있으나 이 README의 이름 색인에는 없다. 사용 타입·오류·설정·상수의 계약 추적이 빠져 있다.

  - `packages/adapters/src/autonomous-external.ts`: `ExternalR2PublicationBucket` (L45).

## packages/contracts/README.md

No drift detected.

## packages/contracts/src/README.md

- [공개 선언 색인 누락] 아래 직접 export 선언은 코드에 있으나 이 README의 이름 색인에는 없다. 사용 타입·오류·설정·상수의 계약 추적이 빠져 있다.

  - `packages/contracts/src/autonomous.ts`: `AutonomousStatus` (L20).
  - `packages/contracts/src/autonomous-external.ts`: `ExternalHfVisibility` (L3), `ExternalOperation` (L4), `ExternalTarget` (L5), `ExternalApprovalRequest` (L25), `ExternalParameters` (L30), `ExternalResource` (L47), `ExternalPendingObservation` (L57), `ExternalOperatorBilling` (L59), `ExternalState` (L76).
  - `packages/contracts/src/autonomous-external-s3.ts`: `ExternalS3Operation` (L2).

## packages/core/README.md

No drift detected.

## packages/core/src/README.md

- [문서 노후화] 마지막 장기 자율 작업 정책은 기존 모델 스케줄러에 자동 제출하지 않는다고 설명한다. 현재 `cloudflare/backend/src/cloudflare/worker.ts:SchedulerDO.alarm` → `advanceAutonomy` → `AutonomousCloudController.step` → `LegacyAutonomousCloudPorts.submit`은 승인·준비 조건을 통과한 자율 작업을 기존 `Scheduler.submit`에 등록한다 (`cloudflare/backend/src/cloudflare/autonomous-ports.ts:62`). 과거 독립 mock 경계와 현재 native 연결을 구분해야 한다.

## scripts/README.md

No drift detected.

## scripts/experiments/README.md

No drift detected.
