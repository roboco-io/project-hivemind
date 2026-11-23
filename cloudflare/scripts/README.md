# scripts

## Overview

이 폴더는 Cloudflare 프로젝트 수준의 스크립트를 묶는다. 현재 하위 폴더는 0단계 타당성 검증용 `phase0` 하나다.
백엔드 운영자 스크립트는 이 폴더가 아니라 [backend/scripts](../backend/scripts/README.md)에 있다.

## Subdirectories & Boundaries

- phase0: [./phase0/README.md](./phase0/README.md) - 공식 Codex·Claude Code CLI의 컨테이너 실행과 파일·프로세스·인증 경계를 확인하는 probe, 판정 로직, 운영자 스크립트. 하위 `cloudflare`는 probe를 실행하는 Worker다.


## Interface

- [phase0 계약](./phase0/README.md)은 `phase0/local.ts` CLI, fixture 판정과 원격 probe를 묶는다. `../package.json:scripts.phase0:local`이 로컬 CLI의 진입점이다.

## Invariants

- 타당성 gate는 backend별 필수 검사 모두가 정확히 한 번 PASS일 때만 통과한다 (`phase0/gate.ts:evaluateGate`). 로컬 준비 확인만으로 원격 수용을 통과하지 않는다 (`phase0/collect.ts:collectLocal`).

## Side Effects

- 하위 실행기는 계정 조회·파일 기록·컨테이너 명령과 실제 모델 호출을 포함한다. 범위는 [phase0 부작용](./phase0/README.md#side-effects)에 구분되어 있다.

## Verification

- `cloudflare`에서 `npm test`를 실행한다 (`../package.json:scripts.test`). 배포·원격 호출·계정 조회는 기본 오프라인 검증에 포함하지 않는다.
