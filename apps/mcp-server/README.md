# mcp-server

## Overview

MCP 클라이언트용 stdio 서버 앱이다. 관제 서비스의 운영자 HTTP API를 MCP 도구로 감싼다. 소스는 `src/` 한 곳에 있다.

## Subdirectories & Boundaries

- src: [./src/README.md](./src/README.md) - `createHivemindMcpServer`, `loadMcpSettings`와 실행 진입점. 기존 작업·워크플로 10개와 장기 자율 작업 운영자 8개, 총 `hivemind_*` 도구 18개를 등록한다. generic 오류와 비밀 redaction을 유지한다.

## 장기 자율 작업 운영자 계약

| 도구 | 동작 |
|---|---|
| `hivemind_autonomous_list` | `limit`/`cursor`로 summary 목록 페이지 조회 |
| `hivemind_autonomous_get` | 현재 revision·모델·snapshot·도구·호스트·자격 증명 reference·외부 profile target/hash 검토 |
| `hivemind_autonomous_create` | 명시적 전체 범위로 초안만 등록. 자동 실행·승인 없음 |
| `hivemind_autonomous_approve` | 사용자 명시 지시의 `taskId`/`revision`/`reason`과 표시한 `externalProfileHashes` 결속 승인 |
| `hivemind_autonomous_cancel` | 명시적 중단 요청. 실제 종료·정리 완료와 구분 |
| `hivemind_autonomous_message` | 메시지 기록. 승인·재개·범위 확장 권한 없음 |
| `hivemind_autonomous_audit` | bounded 이력 네 종류와 외부 행동의 정확한 revision·resourceId·청구 근거 조회 |
| `hivemind_autonomous_record_external_cost` | 명시적 사용자 invoice 금액·근거·사유를 정확한 taskId/requestId/revision에 결속해 기록 |

Cloudflare proxy `/api/cloudflare/autonomous-tasks`만 사용한다. 미설정·503에서 local API로 우회하지 않는다. 일반 로컬 코드 작업과 Cloudflare 배포는 이 operator 기능의 범위가 아니다. 기능 구현 요청으로 실제 원격 작업을 시작하지 않는다.

등록에는 모델 ID, source `snapshotId`, 검사 `argv`, 도구·웹 호스트·system 범위, credential reference와 기간·예산·반복 한도를 명시한다. 값이나 대상을 추측하지 않는다. 외부 profile은 unique ID 최대 3개이며 AWS/HF/GH별 하나다. 실제 비밀 값·원격 URL·임의 실행 옵션은 받지 않는다.

외부 profile 승인은 get에서 표시한 모든 `id -> profileHash`를 `externalProfileHashes`로 전달해야 한다. metadata 누락·hash 변경·stale revision·409이면 새 범위를 자동 승인하지 않는다. 초안 등록과 polling은 승인하지 않는다. 기존 비외부 작업 승인은 `revision`/`reason`만 사용한다.

검토/승인/중단 preflight는 `GET /:id?view=summary`, audit은 `GET /:id/history?kind=...&limit=...&cursor=...`를 사용한다. `historyCursors`는 runs/actions/resources/interventions별 cursor, audit의 `cursor`는 external-actions 페이지용이다. 페이지 건수와 summary의 누적 `counts`를 구분한다. 기본 full GET으로 큰 전체 이력을 읽지 않는다.

`null` 비용은 미확정, `usageUnavailable`의 0은 미측정 placeholder다. `accepted`는 실행 수락이며 청구 확정이 아니다. 예약 상한·원장 확인 비용·실제 공급자 청구액을 구분한다. 로컬 SDK/DOM 통과를 실제 24시간 운영·AWS 배포·원격 비용 집행 근거로 설명하지 않는다. factory/backend/native wiring과 원격 실증은 별도 확인 대상이다.

사용 절차는 [프로젝트 HIVEMIND 스킬](../../.agents/skills/hivemind/SKILL.md), 구현·검증 경계는 [operator 설계](../../docs/plans/2026-11-20-autonomous-operator.md)를 참고한다. native 모델 sidecar의 `mcp__hivemind__action`은 이 18개 운영자 도구에 포함하지 않는다.


## 운영자 확인 최종 비용

`hivemind_autonomous_record_external_cost`는 운영자 전용 `POST /:taskId/external-actions/:requestId/billing`에 `{actualCostMicros,evidenceRef,reason,revision}`을 한 번 전달한다. 여섯 MCP 인자는 모두 필수이며 `revision`은 audit에서 확인한 행동의 revision이다. 현재 summary의 revision을 대신 넣지 않는다. 금액은 사용자가 지정한 양의 정수 micros, evidenceRef는 안전한 128자 이하 ID, reason은 1,000자 이하다. 비용·수수료를 추정하거나 token을 금액으로 바꾸지 않는다.

서버는 이미 확인된 실제 자원 부재와 알려진 결과를 요구하고 정확히 한 건의 인간 reconciliation을 기록해야 한다. live resource/unknown outcome을 건너뛰는 옵션은 없다. 응답의 `billingSource: operator_attested`는 OPERATOR_ATTESTED, 즉 인간 확인이며 provider API 실측이 아니다. `provider_verified`와 구분한다. `evidenceRef`, `attestedAt`, 행동 revision과 resourceId는 읽기 전용 audit에 표시하며 권한 token·credential·private receipt는 반환하지 않는다. Dashboard에는 비용 입력 폼을 추가하지 않는다.

기록 응답 유실은 부재의 증거가 아니다. 자동 재시도하지 않고 동일 immutable key의 audit을 먼저 확인한다. native 모델 sidecar와 `ExternalOperation` 목록에는 이 billing 도구를 추가하지 않는다. 실제 비용 기록을 요청받지 않은 구현·테스트 과정에서 이 도구를 실행하지 않는다.


외부 행동 audit의 `profileId`, `approvedTarget`, `approvedProfileHash`는 해당 행동의 영속 승인 근거다. `approvedTarget`은 “승인 당시 대상”으로 표시하며 AWS account/region/workload 또는 HF repository/revision, GitHub repository/branch만 제한된 텍스트로 투영한다. 현재 registry에서 같은 profile ID의 target이 바뀌어도 과거 행동의 대상·hash로 대체하지 않는다. 근거가 없으면 미보고로 두며 비용 출처·청구 확정과 별개다. Producer와 proxy가 이 필드를 전달해야 실제 조회에서 보인다.


최종 로컬 연결 검사에서는 실제 MCP operator billing → proxy → C1 API → SQL broker/core를 합성 invoice로 검증했다. worker·live resource 거절, 부재 확인 뒤 정확한 revision 기록, 동일 입력 재전송의 인간 reconciliation 1건과 provenance 전달을 확인했다. 격리 root focused 61개와 backend focused 33개가 통과했으며 전체 프로젝트 gate·실제 24시간·과금·배포의 근거는 아니다.


R9 행동별 공개 근거로 `parameterHash`, `parametersSubset`, `providerResult`를 제한적으로 전달한다. 현재 producer의 typed `parameters`도 같은 allowlist로 검사해 `parametersSubset`으로 정규화한다. subset은 lifetimeMs/startActionId/artifactDigest/expectedHead만, 결과는 aws_instance의 i-hex ID 또는 hf_commit/github_commit의 40/64자리 hex OID만 허용한다. 임의 message·raw provider evidence·auth·ownership은 전달하지 않는다. Dashboard는 JSON을 textContent로만 표시하며 새 도구·실행·비용 확정 동작은 없다.
