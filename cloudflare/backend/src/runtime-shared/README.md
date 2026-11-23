# 장기 실행 공통 계약

## Overview

Worker와 컨테이너가 공유하는 장기 실행 타입과 순수 입력 검증이다.

## Interface

- `autonomous.ts:AutonomousSpec`, `AutonomousTask`, `AutonomousLease`, `AutonomousRunResult`, `AutonomousNativeReceipt`, `AutonomousState`는 승인·실행·결과·비용·개입의 공통 형태다.
- `autonomous.ts:validateAutonomousModelPin`은 구체적인 모델 문자열을 검사한다. `validateAutonomousCapabilities`는 도구·웹 호스트·외부 프로필·시스템 조합을 검사한다.
- `autonomous.ts:AUTONOMOUS_EXTERNAL_TOOL`과 `autonomousExternalOperation`은 외부 작업 도구 이름과 지원 operation 조합을 정의한다.

## Invariants

- `autonomous.ts:validateAutonomousModelPin`은 `default`, `latest`, `opus`, `sonnet` 등의 별칭을 거부한다. 모델의 실제 제공 여부는 검증하지 않는다.
- `autonomous.ts:validateAutonomousCapabilities`는 중복 없는 도구 목록과 `Bash`를 요구한다. `WebFetch`와 웹 설정, 외부 작업 도구와 프로필 설정은 각각 함께 있어야 한다.
- 같은 함수는 웹 호스트를 소문자 공개 도메인 형태로 제한하고 예약·내부·모델 제공자 도메인을 거부한다. 프로필은 1~3개다. 시스템은 설정과 일치해야 하며 `aws`, `hf`, `github`만 허용한다.
- `autonomous.ts:AutonomousTask`의 공개 lease 형태는 token 생략을 허용한다. `usageUnavailable`의 0 사용량은 측정값을 뜻하지 않는다 (`AutonomousRun`).

## Side Effects

- 없음. 검증 함수는 입력을 검사하고 잘못된 값에 예외를 발생시킨다 (`autonomous.ts:validateAutonomousModelPin`, `validateAutonomousCapabilities`).

## Verification

- `cloudflare/backend`에서 `npm run typecheck`와 `npm test`를 실행한다.
