# adapters/src

## Overview

이 디렉터리는 중앙 core가 정한 계약을 실제 실행으로 옮기는 어댑터를 담는다. 어댑터는 승인이나 상태 전이를 결정하지 않는다. 어댑터는 실행하고 근거를 반환하며, 근거를 받아들일지는 중앙 core가 판단한다. 계약 타입은 [`../../contracts/src/README.md`](../../contracts/src/README.md)에, 판단 규칙은 [`../../core/src/README.md`](../../core/src/README.md)에 있다.

기본 실행 어댑터는 두 종류이며, 장기 자율 작업·외부 행동 어댑터도 이 디렉터리에 있다. 첫째는 로컬 실행 어댑터다. `index.ts`가 `provider`에 맞는 어댑터를 고르고, `codex.ts`와 `claude.ts`가 각 CLI를 자식 프로세스로 실행하며, `local-execution.ts`가 worktree 생성, 설정 명령, 테스트 명령, diff 수집 순서를 공통으로 처리한다. 둘째는 Cloudflare 포트다. `cloudflare.ts`는 작업 한 건을 원격 백엔드에 제출하고 폴링하며, `cloud-workflow.ts`는 Codex와 Claude 두 워커의 워크플로를 원격 백엔드에 등록하고 조회한다. `process.ts`와 `workspace.ts`는 두 종류가 함께 쓰는 프로세스 실행과 Git worktree 도구다.

## Interface

- `[index.ts:getAdapter]`: `provider`에 맞는 `AgentAdapter`를 반환한다. `mock`은 옵션 없이 동작한다. `codex`와 `claude`는 옵션이 없으면 오류를 던진다.
- `[codex.ts:CodexOptions]`, `[codex.ts:createCodexAdapter]`: `codex exec --json`을 실행하고 JSON Lines 이벤트를 읽는 어댑터.
- `[claude.ts:ClaudeOptions]`, `[claude.ts:createClaudeAdapter]`: `claude --print --output-format json`을 실행하고 결과 객체를 읽는 어댑터.
- `[local-execution.ts:LocalExecutionOptions]`: `repositoryPath`, `worktreeRoot`, `repositoryId`, `model`, `testCommand`, `setupCommand`, `timeoutMs`, `testTimeoutMs`.
- `[local-execution.ts:AgentInvocation]`, `[local-execution.ts:LocalProvider]`, `[local-execution.ts:InvokeAgent]`: 에이전트 호출 결과와 호출 함수의 타입.
- `[local-execution.ts:taskPrompt]`: 작업 제목과 지시를 에이전트 프롬프트로 만든다.
- `[local-execution.ts:createLocalAdapter]`, `[local-execution.ts:executeLocalTask]`: 로컬 실행 공통 절차.
- `[process.ts:ProcessOptions]`, `[process.ts:runProcess]`: 셸 없이 명령을 실행하고 `ProcessEvidence`를 반환한다.
- `[process.ts:processEnvironment]`: 자식 프로세스에 전달할 환경 변수를 허용 목록으로 만든다.
- `[workspace.ts:Workspace]`, `[workspace.ts:WorkspaceOptions]`, `[workspace.ts:createWorkspace]`: 고정 커밋에서 분리된(detached) Git worktree를 만든다.
- `[workspace.ts:collectWorkspaceDiff]`: worktree의 변경을 기준 커밋과 비교한 diff와 `headCommit`을 반환한다.
- `[cloudflare.ts:CloudPortOptions]`, `[cloudflare.ts:createCloudPort]`: `CloudPort`(`connection`, `prepare`, `submit`, `poll`, `cancel`) 구현.
- `[cloud-workflow.ts:WorkflowChecks]`, `[cloud-workflow.ts:createCloudWorkflowPort]`: `CloudWorkflowPort`(`draft`, `approve`, `read`) 구현.

- `[autonomous-runner.ts:createAutonomousHttpClient]`, `[autonomous-runner.ts:AutonomousWorkerClient]`, `[autonomous-runner.ts:runAutonomousIteration]`, `[autonomous-runner.ts:AutonomousIterationOptions]`, `[autonomous-runner.ts:AutonomousExecutor]`, `[autonomous-runner.ts:AutonomousExecutionContext]` - 워커 권한 HTTP, 단일 반복, 제한된 실행 context다. `PrivateSession`, `PrivateSessionStore`, `MemorySessionStore`, `UnsupportedAutonomousCapabilityError`는 비공개 세션과 미지원 경계를 정의한다.
- `[autonomous-runner.ts:runAutonomousCleanup]`, `[autonomous-runner.ts:AutonomousCleanupClient]` - 실행자와 분리된 신뢰 정리 포트다.
- `[autonomous-loop.ts:runAutonomousLoop]`, `[autonomous-loop.ts:AutonomousLoopOptions]`, `[autonomous-loop.ts:AutonomousLoopResult]`, `[autonomous-loop.ts:AutonomousLoopReason]` - 명시적 반복·idle 한도와 대기 간격을 가진 실행 루프다.
- `[autonomous-session-store.ts:EncryptedSessionStore]`, `[autonomous-session-store.ts:PrivateBlobStore]`, `[autonomous-session-store.ts:MAX_PRIVATE_BLOB_BYTES]`, `[autonomous-session-store.ts:validatePrivateBlobKey]`, `[autonomous-session-file.ts:FilePrivateBlobStore]` - 암호화 세션 저장과 로컬 비공개 blob 저장 포트다.
- `[autonomous-claude.ts:createClaudeAutonomousExecutor]`, `[autonomous-claude.ts:createClaudeRuntimeHttpPort]` - Claude 구독 인증과 고정 세션을 private runtime으로 전달하고 응답의 경계·identity·사용량을 검증한다.
- `[autonomous-external.ts:ExternalProviderCredential]`, `[autonomous-external.ts:ExternalArtifact]`, `[autonomous-external.ts:validateExternalArtifact]`, `[autonomous-external.ts:externalArtifactDigest]`, `[autonomous-external.ts:ExternalArtifactPublisher]`, `[autonomous-external.ts:ExternalArtifactLoader]` - 외부 게시물과 인증 전용 타입·검증·digest 계약이다. `createExternalR2ArtifactPublisher`, `createExternalR2ArtifactLoader`는 `external-artifacts/` 저장 포트 구현이다.
- `[autonomous-external.ts:createExternalProviderTransport]`, `[autonomous-external.ts:ExternalProviderOptions]`, `[autonomous-external.ts:ExternalHfLfsConfig]`, `[autonomous-external.ts:externalAwsConfigurationHash]`, `[autonomous-external.ts:ExternalAwsLaunchPolicy]` - 고정 AWS/HF/GitHub/S3 대상의 실행·조회·정리 구현과 launch 정책 digest다.
- `[autonomous-external.ts:AwsTtlGuardPort]`, `[autonomous-external.ts:AwsTtlGuardRequest]`, `[autonomous-external.ts:AwsTtlGuardEvidence]`, `[autonomous-external.ts:AwsOwnershipTimerEvidence]` - 기존 AWS TTL guard 검증과 소유 만료 timer의 포트다.
- `[autonomous-aws-guard.ts:createAwsTtlGuardPort]`, `[autonomous-aws-guard.ts:awsGuardPolicies]`, `[autonomous-aws-guard.ts:awsGuardCanonical]`, `[autonomous-aws-guard.ts:awsGuardDigest]` - 원격 guard 검증·timer 생성과 CDK가 공유하는 정책 함수다. `AwsGuardOptions`, `AwsGuardManifest`, `AwsGuardProfile`, `AwsGuardRole`은 서버 설정이다.
- `[autonomous-external-cost.ts:createExternalCostCache]`, `[autonomous-external-cost.ts:createAwsCostExplorerReader]`, `[autonomous-external-cost.ts:ExternalCostReader]`, `[autonomous-external-cost.ts:ExternalCostCache]`, `[autonomous-external-cost.ts:AwsCostExplorerOptions]` - 영속 조회 횟수 제한과 선택적 AWS 비용 근거 포트다. `ExternalCostQuote`, `ExternalCostResult`는 상한과 확인 비용을 분리한다.
- `[autonomous-external-s3.ts:signExternalS3Request]`, `[autonomous-external-s3.ts:createExternalS3Transport]`, `[autonomous-external-s3.ts:ExternalS3SignInput]`, `[autonomous-external-s3.ts:ExternalS3TransportOptions]`, `[autonomous-external-s3.ts:ExternalS3Transport]` - 고정 virtual-hosted S3 PUT/HEAD 서명과 전송이다.
- `[autonomous-external-large-store.ts:createExternalLargeStore]`, `[autonomous-external-large-store.ts:ExternalLargeStore]`, `[autonomous-external-large-store.ts:ExternalLargeStoreOptions]`, `[autonomous-external-large-store.ts:ExternalLargeStoreError]` - `begin`, `part`, `complete`, `abort`, `abortOwner`, `open` 대형 파일 저장 API다. `ExternalLargeBucket`, `ExternalLargeMultipart`, `ExternalLargeRecordPort`, `ExternalLargeUploadRecord`, `ExternalLargeOwner`, `ExternalLargeBegin`, `ExternalLargePartInfo`가 주입·응답 계약이다.
- `[autonomous-external-large-sql.ts:createExternalLargeRecordPort]` - SQL 업로드 원장이다. `[autonomous-external-large-store.ts:LARGE_MAX_UPLOAD_RECORDS]`, `[autonomous-external-large-store.ts:LARGE_UPLOAD_RECORDS_CEILING]`은 작업 revision별 기본 64개·최대 256개 레코드 한도다.
- `[autonomous-external-hf-lfs.ts:hfLfsCommit]`, `[autonomous-external-hf-lfs.ts:hfLfsProof]`, `[autonomous-external-hf-lfs.ts:lfsPointer]`, `[autonomous-external-hf-lfs.ts:HfLfsInvocation]`, `[autonomous-external-hf-lfs.ts:HfLfsOptions]` - HTTP LFS 게시·읽기 복구·pointer 계약이다. `HF_REGULAR_MAX_BYTES`는 16MiB, `HF_LFS_MAX_FILE_BYTES`는 5GiB다.
- `[autonomous-external-hf-preflight.ts:preflightHfFiles]` - 게시 전에 파일 크기·SHA-256·알려진 비밀과 일반 자격 증명 패턴을 스트리밍 검사한다.
- `[autonomous-external-hf-visibility.ts:HfVisibility]`, `[autonomous-external-hf-visibility.ts:resolveHfVisibility]`, `[autonomous-external-hf-visibility.ts:assertHfVisibility]`, `[autonomous-external-hf-visibility.ts:hfVisibilityDisplay]`, `[autonomous-external-hf-visibility.ts:assertHfLfsAllowed]` - 생략 시 private 규칙과 공개 대형 게시의 명시적 동의를 검증한다.

## Invariants

로컬 실행:

- `[index.ts:mock]`은 합성 diff와 모의 비용(`actualCostMicros: 1000`)만 반환한다. 저장소를 변경하지 않으며 요약에 그 사실을 적는다.
- `[local-execution.ts:executeLocalTask]`는 작업의 `provider`, `runtime`(`local`), `repositoryId`, `testProfile`(`default`), `runId`, `baseCommit`이 설정과 맞지 않으면 실행하지 않는다. 작업의 `testCommand`가 워커 설정의 `testCommand`와 다르면 실행하지 않는다.
- `[local-execution.ts:executeLocalTask]`는 에이전트 상태가 `passed`일 때만 설정 명령과 테스트 명령을 실행한다. 그렇지 않으면 테스트 근거는 `not_run`이다.
- `[local-execution.ts:executeLocalTask]`가 반환하는 `actualCostMicros`는 항상 `null`이다. 성공 조건은 에이전트, 설정, 테스트가 모두 `passed`이고 `headCommit`이 `baseCommit`과 같은 것이다. 에이전트가 커밋을 만들면 실패로 처리한다.
- `[local-execution.ts:validCommand]`는 명령이 1-32개의 인자이고, 각 인자가 공백만이 아니며 1000자 이하이고 NUL 문자가 없을 때만 허용한다.
- `[codex.ts:createCodexAdapter]`는 프로세스가 `passed`여도 `turn.completed` 이벤트가 없거나, `turn.failed` 또는 `error` 이벤트가 있거나, JSON으로 읽을 수 없는 줄이 있으면 상태를 `error`로 바꾼다. 1,000,000자를 넘는 줄은 유효하지 않은 것으로 처리한다.
- `[claude.ts:createClaudeAdapter]`는 도구를 `Read,Edit,Write,Glob,Grep`으로 제한하고 MCP 서버, 세션 저장, 슬래시 명령, 훅을 끈 상태로 실행한다. 결과가 성공(`subtype`이 `success`, `is_error`가 `false`)이 아니거나, `stop_reason`이 `refusal`이거나, `permission_denials`가 비어 있지 않으면 상태를 `error`로 바꾼다.
- `[claude.ts:terminalResult]`는 출력이 배열이면 `type`이 `result`인 항목이 정확히 1개이고 마지막 항목일 때만 결과로 인정한다.

프로세스와 worktree:

- `[process.ts:runProcess]`는 `shell: false`로 실행한다. 타임아웃이나 중단 신호를 받으면 프로세스 그룹에 `SIGTERM`을 보내고, 2000ms 뒤에도 살아 있으면 `SIGKILL`을 보낸다. 명령이 끝난 뒤에도 남은 프로세스 그룹을 정리한다.
- `[process.ts:runProcess]`는 출력을 `maxOutputBytes`(기본값 16000)까지만 보관하고, 넘으면 `truncated`를 `true`로 둔다.
- `[process.ts:processEnvironment]`는 `HOME`을 전달받은 경로로 바꾸고 `PATH` 등 허용한 변수만 넘긴다. `mode`가 `true`이면 Codex 인증 관련 변수만, `'claude'`이면 Claude 인증 관련 변수만 추가한다. 두 제공자의 인증 변수를 같은 프로세스에 함께 넘기지 않는다. Git 전역 설정과 시스템 설정은 `/dev/null`로 막는다.
- `[workspace.ts:createWorkspace]`는 `runId`가 `^[A-Za-z0-9_-]{1,120}$`에 맞지 않거나 `baseCommit`이 16진수 40자가 아니면 거부한다. 같은 경로의 worktree가 이미 있으면 재사용하지 않고 오류를 던진다. `repositoryPath`는 Git 루트여야 한다.
- `[workspace.ts:git]`과 Cloudflare 포트의 Git 호출은 모두 `core.hooksPath=/dev/null`과 `core.fsmonitor=false`를 지정한다. 저장소의 Git 훅은 실행하지 않는다.
- `[workspace.ts:collectWorkspaceDiff]`는 임시 `GIT_INDEX_FILE`을 써서 diff를 만든다. worktree의 실제 인덱스는 바꾸지 않는다. diff는 180000자로 자른다.

Cloudflare 포트:

- `[cloudflare.ts:createCloudPort]`는 `baseUrl`이 경로, 쿼리, 사용자 정보가 없는 `https:` 주소가 아니면 생성 시점에 오류를 던진다. `controlToken`이 비어 있거나 4096자를 넘거나 줄바꿈을 포함해도 오류를 던진다.
- `[cloudflare.ts:safeError]`: 생성자 검증과 `connection()`을 제외한 포트의 실패는 같은 일반 메시지로 바뀐다. 생성자 검증 실패는 `Invalid Cloudflare port configuration.`을 던지고, `connection()`은 던지지 않고 `unavailable` 상태와 별도 메시지를 반환한다. 원격 응답이나 토큰이 오류 메시지에 들어가지 않는다. `[cloudflare.ts:createCloudPort]`의 `scrub`은 반환하는 문자열에서 `controlToken` 값을 `[REDACTED]`로 바꾼다.
- `[cloudflare.ts:createCloudPort]`의 `prepare`는 실패하면 `retryable: false`인 오류를 던진다. 복구한 worktree에 커밋되지 않은 변경이 있으면 실패한다.
- `[cloudflare.ts:submission]`은 제출 데이터를 쓸 때마다 다시 검증한다. 스냅샷 digest와 `snapshotId`, 자격 증명 ID, 검사 목록이 설정과 같아야 한다. worktree 경로는 `worktreeRoot` 안에 있어야 하고, `HEAD`가 분리된 상태로 `baseCommit`을 가리켜야 한다.
- `[cloudflare.ts:binding]`은 원격 작업의 `kind`, `snapshotId`, `provider`, `credentialId`, `checks`가 제출한 값과 다르면 거부한다.
- `[cloudflare.ts:createCloudPort]`의 `poll`은 원격 상태가 종료 상태이고 `containerStopped`가 참일 때만 `terminal`을 참으로 둔다. `success`는 에이전트와 모든 검사가 통과하고 각 검사의 `credentialsAbsent`와 `sourceUnchanged`가 `true`일 때만 참이다.
- `[cloudflare.ts:request]`는 리다이렉트를 따르지 않고(`redirect: 'error'`), 30000ms 뒤 중단하며, 응답 본문이 1MiB를 넘으면 실패한다.

워크플로 포트:

- `[cloud-workflow.ts:createCloudWorkflowPort]`의 `draft`는 입력의 `baseCommit`이 설정의 `policy.baseCommit`과 다르면 거부한다. 워커의 쓰기 경로가 운영자 검사 명령의 인자와 겹치면 거부한다. 계약 파일이 고정 소스에 없으면 거부한다.
- `[cloud-workflow.ts:binding]`은 원격 워크플로의 `id`, `spec.snapshotId`, `spec.contractHash`가 등록된 값과 다르면 거부한다. `approve`와 `read`는 원격 호출 전후에 이 검사를 한다.
- `[cloud-workflow.ts:createCloudWorkflowPort]`의 `approve`는 원격 상태가 `DRAFT`가 아니면 승인 요청을 다시 보내지 않고 현재 상태를 반환한다.
- `[cloud-workflow.ts:createCloudWorkflowPort]`의 `read`는 상태가 `SUCCEEDED`인데 통합 검증 근거가 불완전하면 오류를 던진다. 통합 작업이 `SUCCEEDED`이고 컨테이너가 멈췄고, 프로세스가 `passed`이며 `exitCode`가 0이고, `credentialsAbsent`와 `sourceUnchanged`가 `true`이고, 출력 스냅샷이 있어야 한다.
- `[cloud-workflow.ts:createCloudWorkflowPort]`의 `read`가 반환하는 `actualCostMicros`는 항상 `null`이다.

- `[autonomous-runner.ts:runAutonomousIteration]`은 인증된 claim만 실행 입력으로 사용한다. 실제 제공자는 명시적 executor·정책 집행·영속 세션 복원이 필요하다. 세션 ID·모델·sequence가 정확히 이어져야 하며 공개 finish에는 허용된 결과와 checkpoint 참조만 보낸다. heartbeat·lease·deadline 실패는 실행을 중단하며 불명확한 실행을 자동 재시도하지 않는다.
- `[autonomous-loop.ts:runAutonomousLoop]`는 운영자 인증 필드를 거부하고 반복·idle 한도를 양의 유한 정수로 요구한다. worker-state가 실행 가능한 상태일 때만 반복한다.
- `[autonomous-session-store.ts:EncryptedSessionStore]`는 32바이트 키의 AES-GCM과 task·세션·모델·sequence·objectKey AAD를 쓴다. blob은 최대 12MiB다. `[autonomous-session-file.ts:FilePrivateBlobStore]`는 0700 소유 디렉터리·0600 단일 링크 일반 파일과 심볼릭 링크 거부를 검사한다.
- `[autonomous-claude.ts:createClaudeAutonomousExecutor]`는 Claude 구독 인증 하나, 구체적인 모델 pin, 유효 lease, sequence 증가와 Linux 경계 보고를 검증한다. 보고값 검증 자체가 독립 attestation을 뜻하지 않는다.
- `[autonomous-external.ts:validateExternalArtifact]`는 최대 32개 파일·파일당 256KiB·합계 1MiB와 canonical base64를 요구한다. 비밀 경로·알려진 비밀·일반 인증 패턴과 일부 중첩 인코딩을 거부한다. 완전한 DLP 보장은 아니다.
- `[autonomous-external.ts:createExternalProviderTransport]`는 서버 설정과 승인 target·매개변수 hash를 대조한다. AWS 시작은 원격 TTL guard와 timer 근거가 필수이며 GitHub는 expected HEAD를 고정한다. 조회 실패·404·삭제 수락은 부재나 비용 0의 근거가 아니다.
- `[autonomous-aws-guard.ts:createAwsTtlGuardPort]`는 비활성·미설정이면 AWS 호출 전 거부한다. region은 `ap-northeast-2`이며 원격 정책·Lambda 코드·실행 설정·DynamoDB·timer를 대조한다. guard 검증의 Lambda envelope는 55초·256MiB·x86_64·비VPC다.
- `[autonomous-external-cost.ts:createAwsCostExplorerReader]`는 실제 부재 확인 뒤 확인 비용을 읽는다. Cost Explorer 조회·기타 비용의 별도 검증 supplement가 없으면 전체 최종 비용을 확정하지 않는다. `null`은 미확정이다.
- `[autonomous-external-s3.ts:createExternalS3Transport]`는 `If-None-Match:*`, 소유 mark·checksum·고정 bucket owner를 사용한다. inspect는 같은 승인에 속한 put의 key·digest만 읽는다.
- `[autonomous-external-large-store.ts:createExternalLargeStore]`는 완료 시 전체 객체를 다시 hash하고 크기를 대조한다. 소유자를 지정한 `open`은 검증 완료 원장을 요구한다. `abortOwner`의 취소 tombstone은 해당 revision의 새 업로드도 막는다.
- `[autonomous-external-hf-lfs.ts:hfLfsCommit]`는 모든 파일의 사전 검사를 게시 전에 완료하고 upload 목적지를 서버 허용 HTTPS 호스트로 제한한다. 업로드 호스트에는 HF 인증을 전달하지 않는다. 최종 visibility·parent를 재확인하지만 HF visibility의 원자적 CAS는 보장하지 않는다.
- `[autonomous-external-hf-visibility.ts:assertHfLfsAllowed]`는 공개 LFS 게시에 `allowPublicLarge:true`를 요구한다. 생략된 visibility는 private이며 기존 profile hash를 바꾸는 정규화는 하지 않는다.

## Side Effects

- `[process.ts:runProcess]`는 `spawn`으로 자식 프로세스를 만든다. POSIX에서는 `detached`로 새 프로세스 그룹을 만들고 그 그룹에 신호를 보낸다.
- `[codex.ts:createCodexAdapter]`와 `[claude.ts:createClaudeAdapter]`는 `codex` 또는 `claude` CLI를 실행한다. 이 호출은 실제 모델 호출이며 비용이 발생할 수 있다. 프로젝트 규칙은 실제 모델 호출을 해당 작업에서 명시적으로 요청한 경우에만 허용한다. 기본 타임아웃은 600000ms다.
- `[workspace.ts:createWorkspace]`는 `worktreeRoot/<runId>`에 `git worktree add --detach`로 worktree를 만들고 `worktreeRoot/.artifacts/<runId>/home` 디렉터리를 만든다. 로컬 실행 경로는 이 worktree를 삭제하지 않는다.
- `[local-execution.ts:executeLocalTask]`는 worktree 안에서 설정 명령과 테스트 명령을 실행한다. 기본 타임아웃은 120000ms다.
- `[cloudflare.ts:createCloudPort]`는 `fetch`로 원격 백엔드의 `/health`, `/v1/credentials`, `/v1/jobs/<id>/cancel`을 호출한다. 요청에는 `authorization` 헤더로 `controlToken`을 보낸다. 스냅샷 업로드, 작업 제출, 조회는 동적으로 불러온 `cloudflare/backend/src`의 `client`, `files`, `snapshot`, `scheduler` 모듈이 수행한다.
- `[cloudflare.ts:createCloudPort]`의 `poll`은 원격 출력 스냅샷을 로컬 worktree에 적용한다(`applySnapshot`). 같은 출력이 이미 적용되어 있으면 다시 적용하지 않는다.
- `[cloud-workflow.ts:createCloudWorkflowPort]`의 `draft`는 임시 worktree를 만들어 스냅샷을 읽은 뒤 `git worktree remove --force`와 `rm`으로 지운다. 그 다음 스냅샷을 원격에 업로드하고 워크플로 초안을 만든다.
- `[cloud-workflow.ts:createCloudWorkflowPort]`의 `read`는 `includeDiff`가 참이면 `os.tmpdir()` 아래에 `hivemind-workflow-diff-` 임시 디렉터리를 만들어 입력과 출력 스냅샷을 복원하고 `git diff --no-index`를 실행한 뒤 디렉터리를 지운다.

- `[autonomous-runner.ts:createAutonomousHttpClient]`, `[autonomous-claude.ts:createClaudeRuntimeHttpPort]`는 HTTP를 호출한다. 실행 반복은 세션을 저장하고 timer를 등록하며 종료 시 scoped credential map을 비운다. `runAutonomousCleanup`은 주입한 정리와 중앙 확인을 호출한다.
- `[autonomous-session-file.ts:FilePrivateBlobStore]`는 디렉터리·임시 파일을 생성하고 fsync·hard link로 blob을 원자적으로 게시한다. 기존 blob을 덮어쓰지 않는다.
- `[autonomous-external.ts:createExternalProviderTransport]`는 설정·승인 후 EC2 Spot 시작·종료, 소유 EBS 삭제, HF commit/LFS upload, GitHub commit과 S3 PUT/HEAD를 수행할 수 있다. 비용과 외부에 남는 변경이 발생할 수 있다.
- `[autonomous-aws-guard.ts:createAwsTtlGuardPort]`는 기존 인프라를 조회하고 DynamoDB 소유 레코드·Scheduler 만료 timer를 만든다. `[autonomous-external-cost.ts:createAwsCostExplorerReader]`는 서명한 Cost Explorer 조회를 보내며 조회 비용이 발생할 수 있다.
- `[autonomous-external-cost.ts:createExternalCostCache]`는 `external_cost_cache`, `[autonomous-external-large-sql.ts:createExternalLargeRecordPort]`는 `external_large_uploads`, `external_large_cancelled` 테이블·인덱스를 만든다.
- `[autonomous-external.ts:createExternalR2ArtifactPublisher]`는 조건부로 artifact를 저장한다. `[autonomous-external-large-store.ts:createExternalLargeStore]`는 주입한 bucket의 multipart 생성·업로드·완료·삭제와 원장 기록을 수행한다.

## Verification

- Run: `npm run check` (저장소 루트에서 실행한다. `tsc --noEmit` 다음에 `npm test`를 실행한다. 테스트는 루트의 `tests/` 디렉터리에 있다.)
