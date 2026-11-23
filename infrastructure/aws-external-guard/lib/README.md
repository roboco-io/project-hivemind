# AWS guard stack

## Overview

독립 TTL guard의 IAM, Lambda, EventBridge, Scheduler와 DynamoDB 구성을 CDK로 정의한다. EC2 workload 자체는 생성하지 않는다.

## Interface

- `GuardDeploymentConfig`는 `accountId`, 고정 리전, `resourcePrefix`, `controllerPrincipalArn`, `validUntil`, profile 목록을 받는다. profile 입력에서 `instanceProfileArn`은 제외하며 stack이 생성한 ARN으로 채운다. [guard-stack.ts:`GuardDeploymentConfig`, `AwsExternalGuardStack.constructor`]
- `AwsExternalGuardStack`은 `StackProps`와 `configuration`, 선택적 `fixture`를 받고 읽기 전용 `manifest: AwsGuardManifest`를 노출한다. [guard-stack.ts:`AwsExternalGuardStack`]
- 정책·정규화·해시는 저장소의 `/packages/adapters/src/autonomous-aws-guard.ts`에서 가져온 `awsGuardPolicies`, `awsGuardCanonical`, `awsGuardDigest`를 사용한다. 이 디렉터리에서 별도로 정의하지 않는다. [guard-stack.ts:imports]
- Lambda 런타임 계약은 [lambda](../lambda/README.md)에 있다.

## Invariants

- 명시적 계정·리전과 CDK 환경이 일치해야 한다. fixture 계정은 `fixture: true`일 때만 허용한다. prefix, 같은 계정의 controller role ARN, 양의 정수 만료 시각과 1~16개 profile을 검사한다. [guard-stack.ts:`AwsExternalGuardStack.constructor`]
- manifest 정규화 결과는 3000바이트 이하여야 한다. profile은 정확한 필드 집합, SHA-256 형식의 configuration hash, `opaque_broker_sha256`, 0~60000ms headroom, 60000~86400000ms lifetime, 양의 quote와 manifest 이내 quote 만료를 요구한다. [guard-stack.ts:`AwsExternalGuardStack.constructor`]
- controller role은 guard/scheduler/workload role과 달라야 한다. 각 역할의 inline policy와 permissions boundary는 공통 정책 함수의 같은 문서를 사용한다. [guard-stack.ts:`bindings`, `policies`]
- binding table은 TTL을 설정하지 않고 deletion protection과 `RETAIN`을 사용한다. Lambda는 Python 3.13, 55초, 256MiB이며 테스트·Python 캐시를 asset에서 제외한다. [guard-stack.ts:`table`, `fn`]

## Side Effects

- 합성 시 Lambda asset을 읽고 CDK 리소스 정의와 ARN/digest 출력을 만든다. 별도 배포 시 IAM 역할·boundary·instance profile, DynamoDB table, 로그 그룹, Lambda, 1분 주기 EventBridge rule, 호출 permission, Scheduler group을 생성한다. [guard-stack.ts:`AwsExternalGuardStack.constructor`]
- 로그 그룹은 한 달 보존과 `RETAIN`을 사용한다. admission role은 명시적 controller만 assume할 수 있고 attestation 조회·binding 쓰기·timer 생성 권한을 정의한다. [guard-stack.ts:`logGroup`, `admissionPolicy`, `admission`]

## Verification

- `infrastructure/aws-external-guard`에서 `npm run typecheck`와 `npm test`를 실행한다. 테스트는 TypeScript 테스트와 Lambda unittest를 실행한다. [../package.json:`scripts.typecheck`, `scripts.test`]
- 실제 배포·원격 enforcement는 이 로컬 검증에 포함하지 않는다.
