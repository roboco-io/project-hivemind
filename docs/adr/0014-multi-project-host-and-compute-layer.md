# ADR-0014: 멀티 프로젝트 인프라 호스트와 범용 컴퓨팅 레이어

- **상태**: 채택 (구현 완료)
- **날짜**: 2026-11-28
- **관련 문서**: [프로젝트 호스팅 가이드](../guides/project-hosting.md), [ADR-0012 Cloudflare 아카이브](./0012-cloudflare-archive-retention.md)

## 배경

기존 HIVEMIND AWS 단일 경로는 `Model Factory` 도메인 이름(`/api/model-factory/*`, `ModelFactoryStore`, `modelId`, `models/*`)이 Control Plane, MCP, HUD 관제실 곳곳에 결합되어 있었다. HIVEMIND 본래의 역할은 특정 프로젝트 하나에 종속된 런타임이 아니라, **여러 에이전트·자율 루프·Spot 컴퓨팅 프로젝트를 안전하게 호스팅하는 인프라 추상화 레이어**다.

Model Factory(예: `silicon-model-factory`) 역시 HIVEMIND 위에서 실행되는 프로젝트 중 하나로 모델링해야 새 프로젝트를 추가할 때마다 AWS 스택을 중복 배포하지 않고($0 추가 유휴 비용) 일관된 승인·예산·격리 정책을 적용할 수 있다.

## 결정

### 1. 단일 공유 AWS Hub + 논리·IAM 범위 격리

새 프로젝트를 추가할 때 별도 ECS/DSQL/S3 스택을 복제하지 않는다. 단일 AWS Hub(Control Plane + Aurora DSQL + KMS 암호화 S3 + 멀티 리전 Spot Spoke) 위에서 중앙 `ProjectStore`가 프로젝트별 경계를 강제한다.

- **프로젝트 매니페스트(`ProjectRecord`)**: ID(`^[a-z0-9][a-z0-9-]{1,48}$`), 템플릿(`generic`, `model-factory`, `sw-delivery`, `research-collab`), 상태(`active` | `paused` | `archived`), 기능 권한(`delivery`, `compute`, `collab`, `autonomy_triggers`, `hf_release`, `scoped_credentials`, `notifications`), 2단계 예산 정책, 허용 저장소·리전·S3 접두사·자격 증명 목적.
- **프로젝트 전용 에이전트 토큰(`hmproj_...`)**: 발급 시 원문 1회 반환(`Cache-Control: no-store`), 저장소에는 SHA-256 해시만 보관하고 `timingSafeEqual`로 검증한다.
- **교차 프로젝트 격리**: 프로젝트 토큰은 자기 `projectId`의 작업·세션·트리거만 조회·생성할 수 있다. 타 프로젝트 ID를 지정하면 `403`, 타 프로젝트 자원 조회는 존재 여부 추측을 막기 위해 `404`를 반환한다. 프로젝트 상태를 `paused`로 바꾸면 토큰 인증과 신규 실행이 즉시 차단된다.
- **범위 제한 AWS 자격 증명(`POST /api/agent-credentials`)**: 프로젝트용 목적 `project-inputs-upload`, `project-artifacts-read`를 추가하고, 호스트 카탈로그와 프로젝트 정책의 교집합(S3 접두사 `projects/<projectId>/...`, 허용 리전, 허용 목적)만 발급한다.

### 2. 2단계 예산 원장(Two-Tier Hard Budget Ledger)

중앙 `ComputeStore`가 트랜잭션 안에서 두 한도를 동시에 강제한다.

1. **프로젝트별 한도**: `budget.computeBudgetCapMicros`(프로젝트 누적 예약+정산 상한)와 `budget.maxSingleJobCostMicros`(단일 작업 상한). 한 프로젝트가 예산을 소진해도 다른 프로젝트의 할당량은 영향받지 않는다.
2. **호스트 전역 천장**: 모든 프로젝트의 예약+정산 합계는 Control Plane 전역 상한(`globalBudgetCapMicros`)을 넘을 수 없다.

### 3. Model Factory → 범용 컴퓨팅(Universal Compute) 전면 리팩터링

도메인 중립적인 이름과 계약으로 전면 개편하되, 기존 운영 중인 AWS 리소스와 무중단 호환성을 유지한다.

| 이전 (`Model Factory`) | 현재 (`Universal Compute`) | 호환성 메모 |
|---|---|---|
| `/api/model-factory/*` | `/api/compute/*` | 모든 앱·스크립트·MCP·HUD 전면 전환 |
| `ModelFactoryStore` / `ModelFactoryOrchestrator` | `ComputeStore` / `ComputeOrchestrator` | 중앙 정책 경계 유지 |
| `modelId` | `workloadId` + `workloadKind` + `projectId` | 저장된 레거시 문서는 `normalizeComputeJob()`으로 자동 정규화 |
| `awaiting_training_approval`, `training_queued`, `training_running` | `awaiting_launch_approval`, `queued`, `running` | 읽기 시 기존 상태 문자열 자동 변환 |
| `hivemind_mf_*` | `hivemind_compute_*` (+ `hivemind_project_*`) | MCP `default`/`compute`/`project-agent` 프로필 |
| Aurora DSQL `hm_mf_*` 테이블 | 물리 테이블명 `hm_mf_*` 유지 + `hm_projects_*` 3개 추가 | 무중단 업그레이드; 제한 역할 `hm_control_plane`에 3개 테이블 권한 추가, `hm_ttl_guard`는 `hm_projects_*` 접근 금지 |
| EC2 태그 `hivemind:managed-by=hivemind-model-factory` | 기존 태그 유지 + `hivemind:project-id`, `hivemind:workload-id` 추가 | 기존 IAM 조건 및 TTL Guard Lambda 무중단 동작 |

### 4. 프로젝트 부트스트랩 CLI (`npm run project:bootstrap`)

신규 프로젝트 온보딩을 단일 멱등 명령으로 표준화한다(`scripts/project-bootstrap.ts`, `scripts/lib/project-bootstrap.ts`).

- Control Plane 프로젝트 등록(`POST`) 및 재실행 시 갱신(`PATCH`)
- `0600` 권한 프로젝트 전용 에이전트 토큰 파일 발급(출력·보고서에 비밀 미노출)
- 선택적 주기 자율 트리거 등록(안전상 항상 비활성 상태로 생성)
- 선택적 대상 저장소 스캐폴딩(`hivemind.project.json`, `.mcp.json`, `.codex/config.toml`, `ops/autonomy/*`)
- 사람이 웹에서 확인해야 하는 항목(GitHub App 저장소 권한, HF 토큰 조직 권한, 트리거 수동 활성화) 체크리스트 출력

## 결과

- **장점**: 추가 프로젝트당 AWS 유휴 비용 `$0`, 프로젝트별 독립 예산·토큰·S3·리전·저장소 격리, 단일 관제실 HUD(`#project-filter` + `프로젝트` 탭)에서 전체 호스트 운영 가능.
- **운영 주의**: 기존 AWS Aurora DSQL에 업그레이드 배포할 때는 새 `hm_projects_jobs`, `hm_projects_events`, `hm_projects_meta` 테이블과 `hm_control_plane` 권한을 적용(`scripts/aws-dsql-apply-roles.ts`)한 뒤 Control Plane 이미지를 재배포해야 한다.
