# OIDC 발급자와 중앙 승인 정책

이 구현은 로컬 검증과 배포 템플릿이다. 실제 공개 issuer, AWS 역할 수임, 배포와 키 교체 수용 검증은 수행하지 않았다. 실제 계정·도메인·역할·서명키를 추측하지 않는다.

## 권한 경계

`deriveOidcGrant(config, facts, purpose, now)`는 서버가 읽은 작업·외부 승인·저장된 action·프로필만 받는다. `now`는 밀리초다. 반환 grant의 `issuedAt`·`expiresAt`는 epoch **초**다. 요청 본문에서 issuer·audience·role·subject를 받지 않는다. 통합 계층은 사실을 같은 중앙 원장과 현재 lease에서 읽고, 비동기 STS 호출 전후에 실행 권한을 다시 확인한다.

execute는 running 작업, 현재 revision, 활성 lease, 취소·기간, 승인된 AWS 또는 S3 프로필 전체 해시와 저장된 action 매개변수 해시를 확인한다. intent 또는 dispatching action만 허용한다. TTL 기본값은 60초, 상한은 300초다. 실행 grant는 작업·외부 승인·action·lease 중 가장 빠른 만료 시점으로 줄인다.

cleanup·inspect는 저장된 action과 원래 외부 승인에 결속한다. 작업이 취소되거나 revision·프로필 설정이 바뀌어도 원래 승인의 account와 별도 cleanup 역할을 사용한다. 실행 역할과 정리 역할은 달라야 한다. inspect에는 읽기 전용 권한을 포함한 cleanup 역할 정책을 설정한다. 현재 실행 권한으로 정리 권한을 대신 만들지 않는다.

`oidcSubject(taskId, revision, profileHash, purpose)`는 승인 화면에 표시할 subject를 계산한다. 형식은 `hivemind:task:<sha256>:rev:<revision>:profile:<sha256>:<purpose>`이며 255자 이하다. task ID는 해시로 표시한다. action ID는 grant의 감사 메타데이터이며 subject에 들어가지 않는다. AWS의 세부 action 권한 제한은 역할 정책과 B2의 세션 정책·단기 credential 경로가 담당한다.

## 서명 전용 Worker

`cloudflare/oidc-issuer/`는 독립 Worker 템플릿이다. 기본 `workers_dev`·preview를 끄고 issuer 설정을 비워 두었다. 실제 배포는 별도 명시적 작업이다. 기존 backend 설정은 이 패키지에서 변경하지 않는다.

서명키 `OIDC_PRIVATE_JWK`는 서명 Worker의 secret으로만 설정한다. 서버 설정은 `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_ACTIVE_KID`, `OIDC_PUBLIC_JWKS`다. 마지막 값은 `{ "keys": [...] }` 형식이다. 개인키를 vars·IaC output·저장소·모델·컨테이너에 넣지 않는다. 이 문서에는 실제 키 생성·등록 명령을 실행한 근거가 없다.

trusted backend에는 service binding의 `entrypoint: "OidcSigner"`만 연결한다. binding은 `OidcSignerPort.sign(grant): Promise<{token, kid}>`를 제공한다. 모델·일반 워커에는 binding을 제공하지 않는다. 서비스 binding을 가진 backend는 서명을 요청할 수 있는 신뢰 경계다. 서명자 자체는 중앙 원장을 조회하지 않으므로 binding 호출자는 반드시 core 정책을 거쳐야 한다.

공개 HTTP는 설정한 issuer의 정확한 `GET /.well-known/openid-configuration`, `GET /jwks.json`만 제공한다. issuer에 경로가 있으면 두 경로를 그 뒤에 붙인다. POST·HEAD·다른 origin·추가 query·서명 경로는 거부한다. 공개 응답에는 token을 넣지 않는다. issuer는 canonical HTTPS URL이고 port·userinfo·query·fragment·trailing slash를 허용하지 않는다. 로컬 호스트·IP·예약된 로컬 도메인은 거부한다. DNS의 실제 공개 도달성·TLS·AWS 검색은 배포 후 별도 검증한다.

RS256과 RSA 2048비트 이상만 사용한다. 서명자는 자체 clock, 고정 issuer·audience, 전체 subject 결속, 발급 초와 300초 상한을 다시 검사한다. RPC 전달 중 초 경계가 바뀔 수 있으므로 과거 5초까지 허용하되 미래 발급은 거부하고 원래 발급·만료 초를 그대로 서명한다. 공개 JWK는 `n/e/kid/alg/kty/use`만 새 객체로 투영한다. 입력에 개인 필드가 있어도 공개 응답에는 포함하지 않는다. 활성 public key와 private key의 modulus·exponent가 다르면 초기화하지 않는다.

## 키 교체

먼저 기존 키와 새 키를 JWKS에 함께 공개한다. AWS가 새 공개키를 조회할 시간을 확보한 뒤 active kid와 private key를 새 키로 교체한다. 기존 token의 최대 TTL 300초와 공개 응답 cache 60초, 운영상 전파 여유가 지난 뒤에만 기존 공개키를 제거한다. 두 배포 사이에 JWKS overlap을 유지한다. 자동 키 교체나 실제 AWS 캐시 전파 보장은 구현하지 않았다. 공개키가 아닌 개인키가 공개되면 단순 JWKS 수정만으로 복구했다고 판단하지 않는다.

## 비밀과 감사 기록

JWT와 STS credential은 private 소비 callback에서만 사용한다. 공개 API·이벤트·UI·컨테이너 응답·로그·영속 원장에 값을 저장하지 않는다. 중앙 통합 계층은 task/revision/profile/action/purpose/role/kid/status만 기록한다. 서명 패키지는 로그나 영속 저장을 만들지 않는다. 감사 기록과 B2의 STS 호출 연결은 통합 계층의 책임이다.

## 로컬 검사와 실제 수용

로컬 검사는 생성한 RSA 키로 실제 서명·검증, 1024비트 거부, 잘못된 키 결속 거부, 구·신 키 overlap, 공개 필드 제한, HTTP/RPC 분리, 만료·취소·revision·프로필·S3 scope 변조를 검사한다. Worker 테스트는 Node의 `WorkerEntrypoint` 테스트 대역을 사용하며 원격 Cloudflare RPC 검증을 대신하지 않는다.

집중 검사: `node --import /tmp/hivemind-source-loader.mjs --test tests/oidc-policy.test.ts tests/oidc-issuer.test.ts tests/oidc-worker.test.ts`. `/tmp` loader는 병렬 작업의 소스 검사 도구이며 배포 의존성이 아니다. 배포 패키지 타입 검사: `npx tsc -p cloudflare/oidc-issuer/tsconfig.json --noEmit`.

실제 수용에는 공개 discovery/JWKS의 AWS 도달성, aud·sub 조건이 있는 역할 수임, 잘못된 sub 거절, 취소·기간 종료 실행 거절, 정리 유지와 교체 중 역할 수임을 실제 계정에서 확인해야 한다. 로컬 검사만으로 이슈 #3을 완료 처리하지 않는다.

## 공식 근거

- [AWS IAM OIDC 공급자 요건](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html): HTTPS issuer·discovery/JWKS, private JWK 금지와 공개키 수 제한.
- [AWS STS AssumeRoleWithWebIdentity](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html): 장기 AWS 키 없는 역할 수임과 최소 900초 STS 세션. JWT TTL과 STS 세션 TTL은 다른 값이다.

2026-11-23에 위 공식 문서를 확인했다. 커뮤니티 구현 코드는 복사하지 않았다. GetScopedCredentials의 추가 제한과 실행 전후 재확인은 B2·중앙 통합 계층에서 구현한다.
