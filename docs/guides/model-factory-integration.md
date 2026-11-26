# Silicon Model Factory / Token Factory 연동 가이드

이 문서는 외부 운영 프로젝트(`roboco-io/silicon-model-factory` 등)가 HIVEMIND AWS 단일 경로(`ap-northeast-2` Hub + `us-east-2` Spoke)에 연결해 **조사·문서 Draft PR(Part A)**과 **GPU 스팟 학습·평가·Hugging Face 공개(Part B)**를 실행하는 방법을 정리한다.

## 1. 배포된 AWS 구성 및 비밀 격리

| 리소스 | 위치 / 이름 | 접근 주체 |
| --- | --- | --- |
| Control Plane (ECS Fargate + EFS SQLite) | `ap-northeast-2` / `hivemind-runtime-control-plane` | 운영자 (AWS SSM 포트 포워딩 전용, 공개 인바운드 0) |
| 자율 멀티리전 TTL Guard Lambda (5분 주기) | `ap-northeast-2` / `hivemind-runtime-mf-ttl-guard` | EventBridge 5분 스케줄 (`hivemind:managed-by=hivemind-model-factory` 태그 조건 강제 종료) |
| Ohio Compute Spoke (VPC/ECS, 유휴 `$0/hr`) | `us-east-2` / `hivemind-runtime-us-east-2-cluster` | Spot Fargate 워커 및 동적 EC2 GPU 스팟 (`sg-0e3ac45935e27429c`, 인바운드 0) |
| GitHub 다중 저장소 토큰 | `hivemind-runtime/github-draft-pr` (`tokensByRepo`) | **Control Plane 전용** (워커·검증기·학습 인스턴스 차단) |
| Hugging Face 공개 토큰 | `hivemind-runtime/hf-release-token` | **Control Plane 전용** (워커·검증기·학습 인스턴스 차단) |
| 모델 구독 인증 | `hivemind-runtime/model-subscription-auth` | **AI 워커 전용** (Control Plane·검증기·학습 인스턴스 차단) |
| EC2 학습 인스턴스 프로파일 | `hivemind-runtime-mf-training-instance-profile` (`ec2.amazonaws.com`) | **학습 인스턴스 전용** (`models/*/inputs/*` 읽기, `models/*` 쓰기, `inputs/*` 쓰기 명시 Deny, 아티팩트 KMS 키만 허용; Secrets/EC2 제어 없음). Control Plane이 승인된 프로파일을 자동 주입하며 미허용 프로파일 ARN은 거절 |

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

1. **학습 코드·데이터 입력 S3 업로드 (`models/<modelId>/inputs/<bundleId>/`):**
   ```bash
   HIVEMIND_MODEL_ID=verilog-embed-v1 HIVEMIND_INPUT_DIR=./eval-bundle \
     npx tsx scripts/aws-mf-upload-inputs.ts
   ```
   출력된 `inputs` JSON(`{ s3Prefix, digest, files: [{ path, sha256, sizeBytes }] }`)을 작업 등록의 `compute.inputs`에 그대로 넣는다. `inputs.digest`는 `approvalFingerprint`에 고정되며, Control Plane은 EC2 기동 직전 S3 입력 존재·크기(5 MiB 이하는 SHA-256)를 사전 검증한다.
2. `POST /api/model-factory/jobs`: 동적 `region`, `instanceType`, `amiId`, `maxLifetimeMs`, `maxHourlyPriceUsd`, `maxTotalCostMicros`, `s3ArtifactPrefix`(`models/<modelId>/...`, `inputs/` 제외), `inputs`, `userDataScript`, `releasePolicy` 등록 (`awaiting_training_approval`). `instanceProfileArn`을 생략하면 Control Plane이 승인된 `hivemind-runtime-mf-training-instance-profile`을 자동 부착한다(미허용 ARN 지정 시 거절).
3. `POST /api/model-factory/jobs/:id/approve-training`: `approvalFingerprint` 검증 → 중앙 예산 예약(전역 상한 초과 시 409 거절) → 입력 사전 검증 → EC2 Spot 기동 (`training_running`). Control Plane은 EC2 태그(`hivemind:job-id`, `hivemind:artifact-bucket`, `hivemind:artifact-region`, `hivemind:artifact-prefix`, `hivemind:inputs-prefix`, `hivemind:inputs-digest`)와 `userDataScript` 선두 `export HIVEMIND_JOB_ID`, `HIVEMIND_ARTIFACTS_BUCKET`, `HIVEMIND_ARTIFACTS_REGION`, `HIVEMIND_ARTIFACT_PREFIX`, `HIVEMIND_INPUTS_PREFIX`, `HIVEMIND_INPUTS_DIGEST`, `HIVEMIND_INPUTS_MANIFEST_B64`를 자동 주입한다.
4. 학습/평가 인스턴스는 `aws s3 cp --region "$HIVEMIND_ARTIFACTS_REGION"`으로 입력을 내려받아 SHA-256을 검증하고, 결과물과 `${HIVEMIND_ARTIFACT_PREFIX}/receipt.json`을 직접 업로드한 뒤 `shutdown -h now`로 스스로 종료한다(`InstanceInitiatedShutdownBehavior=terminate`).
5. Control Plane 주기 wake 또는 `POST /api/model-factory/jobs/:id/wake`: EC2 종료 확인 + 실사용 초 비용 정산 + S3 `receipt.json` `manifestDigest` 및 각 파일 존재/크기(`HEAD`) 검증 (`evaluating`).
6. **배포 전 검사 보고 및 출처 명시:**
   - 운영자/에이전트가 `POST /api/model-factory/jobs/:id/verify-release`로 보고할 경우, HIVEMIND는 응답과 저장 상태에 항상 `attestationSource: "operator_self_reported"`와 명시적 고지(`verificationDisclaimer: "이 검사 결과는 운영자/호출자가 직접 보고한 값이며, HIVEMIND가 releaseCheckCommand를 독립 격리 환경에서 실행해 검증하지 않았습니다."`)를 강제 기록한다.
   - 독립 검증기 워커(`workerToken` 인증 전용)가 `POST /api/model-factory/jobs/:id/verifier-attestation`으로 보고한 경우에만 `attestationSource: "independent_verifier"`(`verificationDisclaimer: null`)로 기록된다.
7. `POST /api/model-factory/jobs/:id/approve-release`: 운영자 명시 승인 → Control Plane이 `hivemind-runtime/hf-release-token`으로 S3 검증 산출물을 Hugging Face에 직접 게시 (`released`).
8. **Hugging Face 저장소 공개 범위(`releasePolicy.visibility`) 동작 규칙 (fail-closed):**
   - HIVEMIND의 게시 단계(`assertHfVisibility` / `hfLfsCommit`)는 **비공개 저장소를 공개로 변경하지 않으며, 저장소를 자동 생성하지도 않는다.**
   - 게시 직전 HF API로 저장소의 실제 `private` 상태를 확인해 `releasePolicy.visibility`와 일치할 때만 커밋한다.
   - 따라서 비공개로 미리 만든 저장소에 게시할 때는 `releasePolicy.visibility: "private"`를 사용해야 하며(게시 후 필요 시 사람이 HF에서 공개 전환), 이미 공개된 저장소에만 `releasePolicy.visibility: "public"`을 허용한다. 불일치 시 즉시 거절(`Hugging Face visibility rejected`)된다.
9. `GET /api/model-factory/ledger`: SMF `tools/ledger.mjs` 대사용 중앙 예약·정산·잔여 예산 조회.
