# Phase 0 정리 기록 — Cloudflare 사용안 폐기 및 원격 리소스 삭제

상태: **폐기 및 정리 완료 (2026-11-25)**.
상위 계획: [방향 재정렬 및 AWS 단일 실행 마스터 플랜](2026-11-25-realignment-aws-plan.md).

## 결정

사용자 지시(“클라우드플레어 사용안은 폐기하겠어. 리소스 정리하고 AWS 단일로 진행하자”)에 따라 Cloudflare 기반 `#7`/SMF 운영 검증을 중단하고, HIVEMIND 소유의 Cloudflare 원격 리소스를 즉시 정리한 뒤 AWS 단일 실행 경로(`infrastructure/aws-runtime`)로 직행한다.

## 정리된 Cloudflare 리소스 (`Dohyun@roboco.io's Account` / `f7f7c7474ced58ec160ab9a775bf2bfe`)

| 유형 | 삭제 대상 | 결과 |
|---|---|---|
| Workers | `hivemind-cloudflare-backend`, `hivemind-oidc-issuer`, `hivemind-boundary-check`, `hivemind-phase0` (4개) | 삭제 완료 |
| Containers | `hivemind-cloudflare-runtime`, `hivemind-boundary-check-runtime`, `hivemind-phase0-probe-v1` (3개, 모두 live 0) | 삭제 완료 |
| R2 Buckets | `hivemind-cloudflare-credentials` (객체 57건), `hivemind-cloudflare-artifacts` (객체 302건) | 비우기 및 버킷 삭제 완료 |
| Container Registry Images | `hivemind-boundary-check-phase0container-probe`, `hivemind-cloudflare-backend-runnerdo-runtime`, `hivemind-phase0-phase0container-probe` (총 95태그) | 삭제 완료(최종 검증 참조) |

*비 HIVEMIND 리소스(`software-factory-control`, `sfd-api*`, `software-factory-control-agentsandbox*`)는 일절 건드리지 않았다.*
