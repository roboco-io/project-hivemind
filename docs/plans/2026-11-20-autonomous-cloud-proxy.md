# 운영자 Cloudflare autonomous proxy

## 범위와 결정

- app/main의 기존 dirty 동작을 보존한다. CloudControl과 별도 port를 추가한다.
- 소유 파일은 app.ts, main.ts, autonomous-cloud-proxy.ts, 해당 집중 테스트와 이 문서다. 제공자·broker·공통 autonomous API는 수정하지 않는다.
- 사용자가 승인한 로컬 구현이다. 실제 fetch/비밀 읽기/모델/배포/커밋/전체 검사는 수행하지 않는다.

## 공개 계약

`createAutonomousCloudProxy({baseUrl,controlToken},{fetch?,localTokens?}) -> AutonomousCloudProxy`

port는 `forward(Request):Promise<Response>`만 노출한다. config는 기존 loadCloudflareConfig의 baseUrl/controlToken에서 만든다. 토큰 getter, URL override, CloudControl 의존, 로컬 fallback은 없다.

`AppOptions.autonomousCloudProxy?`가 없으면 `/api/cloudflare/autonomous-tasks` 계열은 인증 뒤 503이다. main에서 기존 config가 있을 때만 port를 생성한다.

## 고정 경로

- GET/POST collection → 원격 `/v1/autonomous-tasks`. POST는 한 번의 명시적 draft 등록만 한다.
- GET task, POST approve/revise/cancel/message/resume/reconcile/reconcile-run/cleaned.
- C3 operator 외부 경로: POST external-approval/external-cancel, GET external-actions, POST external-actions/:requestId/reconcile|cleanup.
- remote external-profiles metadata 경로는 C3가 제공하는 계약에 맞춰 제한적으로 연결한다. worker external-action과 claim/native/heartbeat/finish/reserve/settle/worker-state는 허용하지 않는다.
- query는 collection 또는 task external-actions GET의 단일 limit(1..100)/cursor(기존 API와 같은 형식/4096자)만 허용한다. query 생략은 기존 list 배열이다.

## 인증과 HTTP

Fastify onRequest에서 로컬 operator를 인증한 뒤 body parser를 실행한다. proxy는 원격 control token으로 Authorization을 새로 만든다. 다른 로컬 헤더·쿠키·응답 헤더를 전달하지 않는다. 요청 64KiB, 응답 2MiB, HTTP 5초, redirect:error. 크기·JSON·경로·remote 오류는 고정 오류 메시지로 반환한다.

응답은 task/spec/history, page, C3 action/profile/approval의 명시적 whitelist로 투영한다. checkpoint/native/session/authReturn/ownership/idempotency/token 필드는 제외한다. 남은 문자열에서도 알려진 원격·로컬 토큰과 Bearer 값을 제거한다. app 경계에서도 주입된 port의 응답을 다시 투영하고 로컬 토큰을 제거한다.

## 로컬 외부 sidecar

`AppOptions.localExternalService?:AutonomousExternalService`. 해당 경로는 공통 handler보다 먼저 handleAutonomousExternalApi로 보낸다. external-action은 worker role로 onRequest 인증한다. 미설정은 503이다.

profile이 있는 task의 명시적 approve는 externalProfileHashes(id→SHA-256)를 assertApproval로 확인한 뒤 core approve, sidecar approve 순서로 처리한다. service가 없으면 canonical 승인도 503이며 hash 경합의 409를 유지한다. proxy는 approve에서 revision/reason/검증된 hash map만 전달한다. metadata의 profileHash와 승인 응답의 profileIds 배열을 보존한다.

cancel/revise는 공통 handler가 인증·payload 검증을 한 뒤 실제 core execute 직전에 beforeCoreMutation을 호출한다. service가 있으면 항상 barrier를 호출한다. 없으면 canonical task의 externalProfiles/외부 예약 이력 또는 새 revision의 externalProfiles가 있는 경우 503으로 차단한다. 기존 일반 작업의 취소/수정은 보존한다. barrier 실패는 core mutation을 실행하지 않는다.

## 검증

- fake fetch + Fastify inject: 인증이 JSON parser보다 먼저인지, 고정 경로/헤더/페이지/draft, worker 경로 거절, missing 503.
- 응답 전체 whitelist와 nested private/known-token 제거, redirect/timeout/응답 및 요청 상한.
- 실제 in-memory SQLite core + fake sidecar: external route 우선 처리, cancel/revise barrier 순서/실패, missing service 차단, 기존 일반 취소 유지.
- root build 뒤 새 집중 테스트와 관련 기존 app 회귀만 실행한다. 전체 검사/stamp는 조정자에게 남긴다.

## 경계와 미완료 통합

- 공개 finish 요청의 lease를 확인하기 전에 sidecar stop barrier를 실행하지 않는다. forged finish가 다른 task의 admission을 중단할 수 있기 때문이다. terminal cleanup은 core/controller가 검증한 trusted composition 경계에서 수행하며 worker finish 프로토콜은 확장하지 않는다.
- AppOptions의 external service는 trusted caller가 생성·복구·수명 관리를 한다. app이 임의 broker owner를 생성하거나 복구 중 네트워크를 호출하지 않는다. main의 기본 localExternalService는 미설정이다.
- C3의 readonly profile metadata와 action 페이지 계약은 해당 handler가 제공한다. 이 proxy는 worker 경로와 acceptExternal/settleExternal/cleanedExternal을 노출하지 않는다.
- 등록 POST는 한 번의 원격 draft 등록이다. 실패 시 로컬 큐나 자동 승인으로 전환하지 않는다.

## R1 장기 이력의 bounded review

- 추가 소유 범위: 공통 autonomous-repository, SQLite autonomous-store, DO autonomous-service. 공통 API의 route/operation은 C1이 연결한다.
- `getSummary(id)`는 전체 public spec과 상태/counts, lease.expiresAt만 반환한다. 이력·checkpoint·native/session 필드는 없다.
- `historyPage({id,kind,limit?,cursor?})`는 `pageAutonomousHistory(task,kind,query,secret)`를 사용한다. kind는 runs/actions/resources/interventions다. 반환은 `{taskId,kind,revision,items,nextCursor?}`다.
- 기본20·최대100이며 item JSON 합계 약1MiB로 먼저 제한한다. 따라서 limit은 최대 개수이며 클라이언트는 nextCursor가 없어질 때까지 읽는다. 모든 원본 이력은 그대로 보존한다.
- HMAC cursor는 task ID, kind, settings revision, 최초 길이 high-watermark, 다음 offset, 형식 버전에 결속한다. store secret도 다르면 400, revision 변경/이력 축소는 409다. 새 append는 기존 페이지 열에 끼지 않는다. 정산으로 바뀐 기존 행은 최신 값으로 표시하며 시점 전체 snapshot이라고 주장하지 않는다.
- SQLite summary는 metadata만 읽고 due 전이가 있으면 대상 task만 decode/tick/persist한다. history도 대상 task 하나만 decode한다. DO는 같은 targeted 경로를 사용하며 claim의 credential owner 검사는 기존 중앙 트랜잭션에 남는다. raw hot JSON의 기존 30/32MiB aggregate 한도를 유지한다.
- 새 operator 경로: `GET /:id?view=summary`, `GET /:id/history?kind=...&limit=...&cursor=...`. 기존 full GET은 호환용이다. UI/MCP는 반드시 새 summary/history 경로를 사용해야 2MiB 응답 한도를 넘는 task도 검토할 수 있다.
- 이미 예약된 제공자 receipt의 `acceptExternal/settleExternal/cleanedExternal`은 두 저장소의 32MiB recovery 연산이다. 외부 유료 효과를 기록하는 단계가 정상30MiB gate에 막히지 않는다. 이 이름은 공개 HTTP/proxy route에 추가하지 않는다.
- 집중 회귀: 2MiB를 넘는 task의 3,952개 run 전체를 SQLite HTTP/proxy 및 DO 재시작 페이지에서 읽고 private 필드 없음/중복 없음/누락 없음을 확인한다. Unicode byte budget, cursor scope/revision, 30MiB 초과 receipt 수락·정산·cleanup도 검증한다.
