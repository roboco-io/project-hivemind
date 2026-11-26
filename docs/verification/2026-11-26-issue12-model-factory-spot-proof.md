# 2026-11-26 이슈 #12 검증 보고서 — Model Factory AWS 단일 경로 & Ohio 스팟 TTL Guard 실증

## 1. 자동 검증 결과 (로컬·단위·통합)

- **루트 검증 (`npm run check`):** **1,221 / 1,221 통과** (신규 Part A 5건 `tests/delivery-research-mode.test.ts` + 신규 Part B 6건 `tests/model-factory.test.ts` — MCP `model-factory` 프로파일 13개 도구 포함)
- **AWS CDK 검증 (`infrastructure/aws-runtime`):** **5 / 5 통과** (`HivemindAwsRuntimeStack` + `HivemindAwsSpokeUsEast2Stack` — `HfReleaseTokenSecret` 4자 격리, `ec2:TerminateInstances` 태그 조건, 5분 주기 멀티리전 `ModelFactoryTtlGuardFn` Lambda 검증)

## 2. 실 AWS 배포 및 Control Plane 종단 검증 (`ap-northeast-2` Hub + `us-east-2` Spoke)

신규 ARM64 이미지 3종(`hivemind-runtime-control-plane`, `hivemind-runtime-worker`, `hivemind-runtime-verifier`)을 서울 ECR에 푸시하고, `HivemindAwsRuntimeStack`을 CDK로 배포(`ControlPlaneTaskDef:7`, `HfReleaseTokenSecret`, `hivemind-runtime-mf-ttl-guard` Lambda + 5분 EventBridge 스케줄)한 뒤 실 AWS에서 2단계로 검증했다.

### 2-A. 단독 어댑터 검증 (`scripts/aws-ec2-spot-guard-proof.ts`)
- **실행 시각:** `2026-11-26T05:52:23Z` ~ `2026-11-26T05:53:46Z` (총 84초)
- **인스턴스:** `us-east-2a` / `t4g.nano` Spot / `i-0ec26a0f439d8208a` / 동적 AMI `ami-0e0dc3e6fb1778218`
- **결과:** `running` 진입 후 45초 TTL 만료 시 `sweepExpiredSpotInstances('us-east-2')` 강제 종료 → `finalState: "terminated"` 확인.

### 2-B. 실 배포 서울 ControlPlaneService(SSM 터널) + AWS Lambda TTL Guard + KMS S3 영수증 종단 검증 (`scripts/aws-issue12-live-verify.ts`)
- **Part A 정책 등록 검증:** 배포된 서울 `ControlPlaneService`에서 `roboco-io/silicon-model-factory` 대상 `executionPolicy`(`allowedWebHosts: ["arxiv.org","github.com","huggingface.co"]`, `allowSubagents: true`, `verificationKind: "document_format"`, `preserveWorkspaceOnRetry: true`) 및 `waitReason: "awaiting_operator_approval"` EFS SQLite 저장 확인(`dlv-5542b255-2d17-47f5-9981-ece3c6c1209b`).
- **Part B 스팟 용량 거절 안전 복구 검증:** `us-east-2a`의 `InsufficientInstanceCapacity` 발생 시(`mf-a10e431b-a0e1-4357-9b61-67fa3cf9106d`) 예약 금액(`50,000` micros)이 자동 0원 정산 환원되고 AWS 원문 진단 메시지가 운영자 API `diagnostics`에 그대로 기록됨을 실증(교훈 #1).
- **Part B 종단 완주 (`mf-86616c75-d81f-46f9-bcf5-7ba906ad9633`):**
  - **Control Plane 자체 IAM 기동:** 서울 `ControlPlaneService`가 EFS SQLite에서 `50,000` micros를 예약하고 `us-east-2c`에 `t4g.nano` Spot(`i-039e54adbc8cce1c7`, 동적 AMI `ami-0e0dc3e6fb1778218`, 인바운드 0 SG `sg-0e3ac45935e27429c`, TTL 60초)을 직접 기동.
  - **자율 AWS Lambda TTL Guard 강제 종료:** TTL 만료(`2026-11-26T06:25:31.923Z`) 후 배포된 `hivemind-runtime-mf-ttl-guard` Lambda 실행 → 5개 리전(`ap-northeast-2`, `us-east-2`, `us-east-1`, `us-west-2`, `ap-northeast-1`)을 스캔해 `us-east-2`의 `i-039e54adbc8cce1c7`를 태그 조건 IAM으로 강제 종료.
  - **Control Plane Wake + S3 SHA-256 영수증 + 비용 정산 + 공개 승인:** `/api/model-factory/jobs/:id/wake`가 서울 KMS S3의 `receipt.json`(`manifestDigest: 570033ccddc91eae794c3954088a45e1928c74a668775cc25303d4ebfc44ed3d`)을 검증하고 실제 69초 실행 비용 `192` micros(`$0.000192`)로 정산(잔여 중앙 예산 `499,999,808` micros 환원) → `/verify-release` (`awaiting_release_approval`) → `/approve-release` (`released`) 완주.
- **유휴 비용 복귀:** 검증 직후 서울 `ControlPlaneService`를 `desiredCount: 0`으로 되돌리고 `us-east-2` 잔존 실행 인스턴스 `0`대 확인 완료(상시 유휴 비용 `$0/hr`, 5분 주기 Lambda TTL Guard는 AWS 무료 티어 범위 `$0/월`로 상시 보호 유지).

### 2-C. `us-east-2` EC2 Spot 인스턴스 자체 S3 입력 다운로드 → 실행 → 영수증 업로드 → 자체 종료 → Control Plane 검증 (`scripts/aws-mf-instance-self-e2e.ts`)
이슈 #12 후속 요청(코멘트 `#7188565736`) 완료 기준을 운영자 대리 업로드 없이 실 AWS에서 검증했다.

- **배포 리소스:** `HivemindAwsRuntimeStack` (`ControlPlaneTaskDef:8`), `ModelFactoryTrainingInstanceRole` (`hivemind-runtime-mf-training-instance-role`), `ModelFactoryTrainingInstanceProfile` (`hivemind-runtime-mf-training-instance-profile`, Control Plane `iam:PassRole` 조건 `ec2.amazonaws.com` 한정).
- **실행 작업 / 인스턴스:** `mf-8360532b-9f6b-4977-9944-305d604d646a` / `us-east-2c` `t4g.nano` Spot `i-01ecc42438f759369` (동적 AMI `ami-0e0dc3e6fb1778218`).
- **검증된 종단 경로 (운영자 대리 업로드 0건):**
  1. 운영자는 고정 입력(`eval_canary.py`, `samples.json`)만 서울 KMS S3 `models/smf-instance-e2e/inputs/bundle-1795688191463/`에 업로드하고 SHA-256 매니페스트를 `approvalFingerprint`에 고정.
  2. 서울 `ControlPlaneService`가 입력 S3 사전 검증 후 승인된 인스턴스 프로파일과 `HIVEMIND_*` 부트스트랩 환경 변수·태그를 자동 주입해 `us-east-2`에 인스턴스 기동.
  3. `us-east-2` 인스턴스 자체가 서울 KMS S3에서 입력을 내려받아 SHA-256 검증 → `models/.../inputs/*` 쓰기 시도 시 IAM 명시 Deny 확인(`inputWriteDenied: true`) → `eval_canary.py` 실행(`avgScore: 0.81`) → 결과물(`eval-result.json`)과 `receipt.json`을 자신의 접두사(`models/smf-instance-e2e/runs/run-1795688191463/`)에 직접 업로드 → `shutdown -h now`로 자체 종료(`State: terminated`, `StateTransitionReason: User initiated`).
  4. 서울 `ControlPlaneService` `/wake`가 인스턴스가 직접 올린 `receipt.json`(`manifestDigest: 55c0b64d...6fa29c41`)과 S3 `HEAD` 크기를 검증하고 `evaluating`으로 전이 확인.
  5. 영수증 선도착·인스턴스 종료 지연 경합 시에도 후속 wake가 비용 정산을 완료하도록 `listDueWakeJobs`/`wakeJob`을 보강하고 단위 테스트(`npm run check` **1,222 / 1,222 통과**) 및 최신 `control-plane` ECR 이미지에 반영 완료.

## 3. 아직 실 AWS로 실행하지 않은 항목 (투명 고지)

1. **`roboco-io/silicon-model-factory` 실조사 Draft PR 실행:** 해당 사설 저장소용 Fine-Grained PAT를 `scripts/aws-set-github-secret.ts`로 Secrets Manager에 등록하고 서울 `ControlPlaneService`를 일시 기동(`desiredCount: 1`)한 뒤 실제 Stage 1 조사 작업을 등록·승인하면 바로 실행 가능하다.
2. **실제 GPU(`g5.xlarge` 등) 학습 및 실 Hugging Face 공개:** SMF 측 학습 스크립트, 대상 HF 저장소, Control Plane HF 쓰기 토큰 시크릿 등록 후 운영자 승인으로 실행한다(실제 유료 GPU·외부 HF 공개는 명시적 요청 시에만 수행).
