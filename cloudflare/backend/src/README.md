# src

## Overview

이 폴더는 Cloudflare 백엔드의 공유 계약과 플랫폼에 의존하지 않는 로직을 담는다.
`contracts.ts`가 작업·snapshot·런타임 입출력의 타입을 정의한다. `scheduler.ts`는 메모리 안의 작업 상태를 전이시키고 저장은 호출자에게 맡긴다. `snapshot.ts`와 `files.ts`는 소스 snapshot을 만들고 검증하며 로컬 폴더에 적용한다.
`workflow.ts`와 `compute-group.ts`는 여러 작업을 묶어 진행한다. `carbon-*.ts`, `terra-*.ts`는 벤치마크 캠페인과 모델 게이트웨이를 정의한다. `client.ts`는 운영자용 CLI다.
이 문서는 현재 코드가 정의한 내용을 기록한다. 사용 절차와 배포는 [backend README](../README.md)를 따른다.

## Interface

### 하위 폴더

- [cloudflare](./cloudflare/README.md) - Worker, Durable Object, Container, R2 연결과 HTTP 경로.
- [runtime](./runtime/README.md) - 컨테이너 안에서 실행하는 Linux 런타임.
- [runtime-shared](./runtime-shared/README.md) - 런타임 이미지에 복사하는 자율 작업 계약·검증 코드.

### 계약과 스케줄러

- `[contracts.ts:JobSpec]`, `[contracts.ts:CheckSpec]`, `[contracts.ts:JobRecord]`, `[contracts.ts:Status]`, `[contracts.ts:Provider]` - 작업 제출과 저장 상태의 타입.
- `[contracts.ts:Snapshot]`, `[contracts.ts:SourceFile]` - 소스 snapshot의 타입.
- `[contracts.ts:RuntimeInput]`, `[contracts.ts:RuntimeResult]`, `[contracts.ts:ProcessResult]` - 런타임 입출력의 타입.
- `[contracts.ts:SchedulerState]`, `[contracts.ts:CredentialRecord]`, `[contracts.ts:SealedAuth]` - 스케줄러 상태와 인증 기록의 타입.
- `[contracts.ts:RalphPolicy]`, `[contracts.ts:RalphRound]`, `[contracts.ts:RalphCheckpoint]`, `[contracts.ts:RalphFeedback]` - 반복 실행(Ralph)의 타입.
- `[contracts.ts:terminal]` - 상태가 종료 상태인지 판정한다.
- `[scheduler.ts:Scheduler]` - 메서드는 `submit`, `enqueueCompute`, `registerCredential`, `dispatch`, `running`, `agentFinished`, `computeFinished`, `quarantine`, `failUnstartedNative`, `requestCancel`, `expire`, `get`, `list`다.
- `[scheduler.ts:validateJobSpec]`, `[scheduler.ts:validateCheckSpec]`, `[scheduler.ts:validateModelSelection]` - 제출 입력을 검증한다.
- `[scheduler.ts:SchedulerError]`, `[scheduler.ts:AgentOutcome]`, `[scheduler.ts:ComputeOutcome]` - 오류와 완료 보고의 타입.

### snapshot과 파일

- `[snapshot.ts:createSnapshot]`, `[snapshot.ts:validateSnapshot]`, `[snapshot.ts:snapshotDigest]`, `[snapshot.ts:sha256]` - snapshot을 만들고 digest를 검증한다.
- `[snapshot.ts:canonicalSourcePath]`, `[snapshot.ts:excludedSourcePath]` - 경로를 정규화하고 비공개 경로를 제외한다.
- `[snapshot.ts:MAX_SOURCE_BYTES]`, `[snapshot.ts:MAX_SOURCE_FILES]` - 4MiB, 1,000파일.
- `[files.ts:readSnapshot]`, `[files.ts:restoreSnapshot]`, `[files.ts:applySnapshot]` - 폴더를 snapshot으로 읽고, 빈 폴더에 복원하고, 차이를 소스 폴더에 적용한다.

### 작업 묶음

- `[workflow.ts:validateWorkflowSpec]`, `[workflow.ts:advanceWorkflow]`, `[workflow.ts:mergeWorkflowOutputs]`, `[workflow.ts:changedPaths]`, `[workflow.ts:workflowFingerprint]` - 두 워커의 workflow를 검증·진행하고 결과를 합친다.
- `[workflow.ts:WorkflowSpec]`, `[workflow.ts:WorkflowWorker]`, `[workflow.ts:WorkflowRecord]` - workflow의 타입.
- `[compute-group.ts:validateComputeGroupSpec]`, `[compute-group.ts:advanceComputeGroup]`, `[compute-group.ts:assignGroup]` - compute group을 검증하고 진행한다.
- `[compute-group.ts:ComputeGroupSpec]`, `[compute-group.ts:ComputeGroupRecord]` - compute group의 타입.

### 인증, 큰 입력, 캐시

- `[crypto.ts:validateAuth]`, `[crypto.ts:sealCredential]`, `[crypto.ts:openCredential]`, `[crypto.ts:openAuthReturn]` - 구독 인증을 검증하고 암호화·복호화한다.
- `[large-artifact.ts:validateLargeArtifactRef]`, `[large-artifact.ts:validateLargeArtifacts]`, `[large-artifact.ts:authorizeArtifactRead]`, `[large-artifact.ts:largeArtifactKey]` - large artifact 참조를 검증하고 읽기 권한을 판정한다.
- `[large-artifact.ts:PART_BYTES]`, `[large-artifact.ts:MAX_ARTIFACT_BYTES]` - 8MiB, 8GiB.
- `[large-artifact-store.ts:LargeArtifactStore]` - 메서드는 `head`, `begin`, `part`, `complete`, `abort`다. R2 multipart 업로드를 관리한다.
- `[duckdb-build-cache.ts:duckdbCacheMode]`, `[duckdb-build-cache.ts:duckdbCacheIdentity]`, `[duckdb-build-cache.ts:validateDuckdbCacheEvidence]` - DuckDB 빌드 캐시의 모드, 키, receipt 검증.
- `[npm-cache-object.ts:npmCacheKey]`, `[npm-cache-object.ts:npmCacheMaxBytes]`, `[npm-cache-object.ts:npmCacheLockPath]` - npm 캐시 객체의 키와 상한.

### 벤치마크와 게이트웨이

- `[carbon-benchmark.ts:advanceCarbonCampaign]`, `[carbon-benchmark.ts:reserveCarbonRequest]`, `[carbon-benchmark.ts:settleCarbonRequest]` - 캠페인을 진행하고 비용을 예약·정산한다.
- `[carbon-benchmark.ts:readCarbonUsage]`, `[carbon-benchmark.ts:carbonUsageMicros]`, `[carbon-benchmark.ts:carbonRunBudget]`, `[carbon-benchmark.ts:carbonCampaignBudget]` - 사용량 해석과 예산 상수.
- `[carbon-gateway.ts:handleCarbonGateway]`, `[carbon-gateway.ts:meterStream]`, `[carbon-gateway.ts:syntheticCarbonStream]` - Gemini 스트림 요청을 검증·전달·계량한다.
- `[terra-gateway.ts:handleTerraGateway]`, `[terra-gateway.ts:terraCredential]`, `[terra-gateway.ts:syntheticTerraStream]` - Terra 요청을 검증·전달·계량한다.
- `[terra-latency.ts:readTerraClientTiming]`, `[terra-latency.ts:readTerraSequenceTimings]`, `[terra-latency.ts:readPiBenchmarkProfile]`, `[terra-latency.ts:latencySequence]` - 지연 측정용 프롬프트와 stderr 줄 해석.
- `[claude-result-metrics.ts:extractClaudeResultMetrics]`, `[claude-result-metrics.ts:validateClaudeResultMetrics]` - Claude의 마지막 결과가 보고한 계측값을 정제한다.
- `[evidence.ts:nativeParallelEvidence]` - native subagent 실행 구간의 겹침을 계산한다.

### 운영자 CLI

- `[client.ts:createClient]` - 메서드는 `upload`, `submit`, `get`, `result`, `draftWorkflow`, `approveWorkflow`, `getWorkflow`다.
- `[client.ts:runClientCli]` - 하위 명령은 `snapshot`, `upload`, `submit`, `get`, `result`, `apply`, `workflow-draft`, `workflow-approve`, `workflow-get`, `workflow-result`다. `HIVEMIND_URL`과 `HIVEMIND_CONTROL_TOKEN`을 읽는다.

### 영속 스케줄러와 자율 작업

- `[scheduler-storage.ts:SchedulerStoragePort]`, `SchedulerStorage`, `createSchedulerStorage`, `loadSchedulerState`, `schedulerLegacyByteLength`: 주입한 비동기 storage에 상태를 저장·복원하고 작업 요약 페이지를 제공한다. `SCHEDULER_STATE_NORMAL_BYTES`, `SCHEDULER_STATE_HARD_BYTES`, `SCHEDULER_STATE_LEGACY_BYTES`는 각각 30MiB·32MiB·2MiB다.
- `[scheduler-jobs.ts:SchedulerJobQuery]`, `JobSummary`, `SchedulerJobPage`, `pageSchedulerJobs`: 작업 상세 본문 없이 순서·서명 cursor에 따른 요약 페이지를 반환한다.
- `[autonomous-service.ts:AutonomousService]`: `execute`, `tick`, `supportsLongRunning`으로 공통 `AutonomousEngine`을 Durable Object storage에 연결한다. core 엔진과 API 연산은 저장소의 `/packages/core/src/autonomous.ts`, `/apps/control-plane/src/autonomous-api.ts`에서 가져온다. `AutonomousStorage`, `AutonomousStorageCapacityError`, `AUTONOMOUS_STATE_MAX_BYTES`, `AUTONOMOUS_STATE_HARD_MAX_BYTES`가 저장 계약이다.
- `[autonomous-cloud.ts:AutonomousCloudController]`: `status`, `step`으로 claim·제출·조회·완료·복구를 짧은 영속 단계로 진행한다. `AutonomousCloudRecord`, `AutonomousCloudSubmission`, `AutonomousCloudPoll`, `AutonomousCloudPorts`, `AutonomousCloudOptions`가 단계 상태와 주입 포트 계약이다.
- `[autonomous-cloud-protocol.ts:AutonomousCloudInput]`, `AutonomousCloudOutput`, `SealedAuth`, `AUTONOMOUS_CLOUD_MAX_BYTES`, `validateAutonomousCloudInput`, `validateAutonomousCloudOutput`: 비공개 native 입출력 envelope를 검증한다. 이 파일의 `SealedAuth`는 별도 선언이며 `contracts.ts`에도 같은 이름의 타입이 있다.
- `[autonomous-session-objects.ts:PrivateR2Bucket]`, `R2PrivateBlobStore`: `durable=true`인 private session blob 저장 포트다. `get`, `put`만 제공하며 명시적으로 받은 비공개 bucket을 사용한다.
- `[autonomous-external.ts:ExternalEnvironment]`, `ExternalArtifactBucket`, `ExternalRuntimeOptions`, `AutonomousExternalRuntime`, `createAutonomousExternalRuntime`: 신뢰된 설정·core·SQL·artifact bucket으로 외부 행동 runtime을 구성한다. 반환값은 `enabled`, `service`, `configurationFingerprint`, 선택적 `large`, `configuredSecretValues`, `recover`, `cleanupDue`다.
- `[autonomous-external.ts:createExternalArtifactLoader]`, `externalConfiguredSecretValues`, `openLargeFor`: 제한된 artifact 읽기, 비공개 안전 검사 입력과 owner에 결속된 대형 파일 읽기를 제공한다. 비밀 값 목록은 공개 응답용이 아니다.

## Invariants

- 종료 상태는 `SUCCEEDED`, `FAILED`, `CANCELLED`, `TIMED_OUT`, `NEEDS_REAUTH`, `AUTH_SYNC_FAILED`다. `[contracts.ts:terminal]`
- 동시에 실행하는 agent 작업은 최대 2개, compute 작업은 최대 4개다. `[scheduler.ts:Scheduler.dispatch]`
- 인증 하나는 한 번에 agent 작업 하나에만 배정한다. 격리된 인증은 건너뛴다. `[scheduler.ts:Scheduler.dispatch]`
- 같은 `idempotencyKey`로 다른 내용을 제출하면 409다. `[scheduler.ts:Scheduler.submit]`
- 작업은 checks 1-4개, `instructions` 24,000자 이하, `timeoutMs` 1,000 이상 3,600,000 이하다. `[scheduler.ts:validateJobSpec]`
- check의 `argv`는 1-32개이고 각 1,000자 이하다. `[scheduler.ts:validateCheckSpec]`
- `model`과 `effort`는 함께 지정한다. Claude는 `xhigh`를 받지 않는다. `[scheduler.ts:validateModelSelection]`
- 인증 회수는 컨테이너 종료 확인과 `authGeneration`이 기존 값보다 1 큰 경우에만 유효하다. 아니면 인증을 격리한다. `[scheduler.ts:Scheduler.agentFinished]`
- 부모 작업은 모든 check가 부모의 출력 snapshot에서 성공해야 `SUCCEEDED`가 된다. `[scheduler.ts:Scheduler.settleParent]`
- 같은 작업·시도의 완료 보고가 다른 내용으로 다시 오면 거부한다. `[scheduler.ts:Scheduler.agentFinished]`
- snapshot은 1,000파일, 4MiB 이하다. 경로는 512자 이하의 상대 경로이며 `.`·`..` 구간을 받지 않는다. `[snapshot.ts:canonicalSourcePath]`, `[snapshot.ts:MAX_SOURCE_FILES]`, `[snapshot.ts:MAX_SOURCE_BYTES]`
- `.git`, `.hivemind`, `node_modules`, `auth.json`, `.env*`, `*.pem` 등 비공개 경로는 snapshot에서 제외한다. `[snapshot.ts:excludedSourcePath]`
- `applySnapshot`은 현재 소스의 digest가 기준 snapshot과 같을 때만 적용한다. 실패하면 이미 쓴 파일을 되돌리되 동시 수정으로 rollback이 충돌하면 비공개 backup을 남긴다. `[files.ts:applySnapshot]`
- workflow는 워커가 정확히 2개이고 제공자와 `credentialId`가 서로 달라야 한다. 계약 경로와 쓰기 경로는 서로 겹치지 않아야 한다. `[workflow.ts:validateWorkflowSpec]`
- 각 워커는 자기 쓰기 범위 안의 파일만 바꿔야 한다. 범위를 벗어나면 병합을 거부한다. `[workflow.ts:mergeWorkflowOutputs]`
- compute group은 `concurrency`가 1·2·4, `instance`가 `standard-1`·`standard-3`·`standard-4`, checks가 1-4개다. `[compute-group.ts:validateComputeGroupSpec]`
- Claude 인증은 OAuth 토큰 형식만, Codex 인증은 `auth_mode`가 `chatgpt`이고 `OPENAI_API_KEY`가 없으며 `tokens.access_token`과 `tokens.refresh_token`이 비어 있지 않은 문자열인 경우만 허용한다. `[crypto.ts:validateAuth]`
- 인증 암호화 키는 정확히 32바이트다. 복호화는 `id`와 `generation`이 일치해야 한다. `[crypto.ts:sealCredential]`, `[crypto.ts:openCredential]`
- large artifact는 `source`(tar.gz, 압축 1GiB·해제 2GiB 이하)와 `data`(file, 8GiB 이하)만 받는다. `maxFiles`는 100,000 이하다. `[large-artifact.ts:validateLargeArtifactRef]`
- large artifact 읽기는 compute 작업의 `id`·`attempt`가 권한과 같고, 상태가 `STARTING` 또는 `RUNNING`이며, 컨테이너가 멈추지 않았고, 취소 요청이 없고, 권한과 작업 deadline 전이고, 요청한 digest가 작업의 large artifact에 있을 때만 허용한다. `[large-artifact.ts:authorizeArtifactRead]`
- 저장소는 내용 해시를 검증하지 않고 `contentHashVerification: 'runtime-required'`를 반환한다. `[large-artifact-store.ts:LargeArtifactStore.head]`
- 비용 예약은 실행당 5,000,000 micros, 캠페인당 20,000,000 micros를 넘으면 거부한다. `[carbon-benchmark.ts:reserveCarbonRequest]`
- 사용량을 확인하지 못한 요청은 예약액 전부를 지출로 반영하고 해당 실행을 막는다. `[carbon-benchmark.ts:settleCarbonRequest]`
- Gemini 게이트웨이는 고정 경로의 POST만 받고 본문은 1MiB 이하다. 스트림의 `modelVersion`이 다르면 중단한다. `[carbon-gateway.ts:handleCarbonGateway]`, `[carbon-gateway.ts:meterStream]`
- Terra 게이트웨이는 `terraEndpoint`의 POST만 받고 본문은 8MiB 이하다. `[terra-gateway.ts:handleTerraGateway]`
- `client.ts`의 `apply`는 `SUCCEEDED` 작업만 허용한다. 서버 URL은 https이거나 로컬 호스트의 http여야 한다. `[client.ts:runClientCli]`, `[client.ts:createClient]`

- `[scheduler.ts:Scheduler.failUnstartedNative]`는 신뢰된 `containerStopped:true`, `neverLaunched:true` 증명과 해당 autonomous STARTING 작업·credential 소유권이 맞을 때만 인증을 회수한다. 이미 실행된 작업의 일반 실패 경로로 쓰지 않는다.
- `[scheduler-storage.ts:createSchedulerStorage]`는 transaction이 있는 storage에서 instruction pool·chunk·generation manifest를 원자적으로 바꾼다. 새 root 작업 등이 추가되지 않는 복구 저장만 32MiB를 쓰며 일반 admission은 30MiB다. history 제거와 generation이 달라진 writer를 거절한다.
- `[scheduler-storage.ts:createSchedulerStorage]`는 v2 이관 뒤 legacy `state`를 수정하지 않는다. transaction이 사라진 adapter로 v2 상태를 읽거나 쓸 수 없으며 구버전 rollback용 snapshot으로 legacy 키를 사용하지 않는다.
- `[scheduler-jobs.ts:pageSchedulerJobs]`는 limit 1~100, 기본 20을 적용하고 HMAC cursor를 작업 요약 scope와 최초 상한에 결속한다. `[autonomous-service.ts:AutonomousService]`는 task summary·request index·credential owner를 전체 catalog와 대조한다.
- `[autonomous-service.ts:AutonomousService.partitioned]`는 transaction storage에서 task별 chunk와 catalog를 원자적으로 저장한다. 일반 30MiB·복구 32MiB 합계 한도이며 tick은 만기가 된 task 최대 25개를 읽는다. transaction 없는 legacy 경로는 일반 1536KiB·복구 1900KiB이고 long_running을 거절한다.
- `[autonomous-cloud.ts:AutonomousCloudController]`는 제출 전에 polling marker와 고정 job ID를 저장한다. 응답 유실 뒤 submit을 재전송하지 않는다. 불명확한 실행은 pause·취소·정확한 소유권의 credential 격리·`abandonCloud`로 처리한다.
- `[autonomous-cloud-protocol.ts:validateAutonomousCloudInput]`는 16MiB envelope, 서로 다른 worker/reporter token, HTTPS control origin, native lease·모델·session의 필드 모양을 검사한다. 최초 snapshot은 64KiB·32파일 이하이고 sequence 0에만 제공한다. `[autonomous-cloud-protocol.ts:validateAutonomousCloudOutput]`는 Linux·no-new-privileges·capabilities 제거 증거와 quota checkpoint 모양을 검사한다.
- `[autonomous-session-objects.ts:R2PrivateBlobStore.put]`는 키·크기를 검증하고 `etagDoesNotMatch:'*'`로 덮어쓰기를 막는다. `get`은 선언 크기와 실제 바이트 수를 대조하며 오류 세부 정보를 정리한다.
- `[autonomous-external.ts:createAutonomousExternalRuntime]`는 명시적 설정만 사용한다. 새 외부 행동은 전역·profile·provider 활성화와 credential을 요구하며 AWS 시작은 TTL guard와 설정된 비용 정책도 필요하다. 현재 설정이 바뀌어도 복구는 저장된 과거 provider 정책으로 읽기·정리만 수행하며 timer를 새로 만들지 않는다.
- `[autonomous-external.ts:configuration]`는 HF LFS 공개 게시의 `allowPublicLarge:true`, 명시적 upload host와 크기 한도를 요구한다. 대형 업로드는 multipart bucket·영속 ledger·manifest ledger를 모두 갖춰야 연결한다. `[autonomous-external.ts:openLargeFor]`는 task/revision/profile owner로 파일을 연다.
- `[autonomous-external.ts:cleanupDue]`는 한 번에 기본 20개·최대 100개 journal을 진행한다. 실패는 비용 0으로 확정하지 않고 backoff로 재조회하며 비용 초과는 core의 `stopExternalBudget`으로 전달한다.

## Side Effects

- `scheduler.ts`, `snapshot.ts`, `contracts.ts`, `large-artifact.ts`, `terra-latency.ts`, `evidence.ts`는 저장소·네트워크·환경에 접근하지 않는다. `Scheduler`는 메모리 상태만 바꾼다. `[scheduler.ts:Scheduler]`
- R2: multipart 업로드를 만들고 완료·중단한다. 업로드 기록은 주입받은 storage에 저장한다. `[large-artifact-store.ts:LargeArtifactStore]`
- 네트워크: Gemini API로 요청을 전달한다. `[carbon-gateway.ts:handleCarbonGateway]`
- 네트워크: Terra 요청을 상류 호스트로 전달한다. `[terra-gateway.ts:handleTerraGateway]`
- 네트워크: 운영자 CLI가 `HIVEMIND_URL`의 `/v1/` 경로를 호출한다. `[client.ts:createClient]`
- 파일: 폴더를 읽고, 빈 폴더에 파일을 쓰고, 소스 폴더의 파일을 바꾼다. 적용 중 `.hivemind/apply.lock`을 만든다. `[files.ts:readSnapshot]`, `[files.ts:restoreSnapshot]`, `[files.ts:applySnapshot]`
- 파일: 운영자 CLI가 `--out` 파일을 쓰고 JSON을 stdout에 출력한다. `[client.ts:runClientCli]`
- 상태 변경: workflow와 compute group 진행이 스케줄러의 `requestCancel`, `enqueueCompute`를 호출한다. `[workflow.ts:advanceWorkflow]`, `[compute-group.ts:advanceComputeGroup]`

- Durable storage: `[scheduler-storage.ts:createSchedulerStorage]`는 `scheduler:manifest`, generation별 `scheduler:chunk:*`, 작업 페이지 순서·서명 secret을 저장하고 이전 generation chunk를 지운다. transaction 없는 legacy 경로는 `state`를 사용한다.
- Durable storage: `[autonomous-service.ts:AutonomousService]`는 legacy `autonomous-state` 또는 `autonomous:catalog`, task manifest·chunk·request index·credential owner를 저장한다. `AutonomousCloudController`는 비공개 `autonomous-cloud:<taskId>` 단계를 저장하며 주입 포트의 submit·poll·cancel·quarantine을 호출한다. [autonomous-cloud.ts:`AutonomousCloudController`]
- 비공개 R2: `[autonomous-session-objects.ts:R2PrivateBlobStore]`는 명시적으로 받은 bucket의 `autonomous-sessions/` prefix를 읽고 쓴다. 공개 ARTIFACTS 접근 포트는 없다.
- 외부 행동: `[autonomous-external.ts:createAutonomousExternalRuntime]`는 공통 ExternalBroker·SQL 저장소·provider transport·credential resolver를 연결한다. 생성 자체는 provider를 호출하지 않으며 이후 service/recover/cleanup은 승인된 provider 조회·실행·정리를 호출할 수 있다. `createLargeManifestStore`는 SQL `external_large_manifests`를 만들고 manifest를 저장한다.

## Verification

- Run: `npm test` (`cloudflare/backend/`에서 실행. `node --test test/*.test.ts`)
- Run: `npm run typecheck` (`cloudflare/backend/`에서 실행. `tsc --noEmit`)
- 이 폴더의 `.ts`, `.mjs`, `.py` 파일은 runtime manifest 입력이다. 변경 시 `npm run runtime:check`로 확인한다. 이 디렉터리의 README는 digest 입력이 아니다. [../scripts/runtime-build.ts:`buildRuntimeManifest`, `trees`]
