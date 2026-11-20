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

## Invariants

- 트리 검사는 `backend/src`에서 `.ts`·`.mjs`·`.py`를, `backend/native`에서 `.c`·`.patch`·`.sh`·`.md`를 포함한다. `backend/native`에 `.md` 파일을 추가하거나 바꾸면 `digest`가 달라진다. `[runtime-build.ts:buildRuntimeManifest]`
- 입력은 파일당 2MiB, 합계 32MiB, 512파일 이하다. 심볼릭 링크를 거부한다. `[runtime-build.ts:buildRuntimeManifest]`
- `import-credential.ts`의 `ID`는 `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`와 일치해야 한다. 두 입력 파일은 그룹·기타 권한이 없어야 한다. `import-credential.ts`
- `import-credential.ts`와 `remote-smoke.ts`의 `HIVEMIND_URL`은 경로·쿼리가 없는 HTTPS origin이어야 한다. `import-credential.ts`, `remote-smoke.ts`
- `remote-smoke.ts`는 작업이 `SUCCEEDED`이고 컨테이너 종료와 인증 회수가 확인되며, 두 check와 두 native subagent의 실행 구간이 겹쳐야 통과로 판정한다. `remote-smoke.ts`

## Side Effects

- `runtime-build.ts --write`는 `backend/runtime-build.json`을 덮어쓴다. `[runtime-build.ts:writeRuntimeManifest]`
- `import-credential.ts`는 `/v1/credentials/{id}`에 구독 인증을 전송한다. stdout에는 `id`, `provider`, `generation`, `quarantined`만 출력한다.
- `remote-smoke.ts`는 `/v1/snapshots`와 `/v1/jobs`를 호출해 원격 모델 작업을 만든다. 등록된 구독 인증으로 실제 모델을 호출한다. 근거 폴더에 `submitted.json`과 `acceptance.json`을 쓴다.

## Verification

- Run: `npm test` (`cloudflare/backend/`에서 실행. `node --test test/*.test.ts`)
- Run: `npm run runtime:check` (`cloudflare/backend/`에서 실행. `node scripts/runtime-build.ts --check`)
- `import-credential.ts`와 `remote-smoke.ts`는 테스트 명령에 포함하지 않는다. 원격 호출과 모델 호출이 발생하므로 운영자가 명시적으로 실행한다.


### 실제 프로젝트 인수

`autonomous-acceptance.ts`는 계획 생성, 동일 requestId의 초안 등록·응답 유실 복구, 이력 조회와 로컬 보고를 제공한다. 자동 승인·모델 실행 명령은 없다. 명시적 모델·기간·예산·인증 reference를 지정한다. [사용법과 실제 검증 이관](../../../docs/plans/2026-11-20-issue1-acceptance-harness.md)을 따른다. 보고서가 미검증이라고 표시한 조건을 통과로 바꾸지 않는다.
