# Remaining 통합 검사 — 최종 소유 파일 동결

검증은 모두 합성 근거다. 실제 모델·CLI·provider·공용 네트워크·유료 자원·배포·커밋은 호출하지 않았다. 전체 프로젝트 suite와 runtime stamp는 coordinator 영역으로 남겼다.

## 최종 결과

- 격리된 root SDK/DOM/기존 호환/신규 통합: 61개 통과·0개 실패.
- backend sidecar 30개와 신규 actor 통합 3개: 33개 통과·0개 실패.
- 합계 94개 통과. 해당 focused TypeScript 컴파일/타입 검사도 통과했다.

root는 .superlite 내부의 자동 정리 임시 디렉터리로 컴파일해 공유 dist를 사용하지 않았다. 실제 MCP stdio child entry와 배포 dashboard JS를 함께 검사했다. backend는 직접 TS source를 실행했다. 전체 검사가 아닌 소유 영역 focused 검사다.

## 실제 연결한 경로

1. SchedulerDO/AutonomousService/Scheduler → private file runner/native adapter → 암호화 session 저장·복원 → 별도 compute. actor를 재구성해도 단일 승인과 같은 session으로 두 반복을 완료했다. 실제 CLI 대신 모의 process 2회다. canonical WebFetch와 컨테이너별 grant의 다른 host 거절 및 공개 결과의 token/session/root 비노출을 확인했다.
2. 실제 Worker SQL factory/core/broker/provider adapter → 모의 AWS owned Spot 생성. 동일 requestId 재전송에서 생성 1회, accepted 예약 유지, 재승인 없는 wait/continue, lease 이후 admission stop/cancel/cleanup을 확인했다. 모의 timer ARN은 현재 deterministic ownership binding 규칙에 맞췄다.
3. 실제 MCP action SDK → sidecar → C3 HTTP → concrete Worker factory → core/broker/provider. nested request.taskId를 제거한 canonical body로 HTTP 200을 두 번 받아도 자원은 한 번만 생성된다. producer DTO의 requestId/phase/actionId 및 선택적 금액만 투영하고 unknown을 0으로 만들지 않는다.
4. 실제 운영자 MCP billing 도구 → operator proxy → C1 attestBilling → broker/core. worker는 401, 활성 자원은 409다. 실제 부재 확인 뒤 합성 invoice 25 micros를 명시적으로 기록하고 같은 입력 재전송에도 인간 reconciliation은 1건이다. operator_attested 출처·근거·시각·revision·resourceId·승인 당시 target/hash가 전달된다. provider API 과금 측정이라고 표시하지 않는다.
5. 현재 revision/profileHash가 달라진 사전 승인 거절, summary/history counts·highwater, quota/daily effective wake 이전 claim 거절, 최대 유효 SDK scope와 512 elements·64KiB·strict schema의 상한을 검사했다.

## 고정 계약과 한계

운영자 도구는 정확히 18개이며 billing은 사용자 지시의 taskId/requestId/revision/actualCostMicros/evidenceRef/reason이 모두 필요하다. native sidecar의 ExternalOperation에는 billing을 넣지 않았다. 실제 소유 자원 부재/known outcome 검증을 우회하지 않는다.

Sidecar는 기본 55초, 신뢰 옵션 최대 120초를 허용하되 항상 승인 executionDeadline의 남은 시간으로 제한한다. 초기 lease를 parent가 갱신한 T+40초 호출과 중앙 만료·취소 거절을 실제 core로 검사했다. deadline 이후 응답도 성공으로 바꾸지 않고 새 실행 구간·자동 새 requestId·broad retry를 만들지 않는다.

이전 보고의 actor 503, sidecar 400/DTO 불일치, factory aws.billingPolicy strict schema 차단은 현재 source 조합의 요구 성공 검사로 다시 확인해 통과했다. 테스트를 정상 거절 assertion으로 바꾸어 통과시키지 않았다. provider·factory·core 수정은 각 소유자가 수행했고, 이 작업의 제품 수정은 소유 operator/sidecar 범위다.

모의 guard/비용은 실제 AWS guard 설치나 청구 조회 근거가 아니다. 실제 24시간 운영·Cloudflare/AWS 배포·전체 시스템 운영 준비 완료는 주장하지 않는다. 이제 소유 파일은 동결하며 전체 프로젝트 gate는 coordinator가 실행한다.
