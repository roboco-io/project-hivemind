# ADR 0001: Cloudflare 실행과 인증 스트림 분리

상태: 채택. 원격 수용은 실제 증거에 따라 별도로 판단한다.

## 결정

Worker API, Scheduler Durable Object, 작업별 Container, 두 R2 버킷을 사용한다.
첫 구현은 영속 alarm으로 실행을 조정한다. 외부 Queues adapter는 후속으로 둔다.
공유 작업·소스 계약과 플랫폼 연결을 분리한다.

공식 구독 인증을 유지한다. 공급자 API 키로 자동 전환하지 않는다.
동일한 credentialId는 한 agent 스트림만 소유한다. 내부 native subagents는 그 스트림 안에서 실행한다.
별도 check 컨테이너는 구독 인증 없이 최종 snapshot을 검증한다.
인증 세대 저장과 컨테이너 종료를 확인하기 전에는 lane을 해제하지 않는다.
모호한 종료는 인증을 격리하고 사용자 재인증을 요구한다.

## 근거와 영향

HTTP 요청과 작업 수명을 분리하면 클라이언트 연결이 끊겨도 회수를 이어갈 수 있다.
불변 snapshot은 입력·결과·검증의 귀속을 명확하게 한다.
분리한 인증 버킷과 Worker 암호화 키는 일반 결과에 인증을 섞지 않는다.
반환 개인키는 Worker에만 있으며 컨테이너는 공개키로 인증을 반환한다.

Cloudflare exec의 UID만 신뢰하지 않는다. capability 제거와 no-new-privileges를 검사한다.
Claude nested 호환 모드는 별도 원격 경계 검증이 선행되어야 한다.
AWS는 Cloudflare 수용 후 CDK로 별도 구현한다.
