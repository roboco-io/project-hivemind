# ADR-0010: Silicon Model Factory AWS 단일 경로 확장(조사 작업 + GPU 스팟 학습·공개)

- **상태:** 구현·AWS 배포·실증 완료 (단위·통합 테스트 1,221건 + CDK 5건 통과, 서울 ControlPlaneService + Ohio EC2 Spot + 자율 5분 멀티리전 Lambda TTL Guard + KMS S3 영수증 종단 실증 완료)
- **관련 이슈:** [#12](https://github.com/roboco-io/project-hivemind/issues/12)
- **관련 ADR:** [ADR-0008](./0008-aws-native-sw-delivery-realignment.md), [ADR-0009](./0009-multi-region-spot-placement-architecture.md)

## 배경

Silicon Model Factory(`roboco-io/silicon-model-factory`)는 두 종류의 워크로드를 요구한다.

1. **Part A (조사와 문서 작업):** 기존 AWS SW 전달 경로(`DeliveryStore` + `FARGATE_SPOT` + 독립 Verifier + Draft PR) 위에서 사설 저장소별 토큰 분리, 허용 웹 호스트 allowlist, 승인된 서브에이전트, 장기 반복 및 스팟 중단 재개 시 작업 트리 복원, 문서 검증 범위 고지가 필요하다.
2. **Part B (GPU 스팟 학습과 공개):** 모델별 스택 재배포 없이 동적 AMI·인스턴스 타입으로 리전별 EC2 GPU 스팟을 기동하고, TTL Guard 강제 종료, 장시간 비동기 wake-up 스케줄러, 중앙 하드 비용 예약·정산 원장, S3 대용량 산출물 SHA-256 영수증, Control Plane 전담 Hugging Face 공개 승인 게이트가 필요하다.

## 결정

### Part A — AWS Delivery 조사·문서 작업 확장

- **A1 (다중 사설 저장소 GitHub 자격 증명):** `packages/adapters/src/github-token-resolver.ts`가 Secrets Manager JSON의 `tokensByRepo["owner/repo"]`를 조회하며, 미등록 저장소는 침묵 없이 명시 오류를 반환한다. `scripts/aws-set-github-secret.ts`는 기존 저장소 토큰을 덮어쓰지 않고 병합 등록한다.
- **A2/A3 (허용 웹 호스트 및 서브에이전트 정책):** `WorkerExecutionPolicy`(`allowedWebHosts`, `allowSubagents`, `maxIterationDurationMs`, `preserveWorkspaceOnRetry`, `verificationKind`)를 `approvalFingerprint`에 고정하고, `apps/worker/src/aws-worker-policy.ts`가 Claude `--allowedTools`(`Agent`, `WebFetch(domain:...)`) 및 Codex 환경 변수·프롬프트 제약을 생성한다.
- **A4 (장기 반복·스팟 재개 작업 트리 복원):** 최대 2시간(`7_200_000ms`) 반복 타임아웃을 허용하고, `apps/worker/src/aws-worker-runtime.ts`가 이전 체크포인트 JSON의 `partialPatch` SHA-256을 검증한 뒤 `git apply`로 작업 트리에 복원한다. `preserveWorkspaceOnRetry: true`일 때는 정상 완료 시에도 체크포인트를 S3에 남겨 다음 Ralph 반복에서 이어 작업할 수 있다.
- **A5 (문서 산출물 검증 범위 고지):** `verificationKind === 'document_format'`이면 `buildDraftPrBody`가 Draft PR 본문 상단에 형식·스키마 검증만 수행했고 사실 여부는 미판정이라는 경고 배너를 포함한다.
- **교훈 반영 (#1~#3):** `DeliveryTask`에 명시적 `waitReason`과 `lastPreflight`를 추가하고, 워커가 모델 호출 전에 `POST /api/delivery/tasks/:id/preflight`로 CLI/인증/Git 준비 상태를 검증해 실패 시 즉시 종료·기록한다.

### Part B — Model Factory GPU 스팟 학습·공개 제어면

- **B1/B2 (동적 EC2 GPU 스팟 + 다중 리전 + TTL Guard):** `packages/adapters/src/aws-ec2-spot-trainer.ts`가 무의존 SigV4 EC2 Query API로 작업별 `amiId`, `instanceType`, `region`, `availabilityZoneId`, `maxHourlyPriceUsd`, `hivemind:expires-at` 태그를 지정해 기동한다(모델별 CDK 스택 재배포 불필요). `sweepExpiredSpotInstances(region)`가 만료 태그 또는 태그 누락(fail-closed) 인스턴스를 강제 종료한다.
- **B3 (장시간 wake-up 오케스트레이션):** 학습 중 상주 Fargate 워커를 띄우지 않고 `ModelFactoryOrchestrator.wakeJob` / `wakeDueJobs`가 `nextWakeAt`과 `expiresAt` 기준으로 EC2 상태 및 S3 영수증만 점검한다.
- **B4 (중앙 하드 비용 원장):** `ModelFactoryStore`가 승인 시 `maxTotalCostMicros`를 `BEGIN IMMEDIATE` 트랜잭션으로 예약(전역 상한 초과 시 409 거절 및 진단·감사 이벤트 영속화)하고, 인스턴스 종료 후 실제 실행 초 기준으로 정산해 잔여 예산을 반환한다. `GET /api/model-factory/ledger`가 SMF `tools/ledger.mjs` 대사 기준을 제공한다.
- **B5/B6/B7 (S3 SHA-256 영수증 + 신뢰 HF 공개 + 사람 승인 게이트):** S3 `${s3ArtifactPrefix}/receipt.json`의 파일별 SHA-256으로 `manifestDigest`를 재계산해 검증한다. `release-check.mjs` 통과 검증(`awaiting_release_approval`)과 운영자 명시 승인(`release_approved`) 이후에만 Control Plane 전용 `createTrustedHfReleasePublisher`(`autonomous-external-hf-lfs.ts` 재사용)가 Secrets Manager의 HF 토큰으로 공개한다. 워커는 HF 쓰기 토큰을 절대 보유하지 않는다.

## 책임 경계 (HIVEMIND vs SMF)

| 영역 | HIVEMIND 책임 (구현 완료) | SMF (`silicon-model-factory`) 책임 |
| --- | --- | --- |
| 조사·문서 PR | 다중 사설 저장소 토큰 분리, 허용 웹 호스트·서브에이전트 정책, 사전 점검, 스팟/반복 워크스페이스 복원, 문서 검증 고지 Draft PR | 조사 지시서, `ops/stage1/check.mjs` 형식 검증 스크립트, 저장소별 Fine-Grained PAT 등록 |
| GPU 학습 실행 | 중앙 예산 예약·정산, 동적 AMI/인스턴스 EC2 스팟 기동, TTL Guard 강제 종료, 장시간 wake-up 점검 | 학습 스크립트(`userDataScript`/컨테이너), S3 `${prefix}/receipt.json` 업로드 |
| 평가·공개 | `manifestDigest` 일치 강제, 사람 공개 승인 게이트, Control Plane 단독 HF LFS 공개 | `tools/release-check.mjs` 평가 기준, 대상 HF 저장소 사전 생성, Control Plane Secrets Manager에 HF 토큰 등록 |
