# src/cloudflare

## Overview

이 폴더는 공유 계약(`../contracts.ts`, `../scheduler.ts`)을 Cloudflare Worker, Durable Object, Container, R2에 연결한다.
`api.ts`는 HTTP 요청을 검증하고 `ApiService`로 전달한다. `worker.ts`는 Worker 진입점, 작업별 컨테이너를 다루는 `RunnerDO`, 상태를 소유하는 `SchedulerDO`, 컨테이너의 외부 통신을 제한하는 outbound 진입점을 정의한다.
이 문서는 현재 코드가 정의한 내용을 기록한다. 원격 배포와 검증 상태는 [backend README](../../README.md)와 검증 문서를 따른다.

## Interface

### 모듈 심볼

- `[api.ts:handleApi]` - `/health`와 `/v1/*` 요청을 `ApiService` 메서드로 전달하고 오류를 상태 코드로 바꾼다.
- `[api.ts:authorize]` - `Authorization: Bearer` 값을 상수 시간으로 비교한다. 통과하면 `null`을 반환한다.
- `[api.ts:ApiService]` - `SchedulerDO`가 구현하는 서비스 인터페이스. large artifact, compute group, workflow, carbon 메서드는 선택 항목이다.
- `[api.ts:ApiError]` - `statusCode`를 가진 오류. 메시지는 항상 `Request failed`다.
- `[api.ts:json]` - `cache-control: no-store`를 붙인 JSON 응답을 만든다.
- `[api.ts:MAX_BODY_BYTES]` - JSON 요청 본문의 상한(8MiB).
- `[scheduler-alarm.ts:ensureSchedulerAlarm]` - 대기 중인 alarm이 없거나 더 늦을 때만 `now+2000`ms에 alarm을 설정한다.
- `[worker.ts:default]` - Worker `fetch` 처리기. `/health`, 인증, `/v1/carbon-diagnostics`를 처리하고 나머지는 `SCHEDULER`의 `owner` 인스턴스로 전달한다.
- `[worker.ts:SchedulerDO]` - `ApiService`를 구현하는 단일 Durable Object. 스케줄러 상태를 storage 키 `state`에 저장하고 `alarm`에서 작업을 진행한다.
- `[worker.ts:RunnerDO]` - 작업·시도마다 하나인 컨테이너 Durable Object. 공개 메서드는 `ensure`, `prepare`, `launch`, `checkpoint`, `feedback`, `poll`, `cancel`, `stop`이다.
- `[worker.ts:CodexOutbound]`, `[worker.ts:ClaudeOutbound]`, `[worker.ts:ComputeOutbound]` - 제공자·검증 컨테이너용 outbound 진입점. 허용 호스트만 전달한다.
- `[worker.ts:ResourceComputeOutbound]`, `[worker.ts:ResourceCodexOutbound]`, `[worker.ts:ResourceClaudeOutbound]` - 의존성 설치 경로를 추가로 허용하는 outbound 진입점.
- `[worker.ts:CarbonOutbound]` - 벤치마크 컨테이너용 outbound 진입점. npm 캐시, Terra 게이트웨이, Gemini 게이트웨이 또는 프로브를 처리한다.

### HTTP 경로

`/health`를 제외한 모든 경로는 `[api.ts:authorize]`의 bearer 검사를 통과해야 한다.

| 메서드·경로 | 동작 | 근거 |
|---|---|---|
| `GET /health` | `workerVersion`과 `expectedRuntimeRevision`을 반환한다 | `[worker.ts:default]` |
| `GET /v1/carbon-diagnostics` | Gemini 모델 메타데이터를 조회한다 | `[worker.ts:default]` |
| `GET /v1/terra-auth-readiness` | Terra 인증의 존재·유효 여부를 보고한다 | `[worker.ts:SchedulerDO.fetch]` |
| `PUT /v1/snapshots/{sha256}` | snapshot을 저장한다. 경로와 본문의 digest가 같아야 한다 | `[api.ts:handleApi]` |
| `POST /v1/credentials/{id}`, `GET /v1/credentials` | 인증을 등록하고 메타데이터를 조회한다 | `[api.ts:handleApi]` |
| `POST /v1/jobs`, `GET /v1/jobs`, `GET /v1/jobs/{id}` | 작업을 제출하고 조회한다 | `[api.ts:handleApi]` |
| `GET /v1/jobs/{id}/result`, `POST /v1/jobs/{id}/cancel` | 결과를 조회하고 취소를 요청한다 | `[api.ts:handleApi]` |
| `POST /v1/workflows`, `POST /v1/workflows/{uuid}/approve` | workflow 초안을 만들고 승인한다 | `[api.ts:handleApi]` |
| `GET /v1/workflows/{uuid}`, `GET /v1/workflows/{uuid}/result` | workflow 상태와 결과를 조회한다 | `[api.ts:handleApi]` |
| `POST /v1/compute-groups`, `GET /v1/compute-groups/{uuid}` | compute group 초안을 만들고 조회한다 | `[api.ts:handleApi]` |
| `POST /v1/compute-groups/{uuid}/approve`, `POST /v1/compute-groups/{uuid}/cancel` | compute group을 승인하고 취소한다 | `[api.ts:handleApi]` |
| `POST /v1/large-artifact-uploads` | multipart 업로드를 시작한다 | `[api.ts:handleApi]` |
| `PUT /v1/large-artifact-uploads/{uuid}/parts/{n}` | part 하나를 올린다 | `[api.ts:handleApi]` |
| `POST /v1/large-artifact-uploads/{uuid}/complete`, `POST /v1/large-artifact-uploads/{uuid}/abort` | 업로드를 완료하거나 중단한다 | `[api.ts:handleApi]` |
| `GET /v1/large-artifacts/{sha256}` | 등록된 artifact의 메타데이터를 조회한다 | `[api.ts:handleApi]` |
| `POST /v1/boundary-diagnostics` | 본문이 비어 있고 쿼리가 없으며 `idempotency-key`가 있을 때만 격리 검사를 실행한다. Workers 런타임은 본문 없는 POST에도 빈 스트림을 주므로 본문을 읽어 길이 0을 확인한다 | `[worker.ts:default]` |
| `POST /v1/autonomous-tasks/{id}/tool-calls` | 워커가 도구 호출 기록을 보고한다. reporter 토큰과 현재 lease가 필요하다 | `[worker.ts:SchedulerDO.fetch]` |
| `GET /v1/autonomous-tasks/{id}/tool-calls` | 운영자가 기록을 페이지로 읽는다. 작업 보기의 `counts.workerToolCalls`는 이 기록의 건수를 보기에서만 덧붙인 값이다 | `[worker.ts:SchedulerDO.fetch]` |
| `POST /v1/autonomous-tasks/{id}/external-large/{begin,part,complete,abort,manifest}` | 대형 산출물 업로드. worker 토큰이 필요하고, 컨테이너 egress는 외부 기능이 켜졌을 때만 허용한다 | `[worker.ts:SchedulerDO.fetch]`, `[autonomous-ports.ts:allowNativeControl]` |
| `POST /v1/carbon-benchmarks`, `POST /v1/terra-benchmarks` | 벤치마크 캠페인을 등록한다 | `[api.ts:handleApi]` |
| `GET /v1/carbon-benchmarks/{uuid}`, `GET /v1/terra-benchmarks/{uuid}` | 캠페인과 실행을 조회한다 | `[api.ts:handleApi]` |

## Invariants

- `CONTROL_TOKEN`이 없으면 503, 값이 다르면 401을 반환한다. `[api.ts:authorize]`
- JSON 본문은 `MAX_BODY_BYTES`(8MiB)를 넘으면 413, 비어 있거나 잘못된 JSON이면 400이다. `[api.ts:body]`
- large artifact의 part는 `content-length`가 1 이상 `PART_BYTES` 이하이고 실제 수신 길이와 같아야 한다. `[api.ts:partBody]`
- `idempotencyKey`가 `workflow:`로 시작하는 작업 제출은 400이다. `[api.ts:handleApi]`
- 작업 제출은 제공자에 맞는 승인 플래그(`CODEX_SANDBOX_APPROVED`, `CLAUDE_NESTED_APPROVED`)가 `'true'`일 때만 허용한다. 아니면 503이다. `[worker.ts:SchedulerDO.submit]`
- workflow 승인은 두 플래그가 모두 `'true'`이고 계약 파일의 해시가 일치해야 한다. `[worker.ts:SchedulerDO.approveWorkflow]`
- 컨테이너의 `/health`가 보고한 `runtimeRevision`이 고정한 값 또는 `runtime-build.json`의 `digest`와 같아야 `prepare`와 `launch`를 수행한다. 메타데이터에 `runtimeRevision`이 없고 이미 `prepared` 또는 `launchIssued`인 legacy 컨테이너는 revision 비교 없이 `/health`의 `ok`만 보고 ready로 판정하며, 이때 `prepare`와 `launch`를 호출하지 않는다. `[worker.ts:RunnerDO.ensure]`, `[worker.ts:RunnerDO.prepare]`
- 인증은 버전 확인 후 `prepare`에서만 컨테이너에 전달한다. `[worker.ts:RunnerDO.prepare]`
- `launchIssued`를 exec 전에 저장한다. 결과가 불확실한 launch를 다시 실행하지 않는다. `[worker.ts:RunnerDO.launch]`
- 런타임 exec는 `setpriv --no-new-privs --inh-caps=-all --ambient-caps=-all --bounding-set=-all`로 실행한다. `[worker.ts:RunnerDO.launch]`
- 컨테이너는 `enableInternet:false`로 시작한다. HTTP·HTTPS는 작업별 outbound 진입점을 거친다. `[worker.ts:RunnerDO.ensure]`
- outbound는 https, 허용 호스트, userinfo 없음, 443 포트(또는 생략), `redirect:'manual'` 조건을 만족해야 한다. 아니면 403이다. `[worker.ts:CodexOutbound]`, `[worker.ts:ClaudeOutbound]`, `[worker.ts:ComputeOutbound]`
- 컨테이너의 checkpoint와 결과 응답이 8MiB를 넘으면 거부한다. `[worker.ts:RunnerDO.checkpoint]`, `[worker.ts:RunnerDO.poll]`
- alarm 한 번에 활성 작업은 최대 2개, workflow는 하나를 진행한다. `[worker.ts:SchedulerDO.alarm]`
- 같은 멱등 키로 다른 내용을 등록하면 409다. `[worker.ts:SchedulerDO.createComputeGroup]`, `[worker.ts:SchedulerDO.createWorkflow]`, `[worker.ts:SchedulerDO.createCarbon]`

## Side Effects

- R2 `ARTIFACTS`: snapshot, 작업 결과, 캐시 객체, large artifact를 읽고 쓴다. `[worker.ts:SchedulerDO.putSnapshot]`, `[worker.ts:ResourceComputeOutbound]`, `[worker.ts:CarbonOutbound]`
- R2 `CREDENTIALS`: `AUTH_STORAGE_KEY`로 암호화한 인증 객체를 읽고 쓴다. `[worker.ts:SchedulerDO.storeCredential]`
- Durable Object storage: `SchedulerDO`는 `state`와 커서·토큰 키를, `RunnerDO`는 `metadata`를 저장한다. `[worker.ts:SchedulerDO]`, `[worker.ts:RunnerDO]`
- alarm: `SchedulerDO`가 `ensureSchedulerAlarm`으로 다음 진행을 예약한다. `[scheduler-alarm.ts:ensureSchedulerAlarm]`
- 컨테이너: 시작, exec, 종료와 포트 3000 요청을 수행한다. `[worker.ts:RunnerDO.ensure]`, `[worker.ts:RunnerDO.launch]`, `[worker.ts:RunnerDO.stop]`
- 외부 네트워크: 제공자 호스트, npm·GitHub 호스트, Gemini API, Terra 게이트웨이의 상류 호스트로 요청을 전달한다. `[worker.ts:CodexOutbound]`, `[worker.ts:ClaudeOutbound]`, `[worker.ts:ComputeOutbound]`, `[worker.ts:CarbonOutbound]`
- 이름으로만 읽는 비밀과 플래그: `CONTROL_TOKEN`, `AUTH_STORAGE_KEY`, `AUTH_RETURN_PUBLIC_KEY`, `AUTH_RETURN_PRIVATE_KEY`, `GEMINI_BENCHMARK_KEY`, `TERRA_BENCHMARK_AUTH`, `CODEX_SANDBOX_APPROVED`, `CLAUDE_NESTED_APPROVED`. 값은 이 문서에 기록하지 않는다.

## Verification

- Run: `npm test` (`cloudflare/backend/`에서 실행. `node --test test/*.test.ts`)
- Run: `npm run typecheck` (`cloudflare/backend/`에서 실행. `tsc --noEmit`)
