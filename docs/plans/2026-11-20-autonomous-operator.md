# 장기 자율 작업 운영자 접점

## 범위

operator MCP server와 새 autonomous 모듈, dashboard HTML/JS/CSS, 새 MCP/DOM 테스트와 이 문서를 작성한다. API/core/native/sidecar/배포 설정은 다른 소유자 영역이다. 외부 모델·비밀·공용 네트워크·배포·커밋·전체 테스트·runtime stamp를 실행하지 않는다. 테스트는 실제 MCP SDK와 배포되는 JS의 DOM 이벤트를 사용한다.

## 경계와 계약

Cloudflare proxy /api/cloudflare/autonomous-tasks만 사용한다. 미설정/503에서 local /v1 또는 /api/tasks로 우회하지 않는다. GET ?limit=20&cursor=...는 {items,nextCursor?}, GET /:id?view=summary는 canonical summary, POST 기본 경로는 draft spec, POST /:id/approve는 {revision,reason,externalProfileHashes?}다. 외부 profile을 선택했다면 map이 필수다. cancel/message/resume은 각각 reason/message/{revision,reason}를 사용한다. 승인과 등록은 별도 동작이다. polling과 등록 결과에서 approve를 호출하지 않는다.

확인된 C3/proxy 경로는 GET /:id/external-actions?limit=20&cursor=...와 GET /:id/external-profiles다. actions는 {items,nextCursor?}, profiles는 {profiles,enabled?,available?}다. profile에는 id/provider/enabled/target/operations/upperBoundMicros/maxLifetimeMs/maxActiveActions/profileHash를 사용하며 credential 값은 받지 않는다. 표시한 모든 profileHash를 ID map으로 main approve에 결속한다. metadata가 없거나 비활성/중복 provider/hash 누락이면 외부 profile의 UI/MCP 승인을 막는다. audit은 제한된 core runs/interventions/actions/resources와 C3 외부 행동 한 페이지를 반환한다. next cursor가 있으면 확인된 일부임을 표시한다. reconcile/cleanup은 이번 MCP 도구로 실행하지 않는다.

주의: frozen sidecar는 request.taskId와 ExternalAction 응답을 기대하지만 현재 C3 worker body는 이를 거절하고 ExternalPublicAction을 반환한다. 이 정합성은 해당 소유자가 해결해야 한다. operator 도구와 별개이며 통합 완료로 보고하지 않는다.

## MCP

hivemind_autonomous_list/get/create/approve/cancel/message/audit 일곱 도구를 추가한다. native sidecar의 action과 이름이 겹치지 않는다. 기존 도구의 동작은 유지한다. args는 Zod strict다. list는 limit/cursor, get은 taskId, audit은 taskId/limit/cursor/historyCursors, approve는 taskId/revision/reason/externalProfileHashes?, cancel은 taskId/reason, message는 taskId/message다. mutation 설명은 사용자 명시 지시를 요구한다.

create는 requestId/goal/provider/model/subagentModel?/endsAt/budgetMicros/tools/systems/credentialIds/externalProfiles?/web?/execution/billingPolicy/maxRunMs/maxIterations/schedule?를 받는다. execution에는 명시적 cloudflare backend, snapshotId와 checks argv가 필요하다. snapshot/model/credential/profile/대상을 추측하거나 생성하지 않는다. Claude 구독 실행만 지원하고 profile은 unique ID 최대 세 개이며 AWS/HF/GH별 하나다. args 단계에서 tools/web/외부 profile의 결속을 검사하고 중앙 공통 capabilities 정책이 최종 권한을 검증한다. credential은 reference ID만 받고 token 형태는 거절한다. shell 문자열 실행이나 원격 업로드를 하지 않는다.

approve/cancel preflight는 먼저 canonical summary GET으로 current revision/status를 대조한다. stale 요청은 POST 없이 거절하며 중앙도 revision을 다시 검사해야 한다. SafeMcpServer의 generic 오류·비밀 redaction을 유지한다. public DTO는 allowlist로 생성한다. lease/token/checkpoint/native receipt/runtime ID/raw provider 데이터/credential 값은 반환하지 않는다. runs의 usageUnavailable=true이면 토큰 placeholder 0을 null/미측정으로 표시한다. costMicros=null은 미확정이며 verified 외부 비용과 구독 모델 비용을 합쳐 0으로 만들지 않는다.

## Dashboard

기존 파랑/흰색 관제실의 typography, line, pill과 facts를 재사용한다. 새 영역은 왼쪽 paginated 장기 작업 목록과 오른쪽 승인 검토다. 기존 작업 선택과 polling/focus를 바꾸지 않는 독립 상태를 사용한다. 새 snapshot 등록 폼은 이번 범위에서 생략한다.

목록/current revision/goal/model/end time/tools/web hosts/credential references/external profile ID와 확인된 target/budget metadata를 textContent로 보여준다. 모델 문자열을 innerHTML로 넣지 않는다. credential reference는 실제 비밀과 구분한다. 예약 상한/확인 비용/모델 금액 미확정/미측정 사용량/정리 대기를 각각 표시한다.

승인은 검토한 revision·표시한 profileHash map과 입력 사유에 결속한다. polling에서 revision이 바뀌면 사유를 지우고 다시 검토하게 한다. submit 직전 GET으로 revision을 대조한다. 현재 revision/승인 대기/metadata가 확인된 작업에만 버튼을 활성화한다. cancel/message/resume도 명시적 버튼/사유로 처리한다. 연결 실패는 전용 패널에 표시하며 기존 작업 폼과 polling을 막지 않는다. 목록 버튼을 재사용해 키보드 focus를 보존한다.

## 검증과 자체 검토

먼저 SDK/DOM 테스트를 작성해 실패를 확인한다. 실제 SDK list/call로 draft 등록의 무승인, 엄격한 scope, stale 승인, 503 무우회, generic 오류와 비밀 미노출을 확인한다. DOM harness는 실제 app.js의 polling/select/submit을 실행하고 textContent, focus 버튼 재사용, explicit revision 승인, unknown 비용/미측정 사용량, 외부 metadata 누락 시 잠금을 검사한다. 기존 MCP/dashboard focused 테스트를 함께 실행한다.

metadata의 실제 C3 응답이 연결되기 전에는 통합 완료로 보고하지 않는다. 기존 MCP 도구 수 assertion은 새 도구가 늘어 달라질 수 있지만 소유하지 않은 기존 테스트를 수정하지 않는다. 실패가 생기면 보고한다. UI/SDK 검증은 Cloudflare 원격 실행이나 사용자 승인 근거가 아니다.


## 고정 승인 hash와 충돌

MCP approve args는 taskId/revision/reason/externalProfileHashes?다. 외부 작업은 get에서 표시한 모든 profile ID의 profileHash를 map으로 명시해야 한다. 승인 전 current revision과 metadata를 대조하되 새 hash로 자동 대체하지 않는다. Dashboard도 화면에 표시한 map을 캡처하며 변경을 감지하면 검토를 갱신하고 사유를 지운다. POST 409도 검토만 갱신하며 새 클릭을 요구한다. polling·GET·초안 등록은 승인하지 않는다.

accepted 행동은 실행 수락이며 청구 확정이 아니다. 실제 금액이 아직 없으면 MCP actualCostMicros를 null/billingStatus unknown으로 투영하고 UI에는 원장 확인분과 별도로 미확정 청구가 있음을 표시한다. 원장의 spent/reserved는 공급자 실제 청구액으로 표시하지 않는다. usageUnavailable placeholder는 측정값 0으로 표시하지 않는다.


## R1 bounded review와 동결 근거

새 operator는 기본 full GET을 사용하지 않는다. get/review/approve/cancel preflight는 GET /:id?view=summary를 사용한다. audit은 GET /:id/history?kind=runs|actions|resources|interventions&limit=20&cursor=...의 네 페이지와 별도 external-actions 페이지를 사용한다. MCP historyCursors는 kind별 cursor map이다. 전체 개입/도구 수는 summary.counts.humanInterventions/helpRequests/toolCalls만 투영한다. 각 페이지에는 pageCount/partial/nextCursor를 별도로 둔다. 부분 이력 길이를 전체 건수로 만들지 않는다.

Dashboard는 summary와 bounded runs 20개 페이지를 분리한다. runsNextCursor는 다음 페이지가 있음을 표시하며 전체/최신 이력이라고 주장하지 않는다. summary에 자원 이력이 없다는 이유로 정리가 완료됐다고 표시하지 않는다. snapshot 생성 폼이나 추가 선택적 UI는 구현하지 않았다.

최종 소유 파일 focused 검사: 실제 SDK 13건과 실제 app.js DOM 이벤트 12건, 총 25건 통과·0건 실패. 관련 TypeScript 컴파일 통과. 기존 Dashboard 6건도 별도 통과했다. 기존 MCP 테스트 두 건은 도구 수를 10개로 고정한 assertion으로 실패했다. 새 operator 7개를 더하면 17개다. 이 기존 테스트는 소유 범위 밖이므로 수정하지 않았으며 coordinator가 갱신해야 한다. 전체 suite, runtime stamp, 공용 네트워크·모델·배포·커밋은 실행하지 않았다.

factory/backend wiring과 native 실증은 다른 소유자 작업이다. 이 접점의 로컬 SDK/DOM 검증만으로 전체 시스템 ready, 실제 24시간 운영 또는 AWS 배포 완료를 주장하지 않는다.


## R8 운영자 invoice 기록 계약

운영자 MCP에 hivemind_autonomous_record_external_cost를 추가해 총 도구 수는 18개다. taskId/requestId/revision/actualCostMicros/evidenceRef/reason을 strict required로 받고 단일 operator POST external-actions/:requestId/billing을 실행한다. audit의 immutable 행동 revision만 사용하며 현재 summary revision으로 대체하지 않는다. 공급자 요금이나 token으로 금액을 추정하지 않는다. 서버의 실제 부재 확인·known outcome·인간 reconciliation 1건 보장이 전제다. native sidecar/ExternalOperation에는 billing을 추가하지 않는다.

canonical billingSource는 operator_attested/provider_verified다. UI/MCP는 인간 확인을 provider API 측정과 구분하고 evidenceRef/attestedAt/revision/resourceId를 투영한다. 누락한 revision은 현재 revision으로 만들지 않는다. 새 Dashboard 비용 폼은 없다.

소비자 focused TypeScript 컴파일 및 SDK/DOM/기존 MCP/workflow/Dashboard 50개 통과. 이 결과는 알려준 producer DTO fixture와 실제 SDK/배포 JS 이벤트의 소비자 검증이며 실제 invoice 기록이나 provider 과금 검증이 아니다. 현재 proxy billing route/필드와 C3 operatorBilling nested provenance 전달은 별도 소유자의 연결 확인이 필요하다. 전체 suite는 coordinator만 실행한다.


## 승인 당시 대상 audit

외부 행동별 profileId/approvedTarget/approvedProfileHash를 추가한다. durable old approval에서 producer가 제공한 값만 사용하고 현재 registry 조회값이나 계산한 hash로 채우지 않는다. typed target의 승인된 필드만 각 256자 이내로 투영하고 hash는 64자리 hex만 허용한다. Dashboard는 resourceId가 없어도 행동의 revision/requestId와 “승인 당시 대상”을 표시한다. 누락한 근거는 미보고다. credential/ownership/idempotency 필드, 비용 출처·금액·확정 동작은 변경하지 않는다. 소비자 focused 타입 검사와 SDK/DOM/기존 호환 52개 통과. Producer/proxy의 새 세 필드 전달은 별도 연결 대상이다.


## 최종 소비자 연결 검증과 동결

최종 producer/proxy 계약에 맞춰 실제 운영자 billing SDK → proxy → C1 API → broker/core의 합성 invoice 기록을 검사했다. worker/활성 자원은 거절하며 부재 확인 뒤 같은 입력 재전송에도 인간 reconciliation 1건이다. revision/resourceId/profileId/승인 당시 target·hash/source/evidenceRef/attestedAt가 전달된다. 이 문서의 앞선 pending 및 실패 기록은 당시 상태이며 최종 source 조합에서는 해당 연결이 통과했다.

정확한 도구 수는 18개다. 최대 유효 scope와 SDK 512 elements/64KiB/strict schema 상한을 유지했다. 격리 root focused 61개, backend sidecar/actor focused 33개, 합계 94개와 관련 타입 검사가 통과했다. 제품·테스트·소비자 문서를 동결한다. 전체 프로젝트 gate와 원격 실증은 별도이며 실제 비용·모델·배포 호출은 하지 않았다. 상세는 autonomous-remaining-integration.report.md에 기록했다.


## 마지막 R9 metadata 전달과 gate 재동결

행동의 parameterHash와 typed parametersSubset/providerResult를 추가했다. 현재 producer 필드명 parameters는 동일 allowlist를 거쳐 출력 parametersSubset으로 정규화한다. 임의 message·provider receipt·auth/ownership/idempotency는 노출하지 않는다. lifetimeMs는 양의 safe integer, startActionId는 bounded ID, artifactDigest는 64 hex, expectedHead/commit OID는 40/64 hex, AWS 결과는 i-hex ID로 제한했다. 고정 enum hf_commit은 credential 값과 구분하되 실제 문자열 값의 비밀 가리기는 유지한다.

Source loader focused SDK/DOM 40건 및 no-emit 타입 검사가 통과했다. 공유 dist·전체 gate는 실행하지 않았다. 제품 metadata 변경 전에 coordinator에 통보했으며 기존 global source-before-gates checkpoint는 무효다. 소유 파일을 다시 동결하고 coordinator가 새 checkpoint로 gate를 재실행해야 한다. 이 후 API 범위는 실제 버그 외에 확대하지 않는다.
