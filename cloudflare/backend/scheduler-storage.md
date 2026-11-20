# Scheduler 저장과 작업 목록 조회

Scheduler는 모든 job·credential·idempotency·workflow 이력을 보존한다.
반복되는 job instructions만 private 문자열 pool로 저장하며, 복원 시 원문을 돌려준다.
새 상태는 128KiB 이하 chunk와 SHA-256 manifest로 원자적으로 게시한다.
정규화된 저장 크기는 일반 쓰기 30MiB, 종료·복구 쓰기 32MiB로 제한한다.
이 한도는 8주 실행이나 무제한 트래픽을 보장하지 않는다.

## HTTP 조회

모든 `/v1/jobs` 요청은 기존 operator 인증을 먼저 검사한다.

- `GET /v1/jobs`: 작은 기존 상태에서는 기존 full job 배열을 반환한다.
- legacy 상태 예상 크기가 2MiB를 넘으면 full 배열을 만들기 전에 HTTP 413과
  `{"error":"PAGE_REQUIRED","summaryPath":"/v1/jobs?view=summary&limit=20"}`를 반환한다.
- `GET /v1/jobs?view=summary&limit=20`: `{items,nextCursor?}` 형식의 summary 페이지다.
  limit은 기본 20, 최대 100이다. limit/cursor만 지정해도 summary를 사용한다.
- 다음 페이지는 반환된 cursor를 URL 인코딩해 전달한다.
  cursor는 private 영속 키의 HMAC과 고정 high-watermark를 사용한다.
  조회를 시작한 뒤 추가한 job은 그 페이지 열에 끼어들지 않는다.
- unknown query, 중복 query, 잘못된 limit/view/cursor는 HTTP 400이다.
- summary는 ID·상태·제공자/모델·parent/autonomous ID·실제 check/child 개수·종료/인증 상태와
  알려진 credential generation/owner 여부를 반환한다.
  instructions·argv·checks/childIds 배열·인증 값은 반환하지 않는다.
- `GET /v1/jobs/:id`와 `/v1/jobs/:id/result`는 기존 계약을 유지한다.

## Migration과 rollback

legacy `state`는 검증 후 transaction 안에서 새 형식으로 migration한다.
실패하면 이전 상태가 진실로 남는다. migration 뒤에도 legacy key를 삭제하거나 덮어쓰지 않는다.
다만 새 쓰기 이후의 legacy key는 **구버전 코드 rollback용 최신 사본이 아니다.**
새 형식 reader를 유지하며 disable/drain 또는 forward fix를 사용한다.
구버전 backfill을 별도로 검토한다면 모든 job이 정지하고 credential이 idle이어야 하며,
현재 전체 이력을 손실 없이 legacy 2MiB 안에 저장할 수 있어야 한다.
이력을 지우거나 projection으로 바꿔 크기를 맞추면 안 된다.
transaction이 없는 legacy fallback은 2MiB 이하만 허용하고, v2 manifest가 있으면 거절한다.
