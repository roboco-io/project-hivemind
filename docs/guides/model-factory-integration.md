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

`HIVEMIND_MCP_PROFILE=model-factory`를 지정하면 SW 전달 도구 7개 + 모델 팩토리 도구 10개(총 17개)가 노출된다. 프로필을 지정하지 않으면 협업 도구, 상태 조회, Control Plane 기동·종료, 최소 권한 자격 증명 발급까지 포함한 31개가 노출된다.

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
   - **정산의 실행 시간.** 실행 시간은 기동 시각부터 인스턴스가 실제로 끝난 시각까지다. 끝난 시각은 EC2가 상태 전이 사유에 적어 주는 시각(예: `User initiated (2026-11-27 02:23:56 GMT)`)을 쓴다. EC2가 시각을 주지 않거나 그 시각이 기동 전이거나 점검 시각 뒤이면, 점검이 종료를 알아챈 시각까지로 센다. 2026-11-27 이전에는 항상 알아챈 시각까지 셌고, 점검 주기가 5분이어서 약 60초 실행이 328초로 정산된 일이 있었다. 금액은 여전히 `maxHourlyPriceUsd` 기준 추정이며 실제 스팟 청구액이 아니다.
   - **루트 볼륨 크기 (`compute.rootVolumeGb`).** 생략하면 AMI의 크기를 쓴다. AWS의 PyTorch 학습용 AMI는 30GB다. 8에서 2000 사이의 정수(GiB)를 주면 Control Plane이 AMI의 루트 장치 이름을 조회해 gp3 볼륨을 그 크기로 만들고, 인스턴스가 종료될 때 함께 지운다. 이 값은 승인 지문에 들어간다. AMI의 스냅샷보다 작은 값을 주면 EC2가 기동을 거절하고 작업은 실패로 기록된다. 볼륨 비용은 중앙 원장의 정산에 들어 있지 않다.
2. `POST /api/model-factory/jobs`: 동적 `region`, `instanceType`, `amiId`, `maxLifetimeMs`, `maxHourlyPriceUsd`, `maxTotalCostMicros`, `s3ArtifactPrefix`(`models/<modelId>/...`, `inputs/` 제외), `inputs`, `userDataScript`, `releasePolicy` 등록 (`awaiting_training_approval`). `instanceProfileArn`을 생략하면 Control Plane이 승인된 `hivemind-runtime-mf-training-instance-profile`을 자동 부착한다(미허용 ARN 지정 시 거절).
3. `POST /api/model-factory/jobs/:id/approve-training`: `approvalFingerprint` 검증 → 중앙 예산 예약(전역 상한 초과 시 409 거절) → 입력 사전 검증 → EC2 Spot 기동 (`training_running`). Control Plane은 EC2 태그(`hivemind:job-id`, `hivemind:artifact-bucket`, `hivemind:artifact-region`, `hivemind:artifact-prefix`, `hivemind:inputs-prefix`, `hivemind:inputs-digest`)와 `userDataScript` 선두 `export HIVEMIND_JOB_ID`, `HIVEMIND_ARTIFACTS_BUCKET`, `HIVEMIND_ARTIFACTS_REGION`, `HIVEMIND_ARTIFACT_PREFIX`, `HIVEMIND_INPUTS_PREFIX`, `HIVEMIND_INPUTS_DIGEST`, `HIVEMIND_INPUTS_MANIFEST_B64`를 자동 주입한다.
4. 학습/평가 인스턴스는 `aws s3 cp --region "$HIVEMIND_ARTIFACTS_REGION"`으로 입력을 내려받아 SHA-256을 검증하고, 결과물과 `${HIVEMIND_ARTIFACT_PREFIX}/receipt.json`을 직접 업로드한 뒤 `shutdown -h now`로 스스로 종료한다(`InstanceInitiatedShutdownBehavior=terminate`).
   - **영수증 형식과 `manifestDigest` 계산 규칙.** `receipt.json`은 `{ "version": 1, "jobId", "s3Bucket", "s3Prefix", "manifestDigest", "files": [{ "path", "sha256", "sizeBytes" }], "recordedAt" }`이다. `path`는 `s3Prefix` 아래의 상대 경로다. `manifestDigest`는 `{"version":1,"files":[...]}`를 공백 없이 직렬화한 JSON의 SHA-256이다. `files`는 `path`의 바이트 순서로 정렬하고, 각 항목의 키 순서는 `path`, `sha256`, `sizeBytes`다. 로케일 정렬을 쓰면 안 된다. 바이트 순서에서는 `model/README.md`가 `model/config.json`보다 앞이다. Python에서는 다음과 같다. 계산한 값이 다르면 Control Plane이 영수증을 거절한다.

     ```python
     files = sorted(files, key=lambda f: f['path'])   # 바이트(코드포인트) 순서. locale 정렬 금지
     body = json.dumps({'version': 1, 'files': [{'path': f['path'], 'sha256': f['sha256'], 'sizeBytes': f['sizeBytes']} for f in files]}, separators=(',', ':'), ensure_ascii=False)
     manifest_digest = hashlib.sha256(body.encode('utf-8')).hexdigest()
     ```

     2026-11-27 이전의 Control Plane은 `path`를 로케일 순서로 정렬했다. 파일이 여러 개이고 대소문자나 문장부호가 섞인 경로가 있으면 인스턴스가 계산한 값과 달라졌다. 경로는 ASCII로 쓰는 것을 권한다.
5. Control Plane 주기 wake(5분) 또는 `POST /api/model-factory/jobs/:id/wake`(MCP `hivemind_mf_wake`): EC2 종료 확인 + 실사용 초 비용 정산 + S3 `receipt.json` `manifestDigest` 및 각 파일 존재/크기(`HEAD`) 검증 (`evaluating`).
6. **배포 전 검사 보고 및 출처 명시:**
   - 운영자/에이전트가 `POST /api/model-factory/jobs/:id/verify-release`로 보고할 경우, HIVEMIND는 응답과 저장 상태에 항상 `attestationSource: "operator_self_reported"`와 명시적 고지(`verificationDisclaimer: "이 검사 결과는 운영자/호출자가 직접 보고한 값이며, HIVEMIND가 releaseCheckCommand를 독립 격리 환경에서 실행해 검증하지 않았습니다."`)를 강제 기록한다.
   - 독립 검증기 워커(`workerToken` 인증 전용)가 `POST /api/model-factory/jobs/:id/verifier-attestation`으로 보고한 경우에만 `attestationSource: "independent_verifier"`(`verificationDisclaimer: null`)로 기록된다.
   - 독립 검증기는 `POST /api/model-factory/jobs/:id/dispatch-verifier`(MCP `hivemind_mf_dispatch_verifier`)로 기동한다. 작업이 `evaluating`이고 S3 영수증이 확인된 경우에만 기동된다. 검증기는 모델·GitHub·Hugging Face 비밀이 없는 Fargate Spot 작업이며, 다음 순서로 동작한다. S3의 `receipt.json`이 이 작업의 것이고 그 `manifestDigest`가 Control Plane이 기록한 값과 같은지 확인한다. 산출물 파일을 모두 내려받아 SHA-256을 영수증과 비교한다. 고정 입력(`compute.inputs`)을 내려받아 SHA-256을 승인된 명세와 비교한다. 그다음 고정 입력 디렉터리에서 `releaseCheckCommand`를 실행하고, 산출물 디렉터리는 환경 변수 `HIVEMIND_ARTIFACT_DIR`로 전달한다. 명령의 종료 코드가 0이면 통과다. 표준 출력의 마지막 줄이 JSON 객체이면 그 값을 지표로 기록한다.
   - 따라서 검사 스크립트는 고정 입력에 넣어 두어야 한다. 검증기는 저장소 소스를 받지 않는다. 해시가 맞지 않으면 검증기는 증명을 보고하지 않고 실패로 끝나며, 작업은 `evaluating`에 남는다. 검증기가 내려받는 산출물은 합계 4GiB까지다.
   - 격리의 한계: 검사 명령은 셸 없이, 작업의 자격 증명 환경 변수 없이, 새 홈 디렉터리에서 실행된다. 샌드박스는 아니다. 명령은 검증기 컨테이너와 그 네트워크를 공유한다.
7. `POST /api/model-factory/jobs/:id/approve-release`: 운영자 명시 승인 → Control Plane이 `hivemind-runtime/hf-release-token`으로 S3 검증 산출물을 Hugging Face에 직접 게시 (`released`). 업로드는 수 분이 걸릴 수 있어 Control Plane이 백그라운드에서 최대 30분 동안 진행하고, 응답은 승인 직후의 `release_approved` 작업이다. 결과는 작업 조회(`hivemind_mf_get`)로 확인한다. 게시에 성공하면 `released`와 `publication`이 기록된다. 실패하면 작업은 `release_approved`에 남고, 실패 사유가 `diagnostics`와 `model_factory.release_publish_failed` 이벤트, Control Plane 로그에 남는다. 파일은 S3에서 스트림으로 읽어 올리며, 끝까지 읽은 뒤 크기와 SHA-256이 영수증과 다르면 커밋하지 않는다.
   - `POST /api/model-factory/jobs/:id/publish-release`(MCP `hivemind_mf_publish_release`): 승인됐지만 게시에 실패한 작업을 같은 승인으로 다시 게시한다. `release_approved`이고 `publication`이 없을 때만 허용하며, 같은 작업의 게시가 진행 중이면 409로 거절한다.
   - 2026-11-27 이전에는 `visibility: "private"` 게시가 항상 거절됐다. 게시기가 비공개 저장소에도 공개 대형 게시 확인 값(`allowPublicLarge: false`)을 넘겼고, LFS 검사는 이 값이 있으면 공개 저장소가 아닌 한 거절하기 때문이다. 지금은 공개 저장소에만 이 값을 넘긴다.
8. **Hugging Face 저장소 공개 범위(`releasePolicy.visibility`) 동작 규칙 (fail-closed):**
   - HIVEMIND의 게시 단계(`assertHfVisibility` / `hfLfsCommit`)는 **비공개 저장소를 공개로 변경하지 않으며, 저장소를 자동 생성하지도 않는다.**
   - 게시 직전 HF API로 저장소의 실제 `private` 상태를 확인해 `releasePolicy.visibility`와 일치할 때만 커밋한다.
   - 따라서 비공개로 미리 만든 저장소에 게시할 때는 `releasePolicy.visibility: "private"`를 사용해야 하며(게시 후 필요 시 사람이 HF에서 공개 전환), 이미 공개된 저장소에만 `releasePolicy.visibility: "public"`을 허용한다. 불일치 시 즉시 거절(`Hugging Face visibility rejected`)된다.
9. `GET /api/model-factory/ledger`: SMF `tools/ledger.mjs` 대사용 중앙 예약·정산·잔여 예산 조회.

### 리전별 기본 네트워크와 AMI (`HIVEMIND_MF_REGION_NETWORKS_JSON`)

작업이 `compute.candidateRegions`에 여러 리전을 적으면 Control Plane은 아래 "리전과 AZ 시도 순서"에서 정한 순서대로 리전을 시도한다. 서브넷, 보안 그룹과 AMI는 리전마다 다른 자원이므로, Control Plane은 리전마다 아래 순서로 값을 정한다.

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

### 리전과 AZ 시도 순서 (`placementPlan`)

Control Plane은 스팟 배치 점수 피드(`https://d16jdvzof4zpo7.cloudfront.net/data.json`)의 추세와 EC2 `GetSpotPlacementScores`로 얻은 현재 점수를 함께 써서 리전과 AZ의 시도 순서를 정한다. 스팟 배치 점수는 AWS가 1(낮음)부터 10(높음)까지 매기는 용량 확보 가능성이다. 피드는 리전별, AZ ID별 점수를 시간 순서로 담고 있다. 현재 점수는 작업의 인스턴스 유형 그대로, 리전 단위와 AZ 단위로 한 번씩 조회하며, 피드 표본 뒤에 가장 최근 표본으로 더한다. 두 출처 중 하나만 있어도 순서를 정하고, 현재 점수를 더한 시각은 `placementPlan.liveScoredAt`에 남는다.

Control Plane은 작업을 등록할 때 순서를 계산해 작업의 `placementPlan`에 저장하고, 등록 응답으로 돌려준다. 사람은 학습을 승인하기 전에 이 순서를 볼 수 있다. 학습을 승인해 인스턴스를 기동할 때 Control Plane은 최신 피드로 순서를 다시 계산하고, 그 결과를 `placementPlan`에 다시 저장한다. 기동 시점에 피드를 쓸 수 없으면 등록 때 계산한 순서를 쓴다.

순서는 최근 72시간의 점수로 정한다. 가장 낮은 점수가 높은 리전이 앞에 오고, 같으면 평균 점수, 최근 점수, 리전 스팟 가격 순서로 비교한다. 지금 점수가 높아도 최근에 점수가 떨어진 적이 있는 리전은 용량이 불안정하다고 보기 때문이다. AZ도 같은 기준으로 정렬한다. 점수가 없는 리전은 작업에 적힌 순서대로 뒤에 붙는다.

이 순서는 작업의 `compute.region`과 `compute.candidateRegions`에 적힌 리전만 다시 정렬한다. 리전을 더하거나 빼지 않으므로 `approvalFingerprint`에 넣지 않는다. 작업의 `compute.region`은 `candidateRegions`에 없어도 항상 후보에 들어간다.

리전 안에서 Control Plane은 서브넷의 AZ ID를 `ec2:DescribeSubnets`로 조회해, 계획한 AZ 순서대로 서브넷을 시도한다. AZ 이름(`us-east-2a`)은 계정마다 다른 물리 AZ를 가리키므로 AZ ID(`use2-az1`)로 비교한다. 서브넷 조회가 실패하면 서브넷은 적힌 순서대로 시도한다. 작업이 `compute.availabilityZoneId`를 적었으면 `compute.region`에서는 그 AZ를 먼저 시도한다.

피드는 인스턴스 유형을 풀(pool) 단위로 다룬다. Control Plane은 `compute.workloadClass`가 있으면 그 풀을 쓰고, 없으면 인스턴스 유형과 이름이 같은 풀이나 구성원에 그 유형이 들어 있는 풀을 쓴다. 2026-11-27 기준 피드는 `p5.48xlarge`, `g6e.12xlarge`, `g6e.24xlarge`, `g6e.48xlarge`와 범용 CPU 풀만 다룬다. 피드에 없는 유형은 추세 없이 현재 점수만으로 순서를 정하고, `note`에 피드가 그 유형을 다루지 않는다고 적는다. 현재 점수 조회도 실패하면 `placementPlan.status`가 `type_not_in_feed`, `feed_stale`(24시간보다 오래된 피드), `feed_unavailable`(피드 조회 실패) 중 하나가 되고 리전은 적힌 순서대로 시도한다. 현재 점수 조회에는 Control Plane 역할의 `ec2:GetSpotPlacementScores` 권한이 필요하며, 조회 요청은 작업의 `compute.region` 엔드포인트로 보낸다.

### 에이전트의 최소 권한 AWS 자격 증명 (`hivemind_agent_credentials`)

모델 팩토리 에이전트는 관리자 프로필 대신 이 도구로 받은 단기 자격 증명으로 AWS를 호출한다. 에이전트는 목적(purpose)과 대상만 보내고 정책 본문은 보내지 않는다. Control Plane은 목적마다 코드에 고정된 정책 틀에 대상을 채운다. 그다음 전용 부모 역할(`<prefix>-agent-credentials-parent-role`)을 맡아 리전 STS 엔드포인트에서 `GetScopedCredentials`를 호출한다. 받은 자격 증명의 권한은 부모 역할과 목적 정책의 교집합이다.

| 목적 | 허용 동작 | 범위 |
|---|---|---|
| `spot-placement-read` | `ec2:GetSpotPlacementScores`, `ec2:DescribeSpotPriceHistory`, `ec2:DescribeInstanceTypeOfferings` | `HIVEMIND_MF_ALLOWED_REGIONS`의 리전 |
| `model-inputs-upload` | `s3:PutObject`, `s3:GetObject`, `s3:ListBucket`, KMS `GenerateDataKey`·`Decrypt` | `models/<modelId>/inputs/` |
| `model-artifacts-read` | `s3:GetObject`, `s3:ListBucket`, KMS `Decrypt` | `models/<modelId>/runs/` |

사용 방법은 다음과 같다. 에이전트가 `hivemind_agent_credentials`를 `{"purpose":"model-inputs-upload","modelId":"verilog-embed-base"}`처럼 호출한다. MCP 서버는 자격 증명을 `~/.hivemind/agent-credentials/<profile>.ini`(권한 600)에 쓰고, 도구 결과에는 파일 경로, 프로필 이름, 만료 시각만 넣는다. 에이전트는 `AWS_SHARED_CREDENTIALS_FILE=<파일> AWS_PROFILE=<프로필> aws s3 cp ...`처럼 실행한다. 수명은 60-900초이고 기본값은 900초다. 만료되면 다시 호출한다. 발급된 자격 증명은 일반 임시 자격 증명이므로 에이전트 쪽 AWS CLI 버전에는 제약이 없다. `GetScopedCredentials`는 Control Plane이 직접 서명해 호출하므로 Control Plane 이미지에도 AWS CLI가 필요하지 않다.

목적 목록에 없는 요청, 형식이 틀린 `modelId`, 범위를 넘는 수명은 400으로 거절한다. Control Plane 설정(`HIVEMIND_AGENT_CREDENTIAL_PURPOSES`)에서 꺼진 목적은 403으로 거절한다. STS 호출이 실패하면 502를 돌려주고, 부모 세션의 자격 증명은 어떤 경우에도 돌려주지 않는다. 목적 목록과 정책 틀은 CDK와 코드로만 바꿀 수 있고, 이를 바꾸는 API는 없다. 부모 역할의 `sts:GetScopedCredentials`에는 `sts:DurationSeconds` 900초 이하 조건이 걸려 있다.

감사 기록은 Control Plane 로그(CloudWatch)에 `hivemind.agent_credentials.issued`, `denied`, `failed` 이벤트로 남는다. 기록에는 목적, 대상, 정책 해시, 만료 시각, `ScopedSessionDescription`만 들어가고 자격 증명과 정책 본문은 들어가지 않는다. CloudTrail에도 `GetScopedCredentials` 이벤트가 `requestParameters.scopedSessionDescription`(`hivemind-agent <목적> <modelId>`)과 함께 남는다.

### 에이전트 전용 토큰 (`agent-token`, MCP 프로필 `agent`)

모델 팩토리 에이전트는 운영자 토큰 대신 에이전트 전용 토큰으로 Control Plane을 호출한다. 토큰은 Secrets Manager의 `<prefix>/agent-token`에 자동 생성되고, Control Plane만 읽는다. `npm run bootstrap`의 로컬 설정 단계가 이 값을 `~/.hivemind/aws-agent-token.json`(권한 600)에 쓴다.

| 에이전트 토큰으로 할 수 있는 일 | 운영자 토큰만 할 수 있는 일 |
|---|---|
| Model Factory 작업 목록·조회·원장 조회 | 공개 승인·반려(`approve-release`), 다시 게시(`publish-release`) |
| 학습 초안 등록, 학습 승인(`approve-training`) | 운영자 자체 검증 기록(`verify-release`), 영수증 직접 기록(`receipt`) |
| 점검(`wake`), 독립 검증기 기동, 작업 취소 | 만료 인스턴스 일괄 정리(`sweep-expired`) |
| 최소 권한 AWS 자격 증명 발급 | SW 전달, 협업 세션, 그 밖의 모든 운영자 API |

학습 승인을 에이전트에 허용한 것은 사람의 결정(2026-11-27)이다. 과금은 중앙 예산 상한과 작업별 비용 상한이 막는다. Hugging Face 공개는 사람만 승인한다.

에이전트의 MCP 설정은 다음과 같다. `dist/`는 HIVEMIND 저장소에서 `npm run build`로 만든다. `HIVEMIND_AGENT_TOKEN_FILE`을 주면 프로필은 반드시 `agent`여야 하고, 운영자 토큰 설정을 함께 주면 MCP 서버가 시작을 거부한다. `agent` 프로필의 도구는 상태 조회, Model Factory 도구 8개(공개 승인·다시 게시 제외), 최소 권한 자격 증명 발급으로 모두 10개다. Control Plane 기동·종료 도구는 없다.

```json
{
  "mcpServers": {
    "hivemind": {
      "command": "node",
      "args": ["<HIVEMIND 저장소>/dist/apps/mcp-server/src/main.js"],
      "env": {
        "HIVEMIND_MCP_PROFILE": "agent",
        "HIVEMIND_AGENT_TOKEN_FILE": "<홈>/.hivemind/aws-agent-token.json",
        "HIVEMIND_API_URL": "http://127.0.0.1:4311"
      }
    }
  }
}
```

**한계.** 토큰을 나눠도 같은 컴퓨터의 같은 OS 사용자로 에이전트를 실행하면, 에이전트는 운영자 토큰 파일(`~/.hivemind/aws-operator-token.json`)이나 관리자 AWS 프로필을 직접 읽을 수 있다. 이 경계가 실제로 효과를 내려면 에이전트가 운영자 토큰 파일과 관리자 AWS 자격 증명을 읽을 수 없어야 한다. 예를 들어 에이전트를 별도 OS 사용자나 컨테이너로 실행하고, 그 환경에는 에이전트 토큰 파일만 둔다. 이 분리는 실행 환경의 설정이며 HIVEMIND 코드가 강제하지 않는다.

### 학습 인스턴스의 쓰기 범위 (`staging/`)

학습 인스턴스 역할은 `staging/${aws:userid}/*`에만 쓸 수 있다. EC2 인스턴스 역할 세션의 `aws:userid`는 `<역할 ID>:<인스턴스 ID>`이므로, 인스턴스마다 자기 폴더에만 쓸 수 있다. `models/*`에 대한 쓰기와 삭제는 명시적으로 거부한다. 그래서 한 작업의 학습 코드나 부트스트랩이 다른 작업의 산출물이나 `inputs/`를 덮어쓸 수 없다.

Control Plane은 부트스트랩에서 IMDSv2로 인스턴스 ID를 읽어 `HIVEMIND_ARTIFACT_PREFIX`를 `staging/<역할 ID>:<인스턴스 ID>`로 정한다. 작업 접두사는 `HIVEMIND_JOB_ARTIFACT_PREFIX`로 따로 넘긴다. 학습 스크립트는 지금처럼 `HIVEMIND_ARTIFACT_PREFIX`에 산출물과 `receipt.json`을 올리면 된다. 영수증의 `s3Prefix`도 이 값이어야 한다. Control Plane은 점검(wake) 때 자기가 띄운 인스턴스 ID로 스테이징 폴더를 계산해 영수증을 읽는다. 영수증의 작업 ID와 접두사가 맞으면 파일을 작업 접두사로 서버 측 복사하고, 접두사를 작업 접두사로 바꾼 영수증을 기록한다. 스테이징 폴더는 14일 뒤 수명 주기 규칙으로 지워진다. 한 파일의 서버 측 복사는 5 GiB까지만 된다.

이 방식은 학습 코드와 부트스트랩을 모두 막는다. 이슈 #19에서 제안한 학습 프로세스용 `GetScopedCredentials`는 쓰지 않았다. 학습 프로세스를 root가 아닌 사용자로 바꾸고 자격 증명 갱신 장치를 두어야 해서 SMF 스크립트를 바꿔야 하기 때문이다. 스테이징 도입 전에 기동한 작업은 작업 접두사에 직접 올린 영수증도 그대로 인정한다.

### 원장 저장소와 TTL Guard 정산 (`HIVEMIND_MF_STORAGE`)

Model Factory의 작업과 비용 원장은 기본적으로 Control Plane의 SQLite 파일에 저장된다. Control Plane 환경 변수 `HIVEMIND_MF_STORAGE=aurora-dsql`을 설정하면 서울 Aurora DSQL 클러스터에 저장한다. `GET /api/model-factory/jobs` 응답의 `storageBackend` 필드(`sqlite` 또는 `aurora-dsql`)로 현재 저장소를 확인할 수 있다. 요청과 나머지 응답 형식은 저장소와 무관하게 같다.

DSQL로 바꾸는 이유는 TTL Guard Lambda 때문이다. Control Plane은 평소 `desiredCount 0`으로 꺼져 있고, 그동안 만료된 학습 인스턴스는 5분 주기의 TTL Guard Lambda가 강제 종료한다. 원장이 Control Plane의 SQLite 파일에 있으면 Lambda는 종료만 하고 비용을 정산하지 못한다. 원장이 DSQL에 있으면 Lambda가 종료 직후 같은 원장에 비용을 정산한다.

Lambda의 정산은 다음과 같이 동작한다. Lambda는 인스턴스를 먼저 종료하고 그다음 정산하므로, 원장에 접속하지 못해도 인스턴스는 종료된다. 정산 금액은 기동 시각부터 종료 시각까지의 초 단위 시간(최소 60초)에 작업의 `maxHourlyPriceUsd`를 곱한 값이며 예약 금액을 넘지 않는다. 이 값은 상한가 기준 추정치이고 실제 스팟 청구액이 아니다. Lambda는 S3 영수증 확인과 작업 실패 처리를 하지 않는다. Control Plane이 다음에 기동하면 wake가 이 단계를 이어서 처리하고, 이미 정산된 작업을 다시 정산하지 않는다.

DSQL 원장이 비어 있는 상태로 Control Plane이 처음 기동하면, SQLite 파일의 작업과 이벤트를 DSQL로 한 번 복사한다. DSQL에 작업이 하나라도 있으면 복사하지 않는다. 복사 후에는 SQLite 파일을 더 이상 갱신하지 않는다.

SW 전달 작업(`/api/delivery/*`)의 저장소도 같은 방식으로 바꾼다. Control Plane 환경 변수 `HIVEMIND_DELIVERY_STORAGE=aurora-dsql`을 설정하면 전달 작업과 이벤트를 DSQL에 저장하고, `GET /api/delivery/tasks` 응답의 `storageBackend`로 확인할 수 있다. 두 환경 변수는 서로 독립이다.

DSQL 접속 권한은 두 단계로 줄일 수 있다. 기본 상태에서는 Control Plane과 TTL Guard Lambda가 `admin` 역할로 접속한다. `scripts/aws-dsql-apply-roles.ts`를 운영자가 한 번 실행하면 테이블과 제한된 DB 역할 두 개(`hm_control_plane`, `hm_ttl_guard`)가 만들어지고, 그 뒤 `HIVEMIND_RESTRICTED_DSQL_ROLES=1 scripts/aws-deploy-hub.sh deploy`로 배포하면 두 서비스가 이 역할로만 접속한다. 제한된 역할은 행을 읽고 쓸 수만 있고 테이블이나 역할을 만들거나 지울 수 없다. 순서를 바꿔 배포부터 하면 서비스가 DSQL에 접속하지 못한다. 확인 결과는 [검증 기록](../verification/2026-11-27-dsql-restricted-roles.md)에 있다.

