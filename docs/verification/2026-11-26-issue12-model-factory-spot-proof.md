# 2026-11-26 이슈 #12 검증 보고서 — Model Factory AWS 단일 경로 & Ohio 스팟 TTL Guard 실증

## 1. 자동 검증 결과 (로컬·단위·통합)

- **루트 검증 (`npm run check`):** **1,220 / 1,220 통과** (신규 Part A 5건 `tests/delivery-research-mode.test.ts` + 신규 Part B 5건 `tests/model-factory.test.ts` 포함)
- **AWS CDK 검증 (`infrastructure/aws-runtime`):** **5 / 5 통과** (`HivemindAwsRuntimeStack` + `HivemindAwsSpokeUsEast2Stack`)

## 2. 실 AWS 검증 — `us-east-2` 동적 스팟 기동 + TTL Guard 강제 종료

이슈 #12 완료 기준 B("최소 스팟 인스턴스 기동과 Guard 강제 종료 확인")를 실제 AWS 계정(`<AWS_ACCOUNT_ID>`, `us-east-2` Ohio Spoke VPC)에서 `scripts/aws-ec2-spot-guard-proof.ts`로 검증했다.

- **실행 시각:** `2026-11-26T05:52:23Z` ~ `2026-11-26T05:53:46Z` (총 84초)
- **리전 / AZ:** `us-east-2` / `us-east-2a` (`subnet-0bedc9f4179d6205f`, 인바운드 0 보안 그룹 `sg-0e3ac45935e27429c`)
- **동적 AMI (스택 재배포 없음):** `ami-0e0dc3e6fb1778218` (SSM `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64` 런타임 조회)
- **인스턴스 타입 / ID:** `t4g.nano` Spot / `i-0ec26a0f439d8208a`
- **수명 태그 (`hivemind:expires-at`):** `2026-11-26T05:53:08.040Z` (기동 후 45초)
- **실행 확인:** `2026-11-26T05:52:41.263Z`에 `running` 상태 진입 확인
- **TTL Guard 강제 종료:** 만료 직후 `AwsEc2SpotTrainer.sweepExpiredSpotInstances('us-east-2')`가 `hivemind:managed-by=hivemind-model-factory` 및 `hivemind:expires-at` 태그를 탐지해 `i-0ec26a0f439d8208a` 강제 종료(`sweptMatchedInstance: true`)
- **최종 상태:** `finalState: "terminated"` 확인 완료 (잔존 실행 자원 없음, 상시 유휴 비용 `$0/hr` 유지)

## 3. 아직 실 AWS로 실행하지 않은 항목 (투명 고지)

1. **`roboco-io/silicon-model-factory` 실조사 Draft PR 실행:** 해당 사설 저장소용 Fine-Grained PAT를 `scripts/aws-set-github-secret.ts`로 Secrets Manager에 등록하고 서울 `ControlPlaneService`를 일시 기동(`desiredCount: 1`)한 뒤 실제 Stage 1 조사 작업을 등록·승인하면 바로 실행 가능하다.
2. **실제 GPU(`g5.xlarge` 등) 학습 및 실 Hugging Face 공개:** SMF 측 학습 스크립트, 대상 HF 저장소, Control Plane HF 쓰기 토큰 시크릿 등록 후 운영자 승인으로 실행한다(실제 유료 GPU·외부 HF 공개는 명시적 요청 시에만 수행).
