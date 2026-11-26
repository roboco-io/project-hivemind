# AWS guard CDK 진입점

## Overview

명시적으로 지정한 비공개 설정 파일로 AWS guard stack을 합성한다. 사용자 승인 없이 이 진입점을 실행하지 않는다.

## Interface

- `app.ts` 최상위 진입점은 CDK context `config`로 JSON 경로를 받아 `GuardDeploymentConfig`로 읽고 `AwsExternalGuardStack`을 생성한 뒤 `app.synth()`를 호출한다. [app.ts:`app`, `configuration`]
- stack 계약은 [lib](../lib/README.md)에 있다.

## Invariants

- `config`는 비어 있지 않은 문자열이고 `AWS_PROFILE`은 `roboco`여야 한다. 자동 계정 조회 경로는 없다. [app.ts:`path`, `AWS_PROFILE`]
- 계정은 12자리이며 fixture 계정 `111111111111`은 거절한다. 리전은 `ap-northeast-2`로 고정한다. [app.ts:`configuration`]

## Side Effects

- `readFileSync`로 설정 파일을 읽는다. `app.synth()`는 CDK 합성 산출물을 만든다. stack 생성은 AWS 배포를 수행하지 않는다. [app.ts:`configuration`, `app.synth`]

## Verification

- `infrastructure/aws-external-guard`에서 `npm run typecheck`와 `npm test`를 실행한다. [../package.json:`scripts.typecheck`, `scripts.test`]
- `npm run synth`는 실제 계정·비공개 설정을 요구하므로 일반 로컬 검증 명령으로 실행하지 않는다. [app.ts:`path`, `configuration`]
