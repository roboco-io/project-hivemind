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

### 계약과 스케줄러

- `[contracts.ts:JobSpec]`, `[contracts.ts:CheckSpec]`, `[contracts.ts:JobRecord]`, `[contracts.ts:Status]`, `[contracts.ts:Provider]` - 작업 제출과 저장 상태의 타입.
- `[contracts.ts:Snapshot]`, `[contracts.ts:SourceFile]` - 소스 snapshot의 타입.
- `[contracts.ts:RuntimeInput]`, `[contracts.ts:RuntimeResult]`, `[contracts.ts:ProcessResult]` - 런타임 입출력의 타입.
- `[contracts.ts:SchedulerState]`, `[contracts.ts:CredentialRecord]`, `[contracts.ts:SealedAuth]` - 스케줄러 상태와 인증 기록의 타입.
- `[contracts.ts:RalphPolicy]`, `[contracts.ts:RalphRound]`, `[contracts.ts:RalphCheckpoint]`, `[contracts.ts:RalphFeedback]` - 반복 실행(Ralph)의 타입.
- `[contracts.ts:terminal]` - 상태가 종료 상태인지 판정한다.
- `[scheduler.ts:Scheduler]` - 메서드는 `submit`, `enqueueCompute`, `registerCredential`, `dispatch`, `running`, `agentFinished`, `computeFinished`, `quarantine`, `requestCancel`, `expire`, `get`, `list`다.
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
- `applySnapshot`은 현재 소스의 digest가 기준 snapshot과 같을 때만 적용한다. 실패하면 이미 쓴 파일을 되돌린다. `[files.ts:applySnapshot]`
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

## Side Effects

- `scheduler.ts`, `snapshot.ts`, `contracts.ts`, `large-artifact.ts`, `terra-latency.ts`, `evidence.ts`는 저장소·네트워크·환경에 접근하지 않는다. `Scheduler`는 메모리 상태만 바꾼다. `[scheduler.ts:Scheduler]`
- R2: multipart 업로드를 만들고 완료·중단한다. 업로드 기록은 주입받은 storage에 저장한다. `[large-artifact-store.ts:LargeArtifactStore]`
- 네트워크: Gemini API로 요청을 전달한다. `[carbon-gateway.ts:handleCarbonGateway]`
- 네트워크: Terra 요청을 상류 호스트로 전달한다. `[terra-gateway.ts:handleTerraGateway]`
- 네트워크: 운영자 CLI가 `HIVEMIND_URL`의 `/v1/` 경로를 호출한다. `[client.ts:createClient]`
- 파일: 폴더를 읽고, 빈 폴더에 파일을 쓰고, 소스 폴더의 파일을 바꾼다. 적용 중 `.hivemind/apply.lock`을 만든다. `[files.ts:readSnapshot]`, `[files.ts:restoreSnapshot]`, `[files.ts:applySnapshot]`
- 파일: 운영자 CLI가 `--out` 파일을 쓰고 JSON을 stdout에 출력한다. `[client.ts:runClientCli]`
- 상태 변경: workflow와 compute group 진행이 스케줄러의 `requestCancel`, `enqueueCompute`를 호출한다. `[workflow.ts:advanceWorkflow]`, `[compute-group.ts:advanceComputeGroup]`

## Verification

- Run: `npm test` (`cloudflare/backend/`에서 실행. `node --test test/*.test.ts`)
- Run: `npm run typecheck` (`cloudflare/backend/`에서 실행. `tsc --noEmit`)
- 이 폴더의 `.ts`, `.mjs`, `.py` 파일을 바꾸면 `runtime-build.json`의 `digest`가 달라진다. `npm run runtime:check`로 확인한다.
