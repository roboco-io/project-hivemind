# scripts/resource-validation

## Overview

이 폴더는 자원 검증 실험을 실행하고 보고하는 운영자 도구다.
`experiment.ts`는 로컬과 Cloudflare에서 같은 검사 샤드를 동시 실행 수 1·2·4로 실행한다(코드의 실험 A). `workflow.ts`는 두 워커 workflow 한 건을 로컬 또는 원격에서 실행한다. `suite.ts`는 `workflow.ts`를 12번 순서대로 실행하고 실행 전에 비용 추정을 확인한다.
`usage.ts`는 Cloudflare 사용량을 조회하고 `report.ts`는 결과를 요약한다. 고정 과제는 [benchmark/resource-validation](../../benchmark/resource-validation/README.md)에 있다.

## Interface

- `experiment.ts` CLI - 인자는 `init|baseline|local|local-prefix|cloud|all DIRECTORY [FIXTURE|ORIGIN] [REPO|CONTROL_SECRETS]`다.
- `[experiment.ts:runExperiment]` - CLI 본문.
- `[experiment.ts:matrix]` - seed로 섞은 18개 조건(3블록 x 로컬·Cloudflare x 동시 실행 수 1·2·4)을 반환한다.
- `[experiment.ts:measure]` - 작업을 실행하는 동안 호스트 표본을 `{name}.host.jsonl`에 기록한다.
- `[experiment.ts:executeLocal]`, `[experiment.ts:cloudClient]`, `[experiment.ts:safeEnv]`, `[experiment.ts:atomicJson]`, `[experiment.ts:validFixtureReceipt]` - 다른 스크립트가 함께 쓰는 도우미.
- `workflow.ts` CLI - 인자는 `local|remote-sequential|remote-parallel|disconnect OUTPUT SETTINGS [ORIGIN CONTROL_SECRETS]`다. `CODEX_BIN`, `CLAUDE_BIN`을 읽는다.
- `[workflow.ts:runWorkflowExperiment]` - CLI 본문.
- `suite.ts` CLI - 인자는 `OUTPUT A_OUTPUT SETTINGS ORIGIN CONTROL_SECRET_FILE`이다. `CODEX_BIN`, `CLAUDE_BIN`, `EXTRA_ACCOUNTING_GROUPS`를 읽는다.
- `[suite.ts:runSuite]`, `[suite.ts:order]`, `[suite.ts:costEstimate]` - CLI 본문, 12개 목표의 순서, 실행 허용용 비용 추정.
- `usage.ts` CLI - 인자는 `A_OUTPUT SUITE_OUTPUT OUTPUT ORIGIN CONTROL_SECRET_FILE`이다.
- `[usage.ts:usageReport]`, `[usage.ts:retailUsage]` - CLI 본문과 사용량의 USD 환산.
- `usage.ts`는 추가 비용 집계 범위를 `EXTRA_ACCOUNTING_GROUPS`, `EXTRA_ACCOUNTING_JOBS`로 받는다. `[usage.ts:usageReport]`
- `report.ts` CLI - 인자는 `A_OUTPUT SUITE_OUTPUT REPORT_OUTPUT`이다. `[report.ts:report]`
- `observer.ts` CLI - 인자는 `WORKFLOW_ID ORIGIN CONTROL_SECRETS_FILE`이다.
- `[host-metrics.ts:createHostSampler]`, `[host-metrics.ts:summarizeHost]`, `[host-metrics.ts:HostSample]` - 호스트 CPU·메모리·네트워크 표본과 요약.

## Invariants

- 실행 폴더마다 `operator.lock`을 배타적으로 만든다. 잠금이 이미 있으면 실행하지 않는다. `[experiment.ts:ownRunDirectory]`
- `init`은 `manifest.json`이 이미 있으면 거부한다. 이후 실행은 manifest의 해시가 ledger의 `manifestSha256`과 같아야 한다. `[experiment.ts:runExperiment]`
- 로컬·원격 실행 전에 5분 idle baseline 기록이 있어야 한다. `[experiment.ts:runExperiment]`
- 전체 검사는 13파일·154요청을 기대한다. 실패한 조건이 있으면 중단한다. `[experiment.ts:validFixtureReceipt]`, `[experiment.ts:runExperiment]`
- 원격 origin은 HTTPS여야 한다. 비밀 파일은 그룹·기타 권한이 없어야 한다. `[experiment.ts:cloudClient]`
- 실패한 측정은 0이 아니라 `unavailable`로 기록한다. `[host-metrics.ts:summarizeHost]`, `[usage.ts:retailUsage]`
- `suite.ts`는 A 실험의 18개 조건이 모두 `SUCCEEDED`일 때만 진행한다. 저장된 `suite.json`과 설정이 다르면 거부한다. `[suite.ts:runSuite]`
- `suite.ts`는 원격 목표 전에 이전 원격 컨테이너의 종료를 확인하고, 예산(추정 10 USD)에서 지출·예비·다음 예약을 뺀 값이 음수면 거부한다. `[suite.ts:runSuite]`, `[suite.ts:costEstimate]`
- workflow 설정은 워커 2개, `roundLimit` 3이어야 한다. 로컬 목표는 `started.json`이 있으면 다시 실행하지 않는다. `[workflow.ts:runWorkflowExperiment]`
- 워커가 바꾼 파일은 자기 `writes` 목록 안에 있어야 한다. `[workflow.ts:runWorkflowExperiment]`

## Side Effects

- `experiment.ts`의 `cloud`·`all`은 `/v1/snapshots`, `/v1/compute-groups` 경로를 호출하고 승인한다. 승인하면 Cloudflare 컨테이너가 실행되어 비용이 발생한다. `[experiment.ts:runExperiment]`
- `workflow.ts`의 로컬 모드는 `codex` 또는 `claude` CLI를 실행한다. 사용자 구독으로 실제 모델을 호출한다. `[workflow.ts:runWorkflowExperiment]`
- `workflow.ts`의 원격 모드는 `/v1/workflows`를 만들고 승인한다. 승인하면 원격 모델 작업과 컨테이너가 실행된다. `[workflow.ts:runWorkflowExperiment]`
- `suite.ts`는 목표마다 `node workflow.ts`를 실행하고 `/v1/jobs`를 조회한다. `[suite.ts:runSuite]`
- `usage.ts`는 `wrangler auth token`으로 얻은 토큰을 메모리에만 두고 Cloudflare GraphQL Analytics API를 호출한다. 출력 파일에 토큰을 쓰지 않는다. `[usage.ts:usageReport]`
- `host-metrics.ts`는 `ps`, `git status`와 macOS의 `sysctl`, `vm_stat`, `memory_pressure`, `netstat`를 실행한다. `[host-metrics.ts:createHostSampler]`
- 각 스크립트는 지정한 출력 폴더에 ledger, 결과, 요약 파일을 쓴다. 운영자 토큰은 출력하지 않는다. `[experiment.ts:atomicJson]`, `[report.ts:report]`

## Verification

- Run: `npm test` (`cloudflare/backend/`에서 실행. `node --test test/*.test.ts`)
- `cloud`, `remote-*`, `disconnect`, `suite.ts`, `usage.ts`와 로컬 모델 실행은 테스트 명령에 포함하지 않는다. 비용 또는 모델 호출이 발생하므로 운영자가 명시적으로 실행한다.
