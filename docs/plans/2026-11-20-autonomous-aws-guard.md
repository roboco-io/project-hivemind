# AWS 외부 TTL guard

## 범위와 기본 차단

새 CDK 패키지와 독립 AwsTtlGuardPort만 추가한다. provider adapter, core, WEB/R6 파일은 변경하지 않는다. enabled 또는 고정 인프라 설정이 없으면 admission을 거절한다. 실제 AWS 호출·계정 조회·CDK context lookup·배포·asset upload·모델 실행·커밋은 하지 않는다. npm 설치와 로컬 synth만 허용한다. 테스트 계정 111111111111은 명시적 FIXTURE이며 실제 배포 app은 이 값을 거절한다. 실제 계정·workload·AMI·가격은 추측하지 않는다. 향후 회사 배포는 AWS_PROFILE=roboco, region=ap-northeast-2를 명시해야 한다.

## 신뢰 설정과 계약

createAwsTtlGuardPort({enabled,accountId,region:'ap-northeast-2',guardArn,functionArn,scheduleGroupArn,schedulerRoleArn,expectedCodeSha256,manifest,rolePolicies,credentials,fetchImpl?,now?})를 제공한다. 기존 adapter의 AwsTtlGuardPort/Request/Evidence 타입을 import한다. manifest는 schemaVersion=1, ownershipMode=broker_uuid_registry_v1, registryTableArn, guardArn, validUntil, profiles를 포함한다. profile은 workloadId, configurationHash, instanceProfileArn, parameterPolicy=opaque_broker_sha256, maxLifetimeMs, launchHeadroomMs, quote{source,maxExposureMicros,validUntil}를 고정한다. owner UUID와 parametersHash는 action마다 생성되어 arm에서 결속한다. rolePolicies는 role ARN·정확한 inline policy·permissions boundary ARN/정책·trust policy의 기대값을 고정한다. configurationHash는 provider의 externalAwsConfigurationHash(finalAwsConfig)로 계산하는 normalized fixed launch-policy hash다. enabled/ephemeral admission 상태와 객체 속성 순서에 의존하지 않으며 manifest의 awsGuardDigest와 혼동하지 않는다. quote는 사용자가 제공한 자료이며 가격 조회나 청구 증거가 아니다.

attest는 독립 SigV4 signer로 고정 AWS endpoint만 호출한다. DescribeRule/ListTargetsByRule/GetFunctionConfiguration을 읽고 rule ARN·1분 ENABLED 주기·정확한 Lambda target·schema/config digest·CodeSha256·Role·활성 상태를 확인한다. IAM GetRole/ListRolePolicies/ListAttachedRolePolicies/GetRolePolicy/GetPolicy/GetPolicyVersion으로 실제 inline policy, trust, boundary와 local trusted expectation을 대조한다. ARN만으로 권한을 확인했다고 주장하지 않는다. 요청의 account/region/owner/workload/parameters/configuration hash/expiry/quote를 manifest와 대조하고 원격 read 근거를 bindingHash와 evidenceId에 결속한다. SigV4는 AWS 요청 서명이며 AWS가 evidence 객체를 별도 서명하는 것은 아니다. arm은 이 port가 실제 발급한 동일하고 신선한 attestation만 받는다.

arm은 EC2 생성 전에 고정 schedule group에 CreateSchedule을 호출하고 GetSchedule로 정확한 target·역할·Input·시각·자동 삭제를 확인한다. timer 이름/ClientToken은 request bindingHash에서 결정한다. Input에는 schema/config digest와 요청 identity가 있다. TTL은 epoch milliseconds이며 Scheduler at 표현은 expiry를 초 단위로 올림한다. 임의 role/URL/resource는 요청에서 받지 않는다. 생성 응답 손실은 admission 실패다. 재시도 conflict도 GetSchedule이 동일한 설정임을 확인한 경우만 수용한다.

## 외부 종료와 역할 경계

미리 배포한 EventBridge Rule(rate(1 minute))과 Scheduler oneoff가 같은 Lambda를 호출한다. Rule은 default event bus의 정확한 account/region ARN이다. Lambda는 EC2 DescribeInstances를 pagination하고 owner/request/workload/parameters/guard/timer/expires 태그 전체를 검사한다. 승인 profile과 일치하며 now>=expires일 때만 TerminateInstances한다. 조기 timer는 건너뛰고 주기 rule이 late-create/lost-create-ACK를 다시 발견한다. timer event는 정확한 요청 태그로 범위를 좁히고 periodic event는 manifest 전체를 검사한다. 임의 instance ID를 event에서 받지 않는다. 취소되어 이미 없어진 instance는 idempotent no-op이다. 종료 요청은 비용 정산이나 실제 과금 종료 증거가 아니다.

CDK는 guard/scheduler/workload 역할을 별도로 만들고 각각 좁은 inline policy와 permissions boundary를 둔다. workload 역할에는 guard/rule/scheduler/IAM 변경이나 AssumeRole 권한이 없다. root/SSH는 해당 workload 자격 증명으로 외부 guard를 해제할 수 없다. 별도 운영자 자격 증명 탈취나 account administrator 변경을 방어한다고 주장하지 않는다. IAM trust/source 조건과 Lambda invoke permission은 고정 rule/group/account에 묶는다. oneoff는 ActionAfterCompletion=DELETE로 정리한다. guard는 user workload와 별개이므로 workload 취소 때 rule/Lambda를 삭제하지 않는다.

## 검증

순수 port 테스트는 모든 AWS fetch를 fake로 주입한다. Python unittest는 fake boto3/EC2만 사용한다. CDK assertions는 FIXTURE 계정으로 synth하여 태그 범위·IAMboundary·invoke 조건·periodic rule을 검사한다. 실제 guard 설치와 원격 enforcement, 가격의 정확성은 배포 후 별도 검증 전까지 미검증이다. maxExposureMicros는 trusted quote이며 hard AWS bill cap이 아니다.

## 수정: 동적 broker 소유권

배포 manifest의 action별 ownershipToken/parametersHashes whitelist를 제거한다. manifest는 ownershipMode=broker_uuid_registry_v1과 고정 registryTableArn을 명시하고 workload/configurationHash/instanceProfileArn/maxLifetimeMs/launchHeadroomMs/opaque_broker_sha256 parameter policy/quote만 고정한다. 이 capability가 없으면 신규 admission은 거절한다. UUID와 SHA256의 의미적 승인 및 parameter hash 계산은 기존 broker/provider 계약이 담당하며 guard는 형식과 immutable action binding을 검증한다.

현재 request tag는 SHA256(idempotencyKey)이며 owner UUID로부터 복원할 수 없다. arm은 고정 DynamoDB table에 owner UUID를 키로 schemaVersion/manifest digest/request JSON/bindingHash/timerArn을 조건부 기록하고 consistent read-back한다. 이것은 인프라 배포 전 whitelist가 아니라 broker action이 생긴 뒤, RunInstances 전 수행하는 런타임 binding이다. owner 재사용에 다른 요청을 결속할 수 없다. IAM은 admission 역할만 PutItem/GetItem, guard 역할은 GetItem만 허용한다. workload는 registry/EC2 tag/RunInstances/guard 변경 권한이 없다. attest는 DescribeTable/DescribeTimeToLive로 고정 table/key와 TTL 비활성도 확인한다.

oneoff Input과 registry binding은 같은 요청에 묶인다. periodic Lambda도 UUID owner로 registry를 consistent read하여 request marker와 전체 태그를 대조한다. 실제 reservation OwnerId, fixed-region AvailabilityZone, instance profile ARN을 검사하고 expiry-launch <= maxLifetime+headroom을 요구한다. UUID/hash/태그/registry 불일치는 종료 대상이 아니다. late-create는 원래 expiry 이후에도 다음 periodic sweep에서 종료한다. registry TTL은 사용하지 않으며, timer의 ActionAfterCompletion=DELETE가 binding을 지우지 않는다. late-create 안전성 때문에 binding은 자동 삭제하지 않는다. registry의 별도 보존/정리 비용도 quote가 보장하는 hard fee cap에 포함된 것으로 주장하지 않는다.

현재 manifest/configurationDigest는 활성 action 동안 불변으로 유지해야 한다. 변경하면 기존 registry binding의 digest와 일치하지 않아 cleanup을 거절한다. 기존 action이 남아 있는 guard 교체에는 별도 version migration이 필요하며 이번 구현은 자동 migration을 하지 않는다.

## 로컬 결과와 인계

`createAwsTtlGuardPort`와 public types는 새 packages/adapters/src/autonomous-aws-guard.ts에 있다. provider 파일의 AwsTtlGuardPort(signal 포함)를 type-only import하며 기존 signer를 변경하거나 export하지 않았다. config의 manifest에는 위 동적 capability와 registry ARN이 필수다. factory는 enabled가 true가 아니면 credentials나 AWS fetch를 호출하지 않고 거절한다. C3는 port를 서버 설정으로 주입하며 quote/code digest/credentials를 모델 wire에서 받으면 안 된다.

실제 broker가 생성한 UUID 두 개와 서로 다른 lifetime hash가 단일 unchanged manifest에서 attest/arm되는 회귀 검증을 추가했다. 배포별 owner whitelist나 action별 재배포는 필요 없다. 잘못된 UUID/hash/표적 profile, registry request marker 변조·owner 재사용, 실제 EC2 profile/account/region/LaunchTime 위반을 거절한다. 새 port 집중 테스트 14개, CDK fixture assertions 2개, Python fake boto3/EC2/registry 테스트 12개 통과. 루트 build와 새 CDK 패키지 typecheck 통과. 로그: /tmp/hivemind-aws-guard-port.log, /tmp/hivemind-aws-guard-cdk.log, /tmp/hivemind-aws-guard-cdk-types.log. 전체 suite는 실행하지 않았다.

독립 SigV4 verifier는 실제 네트워크 없이 canonical path/query/body와 IAM global signing region(us-east-1)을 확인한다. guard의 모든 regional resource/API는 ap-northeast-2다. Lambda invoke policy와 reserved concurrency(0 거절), table schema/TTL, 실제 role/boundary 문서도 read-back한다. 실제 AWS에서의 remote enforcement, deployment ZIP digest, quote 정확성은 여전히 미검증이며 배포 승인도 받지 않았다. 실제 배포·자격 증명 조회·AWS API·모델·asset upload·커밋은 수행하지 않았다.

## P1 실행 설정 회귀 수정

독립 review의 Timeout 55→1 변조를 순수 fake AWS로 재현했다. 수정 전 테스트는 Missing expected rejection으로 RED였고 이후 GREEN이다. 실제 로컬 synth 출력은 Timeout55/MemorySize256/VPC 없음, 설치 CDK 기본 architecture는 X86_64다. port는 이 실행 envelope를 정확히 확인하고 attestation evidence digest에도 결속한다. 메모리·architecture·VPC 변조/필수 값 누락, timeout 1, reserved concurrency 0은 admission을 거절한다. infrastructure producer, Lambda code, quote/headroom 값은 변경하지 않았다.

## 공용 launch hash와 실제 provider seam

Dirac 소유 provider가 export하는 externalAwsConfigurationHash를 그대로 사용한다. hash 입력은 고정 account/region/workload/image/instanceType/subnet/instanceProfile/maxLifetime/maxUpperBound scope이며 enabled, credentialRef/값, billingPolicy와 action 데이터는 제외한다. 별도 수작업 canonicalizer나 JSON.stringify(전체 AWS config)를 쓰지 않는다.

수정 후 집중 검사는 guard port 18개와 기존 CDK fixture assertions 2개 통과, guard port/test 대상 strict TypeScript 검사 통과다. 실제 ExternalBroker → createExternalProviderTransport → concrete AwsTtlGuardPort를 연결하고 AWS만 fake로 주입했다. 서로 다른 실제 broker UUID와 lifetime hash 두 개가 동일한 manifest에서 동작하며, 각 fake RunInstances 전에 해당 binding 및 정확한 timer GetSchedule read-back이 존재함을 확인한다. AWS config 속성 순서를 반대로 해도 hash가 같고 enabled 변경도 launch hash에 영향을 주지 않는다. 배포 CodeSha256은 실제 배포 artifact의 신뢰된 metadata가 여전히 필수이며 테스트용 base64 상수를 운영 metadata로 사용하지 않는다.

RED 로그: /tmp/hivemind-aws-guard-execution-red.log (Timeout=1인데 Missing expected rejection). GREEN/회귀: /tmp/hivemind-aws-guard-final-focused.log. Types: /tmp/hivemind-aws-guard-focused-types.log. 로컬 synth metadata는 Timeout55/Memory256/default x86_64/no VPC였다. quote/headroom, Lambda 코드와 CDK 생산 설정은 변경하지 않았다. 원격 enforcement/timeliness는 아직 검증하지 않았으며 실제 AWS 호출·인증 조회·배포·모델 호출은 없다.

## R11 소유 EBS 잔여물 fallback

RunInstances의 TagSpecification.2로 생성 시 붙은 owner/request/workload/parameters/expires/guard/timer 태그와 immutable DDB action binding을 검증한 임시 volume만 cleanup 후보로 삼는다. periodic volume 조회는 instance loop와 독립적으로 수행하여 instance가 이미 사라진 다음 sweep에서도 잔여 EBS를 찾는다. fixed-region EC2 DescribeVolumes를 pagination하고 실제 AvailabilityZone/CreateTime과 TTL 범위를 확인한다.

해당 owner/client-token의 instance inventory가 완전하게 비었거나 모든 matching instance가 terminated임을 별도로 확인한다. TerminateInstances ACK나 shutting-down은 종료 완료 증거가 아니다. volume은 available이며 Attachments가 명시적으로 빈 배열인 경우만 재조회 후 DeleteVolume한다. read-back에서 태그/상태/attachment가 바뀌면 삭제하지 않는다. detach/force 삭제, 임의 event volume ID, unowned volume, 수동으로 다른 instance에 재부착된 volume은 허용하지 않는다.

공용 awsGuardPolicies에 DescribeVolumes(read Resource *)와 DeleteVolume(account/region volume ARN, guard/workload/UUID-owner 태그 조건)을 추가한다. 같은 함수가 CDK 역할과 attest 기대 policy를 만들므로 문서가 일치해야만 신규 admission이 가능하다. workload 역할은 EC2 mutation을 허용하지 않는다. Lambda 결과는 terminationRequests/volumeDeletionRequests라는 요청 개수일 뿐 cleaned/실제 부재/과금 종료 증거가 아니다. 별도 provider reconciliation이 다음 metadata로 부재를 확인해야 한다. quote/headroom과 배포 승인 상태는 변경하지 않는다.

R11 로컬 결과: Python 20개, CDK assertions 3개 통과 및 새 CDK 패키지 typecheck 통과. Lambda 잔여 volume 삭제와 IAM DescribeVolumes/DeleteVolume 누락을 각각 RED로 확인한 뒤 GREEN으로 검증했다. root source를 새 emit한 guard/provider/cost 합동 집중 검사 75개와 build도 통과했다. 로그는 /tmp/hivemind-aws-guard-ebs-red.log, /tmp/hivemind-aws-guard-ebs-iam-red.log, /tmp/hivemind-aws-guard-ebs-tests.log, /tmp/hivemind-r11-guard-provider-cost-focused.log다. 양쪽 공용 IAM helper, actual provider TagSpecification.2의 일곱 태그 일치, DDB binding 없는 volume 거절, attached/재사용/잘못된 request marker 거절, instance 소멸 후 다음 sweep, pagination과 TTL을 포함한다. 삭제 요청은 cleaned 상태나 비용 대사를 생성하지 않는다. 원격 API/배포/실제 volume 삭제는 실행하지 않았으며 enforcement는 미검증이다.
