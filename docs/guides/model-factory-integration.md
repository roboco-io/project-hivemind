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

### Draft PR용 GitHub 자격: GitHub App 설치 토큰 (권장)

Control Plane은 검증을 통과한 변경을 브랜치로 푸시하고 Draft PR을 열 때 `hivemind-runtime/github-draft-pr` 비밀의 자격을 쓴다. 이 비밀에 GitHub App 정보(`githubApp`)가 있으면, Control Plane은 Draft PR을 만들 때마다 그 저장소 하나에만 쓸 수 있는 설치 토큰을 새로 발급받는다. 설치 토큰은 1시간 뒤 만료되고, 권한은 `contents: write`와 `pull_requests: write`뿐이다. 사람이 발급해 저장해 두는 PAT는 만료가 길고 classic PAT의 경우 계정이 접근하는 모든 저장소에 쓰기 권한이 열리므로, GitHub App을 쓰면 비밀이 유출됐을 때의 피해 범위가 줄어든다.

GitHub App 생성과 설치는 GitHub 웹 화면에서 사람이 한 번 해야 한다. GitHub는 이 단계를 API로 제공하지 않는다.

1. `roboco-io` 조직의 Settings → Developer settings → GitHub Apps에서 App을 만든다. Webhook은 끈다. Repository permissions는 Contents `Read and write`, Pull requests `Read and write` 두 개만 준다(Metadata `Read-only`는 자동으로 붙는다).
2. App 설정 화면에서 private key를 생성해 `.pem` 파일을 내려받는다. App ID를 적어 둔다.
3. App을 조직에 설치하고, "Only select repositories"에서 Draft PR을 만들 저장소만 고른다.
4. 아래 명령으로 등록한다. 스크립트는 저장소마다 설치 토큰을 실제로 발급해 설치 여부와 권한을 확인한 뒤 비밀을 쓴다. 확인용 토큰은 바로 폐기한다.

```bash
HIVEMIND_GITHUB_APP_ID=<App ID> \
HIVEMIND_GITHUB_APP_PRIVATE_KEY_FILE=<내려받은 .pem 경로> \
HIVEMIND_GITHUB_APP_REPOSITORIES=roboco-io/project-hivemind,roboco-io/silicon-model-factory \
AWS_PROFILE=roboco npx tsx scripts/aws-set-github-app-secret.ts
```

등록하면 목록에 든 저장소의 기존 PAT는 비밀에서 지워진다. PAT를 남겨 두면 넓은 권한의 자격이 그대로 남기 때문이다. 남기려면 `HIVEMIND_GITHUB_KEEP_PATS=1`을 준다. 목록에 없는 저장소의 PAT는 그대로 둔다. 등록 뒤에는 `.pem` 파일을 지우고, 기존 PAT는 GitHub에서도 폐기한다.

동작 규칙은 다음과 같다. `githubApp.repositories`에 든 저장소는 항상 설치 토큰을 쓴다. 이 저장소의 토큰 발급이 실패하면 Control Plane은 저장된 PAT로 넘어가지 않고 Draft PR 게시를 실패로 처리한다. 목록에 없는 저장소는 이전처럼 `tokensByRepo`의 PAT를 쓴다. Control Plane은 게시 때마다 로그 이벤트 `hivemind.delivery.github_credential_resolved`에 어떤 종류의 자격(`github_app` 또는 `personal_access_token`)을 썼는지 남긴다. 토큰 값은 남기지 않는다.

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

`HIVEMIND_MCP_PROFILE=model-factory`를 지정하면 SW 전달 도구 7개 + 모델 팩토리 도구 7개(총 14개)가 노출된다. 프로필을 지정하지 않으면 협업 도구와 상태 조회까지 포함한 25개가 노출된다.

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

### 리전별 기본 네트워크와 AMI (`HIVEMIND_MF_REGION_NETWORKS_JSON`)

작업이 `compute.candidateRegions`에 여러 리전을 적으면 Control Plane은 스팟 배치 점수 순서대로 리전을 시도한다. 서브넷, 보안 그룹과 AMI는 리전마다 다른 자원이므로, Control Plane은 리전마다 아래 순서로 값을 정한다.

1. 작업의 `compute.regionOverrides[<리전>]`에 적힌 값.
2. 대상 리전이 작업의 `compute.region`과 같으면 작업의 `amiId`, `subnetId`, `securityGroupIds`.
3. 운영자가 Control Plane 환경 변수 `HIVEMIND_MF_REGION_NETWORKS_JSON`에 등록한 리전별 기본값.
4. 위 값이 모두 없으면 작업의 최상위 `amiId`, `subnetId`, `securityGroupIds`(레지스트리 도입 전 동작).

레지스트리는 리전 이름을 키로 하는 JSON 객체다. 각 항목에는 `subnetIds`, `securityGroupIds`, `amiId`, `amiSsmParameter`만 쓸 수 있다. `amiSsmParameter`는 AWS가 소유한 공개 SSM 파라미터(`/aws/service/...`)의 이름이며, Control Plane은 인스턴스를 기동하기 직전에 해당 리전에서 이 파라미터를 읽어 최신 AMI ID를 얻는다. 계정 안의 파라미터 이름은 거절한다. 허용 리전 밖의 리전, 모르는 필드, 형식이 틀린 ID가 하나라도 있으면 Control Plane은 레지스트리 전체를 거절하고 기동하지 않는다.

```json
{
  "us-east-1": {
    "subnetIds": ["subnet-067ecf91041a44411"],
    "securityGroupIds": ["sg-02c88111a9073a681"],
    "amiSsmParameter": "/aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-amazon-linux-2023/latest/ami-id"
  }
}
```

SSM으로 얻은 AMI ID는 `approvalFingerprint`에 들어 있지 않다. 승인 시점에는 AMI ID가 정해지지 않기 때문이다. 실제로 사용한 AMI ID는 작업의 `instance.amiId`에 기록된다. AMI를 승인 시점에 고정해야 하는 작업은 `regionOverrides[<리전>].amiId`를 직접 적는다. AMI 조회가 실패한 리전에서는 인스턴스를 기동하지 않고 다음 후보 리전으로 넘어가며, 실패 사유는 작업의 `failureReason`에 남는다.

CDK 배포 시에는 셸 환경 변수 `HIVEMIND_MF_REGION_NETWORKS_JSON`에 같은 JSON을 넣으면 `HivemindAwsRuntimeStack`이 Control Plane 컨테이너에 그대로 전달한다.

### 원장 저장소와 TTL Guard 정산 (`HIVEMIND_MF_STORAGE`)

Model Factory의 작업과 비용 원장은 기본적으로 Control Plane의 SQLite 파일에 저장된다. Control Plane 환경 변수 `HIVEMIND_MF_STORAGE=aurora-dsql`을 설정하면 서울 Aurora DSQL 클러스터에 저장한다. `GET /api/model-factory/jobs` 응답의 `storageBackend` 필드(`sqlite` 또는 `aurora-dsql`)로 현재 저장소를 확인할 수 있다. 요청과 나머지 응답 형식은 저장소와 무관하게 같다.

DSQL로 바꾸는 이유는 TTL Guard Lambda 때문이다. Control Plane은 평소 `desiredCount 0`으로 꺼져 있고, 그동안 만료된 학습 인스턴스는 5분 주기의 TTL Guard Lambda가 강제 종료한다. 원장이 Control Plane의 SQLite 파일에 있으면 Lambda는 종료만 하고 비용을 정산하지 못한다. 원장이 DSQL에 있으면 Lambda가 종료 직후 같은 원장에 비용을 정산한다.

Lambda의 정산은 다음과 같이 동작한다. Lambda는 인스턴스를 먼저 종료하고 그다음 정산하므로, 원장에 접속하지 못해도 인스턴스는 종료된다. 정산 금액은 기동 시각부터 종료 시각까지의 초 단위 시간(최소 60초)에 작업의 `maxHourlyPriceUsd`를 곱한 값이며 예약 금액을 넘지 않는다. 이 값은 상한가 기준 추정치이고 실제 스팟 청구액이 아니다. Lambda는 S3 영수증 확인과 작업 실패 처리를 하지 않는다. Control Plane이 다음에 기동하면 wake가 이 단계를 이어서 처리하고, 이미 정산된 작업을 다시 정산하지 않는다.

DSQL 원장이 비어 있는 상태로 Control Plane이 처음 기동하면, SQLite 파일의 작업과 이벤트를 DSQL로 한 번 복사한다. DSQL에 작업이 하나라도 있으면 복사하지 않는다. 복사 후에는 SQLite 파일을 더 이상 갱신하지 않는다.

SW 전달 작업(`/api/delivery/*`)의 저장소도 같은 방식으로 바꾼다. Control Plane 환경 변수 `HIVEMIND_DELIVERY_STORAGE=aurora-dsql`을 설정하면 전달 작업과 이벤트를 DSQL에 저장하고, `GET /api/delivery/tasks` 응답의 `storageBackend`로 확인할 수 있다. 두 환경 변수는 서로 독립이다.

DSQL 접속 권한은 두 단계로 줄일 수 있다. 기본 상태에서는 Control Plane과 TTL Guard Lambda가 `admin` 역할로 접속한다. `scripts/aws-dsql-apply-roles.ts`를 운영자가 한 번 실행하면 테이블과 제한된 DB 역할 두 개(`hm_control_plane`, `hm_ttl_guard`)가 만들어지고, 그 뒤 `HIVEMIND_RESTRICTED_DSQL_ROLES=1 scripts/aws-deploy-hub.sh deploy`로 배포하면 두 서비스가 이 역할로만 접속한다. 제한된 역할은 행을 읽고 쓸 수만 있고 테이블이나 역할을 만들거나 지울 수 없다. 순서를 바꿔 배포부터 하면 서비스가 DSQL에 접속하지 못한다. 확인 결과는 [검증 기록](../verification/2026-11-27-dsql-restricted-roles.md)에 있다.

