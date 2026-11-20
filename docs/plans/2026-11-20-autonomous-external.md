# 신뢰 외부 행동 broker — 독립 구현

## 범위와 승인

로컬 구현만 승인됐다. 모델 호출·네트워크·비밀 조회·유료 자원·배포·커밋은 수행하지 않는다. 기존 core·계약·API·runner는 다른 작업 소유다. 이 문서와 새 autonomous-external 계약·core·테스트만 작성한다. 실제 연결 완료로 보고하지 않는다.

## 현재 문제

기존 reserve/settle은 작업 원장이다. 도구·system과 추정 비용만 검사하며 실제 제공자 행동·소유권·청구·정리를 검증하지 않는다. native는 외부 systems를 거절한다. raw credential map을 외부 자격 증명 전달 경로로 확장하면 안 된다.

## 계약

ExternalOperation은 aws.spot.start, aws.spot.inspect, hf.model.commit, github.branch.push다. 요청은 엄격한 판별 유니온이다. URL·shell 명령·임의 provider 옵션을 받지 않는다. AWS 시작은 서버에 고정한 workload profile과 최대 수명, HF/GH 쓰기는 불변 artifact digest를 사용한다. artifact 해석·안전한 업로드는 trusted transport 책임이다.

서버 registry의 ExternalProfile은 enabled=false가 기본이다. provider·고정 target·허용 operations·credential reference·최대 수명·행동 비용 상한·동시 활성 행동 수를 포함한다. target은 AWS account/region/workload, HF repository/revision, GH repository/branch로 제한한다. 승인 시 profile snapshot을 복사하고 fingerprint로 결속한다. registry 변경·비활성화는 새 실행을 막는다. 정리는 저장된 profile로 계속한다. 승인 task/revision/profile/operations/targets는 변경 API가 없고 동일 ID의 다른 승인은 거절한다. 별도 revision도 이전 revision을 암묵 취소하지 않으므로 API bridge가 이를 명시적으로 중단해야 한다.

ExternalTransactionalStore.transaction은 동기 callback의 원자적 영속 commit/rollback을 보장한다. 프로세스 재시작에도 유지해야 한다. core는 저장소 구현을 제공하지 않는다. 테스트 저장소만 메모리다. 하나의 state에 approvals/actions를 보존하며 반환 객체는 복사한다. 후속 bridge가 task 승인/기간/예산을 canonical server state에서 생성한다. 이 broker의 serverApprove를 모델·일반 worker에 직접 노출하지 않는다.

한 task/revision에는 고유 profile을 최대 3개 승인한다. registry가 provider별 최대 1개를 확인한다. AWS·HF·GitHub의 비용과 예약은 같은 task 예산에 합산한다. profile 목록과 systems는 첫 claim 뒤 바꿀 수 없다. 일반 Durable Object의 async transaction은 이 동기 계약과 호환되지 않는다. Cloudflare는 ctx.storage.sql과 transactionSync를 사용하는 별도 동기 영속 adapter를 검증해야 한다. 현재 원격 저장소는 연결되지 않았으며 DO-ready로 표시하지 않는다.

ExternalCredentialResolver.withCredential은 profile reference와 정확한 action scope를 받아 transport callback 안에서만 opaque credential을 제공한다. 환경 변수·CLI·출력으로 전달하지 않는다. 별도 ExternalProviderTransport는 execute, inspect, cleanup, confirmAbsent를 제공한다. transport는 임의 URL을 받지 않고 profile provider에 대응하는 고정 SDK adapter를 사용한다. provider receipt에는 action ownership token, idempotency key, 실행 결과·자원 identity·청구 근거가 있다. provider idempotency를 보장할 수 없는 adapter는 자동 재실행하지 않는다.

## 상태와 실행 순서

1. 서버 승인과 registry snapshot 일치·기간·operation·target·수명·한도 검사.
2. JSON 정규화와 SHA-256으로 정확한 parameters를 결속한다. requestId 재사용은 완전히 같은 요청만 조회로 처리한다.
3. 최대 비용 upperBoundMicros를 task budget에서 예약한다. 같은 taskId의 모든 profile/revision의 verified cost와 예약을 합산한다. 정산된 이전 revision도 제외하지 않는다. task ceiling은 기존 승인 예산의 최솟값이며 새 revision으로 늘릴 수 없다. 낮추려면 이미 지출/예약한 금액 이상이어야 한다. 모델이 지정한 추정값은 사용하지 않는다. action/intent/ownership/idempotency/profile snapshot을 같은 transaction에 영속 저장한다.
4. 호출 직전 별도 transaction에서 취소·만료를 다시 검사하고 dispatching을 저장한다. 그 후에만 resolver와 provider를 호출한다. 비동기 I/O 동안 저장소 transaction을 점유하지 않는다.
5. receipt 검증 후 provider 근거를 저장한다. verifiedCostMicros는 실제 검증된 청구만 표시한다. null은 미확정이다. 검증 비용이 상한을 초과하면 실제 비용을 보존하고 task를 중단한다.
6. 예외·응답 유실은 ambiguous로 남긴다. restart의 recover는 dispatching을 ambiguous로 전환한다. execute의 중복 요청은 provider를 재호출하지 않는다. reconcile은 inspect만 호출하고 재실행하지 않는다.

예약은 실제 비용과 별개다. 미확정 청구에는 전체 상한 예약을 유지한다. 검증 비용이 있어도 지속 자원이 살아 있으면 남은 lifetime 비용 headroom을 유지한다. 자원 부재와 최종 청구가 확인돼야 예약을 모두 해제한다. 이 원장은 실제 provider 과금 hard cap 보장이 아니다. adapter가 외부 지출을 수명/제품 제한으로 제한해야 한다.

## 취소·만료·정리

cancel은 task/revision의 새 dispatch를 차단한다. 예약만 있고 호출 전이면 provable zero로 종료한다. dispatching/ambiguous는 호출되지 않았다고 가정하지 않는다. 실행 중 cancel 뒤 도착한 receipt도 기록하고 자원은 cleanup pending으로 둔다. inspect/reconcile/cleanup은 task lease와 무관하다. stop/expire에도 scoped credential resolver가 정리 전용 권한을 제공할 수 있어야 한다.

cleanup은 소유권이 검증된 자원만 대상으로 한다. cleanup intent를 먼저 영속 저장한다. 삭제 호출 성공만으로 cleaned로 바꾸지 않는다. confirmAbsent가 실제 absence를 확인해야 한다. crash 후 cleanup retry는 삭제 전 absence를 확인하며 adapter cleanup은 멱등이어야 한다. 알 수 없는 create 결과는 inspect로 소유 자원을 발견하기 전 삭제하지 않는다. hf commit/GH push는 되돌릴 수 없는 쓰기이므로 자동 삭제하지 않는다. 보존/완료를 영수증에 기록하며 branch 전체 삭제·공유 데이터 삭제를 정리로 추측하지 않는다.

recover는 이전 broker가 종료된 startup barrier에서만 호출한다. 영속 intent는 provider 호출 전 상태이므로 취소/비용 0으로 확정할 수 있다. dispatching은 ambiguous로 보존한다. getAction과 listPending은 후속 스케줄러의 조회 지점이다. 후속 alarm은 listPending에서 불명확 실행·청구를 reconcile하고, 종료/만료한 소유 자원을 cleanup한다. 살아 있는 broker와 동시에 recover를 호출하지 않는다. confirmed cleaned는 늦게 도착한 정리 응답으로 되돌리지 않는다.

## 제한된 초기 adapter 범위

AWS Spot은 고정 account/region/workload profile, TTL과 단일 활성 자원으로 제한한다. 실제 AWS 구현은 roboco/ap-northeast-2/CDK 정책을 따른다. HF model commit은 고정 private repository/revision에 digest가 고정된 artifact만 허용한다. GH branch push는 고정 repository와 전용 branch에 expected head를 요구하고 force push를 허용하지 않는다. 모델 ID를 새로 만들지 않는다. disabled profile은 명시적 server enable과 승인 전에는 호출할 수 없다.

## 후속 연결 지점

HTTP bridge는 기존 autonomous-api의 승인/취소/만료를 serverApprove/cancel에 연결하고 별도 broker 인증을 적용한다. main ledger와 broker budget을 독립 이중 승인으로 사용하지 말고 하나의 authoritative reservation 경로를 선택해야 한다. API/runner 담당자가 이를 통합하기 전에는 이 모듈을 dispatch에 사용하지 않는다.

초기 bridge는 externalProfiles 최대 1개와 legacy actions 혼용 금지를 적용한다. serverApprove.budgetMicros는 canonical core 승인 예산에서 확인된 legacy 비용을 반영한 서버 값이다. 모델 본문에서 가져오지 않는다. revise 때 이전 revision을 cancel하고 새 serverApprove를 호출해야 한다. cancel은 지정한 revision만 중단하며 다른 revision을 암묵 중단하지 않는다. 상한을 넘은 verified charge는 모든 task 승인을 중단하고 실제 비용을 보존한다.

private 경로는 AutonomousCloudController → LegacyAutonomousCloudPorts → RunnerDO → autonomous-from-file → executeAutonomousClaude를 유지한다. typed action ingress에서 supervisor가 task/revision을 부착한다. raw AWS/HF/GH credential을 resolveCredentials나 native request에 추가하지 않는다. registry/approval은 CLI가 지정하지 않는다. UI/MCP는 승인 profile·예약 상한·verified 비용·unknown·ambiguous·cleanup pending을 구분해 표시해야 한다. 현재 bridge/UI/MCP는 미구현이다.

## 테스트와 자체 검토

로컬 fake provider로 기본 비활성, 승인 불변, canonical 충돌, 호출 전 intent/예약 영속성, 동시 중복, 취소 race, 만료, restart, ambiguous 조회, receipt 소유권 불일치, unknown 청구, 초과 청구, 실제 부재 정리와 재시도를 검사한다. 모델 호출은 0이다.

자체 검토: 외부 원장과 기존 원장의 원자성은 아직 없으므로 integration 미완료다. resolver/transport/store는 신뢰 경계이며 구현체가 계약을 지켜야 한다. 네트워크 AbortSignal은 원격 side effect 중단 근거가 아니므로 예외는 ambiguous다. 완료된 HF/GH 쓰기를 삭제로 되돌리지 않는다. 재시작 복구는 실행 재전송이 아니라 조회/정리만 한다. 기존 파일을 수정하지 않는다.


## 중앙 accepted 원장 연결

- `acceptExternal(lease, actionId, resource?, now)`는 trusted bridge 전용이다. broker가 소유권 receipt를 검증한 뒤 호출한다. canonical MCP 도구·profile·provider scope가 맞는 예약만 accepted로 전환한다.
- accepted는 `actualCostMicros`를 만들지 않고 상한 전체를 reservedMicros에 남긴다. owned resource는 즉시 등록한다. 일반 reserved/unknown은 계속 미해결이지만 accepted는 CONTINUE/WAIT·다음 claim을 막지 않는다.
- `cleanedExternal(id, resourceId, now)`는 실제 부재 확인 뒤 active 또는 cleanup_pending 자원을 cleaned로 바꾼다. TTL 정리가 진행 중인 작업을 전역 중단시키지 않는다. 비용 미확정 accepted가 있으면 최종 완료는 계속 막는다.
- `settleExternal(id, actionId, actualCostMicros, success, now)`는 최종 검증 비용만 한 번 반영한다. canonical 자원과 정리 상태를 보존한다. 예약을 spent로 전환하며 0원 대용값이나 모의 verified cost를 넣지 않는다.
- 세 operation은 persistence dispatch 전용이며 공개 HTTP 경로가 아니다. 일반 worker settle/reconcile로 MCP 행동의 검증 비용을 만들 수 없다. 취소는 자원을 cleanup_pending으로 만들고 비용·자원 정리가 끝날 때까지 stopping을 유지한다.
- C3 bridge가 registry hash 확인·실제 receipt·최종 청구·자원 부재를 책임진다. 개별 provider 실증과 대용량 학습 산출물의 종단 검증은 별도 근거가 필요하다.
