# Silicon Model Factory / Token Factory 연동 가이드

이 문서는 외부 운영 프로젝트(`roboco-io/silicon-model-factory` 등)가 HIVEMIND AWS 단일 경로(`ap-northeast-2` Hub + `us-east-2` Spoke)에 연결해 **조사·문서 Draft PR(Part A)**과 **GPU 스팟 학습·평가·Hugging Face 공개(Part B)**를 실행하는 방법을 정리한다.

## 1. 배포된 AWS 구성 및 비밀 격리

| 리소스 | 위치 / 이름 | 접근 주체 |
| --- | --- | --- |
| Control Plane (ECS Fargate + EFS SQLite) | `ap-northeast-2` / `hivemind-runtime-control-plane` | 운영자 (AWS SSM 포트 포워딩 전용, 공개 인바운드 0) |
| 자율 멀티리전 TTL Guard Lambda (5분 주기) | `ap-northeast-2` / `hivemind-runtime-mf-ttl-guard` | EventBridge 5분 스케줄 (`hivemind:managed-by=hivemind-model-factory` 태그 조건 강제 종료) |
| Ohio Compute Spoke (VPC/ECS, 유휴 `$0/hr`) | `us-east-2` / `hivemind-runtime-us-east-2-cluster` | Spot Fargate 워커 및 동적 EC2 GPU 스팟 (`sg-0e3ac45935e27429c`, 인바운드 0) |
| GitHub 다중 저장소 토큰 | `hivemind-runtime/github-draft-pr` (`tokensByRepo`) | **Control Plane 전용** (워커·검증기 차단) |
| Hugging Face 공개 토큰 | `hivemind-runtime/hf-release-token` | **Control Plane 전용** (워커·검증기 차단) |
| 모델 구독 인증 | `hivemind-runtime/model-subscription-auth` | **AI 워커 전용** (Control Plane·검증기 차단) |

### 저장소별 토큰 갱신 명령

```bash
# 새 사설 저장소 PAT 병합 등록 (기존 저장소 토큰 보존)
printf '%s' "$GITHUB_PERSONAL_ACCESS_TOKEN" | \
  HIVEMIND_GITHUB_REPOSITORY=roboco-io/silicon-model-factory \
  npx tsx scripts/aws-set-github-secret.ts

# Hugging Face 공개 토큰 등록 (Control Plane 전용)
printf '%s' "$HUGGINGFACE_ORG_TOKEN" | \
  HIVEMIND_HF_REQUIRED_ORG=roboco-io \
  npx tsx scripts/aws-set-hf-secret.ts
```

## 2. Control Plane 기동·SSM 터널·유휴 중지

작업 시에만 서울 Control Plane을 켜고, 유휴 시 `desiredCount: 0`으로 되돌리면 상시 비용이 `$0/hr`로 유지된다(5분 TTL Guard Lambda는 별도로 상시 작동).

```bash
# 1) Control Plane 시작
aws --profile roboco --region ap-northeast-2 ecs update-service \
  --cluster hivemind-runtime-cluster --service hivemind-runtime-control-plane --desired-count 1

# 2) 로컬 SSM 포트 포워딩 터널 열기 (http://127.0.0.1:4310)
npx tsx scripts/aws-ssm-tunnel.ts

# 3) 작업 종료 후 유휴 중지 ($0/hr)
aws --profile roboco --region ap-northeast-2 ecs update-service \
  --cluster hivemind-runtime-cluster --service hivemind-runtime-control-plane --desired-count 0
```

## 3. MCP 클라이언트 연결 (Claude Code / Codex)

`HIVEMIND_MCP_PROFILE=model-factory`를 지정하면 SW 전달 도구 6개 + 모델 팩토리 도구 7개(총 13개)가 노출된다.

```json
{
  "command": "node",
  "args": ["dist/apps/mcp-server/src/main.js"],
  "env": {
    "HIVEMIND_API_URL": "http://127.0.0.1:4310",
    "HIVEMIND_MCP_PROFILE": "model-factory",
    "HIVEMIND_OPERATOR_TOKEN_FILE": "/path/to/operator-token.json"
  }
}
```

## 4. API 계약 요약

### Part A — 조사·문서 작업 (`POST /api/delivery/tasks`)

- `delivery.repository`: `"roboco-io/silicon-model-factory"`
- `executionPolicy`:
  - `allowedWebHosts`: `["arxiv.org", "github.com", "huggingface.co"]` 등 허용 호스트 목록
  - `allowSubagents`: `true` (승인 시 Claude `Agent` 도구 허용)
  - `maxIterationDurationMs`: 최대 `7200000` (2시간)
  - `preserveWorkspaceOnRetry`: `true` (스팟 중단 및 다음 Ralph 반복 시 `partialPatch` 자동 복원)
  - `verificationKind`: `"document_format"` (Draft PR에 사실 여부 미판정 경고 배너 자동 삽입)

### Part B — GPU 스팟 학습·평가·공개 (`/api/model-factory/*`)

1. `POST /api/model-factory/jobs`: 동적 `region`, `instanceType`, `amiId`, `maxLifetimeMs`, `maxHourlyPriceUsd`, `maxTotalCostMicros`, `s3ArtifactPrefix`, `releasePolicy` 등록 (`awaiting_training_approval`).
2. `POST /api/model-factory/jobs/:id/approve-training`: `approvalFingerprint` 검증 → 중앙 예산 예약(전역 상한 초과 시 409 거절) → EC2 Spot 기동 (`training_running`).
3. 학습 완료 시 인스턴스가 `${s3ArtifactPrefix}/receipt.json`을 S3에 업로드(각 파일 `path`, `sha256`, `sizeBytes` 및 `manifestDigest` 포함).
4. Control Plane 주기 wake 또는 `POST /api/model-factory/jobs/:id/wake`: EC2 종료 확인 + 실사용 초 비용 정산 + S3 영수증 SHA-256 검증 (`evaluating`).
5. `POST /api/model-factory/jobs/:id/verify-release`: `node tools/release-check.mjs` 통과 및 `manifestDigest` 일치 기록 (`awaiting_release_approval`).
6. `POST /api/model-factory/jobs/:id/approve-release`: 운영자 명시 승인 → Control Plane이 `hivemind-runtime/hf-release-token`으로 S3 검증 산출물을 Hugging Face에 직접 게시 (`released`).
7. `GET /api/model-factory/ledger`: SMF `tools/ledger.mjs` 대사용 중앙 예약·정산·잔여 예산 조회.
