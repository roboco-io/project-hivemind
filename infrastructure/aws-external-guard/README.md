# AWS 외부 TTL guard

아직 배포하지 않은 CDK 패키지다. EC2를 생성하지 않으며 기존 workload에 주입할 instance profile, 독립 종료 Lambda, 1분 EventBridge Rule, Scheduler group, 동적 소유권 binding table과 admission role을 만든다. 계정·AMI·workload·가격을 자동 선택하지 않는다.

## 로컬 검증

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run typecheck
```

테스트 계정 `111111111111`은 FIXTURE다. 테스트는 local synth와 fake fetch/boto3만 사용한다. 실제 app은 이 계정을 거절하고 `AWS_PROFILE=roboco`와 명시적인 private config 경로를 요구한다. context lookup은 없다. 실제 synth/deploy는 실제 계정·비용·대상을 사용자가 지정하고 배포를 승인한 후 별도 작업으로 수행한다.

## 신뢰 설정

`GuardDeploymentConfig`는 accountId, region(기본 허용 리전 `ap-northeast-2`), resourcePrefix, controllerPrincipalArn, validUntil, profiles를 모두 요구한다. profile은 workloadId, configurationHash, parameterPolicy(`opaque_broker_sha256`), maxLifetimeMs, launchHeadroomMs(0..60000), quote{source,maxExposureMicros,validUntil}를 요구한다. instanceProfileArn은 고정 prefix로 만든 실제 profile ARN이다. configurationHash는 provider가 export하는 `externalAwsConfigurationHash(finalAwsConfig)`로 계산한다. 이 함수는 고정 launch policy를 정규화하며 enabled 등 admission 상태와 객체 속성 순서에 의존하지 않는다. CDK manifest의 `awsGuardDigest`와는 별개의 hash다. 수작업 JSON.stringify/canonical hash나 임의 상수로 대체하지 않는다. instance profile ARN을 포함한 최종 서버 설정을 helper에 제공한다.

소비자는 `stack.manifest`와 같은 manifest, 출력 ARN, 고정 역할 binding 3개(`guard`, `scheduler`, `workload`, 각각 `guard-policy` inline policy와 같은 이름의 permissions boundary)를 `createAwsTtlGuardPort`에 제공한다. expectedCodeSha256은 신뢰된 배포 artifact의 AWS Lambda ZIP SHA256(base64)을 별도로 고정해야 한다. admission 때 읽은 값을 스스로 expected 값으로 채우면 안 된다. credentials 공급자는 고정 AdmissionRoleArn의 단기 자격 증명을 제공하는 신뢰된 서버 컴포넌트다. 모델/workload에 이 자격 증명을 전달하지 않는다. provider transport에 port를 연결하는 작업은 별도 담당자 범위다. missing/disabled port는 계속 차단한다.

`attest`는 readonly SigV4 검증이며 `arm`은 conditional DynamoDB binding과 Scheduler timer를 만들고 read-back한다. oneoff Input에 UUID owner/request/parameters/expiry를 결속한다. 매 action마다 manifest 수정이나 재배포는 필요 없다. periodic Lambda는 실제 EC2 profile/account/region/LaunchTime와 registry의 owner/request marker를 검증한다. workload 역할에는 EC2 생성/태그 변경, registry 변경, guard 변경/역할 전환 권한이 없다.

## 보존과 비용

oneoff timer는 실행 후 자동 삭제한다. 취소·종료된 workload는 반복 sweep에서 no-op이다. shared Rule/Lambda/binding table은 workload 취소로 제거하지 않는다. table은 TTL 비활성, deletion protection과 RETAIN을 사용하여 oneoff 이후 late-create도 확인한다. binding 기록 정리는 별도 운영 작업이다. 활성 action 중 manifest digest를 바꾸면 이전 binding을 거절하므로 교체 전 version migration이 필요하다.

maxExposureMicros는 사용자 제공 profile quote다. EC2/EBS/데이터 전송, guard Lambda/Scheduler/DynamoDB/로그를 포함한 모든 AWS 비용의 강제 상한이나 실제 청구액이 아니다. 종료 요청도 실제 provider 부재나 청구 종료 증거가 아니다. 실제 배포와 원격 enforcement는 미검증이다.

## P1 실행 설정 attestation

GetFunctionConfiguration은 코드 hash뿐 아니라 현재 합성 guard의 Timeout=55초, MemorySize=256MiB, Architectures=[x86_64], VPC 미연결도 확인한다. 로컬 synth에서 55/256과 VpcConfig 미지정을 확인했고 설치 CDK function.d.ts는 architecture 기본값을 X86_64로 명시한다. AWS 응답은 VpcConfig 생략 또는 빈 subnet/security-group, 빈 VpcId, dual-stack false만 허용한다. 실행 설정 누락·변조는 timer/EC2 생성 전에 거절한다. GetPolicy와 reserved concurrency=0 차단은 유지한다. 이는 원격 설정 대조이며 실제 종료 timeliness/enforcement나 모든 AWS 비용 상한의 검증은 아니다. quote와 launch headroom은 변경하지 않는다.

## R11 만료 후 EBS 잔여물

periodic guard는 instance 목록이 비어도 별도로 owned volume 태그를 pagination하여 조회한다. 일곱 ownership 태그와 DDB request binding, AvailabilityZone/CreateTime/TTL을 확인한다. owner/client-token으로 instance inventory를 다시 읽어 terminated/부재를 확인하고, volume이 available·명시적 빈 Attachments일 때만 재조회 후 DeleteVolume한다. attached·소유권 불일치·binding 없음·재조회 중 재사용은 삭제하지 않는다. DetachVolume/force 경로는 없다. 결과의 volumeDeletionRequests는 요청 개수이며 cleaned나 실제 부재/과금 종료 증거가 아니다. provider가 이후 metadata로 별도 확인해야 한다.

공용 awsGuardPolicies가 guard의 DescribeVolumes와 guard/workload/UUID owner 조건이 붙은 account/region volume ARN의 DeleteVolume을 포함한다. 같은 함수가 CDK inline/boundary와 attestation 기대값을 생성한다. 이전 IAM 정책이면 신규 paid admission을 거절한다. Lambda 코드 변경에 따른 실제 배포 artifact CodeSha256도 운영자가 새로 고정해야 하며 테스트 상수로 대체하면 안 된다. 실제 배포나 기존 유료 리소스 정리는 이 로컬 변경으로 실행되지 않는다.

## Interface

- `GuardDeploymentConfig`와 `AwsExternalGuardStack.manifest`의 입력·출력 계약은 [lib](./lib/README.md)에 있다. [lib/guard-stack.ts:`GuardDeploymentConfig`, `AwsExternalGuardStack`]
- [bin](./bin/README.md)은 명시적 설정을 읽는 CDK 진입점이다. [bin/app.ts:`configuration`, `app.synth`]
- [lambda](./lambda/README.md)는 `periodic`/`timer` 이벤트를 처리하고 EC2 종료·EBS 삭제 요청 수를 반환한다. [lambda/guard.py:`handler`, `enforce`]

## Invariants

- stack은 명시적 계정·리전과 CDK 환경을 대조하며, CLI는 fixture 계정을 거절한다. [lib/guard-stack.ts:`AwsExternalGuardStack.constructor`] [bin/app.ts:`configuration`]
- 역할별 정책은 `/packages/adapters/src/autonomous-aws-guard.ts`에서 가져온 공통 `awsGuardPolicies`로 생성한다. 소유권 binding과 manifest digest 검증은 Lambda에서도 수행한다. [lib/guard-stack.ts:`policies`] [lambda/guard.py:`binding`, `enforce`]

## Side Effects

- CDK 합성은 로컬 산출물을 생성하고, 별도 배포는 guard용 AWS 리소스를 생성한다. Lambda 실행 시 소유권·TTL이 일치하는 리소스에 종료·삭제 요청을 보낸다. [bin/app.ts:`app.synth`] [lib/guard-stack.ts:`AwsExternalGuardStack`] [lambda/guard.py:`enforce`, `sweep_volumes`]

## Verification

- 이 패키지에서 `npm run typecheck`와 `npm test`를 실행한다. 루트 `npm run check`는 이 패키지의 대체 검증이 아니다. [package.json:`scripts.typecheck`, `scripts.test`] [../../tsconfig.json:`include`]
- 실제 계정의 synth/deploy와 원격 enforcement는 별도 승인·검증 범위다.


## 설정 리전과 물리 가용 영역

`allowedRegions`는 서버/배포 설정의 허용 목록이다. 생략하면 서울만 허용한다. Ohio는 `region: "us-east-2", allowedRegions: ["us-east-2"]`를 명시한다. 목록이 비었거나 중복·잘못된 값이 있으면 거절한다. CDK 환경 리전, ARN, manifest, Lambda 클라이언트 리전이 모두 일치해야 한다. 자동 리전 전환은 없다.

profile의 선택 필드 `availabilityZoneId`는 서울 `apne2-azN`, Ohio `use2-azN`을 받는다. 지정하면 실제 DescribeInstances Placement와 DescribeVolumes의 ID가 같아야 한다. 가용 영역 이름도 선택 리전과 일치해야 한다. 이름으로 ID를 추측하지 않는다. 실행 제공자는 RunInstances의 `Placement.AvailabilityZoneId`를 사용한다. 이름과 ID를 동시에 보내지 않는다. [AWS Placement 계약](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_Placement.html)

새 선택 필드를 생략한 서울 manifest는 기존 직렬화와 digest를 유지한다. 허용 목록을 명시하면 manifest에 region/allowedRegions를 함께 넣고 digest에 결속한다. profile의 AZ ID는 별도 실행 설정 hash에도 결속한다. 리전·AZ ID 변경 시 새 승인과 해당 manifest/코드 hash 대조가 필요하다. Cost Explorer의 청구 API는 `us-east-1`을 유지하고 자원 필터·credential scope는 선택 리전을 쓴다.

로컬 검사: 이 패키지에서 `npm test`, `npm run typecheck`. 실제 AWS 자원·시세·청구 조회 또는 배포는 수행하지 않았다.
