# HIVEMIND 프로젝트 호스팅 및 부트스트랩 가이드

HIVEMIND는 여러 에이전트·SW 전달·Spot 컴퓨팅 프로젝트를 단일 AWS Hub 위에서 격리 호스팅하는 인프라 추상화 레이어입니다. 이 문서는 새 프로젝트를 등록하고, 전용 에이전트 토큰과 저장소 구성을 부트스트랩하는 절차를 설명합니다.

## 1. 프로젝트 매니페스트 (`hivemind.project.json`)

프로젝트의 권한·예산·저장소·리전 정책을 선언하는 파일입니다. 아래는 Model Factory 워크로드를 HIVEMIND 호스트 위의 프로젝트로 구성한 기준 예시입니다.

```json
{
  "schemaVersion": 1,
  "id": "silicon-model-factory",
  "name": "Silicon Model Factory",
  "description": "GPU Spot 학습, 독립 검증, Hugging Face 공개 및 자율 개선 루프",
  "template": "model-factory",
  "repositories": ["roboco-io/silicon-model-factory"],
  "autoMerge": true,
  "budgetUsd": 50,
  "maxJobUsd": 10,
  "regions": ["us-east-2", "us-east-1"],
  "s3ArtifactPrefixes": ["projects/silicon-model-factory/", "models/"],
  "hfAutoPublishPrefixes": ["roboco-io/"],
  "protectedPaths": ["ops/autonomy/policy.json", ".github/workflows/"],
  "branchPrefix": "agent/"
}
```

### 내장 템플릿 (`template`)

| 템플릿 | 기본 기능 권한 | 기본 S3 접두사 | 용도 |
|---|---|---|---|
| `generic` | `delivery`, `compute`, `collab`, `scoped_credentials`, `notifications` | `projects/<id>/` | 범용 프로젝트 |
| `model-factory` | 전체 (`hf_release`, `autonomy_triggers` 포함) | `projects/<id>/`, `models/` | GPU 모델 학습·검증·HF 공개·자율 루프 |
| `sw-delivery` | `delivery`, `autonomy_triggers`, `notifications` | `projects/<id>/` | SW 개발·PR 전달·자동 루프 |
| `research-collab` | `delivery`, `compute`, `collab`, `scoped_credentials`, `notifications` | `projects/<id>/` | 실험용 Spot 실행·병렬 리서치 협업 |

## 2. 프로젝트 부트스트랩 실행

먼저 `--dry-run`으로 변경 계획을 확인한 뒤 실제 적용합니다.

```bash
# 1) 계획 미리보기 (네트워크·디스크 쓰기 없음)
npm run project:bootstrap -- \
  --id my-project \
  --name "My Project" \
  --template generic \
  --repo owner/my-project \
  --budget-usd 20 \
  --max-job-usd 5 \
  --issue-token \
  --with-trigger \
  --target-dir ../my-project \
  --dry-run

# 2) 실제 등록·토큰 발급·저장소 스캐폴딩 (매니페스트 파일 사용 가능)
npm run project:bootstrap -- \
  --manifest ../my-project/hivemind.project.json \
  --issue-token \
  --with-trigger \
  --target-dir ../my-project
```

`Makefile` 단축 명령도 사용할 수 있습니다.

```bash
make project-bootstrap ARGS="--id my-project --name 'My Project' --repo owner/my-project --issue-token --dry-run"
```

### 수행 단계와 멱등성

1. **매니페스트 검증**: ID 형식, 템플릿, 예산·리전·접두사 규칙을 검증합니다.
2. **Control Plane 등록/갱신**: 프로젝트가 없으면 `POST /api/projects`, 이미 있으면 `PATCH /api/projects/:id`로 정책을 갱신합니다.
3. **프로젝트 전용 에이전트 토큰 (`--issue-token`)**: `hmproj_...` 토큰을 발급해 `~/.hivemind/projects/<id>.token.json`(`0600`)에 저장합니다. 비밀 값은 콘솔에 출력하지 않으며, 이미 파일이 있으면 유지합니다(재발급은 `--rotate-token`).
4. **주기 자율 트리거 (`--with-trigger`)**: `<id>-loop` 트리거를 **비활성(꺼짐) 상태**로 등록합니다.
5. **대상 저장소 스캐폴딩 (`--target-dir`)**: `hivemind.project.json`, `.mcp.json`, `.codex/config.toml`과(`--with-trigger` 지정 시) `ops/autonomy/{state.json,check.mjs,README.md}`를 생성합니다. 기존 파일은 `--force` 없이는 덮어쓰지 않습니다.

## 3. 프로젝트 격리 및 보안 규칙

- **MCP 프로필 `project-agent`**: 스캐폴딩된 `.mcp.json`과 `.codex/config.toml`은 `HIVEMIND_MCP_PROFILE=project-agent`와 프로젝트 전용 `HIVEMIND_AGENT_TOKEN_FILE`만 사용합니다.
- **교차 프로젝트 차단**: 프로젝트 토큰으로 다른 프로젝트의 컴퓨팅 작업·SW 전달 작업·협업 세션을 조회하면 `404`, 타 프로젝트 저장소·리전·S3 접두사·자격 증명을 요청하면 `403`으로 거절됩니다.
- **2단계 예산 보호**: 각 프로젝트는 자신의 예산 상한과 단일 작업 상한 안에서만 승인할 수 있으며, 전체 프로젝트 합계도 호스트 전역 예산 천장을 넘지 못합니다.
- **관제실 UI 제어**: 상단 프로젝트 필터(`#project-filter`)와 `프로젝트` 탭에서 프로젝트 생성, 승인 정책 모드(`minimal_human`/`balanced`/`manual_first`) 조회·변경, 예산 사용률 확인, 일시 정지(`paused`)/재개(`active`), 토큰 발급·폐기를 운영자 권한으로 즉시 수행할 수 있습니다.
- **승인 정책 및 건별 판단 근거**: 에이전트는 `POST /api/compute/jobs/:id/request-approval` 또는 `POST /api/delivery/tasks/:id/request-approval`(MCP: `hivemind_compute_request_approval`)으로 정책 평가를 요청합니다. 중앙 Control Plane은 프로젝트의 `approvalPolicy` 규칙(비용 상한, 최대 수명, 인스턴스 패밀리, 독립 검증기, 공개 범위, 에이전트 에스컬레이션)을 검증해 자동 승인 또는 수동 승인 요청을 결정하고, 모든 판단 근거를 `GET /api/approvals`·`GET /api/projects/:id/approvals`와 관제실 `승인 인박스 → 건별 승인 판단 근거 이력`에 기록합니다.

## 4. 사람이 웹에서 확인해야 하는 체크리스트

자동 부트스트랩 이후 아래 항목은 운영자가 직접 확인합니다.

1. **GitHub App 저장소 권한**: 대상 저장소가 GitHub App 설치 목록에 포함되어 있는지 확인합니다.
2. **Hugging Face 토큰 권한**(`hf_release` 사용 시): Secrets Manager의 HF 토큰이 대상 조직 쓰기 권한을 갖는지 확인합니다.
3. **자율 트리거 활성화**(`--with-trigger` 사용 시): 저장소에 `ops/autonomy/*` 파일을 커밋한 뒤 운영자 권한으로 `POST /api/autonomy/triggers/<id>-loop/enable`을 호출합니다.
