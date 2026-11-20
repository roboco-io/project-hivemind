# 외부 제공자 HTTP 어댑터

## 범위와 결정

- 조정자가 승인한 독립 작업이다. 계약·broker·API·환경 설정은 변경하지 않는다.
- `createExternalProviderTransport`는 기존 transport 계약을 구현한다. factory의 `enabled === true`와 제공자별 `enabled === true`가 모두 필요하다. 기본은 차단한다.
- HTTP는 주입한 fetch 또는 실행 시의 global fetch만 사용한다. 테스트는 주입한 fake만 호출한다. URL·shell·SDK client 옵션·모델 자격을 작업 입력으로 받지 않는다.
- credential은 provider discriminated union이다. broker의 resolver callback에서만 전달한다. 로그·환경·CLI·receipt에 넣지 않는다.
- 전체 검사는 조정자가 수행한다. 이 작업은 root build 후 집중 테스트만 수행한다.

## 공개 형태

`createExternalProviderTransport({enabled?,aws?,hf?,github?,artifacts,fetch?,now?})`

- AWS: enabled, accountId, region, workloadId, imageId, instanceType, subnetId, instanceProfileArn, maxLifetimeMs. 단일 인스턴스 Spot one-time 요청이다. 시작 파라미터는 lifetimeMs뿐이다. profile의 account/region/workload와 TTL을 다시 검사한다.
- HF: enabled, repository, revision. 기존 private model 저장소만 허용한다. parent commit을 고정한 NDJSON commit을 사용한다.
- GitHub: enabled, repository, branch. 기존 branch의 expectedHead를 읽어 비교한 뒤 blob/tree/commit과 force:false ref 갱신을 사용한다. ref 갱신 직전에 head를 다시 확인한다.
- artifacts.load(digest): immutable `{files:[{path,contentBase64}]}`. `externalArtifactDigest()`가 필드 순서를 고정한 JSON payload의 SHA-256을 digest로 사용한다. 전체 raw content는 1MiB, 파일은 최대32개, 각 파일은 최대256KiB다. 경로는 보수적 allowlist와 secret/runtime 경로 차단을 사용한다. artifact 생산자가 비밀 없음도 보장해야 한다. 임의 콘텐츠의 비밀 여부를 어댑터가 완전히 판별한다고 주장하지 않는다.

## 실행과 근거

AWS는 고정 regional STS `GetCallerIdentity`를 SigV4로 서명해 credential의 account를 먼저 확인한다. EC2 Query는 `https://ec2.<region>.amazonaws.com/` 한 곳으로 보내고 node:crypto SigV4로 서명한다. AMI/instance type/subnet/instance profile은 trusted config에서만 온다. ClientToken과 ownership tag를 고정한다. 시작 성공은 DescribeInstances에서 account ownerId, clientToken, ownership tags와 instance ID를 확인해야 인정한다. 응답 유실 후에는 tag/clientToken 필터로 발견한다. cleanup은 확인한 instance 하나만 TerminateInstances하며, confirmAbsent는 별도 DescribeInstances의 terminated 또는 명시적 부재를 확인한다. TTL은 승인/어댑터 실행 경계이며 EC2 자체의 강제 종료/과금 상한이 아니다. broker의 만료 cleanup이 필요하다.

HF는 고정 `huggingface.co` API만 사용한다. repo의 private 상태와 parent SHA를 확인한다. ownership 표식을 commit 메시지에 저장하고 provider의 commit 기록과 tree/content 근거로 확인한다. 삭제는 구현하지 않는다.

GitHub는 고정 `api.github.com` Git data API만 사용한다. branch 보호/권한 실패를 우회하지 않는다. commit message의 ownership 표식, 부모 SHA, tree와 blob 내용이 일치해야 성공이다. parent tree의 artifact 외 모든 leaf를 비교하여 추가 변경·삭제도 거절한다. non-force 갱신도 엄밀한 atomic compare-and-swap은 아니므로 마지막 head 조회와 PATCH 사이 외부 writer 경합은 남는다. protected branch 정책과 단일 writer가 별도로 필요하다. 삭제는 구현하지 않는다.

모든 HTTP는 redirect:error, 요청별 5초 제한, 응답 1MiB 제한을 사용한다. mutation 직전에도 기존 action expiresAt을 확인한다. raw 예외/응답을 외부에 전파하지 않는다. receipt는 고정 필드와 검증된 provider ID만 포함한다. provider의 비용 근거가 없으므로 금액은 null/final:false다. 빈 discovery는 inspect에서 null이며 실행 실패나 비용0의 근거가 아니다. POST/PATCH 오류는 mutation 여부가 불명확하므로 broker가 ambiguous로 처리한다.

## 테스트 계획

1. disabled/target/credential/TTL 차단과 HTTP 호출0.
2. SigV4 고정 endpoint·ClientToken·trusted EC2 파라미터, ownership discovery/cleanup/실제 종료 확인.
3. artifact digest·base64·파일/경로 제한, HF private repo/NDJSON/parent/commit 확인.
4. GitHub expected head, provider blob/tree/commit 확인, force:false와 경합 거부.
5. redirect·timeout·크기 초과·credential echo 예외 차단, receipt에 비밀 없음.

실제 provider·네트워크·비밀·모델 호출은 수행하지 않는다. synthetic HTTP 테스트는 실제 제공자 수용 근거가 아니다.

## 구현의 명시적 한계

- HF는 inline git blob만 검증한다. LFS 업로드·다운로드와 redirect는 지원하지 않으며 해당 근거를 확인하지 못하면 ambiguous로 남긴다.
- HF/GitHub recovery는 제한된 최근 commit 응답 안에서만 발견한다. 더 오래된 결과를 찾지 못해도 부재나 실패를 추정하지 않는다.
- 저장소 관리자가 동시 변경하는 privacy/branch 정책은 어댑터가 고정할 수 없다. GitHub REST ref API에는 expectedHead 원자적 CAS가 없으므로 조회/PATCH 사이의 외부 writer 경합은 남는다.
- EC2는 종료 이후의 추가 비용과 관련 자원의 비용까지 이 어댑터가 검증하지 않는다. 모든 비용은 null이며 broker의 별도 정산 근거가 필요하다. trusted AMI·instance profile의 보안/정리 정책도 운영자 책임이다.
- secret 경로·대표 credential 패턴은 거절하지만 일반 파일에 숨긴 모든 비밀을 판별하지 못한다. immutable loader는 공개 가능한 payload만 제공해야 한다.
- HTTP/timeout 실패 후에는 재생성하지 않고 broker의 inspect/reconciliation 절차를 따른다. HF/GitHub retained commit을 자동 삭제하지 않는다.

## 로컬 검증

- root `npm run build` 후 `node --test dist/tests/autonomous-external-providers.test.js`를 사용한다.
- disabled/기본 제공자 동작, 불완전 부재 근거, secret artifact, intent TTL, 준비 중 만료, AWS caller account, GitHub 부수 변경의 red→green을 기록했다.
- 실제 네트워크·제공자·모델·비밀 조회는 없었다. runtime stamp와 배포는 수행하지 않는다.
