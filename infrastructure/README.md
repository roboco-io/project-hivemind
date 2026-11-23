# infrastructure

## Overview

독립 AWS TTL guard의 CDK 정의를 모은다. 현재 하위 패키지는 외부 workload 종료와 잔여 EBS 삭제 요청을 위한 guard를 정의하며 EC2 workload 자체는 생성하지 않는다.

## Interface

- [aws-external-guard](./aws-external-guard/README.md): 명시적 배포 설정을 받아 guard manifest와 리소스를 정의하는 `AwsExternalGuardStack`, 이벤트를 처리하는 `handler`를 제공한다. [aws-external-guard/lib/guard-stack.ts:`AwsExternalGuardStack`] [aws-external-guard/lambda/guard.py:`handler`]

## Invariants

- 계정·리전을 자동 선택하지 않는다. CLI는 `AWS_PROFILE=roboco`, 명시적 config 경로, 실제 계정과 `ap-northeast-2`를 요구한다. [aws-external-guard/bin/app.ts:`path`, `configuration`]
- 소유권·설정 digest와 만료 검증을 통과한 리소스만 종료·삭제 대상으로 삼는다. [aws-external-guard/lambda/guard.py:`enforce`, `sweep_volumes`]

## Side Effects

- CDK 합성은 로컬 산출물을 만든다. 별도 승인된 배포는 AWS 리소스를 만들고, 배포된 Lambda는 조건에 맞는 EC2 종료·EBS 삭제를 요청한다. [aws-external-guard/bin/app.ts:`app.synth`] [aws-external-guard/lib/guard-stack.ts:`AwsExternalGuardStack`] [aws-external-guard/lambda/guard.py:`enforce`, `sweep_volumes`]

## Verification

- `infrastructure/aws-external-guard`에서 `npm run typecheck`와 `npm test`를 실행한다. 루트 `npm run check`의 TypeScript include는 이 별도 패키지를 포함하지 않는다. [aws-external-guard/package.json:`scripts`] [../tsconfig.json:`include`]
