# 장기 자율 작업

장기 작업은 기존 `/api/tasks`와 별도 계약이다. 중앙 core가 기간·예산·승인·lease·자원 원장을 관리한다. 한 번 승인한 revision 안에서 반복한다. 범위를 바꾸면 다시 승인해야 한다.

## 실행 경계

기본 실행은 명시적인 mock이며 Cloudflare 자율 실행은 기본 비활성이다. 별도 승인한 Cloudflare 실행 설정이 활성화되면, 고정 source·검사·인증 설정을 승인받은 작업만 기존 모델 스케줄러를 통해 실행한다. 등록만으로 실행하지 않는다. 네이티브 실행기와 비공개 세션 저장소가 연결되지 않은 제공자는 실행을 거절한다.

로컬 상태는 SQLite의 별도 테이블, 원격 상태는 Durable Object의 별도 키에 저장한다. 원격 상태를 로컬 SQLite에 복사하지 않는다. 워커는 HTTP만 사용한다. 대기는 미래의 재개·lease 만료·작업 종료 시각에 알람을 예약하며 모델을 호출하지 않는다. 기존 모델 작업이 실행 중일 때만 기존 스케줄러의 짧은 주기를 유지한다.

## API

기본 경로는 `/v1/autonomous-tasks`다. JSON과 Bearer 토큰을 사용한다.

| 역할 | 메서드·경로 | 본문 |
|---|---|---|
| 운영자 | POST 기본 경로 | AutonomousSpec |
| 운영자 | GET 기본 경로 또는 `/:id` | 없음 |
| 운영자 | POST `/:id/approve` | revision, reason |
| 운영자 | POST `/:id/revise` | spec, reason |
| 운영자 | POST `/:id/resume` | revision, reason |
| 운영자 | POST `/:id/reconcile` | actionId, actualCostMicros, success, resource?, reason |
| 운영자 | POST `/:id/reconcile-run` | runId, actualCostMicros, reason |
| 운영자 | POST `/:id/cancel` 또는 `/message` | reason 또는 message |
| 운영자 | POST `/:id/cleaned` | resourceId |
| 워커 | POST `/:id/claim` | workerId |
| 워커 | POST `/:id/native-start` | lease, runtimeId (private runtime이 호출) |
| 워커 | POST `/:id/heartbeat` | lease |
| 워커 | POST `/:id/finish` | lease, result |
| 워커 | POST `/:id/reserve` | lease, request |
| 워커 | POST `/:id/settle` | lease, actionId, actualCostMicros, success, resource? |

`message`는 기록만 남기며 실행 권한을 주지 않는다. 도움 요청 뒤 운영자는 현재 revision과 사유로 `resume`을 호출한다. 같은 승인 범위에서만 재개하며, 범위 확장은 `revise`와 새 `approve`가 필요하다. `reconcile`은 소유자를 잃은 행동의 비용을 정산한다. `reconcile-run`은 미확정 반복 비용을 정산하며 최초 보고된 `costMicros: null`은 보존한다. 정산 자체는 승인을 대신하지 않는다. 공개 작업의 `counts.humanInterventions`는 help를 제외한 사람 개입 건수다. `counts.helpRequests`는 도움 요청 건수이며, `counts.toolCalls`는 멱등 행동 원장 건수다. 동일 요청의 재전송은 새 도구 호출로 세지 않는다. `resume`은 최초 승인 시각·revision·범위를 유지하지만 사람 개입 기록은 추가한다.

로컬은 서버의 운영자·워커 토큰을 그대로 사용한다. Cloudflare는 `CONTROL_TOKEN`과 별도의 선택적 `AUTONOMOUS_WORKER_TOKEN`을 사용한다. 워커 토큰이 없거나 운영자 토큰과 같으면 워커 경로는 닫힌다. 두 입구 모두 본문 해석 전에 인증한다. 기존 경로의 인증은 바뀌지 않는다.

```sh
npm run build
npm start
# 별도 터미널: 합성 작업을 등록하고 한 번 승인한 뒤 두 번 실행한다.
HIVEMIND_OPERATOR_TOKEN=local-development-only \
HIVEMIND_WORKER_TOKEN=local-worker-only npm run autonomous:mock
```

이 명령은 합성 결과와 모의 비용만 만든다. 운영자 토큰은 등록·승인 어댑터에만 있고 실행기에는 전달하지 않는다. 세션 본문·인증은 공개 조회에 넣지 않는다. MemorySessionStore는 합성 실행 전용이다. 프로세스 종료 후 실제 세션을 복구하는 영속 저장소로 간주하지 않는다.

## R1–R11 상태

| 요구 | 구현 경계와 남은 검증 |
|---|---|
| R1 장기 작업 | 명시적 56일 프로필, 분할 영속 저장·복원·페이지 조회. 실제 8주·최대 메모리 미검증 |
| R2 사전 승인 | revision·설정 fingerprint·대상 hash 결속. 범위 변경은 재승인 |
| R3 도구 확장 | Bash·Agent·WebFetch·비공개 action 채널. exact host·DNS/IP/TLS 검사 구현, 실제 Workers 격리 미검증 |
| R4 모델 지정 | 주·자식 CLI 모델 ID 고정과 alias 차단. 실제 Fable 가용성·자식 응답 모델 미검증 |
| R5 세션·캐시 | 비공개 세션 복원. 이전 실제 Claude 2회 반복과 cache read 확인. 신규 장기 경로 미검증 |
| R6 대기 | 일일 시간대·DST·구조화 quota reset 대기·재시작 복원 구현. 실제 제한 도달 미검증 |
| R7 자격 증명 | 구독 인증 직렬화, 서버 전용 AWS·HF·GitHub resolver. 새 실제 제공자 자격 미사용 |
| R8 비용 상한 | task 전체 revision 예산·예약·정산·미확정 비용 차단. 외부 행동은 예약 기반 상한이며 실제 청구는 Cost Explorer로 사후 검증한다. 주기 점검이 상한 초과를 보면 작업을 중단한다. 실행 중 실제 청구 기반 집행은 만들지 않았다([비용 상한과 중단](#비용-상한과-중단)). 실제 청구·하드 상한 보장 미검증 |
| R9 외부 행동 | AWS Spot·AWS S3 put·inspect·HF commit(private 또는 공개)·HF LFS commit(private만)·GitHub expected-head commit, 멱등 복구 구현. 모두 가짜 HTTP로만 검사했고 실제 AWS·Hugging Face·GitHub는 미검증 |
| R10 사람 개입 | operator MCP 19개 도구와 dashboard, 승인·변경·메시지·취소·청구 근거 기록 |
| R11 정리 | 소유 자원 정리·재시작 복구·AWS TTL guard/CDK 구현. 실제 자원 정리 미검증 |

외부 자원의 `cleaned`·정산 전이는 서버 전용 경로가 실제 부재 근거를 확인한 뒤 수행한다. 공개 API로 이를 우회할 수 없다. 임의 Bash에는 제공자 비밀을 주입하지 않는다. 검증 후보는 Cloudflare에 배포했으며 새 기능은 비활성이다. 원격 격리와 장기 운영 수용은 아직이다. 구현·검사 근거와 잔여 운영 검증은 [잔여 구현 기록](plans/2026-11-20-autonomous-remaining.report.md)을 따른다.

## 검증 범위

lease가 만료된 실행은 체크포인트가 있어도 자동 재실행하지 않는다. 중앙 정책은 중단된 실행의 비용을 미확정으로 기록하고 운영자 확인을 기다린다. `usageUnavailable: true`인 실행의 토큰 카운터 0은 측정값이 아닌 자리표시자다. `reconcile-run`은 비용만 정산하며 누락된 사용량을 측정값으로 바꾸지 않는다. 기본 metered 정책에서 미확정 비용은 재개와 종료 확정을 막는다. 운영자가 실제 비용을 확인해 정산한 뒤 같은 범위에서 명시적으로 재개해야 한다. 이 경로는 실제 CLI 세션 복원이나 R1 완료를 입증하지 않는다.

통합 테스트의 24시간은 주입한 합성 시계다. 실제 시간을 기다린 실험이나 Cloudflare 원격 실행 근거가 아니다. HTTP 등록·단일 승인·대기·서비스 재시작·자원 원장·정리 재시도를 로컬에서 검사한다. 실제 24시간 Bash·서브에이전트 실행, CLI 세션 복원과 캐시 읽기, 유료 자원 정리까지 확인하기 전에는 이슈 #1의 완료 기준을 충족했다고 보고하지 않는다.

## 제공자 연결과 운영 한계

현재 구현은 중앙 정책·HTTP·mock과 명시적으로 연결하는 Claude native 실행 경로를 제공한다. AES-GCM 저장소는 파일 또는 private R2에 세션을 보존한다. 실제 Cloudflare의 Claude 구독 CLI 두 반복·세션 복원·필수 경계 gate·별도 검사는 [실증 기록](plans/2026-11-19-autonomous-cloud.report.md)에서 확인했다. 캐시 절감 효과·24시간·대규모 운영은 미검증이다. 이슈 #1은 아직 완료되지 않았다.

| 구분 | 현재 제공 범위 | 실제 운영 전 조건 |
|---|---|---|
| 중앙 의미론 | revision 승인, 기간·반복·예산 검사, lease, 대기, 행동·자원·개입 원장 | 로컬 합성 검증과 원격 검증을 구분 |
| 실행·저장 포트 | Claude HTTP 실행기, 인증된 private bootstrap, AES-GCM 파일·private R2 저장 | 운영 키·private 저장소와 격리 런타임을 명시적으로 구성 |
| 미검증 운영 | 24시간 Claude 구독·캐시 절감 효과·대규모 원격 격리, AWS/HF 연결, 실제 비용 집행·정리 | 격리·권한·청구·정리를 원격 환경에서 검증 |

현재 원장과 반복 기록은 작업 상태와 함께 누적된다. [Cloudflare 공식 한도](https://developers.cloudflare.com/durable-objects/platform/limits/)의 SQLite 기반 Durable Object KV는 키와 값을 합해 2 MB로 제한한다. 서비스는 UTF-8 직렬화 상태에 신규 작업용 1536 KiB 제한과 복구용 1900 KiB 상한을 적용한다. 취소·정리 확인·tick·heartbeat·정산·진행 중 실행의 finish·조회와 의도적인 정책 중단 기록에는 복구 여유를 사용한다. 신규 작업·claim·승인·재개·범위 변경은 1536 KiB를 넘는 상태를 저장하지 않는다. 복구 여유도 유한하며 1900 KiB 초과 쓰기는 이전 상태를 보존하고 거절한다. 이 제한은 플랫폼 한도를 대체하지 않는다. 8주 운영을 주장하기 전에 기록 보존 정책, 분할 저장과 페이지 조회를 구현하고 최대 상태 크기를 검증해야 한다. 기간을 지정할 수 있다는 사실만으로 무제한 기록 보존이나 8주 실행을 보장하지 않는다.

## Claude native 연결

워커는 `createClaudeAutonomousExecutor`와 `createClaudeRuntimeHttpPort`를 명시적으로 주입한다. private runtime URL·토큰은 신뢰하는 워커 설정에만 두며 작업 정책·공개 상태에 저장하지 않는다. private `/iteration`은 인증한 뒤 요청을 처리한다. 실행 요청에는 현재 `executionLease` 복사본을 포함한다. runtime은 자신의 runtime ID로 중앙 `native-start`를 호출해 유효한 claim을 확인하고, 응답의 정규 정책·체크포인트·deadline을 요청과 대조한 뒤 CLI를 시작한다. 같은 lease를 다른 runtime에 결속할 수 없다. 실행 중 중앙 heartbeat가 거절되면 중단한다. runtime의 중앙 authorizer는 신뢰하는 설정 `HIVEMIND_CONTROL_API_URL`과 `HIVEMIND_AUTONOMOUS_WORKER_TOKEN`을 사용한다. 워커가 private runtime에 보내는 토큰은 별도 `HIVEMIND_AUTONOMOUS_RUNTIME_TOKEN`이다. 운영자 토큰은 native-start를 호출할 수 없다. private 포트 인증만으로 중앙 승인을 대신할 수 없다. 전용 bootstrap 직접 실행은 `HIVEMIND_AUTONOMOUS_RUNTIME_TOKEN` 설정으로 명시적으로 선택하며 기본 loopback 포트는 3100이다. 기존 Docker CMD와 rollout 게이트는 유지한다. 로컬 호스트 CLI로 우회하지 않는다.

native는 `durable === true`인 비공개 저장소를 요구한다. `EncryptedSessionStore`는 명시적인 32바이트 키와 durable blob 저장소를 받는다. 파일 저장소와 private R2는 불변 객체를 저장한다. 암호화 AAD는 작업·세션·모델·sequence·객체 키를 결속한다. 주·자식 transcript와 작업 snapshot을 보존하며 제공자 인증 파일은 bundle에서 제외한다. MemorySessionStore는 mock 전용이다.

Claude native는 Bash를 필수로 두며 Agent·WebFetch·`mcp__hivemind__action`을 작업 허용 목록에 추가할 수 있다. WebFetch에는 승인한 exact host 목록, action에는 승인한 외부 profile 목록이 필요하다. 자식 모델은 `subagentModel ?? model`로 고정한다. 주 모델과 자식 모델은 별칭 대신 구체적인 모델 ID를 지정해야 한다. 실제 제공자의 해당 모델 가용성은 별도 검증이 필요하다. 주 세션의 승인 credential ID는 정확히 하나다. 외부 profile을 사용하면 승인한 aws·hf·github만 systems에 지정하며, 제공자 비밀은 서버 전용 resolver가 처리한다.

native 비용은 `costMicros: null`로 보고한다. 기본 metered 정책에서 계속 실행할 반복은 중앙에서 입력 대기로 전환하며, 운영자가 근거로 `reconcile-run`을 호출한 뒤 `resume`해야 다음 반복을 실행한다. 정상 실행 중 complete·failed 결과는 종료 의도를 보존한 stopping으로 전환한다. 비용·미확정 행동·자원 정리가 끝나면 completed·failed를 확정하며 추가 모델 호출이나 resume은 필요 없다. 예산 중단·기존 취소가 우선하고 범위 위반으로 입력 대기 중인 작업은 워커 결과만으로 종료하지 않는다. 사용량으로 비용 0을 추정하지 않는다. 따라서 이 경로는 무인 반복 운용을 입증하지 않는다.

중앙 claim은 다른 native 작업과 credential ID가 겹치면 lease가 있거나 확인되지 않은 실행 비용이 남은 동안 실행을 거절한다. 새 구독 정책에서 runtime 완료 근거가 확인된 이력은 다음 작업의 credential 사용을 막지 않는다. stopping과 소유자를 잃은 실행도 포함한다. lease 만료 후에도 먼저 중앙 만료 처리와 수동 비용 대사가 필요하다. mock 작업은 이 native 직렬화 대상에서 제외한다.

## 구독 반복 정책과 명시적 워커 루프

`billingPolicy: {model:'subscription', budget:'external_actions'}`는 Claude 작업에서만 명시적으로 선택한다. 생략하면 기존 미확정 모델 비용 대사 정책을 유지한다. 정책 변경은 revision과 새 승인이 필요하며, 실행 이력이 있으면 정책을 바꿀 수 없다.

새 정책의 `budgetMicros`는 중앙 외부 행동 예약·정산 예산이다. 구독료·모델 금액·플랫폼·컨테이너·R2 비용은 이 예산에 포함되지 않는다. 외부 행동의 비용 상한은 예약 기반이며, 실제 청구를 읽어 실행 중에 집행하는 기능은 만들지 않았다. 사후 검증과 주기 점검의 범위는 [비용 상한과 중단](#비용-상한과-중단)에 적었다. native 실행의 `costMicros`는 계속 `null`이며 비용 0으로 확정하지 않는다.

별도 reporter는 CLI 시작 전에 ready를 확인하고 프로세스 종료·세션 수집 뒤 완료 receipt를 제출한다. 중앙은 runtime·session·model·sequence·사용량이 finish와 일치할 때만 `subscription_runtime` 근거를 기록한다. 확인된 구독 반복은 사람의 매회 `reconcile-run`·`resume` 없이 이어진다. receipt 누락·lease 유실·실행 결과 불명확은 자동 면제하지 않는다. 기본 metered 정책은 앞 절의 수동 대사 흐름을 유지한다.

| 역할 | 경로 | 본문 |
|---|---|---|
| 워커 | GET `/:id/worker-state` | 없음. taskId·status·endsAt·nextRunAt·iteration만 반환 |
| reporter | POST `/:id/native-ready` | lease, runtimeId |
| reporter | POST `/:id/native-receipt` | lease, receipt |

로컬 서버의 선택 설정은 `HIVEMIND_NATIVE_REPORTER_TOKEN`, Cloudflare는 `AUTONOMOUS_REPORTER_TOKEN`이다. runtime reporter는 `HIVEMIND_CONTROL_API_URL`과 `HIVEMIND_NATIVE_REPORTER_TOKEN`을 사용한다. reporter 키는 운영자·워커·private ingress 키와 분리한다. CLI 환경·세션·공개 응답에는 넣지 않는다. 워커 HTTP는 GET과 POST 모두 redirect를 거절하여 lease 본문과 인증의 재전송을 막는다. 설정 누락이나 권한 거절 시 새 정책의 CLI 실행을 시작하지 않는다.

`packages/adapters/src/autonomous-loop.ts`의 `runAutonomousLoop(options)`는 선택적 라이브러리다. import나 기존 명령 실행으로 루프를 시작하지 않는다. 기존 `runAutonomousIteration` 옵션에 양의 정수 `maxIterations`와 `maxIdlePolls`를 반드시 지정한다. `pollMs` 기본값은 1000ms이며 1-60000ms만 허용한다. `maxIdlePolls`는 루프 전체의 대기 횟수 상한이다. 성공 결과는 `{iterations, reason}`이며 반복 상한은 `iteration_limit`, 대기 상한은 `idle_limit`이다. `workerState` 없는 구형 클라이언트는 단일 반복에 쓸 수 있지만 루프에는 쓸 수 없다.

루프는 운영자 credential을 받지 않고 자동 승인하지 않는다. waiting·다른 워커의 running·claim 경합에서는 잠든 뒤 최소 상태만 조회한다. 종료·입력 대기·stopping·승인 대기에서는 새 실행 없이 반환한다. 실제 sleep은 AbortSignal로 중단할 수 있다. 실행·체크포인트·finish 오류는 호출자에게 전파하며 자동 재시도하지 않는다. 호출자는 중앙 상태와 미확정 실행을 확인한 뒤 후속 행동을 결정해야 한다. 테스트용 `now`·`wait` 주입은 합성 시계이며 실제 24시간 무인 운영 근거가 아니다.

## Cloudflare 자율 실행 후보와 승인 경계

Cloudflare 실행 연결은 [실행 계획](plans/2026-11-19-autonomous-cloud.md)의 배포 후보다. 위의 기존 워커 루프와 별도 경로이며, 기본값은 `AUTONOMOUS_CLOUD_ENABLED=false`다. 기존 local 작업을 활성화만으로 원격 실행하지 않는다. Cloudflare profile은 운영자가 고정한 `SourceSnapshot`의 `snapshotId`와 검사 argv를 사용한다. 모델이나 작업 본문이 소스 URL·검사 명령·배포 대상을 선택하지 않는다. 실행 이력 뒤에는 소스와 검사를 변경하지 않는다.

승인된 profile은 중앙 private claim → 기존 Scheduler JobRecord → 기존 RunnerDO → private native 파일 실행 순서로 진행한다. 일반 워커의 claim·finish로 이 경로를 대신하지 않는다. 다음 alarm은 로컬 워커 없이 반복을 진행해야 한다. 재시작 뒤에도 기존 run·job·lease와 session을 복원해야 하며, exec 응답이 유실됐다는 이유로 모델 작업을 다시 제출하지 않는다.

완료에는 native 결과 외에 실제 모델 컨테이너 종료, sealed auth의 인증 세대 반영, 인증 없는 compute 검사의 성공이 모두 필요하다. 확인되지 않은 종료·인증 회수는 기존 credential lane을 격리한다. legacy 작업과 native 작업은 같은 credential을 동시에 사용하지 않는다. 취소·시간 만료 뒤 도착한 finish는 거절한다. 검사 실패는 자동 다음 반복으로 넘어가지 않는다. 설정 누락과 runtime manifest 불일치는 인증 전달 전에 차단한다.

### 승인 후보

대상은 기존 `hivemind-cloudflare-backend` Worker와 `https://hivemind-cloudflare-backend.roboco.workers.dev`다. 계정은 기존 `wrangler.json`과 대조한다. 새 Worker·bucket·AWS 자원을 만들지 않는다. 고정 후보 hash와 전체 검사·로컬 실패 근거는 [후보 검증 기록](plans/2026-11-19-autonomous-cloud.report.md)에 보존한다. 승인된 실제 Cloudflare 두 반복·경계 gate는 해당 기록에서 확인했다. 24시간·대규모 운영은 미검증이다.

별도 사용자 승인 범위는 기존 Worker 갱신, delta secret 세 개(`AUTONOMOUS_WORKER_TOKEN`, `AUTONOMOUS_REPORTER_TOKEN`, `AUTONOMOUS_SESSION_KEY`), feature 활성화와 격리된 CLI canary 두 반복이다. 기존 `GEMINI`와 그 밖의 secret은 보존한다. delta만 적용하고 기존 secret 삭제·전체 재등록을 수행하지 않는다. 실제 값은 문서·로그·일반 artifact에 기록하지 않는다.

canary는 운영자가 고정한 `counter.txt` snapshot·Node 검사 argv·명시적 모델 ID를 사용한다. 최대 두 CLI 반복, 반복당 120초, 전체 10분, `standard-1`, native 동시 실행 하나로 제한한다. source는 64KiB·32파일 이하, 검사마다 10초 이하다. 24시간 실행·AWS·HF는 승인 후보에 포함하지 않는다. 이 문서 작성은 실행 승인이 아니다.

### 중단과 rollback

1. 신규 자율 dispatch를 비활성화하고 진행 중 task·job·run·credential generation을 조회한다.
2. 중앙 취소를 요청하고 기존 Runner의 종료·인증 회수·세대 반영을 확인한다. 미확인 lane은 격리를 유지한다.
3. 진행 중 모델·compute와 미회수 인증이 없음을 확인한 뒤 이전 Worker/runtime 조합으로 복원한다. 먼저 코드를 되돌려 private 실행 상태를 잃지 않는다.
4. 암호화 session·private 결과와 사건 기록을 보존한다. token·session key를 임의 교체하지 않는다. 원인 검토와 새 사용자 승인 전에는 다시 활성화하지 않는다.

GET metadata는 조회 시점의 운영 상태만 입증한다. 실제 local Docker 무모델 probe는 로컬 이미지 경계만 입증한다. fake Cloudflare actor·unit 테스트는 상태 전이와 플랫폼 호출 계약을 검사한다. Wrangler dry-run은 배포 패키징만 검사한다. 실제 원격 CLI·종료·인증 회수·검사를 확인한 기록만 Cloudflare 실행 근거로 사용한다.

### 불명확한 실행의 복구

`paused` controller는 core의 `reconcile-run`·`resume`만으로 다시 제출하지 않는다. 같은 job의 자동 모델 재시도도 하지 않는다. 먼저 기존 job의 실제 종료와 인증 회수·세대 반영을 확인하고 격리 사유를 해결한다. 원본 task·job·run과 private session 근거를 보존한다. 현재 private pause를 해제하는 운영 API는 없으므로, 재실행이 필요하면 운영자가 검토한 고정 source로 새 작업을 등록하고 별도로 승인한다. 저장소의 private record를 지우거나 status를 ready로 바꾸는 방식으로 복구하지 않는다.

### Native 실행 전 실제 경계 probe

runtime manifest fence가 통과해도 provider 인증을 바로 전달하지 않는다. Runner는 이미지가 보호하는 `runtime/autonomous-boundary-probe.ts`를 무모델로 실행하고, 실제 파일 접근 차단까지 통과한 proof를 현재 runtime revision에 결속해 보존해야 한다. proof가 없거나 실패하거나 다른 revision의 proof이면 provider 입력 전달과 native launch를 차단한다. 같은 UID·capability 0·NoNewPrivs·관리 설정만으로 파일 접근 격리를 입증하지 않는다.

최종 이미지의 실제 로컬 Docker probe는 UID·capability·NoNewPrivs·관리 설정·native 인증 경계를 통과했지만, amd64 에뮬레이션 환경에서 namespace 생성이 거부되어 sandbox는 실패했다. 이 결과는 실제 파일 접근 차단의 성공이 아니다. Cloudflare probe도 실패하면 실행 gate를 닫는다. probe 생략·sandbox 완화·호스트 실행으로 대체하지 않는다.

### 증명된 미시작 실패

native boundary probe 미지원 같은 모델 실행 전 실패는 별도로 처리한다. 신뢰된 Runner가 실제 컨테이너 종료와 native 미실행을 모두 확인한 경우에만 기존 credential lane을 같은 인증 세대로 반환한다. job의 authDisposition은 unchanged_unstarted이며 인증 갱신을 수행한 것으로 표시하지 않는다. 중앙 private finishUnstartedCloud는 nativeStart·receipt가 없는 실행만 비용0·사용량0의 failed로 종료한다. 이 0은 모델 미실행을 증명한 preflight에만 적용한다.

exec intent 유실·이미 launch한 실행·종료 미확인은 이 경로를 사용할 수 없다. 기존 격리·미확정 비용 경계를 유지하며 다른 job이 소유한 credential lane을 해제하지 않는다. 비용0 proof를 받는 공개 HTTP endpoint는 추가하지 않는다. 실패 뒤 모델 자동 재시도는 하지 않으며 재실행에는 새 작업 등록·승인이 필요하다.

### 서버의 기존 Claude 호환 모드 전달

Worker는 기존 CLAUDE_NESTED_APPROVED 설정을 private 입력의 선택 필드 claudeNestedCompatible에 복사한다. 파일 실행기는 이를 trusted options의 nestedCompatible로 전달해 기존 Claude 설정 모드를 선택한다. standalone 기본값은 false로 유지한다. task·native request·공개 JobSpec은 이 필드를 지정할 수 없다. 실패 시 모드를 바꾸는 fallback은 없으며 실제 boundary probe는 인증 전달 전에 계속 필수다. 이 전달은 기존 서버 계정 모드와의 설정 일치이며 새 실행 권한을 부여하지 않는다.

## 비용 상한과 중단

외부 행동의 상한은 예약으로 막는다. 행동을 실행하기 전에 profile의 `upperBoundMicros`를 작업 예산에서 예약한다. 예약과 확인된 비용의 합(exposure)이 작업 상한(cap)을 넘으면 새 행동을 승인하지 않는다. 이 예약은 실제 청구액이 아니라 최대 노출액이다.

실제 청구는 Cost Explorer를 읽어 사후에 확인한다. Cost Explorer 데이터는 최대 48시간 늦게 반영되므로, 실행 중인 자원의 실제 청구를 읽어 바로 차단하는 기능은 만들지 않았다. 검증된 비용이 들어오기 전까지 예약은 유지된다.

Cloudflare 백엔드의 Durable Object alarm은 정리 작업과 함께 주기 점검(sweep)을 한다. 점검은 다음 세 경우 중 하나에서 작업을 중단한다. 첫째, broker가 `cost_exceeded`로 표시한 경우다. 둘째, 검증된 비용(verified)이 cap 이상인 경우다. 셋째, exposure가 cap을 넘는 경우다. exposure가 cap과 같으면 중단하지 않는다. 중단은 기존 `budget_exceeded` 중단 경로를 쓰며, 이미 중단 중이거나 종료된 작업에는 아무 일도 하지 않는다. `stopExternalBudget`은 서버 내부 연산이며 HTTP 경로가 없다. 점검은 자원 만료 시각도 다음 alarm 시각에 반영한다. 로컬 control-plane에는 이 점검을 연결하지 않았다.

이 중단은 새 모델 호출과 새 외부 행동을 막는다. 이미 만들어진 외부 자원의 정리는 기존 정리 절차가 맡으며, 중단이 곧 정리 완료를 뜻하지 않는다.

## 워커 도구 호출 기록

`counts.toolCalls`는 broker를 거친 외부 행동의 건수다. 워커 컨테이너 안에서 Claude가 부른 Bash·WebFetch 같은 내부 도구 호출은 포함하지 않는다. 내부 도구 호출은 별도 기록으로 남기며, `counts.workerToolCalls`에 저장된 건수를 표시한다.

이 기록은 워커가 보고한 내용이며 독립 증명이 아니다. 워커가 기록을 빠뜨리거나 바꿀 수 있고, HIVEMIND는 보고되지 않은 호출을 알 수 없다. 모든 레코드와 응답에 `source: 'worker_report'`를 표시한다. 대시보드와 MCP 도구는 같은 문구로 이 사실을 알린다.

컨테이너 안의 hook(`PreToolUse`, `PostToolUse`, `PostToolUseFailure`)이 호출마다 한 줄을 spool 파일에 추가한다. 워커는 heartbeat와 종료 전에 묶음으로 서버에 전송한다. 서버는 lease를 확인한 뒤 `(작업, 실행, sequence)`를 멱등 키로 저장한다. 재전송은 중복을 만들지 않는다. 건너뛴 sequence는 409와 `expectedSequence`로 거절한다.

| 항목 | 한도 또는 규칙 |
|---|---|
| 레코드 크기 | 1024바이트 |
| 입력 요약 | 512바이트. 가리기를 마친 뒤 UTF-8 경계에서 자른다. 잘리면 `inputTruncated: true` |
| 전송 묶음 | 32건 |
| 작업당 저장 | 20000건, 16 MiB |
| 워커 spool | 8 MiB |
| 저장하지 않는 값 | `tool_response`. 입력 원문도 저장하지 않고 가린 요약과 원문 SHA-256 digest만 저장한다 |

알려진 비밀 값, API 키·토큰 형태, PEM 블록, `Authorization`·`Bearer` 값, URL의 사용자 정보는 요약에서 `[REDACTED]`로 바꾼다. 가리기는 패턴 기반이므로 모든 비밀을 잡는다고 보장하지 않는다. spool이나 저장소가 가득 차면 작업을 멈추지 않고 버린 건수를 센다. 이 값은 응답의 `totals.droppedByWorker`, `totals.droppedByStore`에 나온다. 버린 건수가 있으면 기록이 완전하지 않다. spool을 쓸 수 없으면 `PreToolUse`는 닫힌 쪽으로 실패해 해당 도구 호출을 막는다.

| 역할 | 메서드·경로 | 본문 또는 쿼리 |
|---|---|---|
| 운영자 | GET `/:id/tool-calls` | `limit`(1-100), `cursor` |
| reporter | POST `/:id/tool-calls` | lease, records, droppedByWorker |

운영자 대시보드는 `/api/cloudflare/autonomous-tasks/:id/tool-calls`를 거쳐 같은 응답을 읽는다. MCP 도구는 `hivemind_autonomous_tool_calls`다. 서버가 준 값은 대시보드에서 `textContent`로만 표시한다. 실제 컨테이너가 보내는 hook payload 필드는 Claude Code 2.1.319 기준의 추정이며 실제 컨테이너에서 확인하지 않았다.

## S3 쓰기·조회

`provider: 's3'` profile은 `aws.s3.put`과 `aws.s3.inspect`를 허용한다. put은 이미 등록한 artifact를 서버가 정한 bucket과 prefix 아래 한 객체로 저장한다. 모델이 정하는 값은 `keySuffix`와 `artifactDigest`뿐이다. inspect는 같은 승인 안의 put을 가리키는 `{putActionId}`만 받으며, 그 put의 키와 digest를 HEAD로 확인한다. bucket·prefix·계정·region·KMS 키는 서버 profile만 정하고, 운영자는 승인 화면에서 bucket과 prefix를 본다.

put은 기존 객체를 덮어쓰지 않으며 HIVEMIND는 객체를 삭제하지 않는다. 비용은 `verifiedCostMicros: null`로 두어 운영자가 정산하기 전까지 예약을 유지한다. 인스턴스 종료나 작업 종료는 저장 비용을 끝내지 않는다. 객체 크기는 artifact 한도(1 MiB)와 `maxObjectBytes` 중 작은 값을 넘을 수 없다. 설계, IAM 예시와 한계는 [S3 설계](plans/2026-11-21-autonomous-external-s3.md)에 있다. 이 경로는 가짜 HTTP로만 검사했으며 실제 AWS S3와의 서명 호환은 확인하지 않았다.

## Hugging Face 공개 범위와 LFS commit

HF target에는 선택 필드 `visibility`(`private` 또는 `public`)가 있다. 생략하면 private이다. 서버 설정의 visibility와 승인한 profile의 visibility가 다르거나, 저장소가 보고하는 `private` 값이 기대와 다르면 commit하지 않는다. visibility를 정하면 profile 해시가 바뀌므로 운영자는 정확한 공개 범위를 승인한다. 운영자 화면은 `hfVisibilityDisplay`(`visibility`, `publicEffect`, `notice`)를 보여 주어 공개 저장소에 commit한다는 사실을 승인 시점에 드러낸다. 비공개 저장소를 공개로 바꾸거나 저장소를 만드는 기능은 없다.

`hf.model.lfs_commit`은 inline 한도(총 1 MiB)를 넘는 큰 파일을 올리는 별도 작업이다. 매개변수는 `{manifestDigest, message}`다. 흐름은 다음과 같다. 워커가 `external-large/begin`, `part`, `complete`로 파일을 8 MiB 조각 단위로 올리고, `manifest`로 파일 목록을 묶어 digest를 받는다. 서버는 이 manifest가 승인된 작업·revision·profile의 것인지 확인해 grant로 기록한다. grant가 없는 digest로는 commit할 수 없다. 작업을 취소하거나 revision을 바꾸면 해당 작업의 진행 중 업로드를 모두 중단한다.

| 항목 | 한도 또는 규칙 |
|---|---|
| 파일 크기 | 파일당 5 GiB(LFS basic transfer). LFS multipart는 지원하지 않는다 |
| 조각 | 8 MiB. 마지막 조각을 뺀 모든 조각은 정확히 8 MiB |
| 업로드 기록 수 | 작업·revision당 상태와 무관하게 최대 64개(`maxUploadRecords`, 설정 상한 256). 원장에는 행 삭제 경로가 없어서 `begin`과 `abort`를 반복하면 기록이 끝없이 늘 수 있으므로, 새 `begin`이 상한에서 413으로 거절된다. 같은 파일을 다시 `begin`해 기존 업로드를 이어 가는 호출은 새 기록을 만들지 않아 상한과 무관하게 통과한다. |
| 무결성 | 조각마다 sha256을 기록하고, 완료 때 객체를 다시 읽어 전체 sha256과 크기를 확인한다. 다르면 객체를 지우고 409 |
| 소유 | 저장 키는 작업·revision·profile에 묶인다. 다른 작업의 `storageRef`는 거절한다 |
| 공개 저장소 | 거절한다. 여러 GiB 파일은 기존 중첩 디코드 비밀 검사를 할 수 없기 때문이다 |
| 비밀 검사 | 대형 파일의 내용은 비밀 값 검사를 거치지 않는다. 서버는 commit 매개변수와 파일 경로만 검사한다. 그래서 대형 파일은 private 저장소에만 올릴 수 있고, 파일에 비밀이 없다는 보증은 하지 않는다 |
| 업로드 검증 | manifest는 `complete`로 hash 검증을 마친 파일만 담을 수 있다. 객체가 저장소에 있다는 사실만으로는 받지 않는다 |
| 업로드 주소 | 서버가 정한 허용 호스트의 https만 받고, redirect를 따르지 않으며, 그 요청에 Authorization 헤더를 보내지 않는다 |

Hugging Face LFS API의 동작은 공식 문서로 확인하지 않은 가정이다. 가짜 HTTP로만 검사했으며 실제 Hugging Face는 미검증이다. 다중 GiB 객체를 Worker에서 다시 읽어 hash를 확인할 때의 CPU 한도도 검증하지 않았다.

## 실제 프로젝트 검증 이관

2026-11-20 사용자 지시에 따라 실제24시간·외부 제공자·Fable 검증은 실제 프로젝트에서 수행한다. 이는 통과 판정이 아니다. 원문 이슈의 실제 수용과 이번 bounded 구현 완료를 구분한다. [구현 마감 기록](plans/2026-11-20-issue1-implementation-closeout.md), [인수 도구](plans/2026-11-20-issue1-acceptance-harness.md)를 따른다.

HF/GitHub action에는 선택적 `artifact: {files:[{path,contentBase64}]}`를 함께 보낼 수 있다. 기존 action의 `parameters.artifactDigest`는 canonical artifact digest여야 한다. 모델 sidecar는 같은 승인 프로필로 파일을 등록한 뒤 반환 digest와 일치할 때만 원래 requestId의 action을 호출한다. 등록 자체는 외부 게시가 아니다. 파일이 다른 작업/revision/profile에서 등록되었다면 그 digest를 알아도 게시할 수 없다.

현재 inline 상한은 총1MiB·32파일·파일당256KiB다. revision당32개·32MiB까지 저장을 예약하며 실패한 업로드도 할당량에 포함한다. HF commit은 서버가 정한 visibility(생략하면 private)를 따르며, 대형 파일은 private 저장소의 LFS commit만 지원한다. 비공개에서 공개로의 전환과 저장소 생성, 범용 S3 API는 지원하지 않는다. S3는 `aws.s3.put`·`aws.s3.inspect`만 제공한다. 이 범위를 넘어선 모델 배포를 완료했다고 표시하지 않는다.
