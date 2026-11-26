# 위임 인스턴스 인증과 직접 업로드

이 구현은 실제 AWS/Hugging Face를 호출하지 않고 검사했다. 실제 계정 검증과 승인된 AMI 배포는 남아 있다. 모델 파일은 인스턴스에서 S3/HF로 직접 전송한다. 중앙은 승인·인증·영수증·독립 검증을 담당한다.

## 인스턴스 전용 채널

`packages/adapters/src/delegated-instance-auth.ts`의 `createDelegatedInstanceAuth`를 중앙의 현재 소유 인스턴스 조회와 연결한다. 바인딩은 taskId/workloadId/revision/descriptorHash/instanceId/accountId/region이다. 중앙 조회는 실제 소유 행동의 인스턴스, IAM role 이름과 고유 role ID를 제공한다. 원시 IID나 작업자가 보고한 ARN으로 소유를 만들지 않는다.

1. 중앙이 목적별 challenge를 발급한다. nonce는 무작위 256비트이며 TTL은 최대 60초, 대기 슬롯은 최대 1024개다. 동시 발급도 이 한도를 공유한다. 재시작하면 미사용 challenge는 폐기된다.
2. 신뢰하는 부트스트랩이 인스턴스 IAM 세션으로 고정 `POST GetCallerIdentity` 요청을 SigV4 서명한다. audience/nonce/purpose와 선택적 key thumbprint를 모두 서명한다. `scripts/delegated/instance_auth_client.py`는 공식 botocore 서명기를 쓴다.
3. 중앙은 method/URL/body/서명 헤더/리전/시각을 검사하고 challenge를 한 번만 소비한다. 지정 리전의 고정 STS HTTPS 주소로만 전달한다. query·redirect·임의 host·다른 Action은 거절한다. Worker 호환 `redirect: manual`을 사용하며 3xx와 이미 리디렉션된 응답을 거절한다. 응답은 총 5초·16KiB로 제한한다.
4. STS가 검증한 account/assumed-role ARN/session instance ID/UserId의 고유 role ID를 중앙 소유 기록과 대조한다. 요청 전후에 소유 상태를 확인한다. 서명 요청·세션 토큰·STS 본문은 공개 영수증이나 로그에 넣지 않는다.

리전은 중앙의 허용 목록을 검증한 서버 설정에서 선택한다. D helper는 리전 문법과 바인딩의 일치를 검사한다. 각 팩터리는 리전 하나를 고정하며 다른 리전으로 전환하지 않는다. 이 인증은 자격증명 소유를 검증하며 원격 attestation이 아니다.

`bootstrap`과 `hf-token`은 실행 중인 승인 workload에만 허용한다. 중앙의 `active/expiresAt`은 모델의 짧은 lease나 WAIT 상태와 별개다. 진행 중인 workload revision·중단 여부·작업 종료·소유 행동 TTL로 계산한다. `report`는 보존된 과거 소유 바인딩에도 허용하여 취소·기간 종료 후 영수증을 회수한다. 이때 새 challenge의 신선도는 그대로 검사하며 새 실행·토큰 전달·공개 권한을 만들지 않는다. 보고 내용은 독립 검증 전까지 사실로 확정하지 않는다.

## 부트스트랩 키와 HF 토큰

중앙의 `bootstrapKeys.read/register`는 전체 바인딩에 따른 durable CAS 저장소여야 한다. `register`는 최초 부트스트랩 등록 시점과 현재 권한을 다시 확인해야 한다. 학습 자식을 시작하기 전에 RSA 공개 키를 등록한다. 같은 바인딩에서 다른 키로 교체하지 않는다. 키를 잃으면 중앙의 새 명시적 등록 정책이 필요하며 임의 재등록으로 우회하지 않는다.

HF 전달은 별도 `hf-token` 목적이다. 저장된 키의 RFC7638 SHA-256 thumbprint와 서명된 thumbprint가 같아야 한다. 공개 JWK는 `{e,kty,n}`, RSA 2048~4096비트, 지수 65537로 제한한다. 토큰은 승인된 단일 `hfTokenRef`에서만 읽고 RSA-OAEP/SHA-256으로 암호화한다. OAEP label에는 바인딩·audience·nonce·목적·키·만료 시각을 넣는다. 중앙 private route는 TLS·`Cache-Control: no-store`를 사용하며 envelope를 모델/UI/이벤트로 보내지 않는다.

`scripts/delegated/token-file.ts`는 envelope와 예상 바인딩을 검사하고 업로더 전용 `/run/hivemind/hf-token`에 0600으로 쓴다. 디렉터리는 소유자 전용이어야 한다. 기존 파일·symlink는 거절한다. 콜백 완료·실패·전달 TTL 종료 시 파일을 지운다. 프로세스 강제 종료 시 파일 정리는 보장하지 않으므로 `/run`의 임시 저장과 부팅 시 정리도 운영 구성이 맡는다. 전달 TTL은 외부 HF 토큰 자체의 만료나 폐기를 뜻하지 않는다. HF에서 대상 저장소/조직과 수명을 제한한 토큰을 사용해야 한다.

## 신뢰하는 로컬 실행 포트

`scripts/delegated/bootstrap.ts`는 승인 descriptor fingerprint, 부트스트랩 바이트 해시, 입력 manifest digest, code/data 콘텐츠 해시를 검사한다. 임의 UserData·셸 명령·URL을 실행하지 않는다. 고정 `/opt/hivemind/bin/train-approved`만 신뢰하는 `runTraining` 포트에 전달한다. 환경은 고정 PATH/LANG뿐이다. 부트스트랩 키 등록 후 학습을 시작한다.

실제 런타임은 `isolateTraining`에서 IMDS 접근 차단, 자격증명 파일 숨김, 비특권 사용자 실행을 강제해야 한다. 세 조건을 충족하지 않으면 helper가 학습을 거절한다. 이 포트의 선언 자체가 OS 격리를 구현하지는 않는다. 승인된 AMI가 해당 포트를 구현·검증해야 한다. 이번 테스트는 실제 학습 명령을 실행하지 않았다.

부모 IAM 자격증명과 GSC 자격증명은 모두 신뢰하는 부트스트랩/업로더 콜백 안에만 둔다. 학습 자식과 모델에는 환경·파일·IMDS로 전달하지 않는다. GSC는 원래 세션의 ARN과 신원을 유지하므로 IAM 신원으로 자식과 부트스트랩을 구분할 수 없다. AMI나 부트스트랩이 침해되면 완전한 자식 프로세스 격리를 보장하지 않는다.

## 직접 게시와 정책

`scripts/delegated/publisher.ts`는 로컬 `/outputs/`의 승인 파일을 검사하고 객체 수·개별/합계 바이트 한도를 적용한다. `withParentCredentials`는 필요하면 신뢰하는 업로더 안에서 IMDS 세션을 갱신한다. 학습 시작과 게시 전에 `delegatedUploadAdmission`으로 필수 `descriptor.awsDelivery`를 검사한다. mode/purpose, 정확한 scope policy 해시, 계정 내 role ARN, 1~120초의 승인 기간이 맞아야 한다. 부모 세션은 승인 role과 해당 instance ID가 모두 같아야 한다. 필드가 없으면 이 GSC 업로더를 실행하지 않는다. 각 객체 업로드 전에 B2의 `createAwsScopedCredentialResolver().withCredentials`로 S3 bucket/prefix/actions와 최대 120초를 제한한다. 갱신 시 중앙 workload 권한을 다시 확인한다. 모델 lease/JWT에 의존하지 않으며 GSC 실패 시 부모 자격증명으로 업로드하지 않는다.

`scripts/delegated/sdk_port.py`는 공식 boto3/Hugging Face SDK 포트다. 가중치 본문을 중앙에 보내지 않는다.

- S3는 파일을 스트리밍하는 단일 PUT, 최대 5GiB다. SHA-256, 예상 bucket owner, `IfNoneMatch=*`를 지정하고 응답의 실제 VersionId를 보고한다. 대상 S3 bucket은 versioning이 활성화되어 있어야 한다. 누락·빈 값·문자열 `null`인 VersionId는 SDK와 publisher 모두 거절하며 영수증이나 후속 HF 게시를 만들지 않는다. 변경 가능한 비버전 key를 버전 소유·정리의 근거로 사용하지 않는다. SDK 재시도는 한 번의 요청으로 제한한다. 버전 없는 결과나 모호한 실패를 성공 영수증으로 만들지 않는다. 이 포트는 multipart를 구현하지 않는다. 다른 업로더의 native composite 영수증은 중앙의 별도 검증 규칙을 따른다.
- HF는 기존 고정 저장소의 공개 범위와 HEAD를 확인하고 `parent_commit`으로 커밋한다. 저장소 생성·공개 전환은 하지 않는다. 커밋 후 고정 SHA의 파일 크기·LFS SHA-256 또는 Git blob OID와 공개 범위를 확인한다. 작은 Git 파일은 LFS 전체 SHA를 검증했다고 표시하지 않는다. 공개 전환은 C의 별도 승인·품질 검증 경로다.
- 중앙 보고는 경로·버전/커밋·크기·체크섬뿐이다. 로컬 경로·토큰·자격증명은 영수증에 넣지 않는다. SDK 보고와 중앙의 독립 검증은 구분한다. 응답 유실 시 업로더를 무조건 재시도하지 않으며 보존된 소유 기록으로 회수해야 한다.

`buildDelegatedInstancePolicy`는 고정 bucket/prefix/account/region, 승인된 입력 객체 버전, 정책 revision/hash를 만든다. 명시적 Deny로 범위 밖 객체·입력 버전과 IAM/guard 변경 등 허용 목록 밖 행동을 막는다. `sts:GetScopedCredentials`는 명시적 120초 이하 duration만 허용한다. guard 배포 설정의 선택적 `delegatedUpload: {bucket,prefix,maxScopedSeconds}`가 실제 workload role과 permissions boundary에 같은 정책을 추가한다. 기존 guard 관리 Deny는 그대로 유지한다. guard/scheduler 역할과 Lambda의 AWS 행동은 늘리지 않는다. 생략한 manifest와 기본 정책은 기존 형식을 유지한다.

실제 workload 정책 해시는 `awsGuardDigest(awsGuardPolicies(settings).workload.policy)`다. CDK는 `workloadPolicySha256`과 `WorkloadPolicySha256` 출력으로 같은 값을 제공한다. `descriptor.iam.policySha256`은 이 실제 문서 해시와 같아야 한다. 별도의 `descriptor.awsDelivery.policySha256`은 `delegatedUploadAdmission`이 반환하는 GSC scope policy 해시다. 두 해시는 목적이 다르다. 중앙 admission은 descriptor의 bucket/prefix가 manifest와 같은지, 승인 duration이 `maxScopedSeconds` 이하인지 검사한다. attester는 실제 inline/boundary 문서가 이 빌더의 결과와 같은지 검사하고 이전 S3/GSC 권한 없는 문서를 거절한다.

출력 정책은 신뢰하는 IaC가 instance role에 부착해야 한다. 관리자가 정책을 제거하거나 바꾸는 위험까지 제거하지는 않는다.

## 로컬 검증

```sh
node --import ./scripts/delegated/source-test-loader.mjs --test tests/delegated-instance-auth.test.ts tests/delegated-instance-policy.test.ts tests/delegated-bootstrap.test.ts tests/delegated-publisher.test.ts tests/delegated-token-file.test.ts
python3 -m unittest discover -s scripts/delegated -p 'test_*.py'
```

source loader는 개발 검사에서 `.js` import를 `.ts`로 해석하는 도구다. 배포물이나 런타임의 구성 요소가 아니다. 실제 부팅/OS 격리·인스턴스 프로필·GSC·대형 S3/HF 업로드는 승인된 실제 환경에서 후속 검증한다. 전체 체크와 공유 런타임 빌드는 조율자가 수행한다.

근거: [HashiCorp AWS IAM 인증](https://developer.hashicorp.com/vault/docs/auth/aws), [STS GetCallerIdentity](https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html), [AWS SigV4](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html), [GSC 권한과 신원 유지](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp_control-access_getscopedcredentials.html), [RFC7638](https://www.rfc-editor.org/rfc/rfc7638), [boto3 PutObject](https://docs.aws.amazon.com/boto3/latest/reference/services/s3/client/put_object.html), [HF SDK 업로드](https://huggingface.co/docs/huggingface_hub/guides/upload).

Workers의 redirect 모드 근거: [Cloudflare Request 문서](https://developers.cloudflare.com/workers/runtime-apis/request/).

## 부팅 시 locator 발견

`scripts/delegated/imds_locator.py`는 고정 `169.254.169.254`에 직접 연결한다. proxy 환경이나 임의 endpoint를 사용하지 않는다. IMDSv2 token PUT(TTL 60초) 후 instance-id, identity document, `hivemind:task/revision/profile/descriptor/input`의 다섯 태그만 GET한다. redirect와 IMDSv1 fallback은 없다. 전체 5초, 응답별 16KiB, 합계 32KiB로 제한하고 token을 반환·로그하지 않는다.

`discover_instance_locator`는 task/revision/profile/descriptor/input/instance/account/region locator를 반환한다. IID와 태그는 권한 증명이 아니다. `discover_and_sign_bootstrap`은 신뢰하는 중앙 challenge 콜백을 호출하고 기존 botocore 서명기를 연결한다. 반환값은 세션 헤더를 포함한 private bootstrap API 입력이며 모델·공개 로그에 넣지 않는다. 중앙은 locator를 실제 소유 기록으로 다시 해석하고 STS 인증을 수행해야 한다. 호출자는 같은 키의 publicKeyJwk와 서명 요청을 bootstrap route에 제출한다.

근거: [IMDS의 instance tags](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/work-with-tags-in-IMDS.html), [IMDSv2 token 절차](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-service.html).
