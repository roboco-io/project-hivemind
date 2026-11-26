# 열린 이슈 병렬 구현 — 2026-11-23

## 현재 상태와 실행 경계

GitHub 열린 이슈는 #1/#3/#4/#5다. #1 실제 장기 운영은 사용자가 실제 프로젝트로 이관했다. 기존 HF·팀 원장·문서 미커밋 변경을 보존한다. #3/#4는 실제 AWS/HF 검증이 완료 조건이므로 로컬 성공만으로 닫지 않는다. #5는 Ohio/Seoul CDK·스크립트와 타 리전 거부 회귀가 로컬 완료 기준이다. 실제 모델·AWS 자원·HF 업로드·공개 전환·배포·push·commit·GitHub 댓글/상태 변경을 하지 않는다.

AI 조율·병렬 agent·테스트 우선·교차 리뷰를 사용한다. 신규 AWS IaC는 CDK. 실제 실행 시 AWS_PROFILE=roboco이며, 이번 이슈의 명시적 추가 테스트 리전은 us-east-2다. 기본 서울을 유지하고 임의 fallback·자동 다중 리전 전환은 하지 않는다. 기존 dirty tree에서 파일 소유를 분리하고 checkpoint commit/worktree 이동을 생략한다.

## 공통 설계

A(#5)는 리전/AZ ID를 설정과 허용 목록으로 바꾸고 기존 guard/cost 컴포넌트를 갱신한다. 공유 backend/provider 파일은 I가 통합한다.
B1(#3)는 별도 서명 전용 Worker와 중앙 OIDC 승인 정책을 구현한다. 서명키는 signer만 읽고, HTTP에는 discovery/JWKS만 공개한다. signer RPC는 trusted service binding으로만 호출한다.
B2(#3)는 STS 단기 credential resolver와 IAM/CDK 신뢰 정책을 구현한다. 장기 AWS key를 필요로 하지 않는 경로를 추가한다. 기존 key 경로는 명시적 기존 mode에서만 보존하며 OIDC 실패 시 key로 fallback하지 않는다.
C(#4)는 승인 workload/input manifest, durable receipt/accounting/publication 상태와 HF/S3 독립 검증을 구현한다.
D(#4)는 학습 인스턴스 전용 bootstrap/report 인증·전달·직접 업로드 helper와 IAM 정책을 구현한다. 모델 data plane은 Cloudflare를 거치지 않는다. 공유 연결은 I가 담당한다.
I는 기존 broker·backend·API·UI/MCP와 실제로 연결한다. 새 기능은 기본 비활성. 실제 계정·issuer origin·role·bucket·repo·AMI·subnet·예산을 추측하지 않는다.

## A 리전 계약

Own infrastructure/aws-external-guard/**, packages/adapters/src/autonomous-aws-guard.ts, autonomous-external-cost.ts, NEW region helper + 관련 tests. GuardDeploymentConfig.region:string와 allowedRegions server allowlist(생략하면 legacy서울만)를 검증한다. guard manifest/정책/ARN/Lambda클라이언트는 선택 리전을 쓰고 다른 리전을 계속 거절한다. AZ는 availabilityZoneId 선택 필드로 지원하고 실제 AWS Placement/Describe 증거에 결속한다. defaultlegacy config/hash 의미 보존. helper/adapter 옵션 exact interfaces를 I에 조기 전달한다. I owns existing packages/adapters/src/autonomous-external.ts 및 cloudflare/backend/src/autonomous-external.ts.

## B1 OIDC issuer/policy 계약

Own NEW packages/contracts/src/oidc.ts, packages/core/src/oidc.ts, packages/adapters/src/oidc-issuer.ts, cloudflare/oidc-issuer/** 및 해당 tests. 키는 RS256로 고정(허용 알고리즘 하나면 요구 충족), RSA2048이상. public JWK는 n/e/kid/alg/kty/use만 반환하고 d/p/q/dp/dq/qi/private 필드는 절대 반환하지 않는다. 공개 issuer HTTPS·port/query/userinfo/fragment 금지, exact issuer와 JWKS uri, GET discovery/JWKS 외 모든 HTTP 서명 요청 거부. old/new JWKS overlap으로 key rotation. 신규 signer Worker는 배포 template만 만들고 기존 live backend binding을 임의 배포하지 않는다.

Core deriveOidcGrant(config,facts,purpose,now)는 trusted current task/approval/profile/action/lease에서만 sub/aud를 계산한다. execute는 현재 승인 revision·활성 lease·취소/기간 검사. cleanup/inspect는 이미 저장된 소유 action/approval의 별도 cleanup role·subject이며 만료 후 정리 가능. untrusted body에서 sub/aud/role을 받지 않는다. sub는 task hash·revision·profile hash·purpose를 포함해255자 이하. config server issuer/audience/role bindings, TTL<=300초(기본60). signer는 자체 clock/고정 issuer/audience/subject grammar를 재확인한다. signing capability·JWT는 모델/컨테이너/공개 API·이벤트에 주지 않는다. B2에 정확한 Grant/Facts/SignerPort 계약을 조기 전달한다.

## B2 STS/IAM 계약

Own NEW packages/adapters/src/aws-web-identity.ts, cloudflare/backend/src/autonomous-oidc-runtime.ts(필요시), infrastructure/aws-oidc/** 또는 기존 CDK package의 별도 새 oidc 파일(IaC 공유파일 수정은 A/I와 협의), 관련 tests. fixed regional STS endpoint, query AssumeRoleWithWebIdentity(unsigned), DurationSeconds900, role session name task-derived safe64자. 반환 expiration/ARN/account/role/secret shape를 검증하고 execute 취소를 요청 전후 재확인한다. consume callback 안에서만 AWS credentials를 사용하고 persist/log/UI 금지. JWT/STS credential 실패 후 long-term fallback 금지. 캐시는 생략 가능. Audit는 task/revision/profile/action/purpose/role/kid/status 등 비밀 없는 metadata만.

Resolver revalidates canonical core/broker facts. inspect는 cleanup/read-only role로 처리한다. IAM CDK는 public issuer·aud·sub 조건 필수, subject 없는 wildcard trust 금지, execute/cleanup roles 별도. 서명키 개인 값은 CDK input/output에 넣지 않는다. session policy/hash·role/sub display는 I의 safe metadata/approval fingerprint에 결속한다. STS 실제 계정은 호출하지 않는다.

## C 위임 실행·영수증 계약

Own NEW packages/contracts/src/delegated.ts, packages/core/src/delegated.ts, packages/core/src/delegated-store.ts, packages/adapters/src/delegated-proof.ts +tests. WorkloadDescriptor는 AMI/bootstrap hash/input manifest digest(또는 명시 승인된 digest 목록)/IAM policy revision/hash/account/region/AZ-ID/S3bucket+prefix/object+byte+retention+request/transfer cost ceilings/HFrepo+visibility/token ref+delivery metadata/quality gate IDs를 포함한 canonical fingerprint다. InputManifest는 승인 code/data refs+hash/정형 인자만 받고 raw UserData/shell/임의 URL은 거절한다. descriptor 변경은 새 승인 hash가 필요하다.

Controller는 private current-task/profile/instance authority와 durable store·independent verifier ports를 요구한다. receipt는 workload/task/revision/instance에 결속하고 reported/unverified/verified/mismatch/unknown을 구분한다. 보고만으로 성공·비용0·검증passed를 만들지 않는다. S3 proof HEAD(checksum+version+size+owner)·HF fixed API(commit SHA/file hashes+visibility)는 실제 상태를 조회하는 concrete fake-fetch-tested adapter를 제공한다. checksum/composite multipart의 불확실성은 unknown이지 성공이 아니다. 데이터 본문은 중계하지 않는다.

public privacy transition은 commit과 별도 action. preapproved release policy·trusted quality facts·정확한 검증 receipt/commit이 모두 있어야 하며 worker passed:true를 믿지 않는다. HF settings API는 official source 확인 후 구현한다. 새 repo 생성 금지, 예상 SHA/visibility·postcondition 확인, ambiguous write는 intent 기록 후 조회 복구(무조건 재시도 금지). S3 저장·요청·전송 reserve와 retention 종료·소유 버전 정리 ledger를 두며 실제 billing 없으면 null/미확정 유지한다. legacy broker budget을 우회하지 않고 I가 중앙 reserve/settle과 연결한다. A/B와 겹치는 shared files 수정 금지.

## D 인스턴스 bootstrap/인증 계약

Own NEW packages/adapters/src/delegated-instance-auth.ts, scripts/delegated/** (또는 cloudflare/backend/scripts/delegated/** 중하나), NEW policy helper/IaC 파일 +tests. 중앙 challenge를 받은 instance가 자체 IAM role의 fixed STS GetCallerIdentity SigV4 request를 제출하는 IAM-auth 방식 등 실제 검증 가능한 port를 쓴다. 인증 subject는 expected account/workload role + session instance ID + canonical owned instance fact로 제한한다. 요청 endpoint/Action/method/headers/region/time/서명된 audience·nonce를 고정하고 replay를 막는다. raw credential·JWT/IID 보고만으로 소유를 인정하지 않는다. signed request는 fixed STS에만 전달하고 public response/log에 반사하지 않는다. 실제 STS 호출 없음.

HF token 전달은 instance 전용 private 채널이며 receipt route와 별도 purpose, cache no-store/TTL·0600 파일·자식 training env 비전달. 필요시 signed instance key thumbprint와 RSA-OAEP envelope를 사용한다. 명시한 scoped credential ref만 전달한다. 토큰 scope 자체는 외부 HF에서 제한한다. helper는 input/bootstrap hash 확인 후 고정 approved entrypoint만 실행하며, weights는 instance→S3/HF direct API/official SDK port를 쓴다. 실제 weight upload는 테스트에서 stub. report는 metadata만. instance IAM policy는 특정 bucket/prefix/version/region과 guard 불변 권한을 제한한다. trust delegated AMI/bootstrap/IAM라는 한계도 문서화한다.

## I 통합 소유

Existing packages/contracts/src/autonomous-external.ts, core/autonomous-external.ts/sql/store 필요한 부분, adapters/autonomous-external.ts, backend/src/autonomous-external.ts + NEW backend/src/delegated-runtime.ts/api 등, worker.ts/env/routes, apps/control-plane/autonomous-external-api.ts, MCPautonomous.ts/dashboard 등 safe metadata, 관련 통합 테스트. A/B/C/D 새 모듈을 재구현하지 말고 연결한다. API auth BEFOREbody, server identities only, bounded metadata, public projections must show roles/sub/descriptor/visibility/token delivery but notsecrets. 실제 scope와 proof ports 없으면 failclosed. issuer private binding/instance bootstrap/receipt/publication routes가 API로 도달 가능해야 하며, 모델 plain AWS/HF secrets 전달 경로는 추가하지 않는다.

#3/#4 전체 실증은 외부 설정·명시적 실제 실행 범위가 있어야 한다. 이번 구현을 실제 수용 완료라고 표시하지 않는다. 구현 차단과 실제 검증 이연을 구분하고 아직 연결되지 않은 단계가 있으면 보고한다.

## 검증과 검토

각 agent TDD·집중 검사→공통 계약 seam 검토→수정 반복→coordinator root npm run check/backend tsc+test/guard CDK+Python/IAM CDK/runtime stampcheck/dryrun→fresh final reviewer. 병행 중 shared dist 빌드 금지. 커밋·push·실제 AWS/HF·배포 없음. 실패와 미검증 숨기지 않는다.

## 사용자 제안 반영: GetScopedCredentials

공식 문서(2026-11-19 출시 공지·API·IAM 가이드)를 확인했다. 기존 임시 AWS 세션의 권한·수명 축소 기능이므로 Cloudflare의 OIDC 최초 인증을 대체하지 않는다. B2는 OIDC→AssumeRoleWithWebIdentity(900초)→GetScopedCredentials(명시 정책/짧은 TTL)→private provider callback으로 연결한다. D는 instance role→GSC→trusted uploader로 연결한다. 모델·training child에 부모/자식 AWS credentials를 직접 주지 않는다. STS regional endpoint만 쓰고, 부모 만료·실행 기간을 넘지 않으며 API 실패 때 부모 권한으로 fallback하지 않는다. 공개 metadata는 role/sub/정책 hash·TTL·감사 식별자만 제공한다.

GSC는 principal/source identity/tags를 바꾸지 않는다. 개별 추적은 원래 역할 session과 안전한 ScopedSessionDescription·중앙 action ID를 사용한다. Policy 최대2048자, Policy layer 최대3개이며 명시적인 sts:GetScopedCredentials 권한이 필요하다. GSC token이 별도 IAM 신원을 만든다고 표시하지 않는다. HF token에는 적용되지 않는다.

- https://docs.aws.amazon.com/STS/latest/APIReference/API_GetScopedCredentials.html
- https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp_control-access_getscopedcredentials.html
- https://aws.amazon.com/about-aws/whats-new/2026/11/sts-getscopedcredentials/
