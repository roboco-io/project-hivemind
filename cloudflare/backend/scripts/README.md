# scripts

## Overview

이 폴더는 Cloudflare 백엔드의 운영자 스크립트다.
최상위 스크립트는 런타임 빌드 버전 기록, 구독 인증 등록, 원격 수용 검사를 담당한다. 하위 폴더는 인증 재사용, 큰 입력 업로드, 자원 검증 실험, DuckDB 사전 실험 도구를 담는다.
여러 스크립트가 원격 백엔드를 호출하거나 실제 모델을 실행한다. 각 항목의 Side Effects를 확인한 뒤 실행한다.

## Interface

### 하위 폴더

- [auth](./auth/README.md) - pi OAuth 인증을 macOS Keychain에 보관하고 내보낸다.
- [duckdb-pilot](./duckdb-pilot/README.md) - DuckDB 빌드·메모리 사전 실험의 로컬 실행기와 원격 제출 도구.
- [large-artifacts](./large-artifacts/README.md) - large artifact 업로드와 로컬 준비 검증.
- [resource-validation](./resource-validation/README.md) - 자원 검증 실험의 실행, 사용량 조회, 보고.

### 최상위 스크립트

- `runtime-build.ts` CLI - 인자는 `--write` 또는 `--check` 하나다. `npm run runtime:stamp`와 `npm run runtime:check`가 실행한다.
- `[runtime-build.ts:buildRuntimeManifest]` - 고정 입력과 `backend/src`, `backend/native` 트리의 파일별 SHA-256과 전체 `digest`를 계산한다.
- `[runtime-build.ts:writeRuntimeManifest]`, `[runtime-build.ts:checkRuntimeManifest]` - `backend/runtime-build.json`을 쓰고, 저장된 값이 새로 계산한 값과 같은지 확인한다.
- `[runtime-build.ts:RUNTIME_FIXED_INPUTS]`, `[runtime-build.ts:RuntimeBuildManifest]`, `[runtime-build.ts:defaultRoot]` - 고정 입력 목록, manifest 타입, 기본 루트.
- `import-credential.ts` CLI - 인자는 `codex|claude ID AUTH_FILE CONTROL_SECRETS_FILE`이다. `HIVEMIND_URL`을 읽는다.
- `remote-smoke.ts` CLI - 인자는 `CONTROL_SECRETS_FILE PRIVATE_EVIDENCE_DIRECTORY [all|submit|collect] [providers]`다. `HIVEMIND_URL`을 읽는다.
- `[runtime-build.ts:syncRuntimeAutonomousContract]` - 루트의 자율 작업 계약을 런타임 계약과 대조하거나 복사한다. CLI의 `--check`는 대조만 수행한다.
- `[autonomous-acceptance.ts:createAcceptancePlan]`, `loadManifest`, `saveManifest`, `registerAcceptance`, `observeAcceptance`, `reportAcceptance`, `acceptanceMain` - 장기 수용 계획의 고정, 초안 등록, 조회와 보고를 제공한다. CLI는 `plan|register|observe|report`다.
- `[autonomous-pilot.ts:createPilotPlan]`, `[autonomous-pilot.ts:pilotMain]` - 명시한 Claude 모델과 request ID로 두 회차 로컬 계획을 만든다. CLI는 `--plan --provider claude --model PIN --request-id ID`만 받는다.
- `[autonomous-readiness.ts:TARGET]`, `readPrivateConfig`, `readReadiness`, `parseReadinessArgs`, `readinessMain` - 코드에 고정된 대상의 준비 상태를 조회한다. `TARGET`의 버전은 비교 기준이며 현재 배포 상태의 증명이 아니다.
- `[autonomous-docker-probe.mjs:dockerProbeArgs]`, `runDockerProbe` - 불변 로컬 이미지 ID로 모델 호출 없는 Docker 격리 검사를 수행한다.

## Invariants

- 트리 검사는 `backend/src`에서 `.ts`·`.mjs`·`.py`를, `backend/native`에서 `.c`·`.patch`·`.sh`·`.md`를 포함한다. `backend/native`에 `.md` 파일을 추가하거나 바꾸면 `digest`가 달라진다. `[runtime-build.ts:buildRuntimeManifest]`
- 입력은 파일당 2MiB, 합계 32MiB, 512파일 이하다. 심볼릭 링크를 거부한다. `[runtime-build.ts:buildRuntimeManifest]`
- `import-credential.ts`의 `ID`는 `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`와 일치해야 한다. 두 입력 파일은 그룹·기타 권한이 없어야 한다. `import-credential.ts`
- `import-credential.ts`와 `remote-smoke.ts`의 `HIVEMIND_URL`은 경로·쿼리가 없는 HTTPS origin이어야 한다. `import-credential.ts`, `remote-smoke.ts`
- `remote-smoke.ts`는 작업이 `SUCCEEDED`이고 컨테이너 종료와 인증 회수가 확인되며, 두 check와 두 native subagent의 실행 구간이 겹쳐야 통과로 판정한다. `remote-smoke.ts`
- 수용 계획은 1~56일의 기간과 명시적 한도를 요구한다. 등록은 실행 승인을 하지 않으며, 응답 유실 후에는 같은 manifest와 request ID로 재시도한다. `[autonomous-acceptance.ts:createAcceptancePlan]`, `[autonomous-acceptance.ts:registerAcceptance]`
- 수용 보고는 공개 이력의 한계를 기록하며 `verified:false`를 유지한다. 세션 복구·도구 실행·비용 중단은 공개 상태만으로 입증하지 않는다. `[autonomous-acceptance.ts:reportAcceptance]`
- Docker 검사는 네트워크를 끄고 capability를 제거하며 읽기 전용 root와 UID 1000을 사용한다. 결과의 `cloudflareEvidence`는 `false`다. `[autonomous-docker-probe.mjs:dockerProbeArgs]`, `[autonomous-docker-probe.mjs:runDockerProbe]`

## Side Effects

- `runtime-build.ts --write`는 `backend/runtime-build.json`을 덮어쓴다. `[runtime-build.ts:writeRuntimeManifest]`
- `import-credential.ts`는 `/v1/credentials/{id}`에 구독 인증을 전송한다. stdout에는 `id`, `provider`, `generation`, `quarantined`만 출력한다.
- `remote-smoke.ts`는 `/v1/snapshots`와 `/v1/jobs`를 호출해 원격 모델 작업을 만든다. 등록된 구독 인증으로 실제 모델을 호출한다. 근거 폴더에 `submitted.json`과 `acceptance.json`을 쓴다.
- 수용 계획은 owner-only manifest와 잠금·관측 파일을 쓴다. `register`는 snapshot과 미승인 작업을 원격에 등록하고 `observe`는 원격 이력을 읽는다. `[autonomous-acceptance.ts:saveManifest]`, `[autonomous-acceptance.ts:registerAcceptance]`, `[autonomous-acceptance.ts:acceptanceMain]`
- 준비 상태 조회는 고정 대상에 GET 요청을 보낸다. Docker 검사는 로컬 컨테이너와 임시 폴더를 만들고 정리한다. `[autonomous-readiness.ts:readReadiness]`, `[autonomous-docker-probe.mjs:runDockerProbe]`

## Verification

- Run: `npm test` (`cloudflare/backend/`에서 실행. `node --test test/*.test.ts`)
- Run: `npm run runtime:check` (`cloudflare/backend/`에서 실행. `node scripts/runtime-build.ts --check`)
- `import-credential.ts`와 `remote-smoke.ts`는 테스트 명령에 포함하지 않는다. 원격 호출과 모델 호출이 발생하므로 운영자가 명시적으로 실행한다.


### 실제 프로젝트 인수

`autonomous-acceptance.ts`는 계획 생성, 동일 requestId의 초안 등록·응답 유실 복구, 이력 조회와 로컬 보고를 제공한다. 자동 승인·모델 실행 명령은 없다. 명시적 모델·기간·예산·인증 reference를 지정한다. [사용법과 실제 검증 이관](../../../docs/plans/2026-11-20-issue1-acceptance-harness.md)을 따른다. 보고서가 미검증이라고 표시한 조건을 통과로 바꾸지 않는다.
