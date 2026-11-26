# 이슈 #1 후속 구현 계획 — 2026-11-21

상태: 구현 진행 중. 이 문서는 구현 에이전트가 공유하는 계약이다. 실제 모델·외부 제공자·유료 자원·배포는 이 계획의 구현 단계에서 호출하지 않는다. 모든 검사는 가짜 HTTP·로컬 SQL·합성 시계를 쓴다.

## 공통 규칙

- 언어는 TypeScript, Node 24다. 루트 검사는 `npm run check`, 백엔드 검사는 `cloudflare/backend`에서 `npm run typecheck`와 `npm test`다.
- 기존 규칙을 따른다. 대상·URL·자격 증명은 서버 설정만 정하고 모델 입력으로 받지 않는다. 실패는 닫힌 쪽으로 처리한다. 비밀 값은 로그·이벤트·응답에 넣지 않는다. 응답 유실 뒤 재시도는 중복 효과를 만들지 않는다.
- import 관례: contracts는 `.js`, core·adapters는 `.ts` 확장자를 쓴다. `packages/*`는 `cloudflare/backend`를 import하지 않는다. 컨테이너 runtime 코드는 `packages/contracts`의 값을 import하지 않는다(`runtime-shared` 사본을 쓴다).
- 병렬 작업 P1–P4는 아래 "소유 파일"만 만들거나 고친다. 기존 공용 파일은 P1–P4가 고치지 않고 통합 작업 I1이 고친다. 공용 파일에 필요한 변경은 구현 에이전트가 보고서에 "I1 요청"으로 적는다.
- 각 새 소스 파일에는 같은 작업이 소유하는 테스트 파일이 있다. 테스트를 먼저 쓰고 실패를 확인한 뒤 구현한다.
- 한 파일만 빠르게 검사할 때는 기존 계획 문서의 집중 emit 방식(`./node_modules/.bin/tsc ... --outDir dist <test files>` 뒤 `node --test dist/tests/<name>.test.js`)을 쓴다. 다른 작업이 작성 중인 파일 때문에 전체 빌드가 깨질 수 있으므로 전체 `npm run check`는 I1이 실행한다.

## P1 비용 초과 시 작업 중단 (R8)

현재 사실(2026-11-21 코드 확인): 예약 기반 상한(`packages/core/src/autonomous-external.ts:102,:260`), Cost Explorer 조회(`packages/adapters/src/autonomous-external-cost.ts`), Durable Object alarm의 주기적 정리(`cloudflare/backend/src/autonomous-external.ts:224-235`)는 이미 있다. 빠진 것은 broker의 `cost_exceeded`가 중앙 작업을 중단시키지 않는 점, 그리고 `nextWake`가 action 만료 시각을 반영하지 않는 점이다. Cost Explorer 지연 때문에 실행 중 실제 청구 기반 집행은 만들지 않는다. 실행 중 상한은 예약과 TTL guard다.

소유 파일:
- `packages/core/src/autonomous-external-exposure.ts`, `tests/autonomous-external-exposure.test.ts`
- `packages/core/src/autonomous-external-cost-watch.ts`, `tests/autonomous-external-cost-watch.test.ts`

계약:
- `ExternalTaskExposure {taskId:string; revision:number; capMicros:number; verifiedMicros:number; reservedMicros:number; exposureMicros:number; brokerCostStop:boolean; stop:null|'verified_reached_cap'|'exposure_over_cap'|'broker_cost_exceeded'; nextExpiryAt?:number}`
- `externalTaskExposure(state:ExternalState, taskId:string):ExternalTaskExposure|null`
- `listExternalCostStops(state:ExternalState):ExternalTaskExposure[]`
- `createExternalCostWatch(o:{store:ExternalTransactionalStore; stopTask(taskId:string,reason:string):Promise<void>; cancelApprovals(taskId:string,revision:number):void; now?:()=>number}):{sweep(limit?:number):Promise<{stopped:string[];failed:string[];nextExpiryAt?:number}>}`
- 중단 규칙: `verified >= cap`, 또는 `exposure > cap`, 또는 broker의 `cost_exceeded`. `exposure == cap`은 중단하지 않는다(승인 조건이 exposure가 cap과 같아지는 것을 허용하기 때문이다).

검사: cap 100·예약 100·verified null → `stop:null`. verified 60+40 → `'verified_reached_cap'`. 상한 100·verified 130 → `'broker_cost_exceeded'`, exposure 130. 같은 상태로 sweep 두 번 → `stopTask` 1회. `stopTask` 예외 → `failed:['t1']`, 다음 sweep에서 중단. 중단 없음·자원 만료 5000 → `nextExpiryAt:5000`.

## P2 워커 내부 도구 호출 기록 (R9)

현재 사실: `counts.toolCalls`는 broker action 수다(`packages/core/src/autonomous.ts:157`). hook은 `PreToolUse`만 등록돼 있고 기록을 남기지 않는다. 이 기록은 워커의 보고이며 독립 증명이 아니다. 문서와 저장 레코드에 `source:'worker_report'`로 표시한다.

소유 파일(각각 테스트 파일 포함):
- `packages/contracts/src/autonomous-tool-audit.ts` — 타입과 한도
- `cloudflare/backend/src/runtime/tool-audit-redact.ts` — 가리기와 요약(순수 함수)
- `cloudflare/backend/src/runtime/tool-audit-hook.ts` — hook 진입점, spool에 추가
- `cloudflare/backend/src/runtime/tool-audit-spool.ts` — spool 줄을 레코드로 접기
- `cloudflare/backend/src/runtime/tool-audit-reporter.ts` — 묶음 전송
- `packages/core/src/autonomous-tool-audit-sql.ts` — 기존 `ExternalSqlPort` 위의 저장소
- `apps/control-plane/src/autonomous-tool-audit-api.ts` — HTTP 처리기
- `apps/mcp-server/src/autonomous-tool-audit.ts` — MCP 도구 `hivemind_autonomous_tool_calls`
- `apps/dashboard/public/tool-audit.js` — 대시보드 패널(값 표시는 `textContent`만 사용)

계약:
- `ToolAuditRecord {sequence:number; tool:string; inputDigest:string; inputSummary:string; inputTruncated:boolean; outcome:'allowed'|'denied'|'error'; startedAt:number; durationMs:number|null; subagent?:true}`
- `StoredToolAuditRecord = ToolAuditRecord & {runId:string; iteration:number; receivedAt:number; source:'worker_report'}`. `iteration`·`receivedAt`·`source`는 서버가 정한다.
- `ToolAuditTotals {recorded:number; denied:number; errors:number; droppedByWorker:number; droppedByStore:number}`
- `TOOL_AUDIT_LIMITS = {recordBytes:1024, summaryBytes:512, batchRecords:32, taskRecords:20000, taskBytes:16*1024*1024, spoolBytes:8*1024*1024}`
- `redactText(text:string, secrets:readonly string[]):string`
- `summarizeToolInput(tool:string, input:unknown, secrets:readonly string[]):{inputDigest:string; inputSummary:string; inputTruncated:boolean}`
- `foldToolAuditSpool(raw:string):{records:ToolAuditRecord[]; droppedByWorker:number}`
- `shipToolAudit(o:{lease:AutonomousLease; url:string; token:string; records:ToolAuditRecord[]; droppedByWorker:number; fetchImpl?:typeof fetch; signal:AbortSignal}):Promise<{shipped:number}>`
- `createToolAuditStore(sql:ExternalSqlPort, secret:string)` → `append(scope:{taskId:string;runId:string;iteration:number}, batch:{records:ToolAuditRecord[];droppedByWorker:number}, now:number):{recorded:true;nextSequence:number}`, `page(taskId:string, q:{limit?:number;cursor?:string}):{items:StoredToolAuditRecord[];totals:ToolAuditTotals;nextCursor?:string}`, `totals(taskId:string):ToolAuditTotals`
- `handleToolAuditApi(request:Request, o:{operatorToken:string; reporterToken?:string; authorize:(lease:AutonomousLease)=>Promise<{taskId:string;runId:string;iteration:number}>; store:ToolAuditStore}):Promise<Response|null>`. 경로는 `GET /v1/autonomous-tasks/:id/tool-calls`(운영자)와 `POST` 같은 경로(reporter)다. 다른 경로는 `null`을 반환한다.

규칙:
- 가리기 대상: 알려진 비밀 값, `sk-ant-…`, `sk-proj-…`, `ghp_`·`github_pat_`, `hf_…`, `AKIA…`, PEM 블록, `Authorization:`·`Bearer` 값, URL userinfo, `(token|secret|password|passwd|api[_-]?key|credential)` 뒤 `=` 또는 `:`의 값. digest는 가리기 전 canonical 입력으로 계산한다. 가린 뒤 UTF-8 경계에서 자른다. `tool_response`는 저장하지 않는다.
- 멱등 키는 `(taskId, runId, sequence)`다. 최고 기록 이하 sequence는 무시한다. 최고 기록+1은 받는다. 그보다 크면 409와 `expectedSequence`를 반환하고 저장하지 않는다.
- spool·저장소가 가득 차면 작업을 멈추지 않고 버린 수를 `droppedByWorker`·`droppedByStore`에 기록한다. spool을 쓸 수 없으면 `PreToolUse`는 닫힌 쪽으로 실패한다.
- runtime 파일에는 한도 사본을 두고, contracts의 값과 같음을 테스트로 확인한다.

검사: `export HF_TOKEN=hf_abcdefghijklmnopqrstuvwx; ls` → 요약 `export HF_TOKEN=[REDACTED]; ls`, digest는 원문의 SHA-256. 60,000바이트 명령 → 요약 512바이트 이하, `inputTruncated:true`, 레코드 1024바이트 이하. sequence 1..3을 두 번 추가 → `recorded 3`, 두 응답 모두 `nextSequence:4`. 빈 저장소에 5..6 → 409 `expectedSequence:1`, 0행. 한도 2인 저장소에 3건 → `recorded 2`, `droppedByStore 1`. 허용되지 않은 호스트의 `WebFetch` → `outcome:'denied'`, `durationMs:null`. lease 불일치 POST → 409, 운영자 토큰 POST → 401. 45행·limit 20 → 20·20·5, 변조 cursor 400, 다른 작업 cursor 400. 저장 뒤 응답 유실 → 재전송 성공, 중복 0.

## P3 S3 작업 계약

소유 파일(각각 테스트 포함): `packages/contracts/src/autonomous-external-s3.ts`, `packages/core/src/autonomous-external-s3.ts`(`tests/autonomous-external-s3-core.test.ts`), `packages/adapters/src/autonomous-external-s3.ts`(`tests/autonomous-external-s3-transport.test.ts`), `docs/plans/2026-11-21-autonomous-external-s3.md`.

계약:
- `ExternalS3Operation = 'aws.s3.put'|'aws.s3.inspect'`
- `ExternalS3Target {accountId:string; region:string; bucket:string; prefix:string; kmsKeyId?:string; maxObjectBytes:number; retentionDays:number}`
- `ExternalS3Parameters {keySuffix:string; artifactDigest:string}`
- `ExternalS3Profile`: 기존 profile 한도 필드 + `{provider:'s3'; target:ExternalS3Target; operations:ExternalS3Operation[]}`. 자격 증명 형태는 기존 `aws`와 같다.
- `validateExternalS3Target(value:unknown):ExternalS3Target` — 점이 있는 bucket 이름과 `/`로 끝나지 않는 prefix는 거절한다.
- `validateExternalS3Parameters(value:unknown):ExternalS3Parameters` — 추가 키(예: `bucket`)는 거절한다.
- `externalS3ObjectKey(target:Pick<ExternalS3Target,'prefix'>, keySuffix:string):string` — suffix 규칙 `^[A-Za-z0-9_][A-Za-z0-9_./-]{0,239}$`, `..`·`//`·`/./`·끝 `/` 금지. 예: `({prefix:'runs/'},'t1/m.json')` → `'runs/t1/m.json'`.
- `externalS3Mark(i:Pick<ExternalInvocation,'ownershipToken'|'idempotencyKey'|'parametersHash'>):string` — `JSON.stringify([o,k,p])`의 SHA-256 hex.
- `signExternalS3Request(input:{method:'PUT'|'HEAD'; target:Pick<ExternalS3Target,'region'|'bucket'>; key:string; headers:Record<string,string>; payloadSha256:string; credential:{accessKeyId:string;secretAccessKey:string;sessionToken?:string}; now:number}):{url:string; method:'PUT'|'HEAD'; headers:Record<string,string>}` — URL은 `https://<bucket>.s3.<region>.amazonaws.com/<key>`.
- `createExternalS3Transport(options:{enabled?:boolean; target:ExternalS3Target; loadFiles:(i:ExternalInvocation)=>Promise<ExternalArtifact['files']>; fetch?:typeof fetch; now?:()=>number}):{execute(i,c,authority?):Promise<ExternalProviderReceipt>; inspect(i,c):Promise<ExternalProviderReceipt|null>}`

규칙: PUT은 `If-None-Match:*`, `x-amz-checksum-sha256`, `x-amz-expected-bucket-owner`, `x-amz-meta-hivemind-mark`를 보내고 `kmsKeyId`가 있으면 SSE-KMS 헤더를 보낸다. HEAD는 `x-amz-checksum-mode:ENABLED`로 크기·checksum·mark·KMS 키를 확인한다. `redirect:'error'`, 5초 제한, `now()<expiresAt` 확인. put의 효과는 `retained`이며 HIVEMIND는 객체를 삭제하지 않는다. 비용은 `billing:{verifiedCostMicros:null,final:false}`로 두어 운영자 정산 전까지 예약을 유지한다. 404나 네트워크 오류의 inspect는 `null`(미해결)이며 부재 증명이 아니다. 자동 재-put은 없다. 크기는 기존 1MiB artifact 한도를 따른다.

검사: `'../x'`·`'a/../b'`·`'/a'`·`'a//b'`·`'a/'` → 예외, fetch 0회. `'%2e%2e/x'`·`'a\\b'` → 예외. PUT 412 + 다른 mark → `failed`/`none`; 같은 mark·checksum → `succeeded`. digest 불일치 → fetch 전 거절. PUT 예외 뒤 HEAD 200 일치 → 성공 영수증, HEAD 404 → `null`. 만료 → fetch 0회. `maxObjectBytes:1024`에 1025바이트 → PUT 없음.

문서(`…-autonomous-external-s3.md`)에는 설계, IAM 예시(`s3:PutObject`·`GetObject` on `bucket/prefix*`, `kms:GenerateDataKey`, Delete 없음), 비용 의미와 "신뢰하는 워크로드 기술서"를 적는다. 기술서는 코드 없이 문서로만 정의한다: AMI, 부팅·입력 manifest digest, IAM 정책 revision, account·region, bucket·prefix, 바이트·보존·비용 한도를 승인 fingerprint에 결속한다. 한계도 적는다: HIVEMIND는 인스턴스 내부의 개별 쓰기를 중개하거나 보지 못하고, 같은 ARN의 IAM 정책은 바뀔 수 있고, reporter 영수증은 자기 보고이며, 인스턴스 종료는 저장 비용을 끝내지 않는다.

## P4 대형 산출물 업로드와 Hugging Face 공개 커밋

현재 사실: HF는 `private===true`만 허용한다(`packages/adapters/src/autonomous-external.ts:274,:324`). inline artifact 한도는 합계 1MiB·32파일·파일당 256KiB다. `cloudflare/backend/src/large-artifact-store.ts`는 키가 작업 간 공유되고 전체 hash를 검증하지 않아 그대로 쓸 수 없다. 8MiB part와 part별 sha256 원장, begin/part/complete/abort 흐름만 본뜬다.

소유 파일(각각 테스트 포함):
- `packages/contracts/src/autonomous-external-large.ts`, `packages/core/src/autonomous-external-large.ts`
- `packages/adapters/src/autonomous-external-large-store.ts`
- `packages/adapters/src/autonomous-external-hf-lfs.ts`
- `packages/adapters/src/autonomous-external-hf-visibility.ts`
- `apps/control-plane/src/autonomous-external-large-api.ts`
- `cloudflare/backend/src/runtime/autonomous-large-upload.ts`

계약:
- `ExternalLargeFile {path:string; size:number; sha256:string; storageRef:string}`, `ExternalLargeManifest {version:1; taskId:string; revision:number; profileId:string; files:ExternalLargeFile[]}`, `ExternalLargeLimits {maxFileBytes:number; maxTotalBytes:number; maxFiles:number}`
- `largeOwnerKey(taskId:string, revision:number, profileId:string):string`(64 hex), `largeStorageRef(ownerKey:string, sha256:string):string`(`'external-large/<ownerKey>/<sha256>'`), `validateExternalLargeManifest(value:unknown, limits:ExternalLargeLimits):ExternalLargeManifest`(다른 owner key의 `storageRef`는 거절), `externalLargeManifestDigest(m:ExternalLargeManifest):string`(접두 `'hivemind-large-v1\n'`), `largePartPlan(size:number):{partBytes:number; count:number; lastBytes:number}`(예: `8388609` → `{partBytes:8388608,count:2,lastBytes:1}`)
- `createExternalLargeStore(o:{bucket:ExternalLargeBucket; records:ExternalLargeRecordPort; limits:ExternalLargeLimits; now?:()=>number})` → `begin(owner, file:{path,size,sha256}, expiresAt)`, `part(uploadId, n, data:Uint8Array)`, `complete(uploadId):Promise<ExternalLargeFile>`, `abort(uploadId)`, `abortOwner(taskId, revision)`, `open(file)`. `complete`는 객체를 스트림으로 다시 읽어 sha256과 크기를 확인하고, 불일치면 객체를 지우고 409를 낸다. `ExternalLargeBucket`·`ExternalLargeRecordPort`는 이 파일이 정의하는 주입 포트다.
- `lfsPointer(sha256:string, size:number):string` → `'version https://git-lfs.github.com/spec/v1\noid sha256:<sha>\nsize <n>\n'`, 크기 0은 예외.
- `hfLfsCommit(i:ExternalInvocation, token:string, manifest:ExternalLargeManifest, o:HfLfsOptions):Promise<{commitOid:string}>`, `hfLfsProof(i, token, manifest, o, expected?:string):Promise<{commitOid:string}|null>`. 업로드 URL은 서버 소유 허용 호스트 목록의 https만 받고, redirect를 따르지 않고, 그 요청에 Authorization 헤더를 보내지 않는다.
- `type HfVisibility='private'|'public'`, `resolveHfVisibility(value:unknown):HfVisibility`(`undefined` → `'private'`, `'Public'` → 예외), `assertHfVisibility(info:unknown, expected:HfVisibility):void`(boolean `private`가 기대와 같아야 하고 `disabled!==true`), `hfVisibilityDisplay(target):{visibility:HfVisibility; publicEffect:boolean; notice:string}`
- `handleExternalLargeApi(request:Request, o:ExternalLargeApiOptions):Promise<Response|undefined>` — 경로 `external-large/{begin,part,complete,abort,manifest}`.
- `uploadWorkspaceFiles(o:{root:string; paths:string[]; post:LargePost; signal?:AbortSignal}):Promise<{manifestDigest:string}>` — realpath가 root 안이어야 하고 symlink를 거절하며, 스트리밍 hash를 쓰고 `begin().parts`에서 재개한다.

결정(Ruling):
- 새 작업 종류는 `hf.model.lfs_commit`이고 매개변수는 `{manifestDigest, message}`다.
- 생략한 visibility는 정규화하지 않는다. 정규화하면 기존 `profileHash`가 모두 바뀐다. 생략은 private을 뜻한다.
- v1 파일 크기 상한은 5GiB(LFS basic transfer)다. LFS multipart는 다루지 않는다.
- 공개 profile에서는 `hf.model.lfs_commit`을 거절한다. 다중 GiB 파일은 기존 중첩 디코드 비밀 검사를 돌릴 수 없기 때문이다.
- 비공개에서 공개로의 전환과 저장소 생성은 구현하지 않는다.
- Hugging Face LFS API 동작은 문서로 확인하지 않은 가정이다. 가짜 HTTP로만 검사하고, 문서와 보고서에 "실제 HF 미검증"으로 적는다.

검사: visibility 없는 설정의 `profileHash`는 현재와 같다(I1). 공개 설정에 저장소가 `private:true` → 예외, POST 없음. `private:'false'` → 예외. `maxFileBytes+1` → `begin` 400. 마지막이 아닌 part가 8MiB가 아님 → 400. part hash 불일치 → `complete` 409, 객체 삭제. `begin` 두 번 → 같은 `uploadId`와 저장된 part. `complete` 두 번 → 같은 결과. 작업 B가 작업 A의 `storageRef`를 인용 → 거절. 취소 뒤 `part` → 409. 만료 뒤 `part`·`complete` → 409. commit POST timeout 뒤 inspect → 표시된 commit으로 영수증. 허용 목록 밖 href → 예외, token 미전송. `['../x']` → 예외.

## I1 통합 (P1–P4 완료 뒤)

I1은 기존 공용 파일을 고치고 전체 검사를 통과시킨다. 변경 내용은 다음과 같다.

- 격리 검사 경로 수정: `cloudflare/backend/src/cloudflare/worker.ts`의 `/v1/boundary-diagnostics`는 `request.body!==null`로 빈 본문을 판정한다. 2026-11-21 원격 확인에서 Workers 런타임은 본문 없는 POST에도 null이 아닌 body를 주어 모든 요청이 400이 됐다. 본문을 읽어 길이 0인지 확인하도록 고치고, body가 빈 스트림인 요청을 받는 회귀 검사를 추가한다.
- P1 연결: `packages/core/src/autonomous.ts`에 `stopExternalBudget(id, reason, now)` 추가(기존 `budget_exceeded` 중단 재사용, 이미 중단·종료면 무동작). `autonomous-store.ts`·`apps/control-plane/src/autonomous-api.ts`·`cloudflare/backend/src/autonomous-service.ts`의 연산 목록에 추가하되 HTTP 경로는 만들지 않는다. `cloudflare/backend/src/autonomous-external.ts`의 `cleanupDue` 시작에서 `sweep()`을 호출하고 `nextExpiryAt`을 `nextWake`에 반영한다. 로컬 control-plane 연결은 이번에 하지 않는다.
- P2 연결: `claude-managed-settings.json`에 감사 hook 등록(`PreToolUse` `.*`, `PostToolUse`, `PostToolUseFailure`), `autonomous-claude.ts`의 hook 고정 검사 갱신과 heartbeat·종료 전 flush, `counts.workerToolCalls?` 추가(`packages/contracts/src/autonomous.ts`와 `runtime-shared` 사본), `toolAuditScope` 연산, reporter 경로 인증(`cloudflare/api.ts`), `worker.ts`에서 저장소 생성과 처리기 호출, control-plane·proxy·MCP·대시보드 연결.
- P3 연결: contracts union 확장, core의 profile·parameters·effect 분기, SQL journal 검증, adapters transport 위임, backend 설정 parser(profile 최대 4개, `s3` 자격 증명은 `aws` 형태), action MCP schema, control-plane 표시.
- P4 연결: HF target의 `visibility`, `hf.model.lfs_commit`, adapters의 `assertHfVisibility` 교체와 LFS 분기, backend parser(`providers.hf.lfs`), control-plane의 `approvedTarget`·표시·대형 경로 위임·취소 시 `abortOwner`, SQL의 업로드 기록 표, action MCP의 `largeArtifact`.
- 문서: `docs/autonomous-tasks.md`의 비용 서술(58행·99행 부근)을 실제 구현 상태로 고치고, 도구 호출 기록이 워커 보고임을 적는다. 바뀐 디렉터리의 계약 README를 갱신한다. `cloudflare/backend/runtime-build.json`은 runtime 입력이 바뀌면 `npm run` 스크립트로 다시 찍는다.
- 완료 조건: 루트 `npm run check`, 백엔드 `npm run typecheck`·`npm test`가 실패 0으로 통과한다.

## 미검증으로 남는 것

실제 AWS·S3·Hugging Face·Cost Explorer 호출, 실제 컨테이너의 hook payload 필드(Claude Code 2.1.319 기준 추정), Worker에서 다중 GiB 객체를 다시 읽어 hash를 확인할 때의 CPU 한도는 이 계획에서 검증하지 않는다.
