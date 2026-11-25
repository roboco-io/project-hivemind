# Milestone 1 실증 기록: AWS Fargate Spot 무인 완주 및 검증 Draft PR 전달

- **실증 일시:** 2026-11-25 (KST 18:27–18:30)
- **관련 이슈 / 기준 문서:** [Issue #8](https://github.com/roboco-io/project-hivemind/issues/8), [ADR-0008](../adr/0008-aws-single-path-and-verified-draft-pr.md), [AWS 단일 경로 계획서](../plans/2026-11-25-realignment-aws-plan.md)
- **대상 저장소:** `roboco-io/project-hivemind` (`origin/main` = `fbd09f0118ef3ba074756292d7b4b1149b19a15d`, 636개 추적 파일, 7.24 MB `git bundle`)
- **AWS 실행 환경:** `roboco` (`<AWS_ACCOUNT_ID>`, `ap-northeast-2`, `HivemindAwsRuntimeStack`, NAT Gateway 0 · EIP 0 · ALB 0 · 퍼블릭 인바운드 CIDR 0개)

---

## 1. 플랫폼 이전 성패 (전달 성공): 통과

승인 직후 로컬 AWS SSM 포트 포워딩 터널을 **즉시 종료한 무인 상태**에서, 상시 `ControlPlaneService`(`http://10.0.1.198:4310`)가 `FARGATE_SPOT` AI 워커(Codex) → 별도 `FARGATE_SPOT` 독립 검증기 → 격리 브랜치 **Draft PR** 게시까지 끝까지 완주했습니다.

### 실행 요약

| 항목 | 실측 값 |
| --- | --- |
| Delivery Task ID | `dlv-6aa481f0-ac5e-4f75-990c-c8b1424ecea3` |
| Run ID / Iteration | `run-65946a11-ab7f-48d3-940f-d438a897f207` / `1/3` |
| 과제 | 운영자 전용 `GET /api/tasks/:id` 상세 조회 API 추가 (`401`/`404`/`200 { task, events }`, 토큰 비노출) |
| 승인 → Draft PR 게시 총 소요 시간 | **181.6초 (3분 1.6초)** (`2026-11-25T09:27:27.581Z` → `09:30:29.150Z`, SSM 터널 종료 상태) |
| AI 워커 ECS 태스크 (`FARGATE_SPOT`) | `arn:aws:ecs:ap-northeast-2:<AWS_ACCOUNT_ID>:task/hivemind-runtime-cluster/5a27b66abb194a45b638295031f9e854` (`4 vCPU / 8 GiB` ARM64, 실행 118초, `exitCode: 0`) |
| 독립 검증기 ECS 태스크 (`FARGATE_SPOT`) | `arn:aws:ecs:ap-northeast-2:<AWS_ACCOUNT_ID>:task/hivemind-runtime-cluster/dc4aa4e70e2f4413aabbbf076e83dd5a` (`4 vCPU / 8 GiB` ARM64, 실행 41초, `exitCode: 0`, 수용 테스트 `8,047 ms`) |
| Fargate Spot 추정 컴퓨트 비용 | **약 $0.0025** (159초 × ARM64 `ap-northeast-2` `FARGATE_SPOT` 4 vCPU / 8 GiB 단가 기준; 모델 호출은 구독 인증 사용) |
| 생성된 Draft PR | **[PR #10](https://github.com/roboco-io/project-hivemind/pull/10)** (`isDraft: true`, `main` 무변경) |
| 격리 브랜치 | `hivemind/dlv-6aa481f0-ac5e-4f75-990c-c8b1424ecea3-r1` |

### 2. 불변 수용 테스트 및 검증–게시 코드 동일성 증명

| 증명 항목 | 값 | 검증 결과 |
| --- | --- | --- |
| 고정 기준 커밋 (`baseCommit`) | `fbd09f0118ef3ba074756292d7b4b1149b19a15d` | `origin/main`과 동일 (PR 후에도 `main` 무변경 확인) |
| 고정 수용 테스트 파일 | `tests/api.test.ts`, `packages/contracts/src/index.ts` | `acceptancePathsUnmodified: true` (패치 미수정 + 베이스 커밋 재복원 후 SHA-256 검증) |
| 승인 수용 테스트 Digest | `b26e594857a49145e237c8993899b8dc21433b64a6696953e4bdebe508daa018` | 승인·검증기·PR 게시 전 구간 일치 |
| 검증 통과 트리 해시 (`verifiedTreeHash`) | `830e188096ced102932a9ac35e47295dac157a88` | 독립 검증기(`hivemind-runtime-verifier`, 모델 CLI·비밀 없음) 산출 |
| PR 게시 트리 해시 (`prTreeHash`) | `830e188096ced102932a9ac35e47295dac157a88` | Control Plane 재계산 일치 |
| GitHub 원격 커밋 트리 SHA | `44b8ef17f0d5a53286569a66571afe49bbd5e6cf` → `830e188096ced102932a9ac35e47295dac157a88` | GitHub API(`git/commits`) 3자 바이트 일치 확인 |
| 변경 파일 범위 | `apps/control-plane/src/app.ts` (+2), `packages/core/src/store.ts` (+6), `docs/architecture.md` (+1) | 기존 `tests/api.test.js` 전체 통과 + 신규 `GET /api/tasks/:id` 계약(401/401/404/200·이벤트 격리·비밀 비노출) 통과 |

### 3. 실전 실행 중 발견·해결한 운영 이슈

1. **AWS Fargate `networkInterfaces()` 링크-로컬 우선 반환:** Fargate `awsvpc`에서 `eth0`가 `169.254.172.2`(링크-로컬), `eth1`이 VPC ENI IP(`10.0.x.y`)로 반환되어 `detectPrivateVpcIpv4()`가 RFC1918 주소만 선택하도록 보완 (`apps/control-plane/src/main.ts`).
2. **ECS `RunTask` 태그 권한 누락:** `ControlPlaneTaskRole`에 `ecs:TagResource`(클러스터 태스크 ARN 한정) 추가 (`infrastructure/aws-runtime/lib/aws-runtime-stack.ts`).
3. **Codex 기본 모델 지정:** `ModelSubscriptionAuthSecret`에 하드코딩한 `gpt-5.4-mini`가 구독 환경에서 exit 1을 반환해 모델 지정을 제거(구독 기본 모델 사용)하고 워커 오류 로그가 배너 대신 `stderr` 말미(`slice(-2500)`)를 남기도록 보완 (`apps/worker/src/aws-worker-main.ts`).
4. **보안 강화 권고 (미완료 후속):** 이번 실증의 `GithubDraftPrSecret`에는 로컬 `gh auth token`을 시딩했습니다. 상시 운영 전 `roboco-io/project-hivemind` 단일 저장소의 `contents: write` + `pull_requests: write`만 허용하는 Fine-Grained PAT로 교체하는 것을 권장합니다.

---

## 4. 제품 가설 성패 (사람 무검토 판단): 통과 (보강 과제 도출)

운영자가 **[PR #10](https://github.com/roboco-io/project-hivemind/pull/10)의 diff를 전혀 열지 않고** 의도·정책·불변 수용 테스트·해시 일치 근거만으로 **30초(`0.5분`) 만에 승인**을 결정했으며, 해당 기록을 AWS 상시 `ControlPlaneService` (`POST /api/delivery/tasks/dlv-6aa481f0-ac5e-4f75-990c-c8b1424ecea3/human-decision`, EFS SQLite 지속 저장)에 반영했습니다.

- **판단 대상 Task ID:** `dlv-6aa481f0-ac5e-4f75-990c-c8b1424ecea3`
- **최종 작업 상태:** `approved`

| 운영자 판단 항목 | 기록 값 |
| --- | --- |
| `decision` | `approve` (승인) |
| `openedDiff` | **`false`** (diff 열람 없이 판단 완료) |
| `durationMinutes` | **`0.5`** (30초) |
| `reason` | 불변 수용 테스트 통과 및 `verifiedTreeHash === prTreeHash` 근거만으로 diff 열람 없이 30초 만에 승인 |
| `missingEvidence` | **변경사항에 대해서 좀 더 자세한 요약이 필요함.** (Phase 2 [Issue #9](https://github.com/roboco-io/project-hivemind/issues/9) 최우선 보강 항목으로 이관) |

### Milestone 1 최종 결론

1. **플랫폼 이전 성패 (전달 성공): 통과** — Cloudflare 없이 AWS 단일 경로(`FARGATE_SPOT`, NAT·EIP·ALB 0, SSM 포트 포워딩)에서 `project-hivemind` 전체 저장소(7.24 MB `git bundle`)의 실제 과제를 무인 완주하고 검증–게시 트리 해시 3자 일치 Draft PR 생성 완료.
2. **제품 가설 성패 (무검토 판단): 통과** — 운영자가 diff를 열지 않고(`openedDiff: false`) 30초(`0.5분`) 만에 승인 결정. 동시에 **"변경사항에 대한 더 자세한 구조화 요약"**이 무검토 판단 신뢰도를 높이는 핵심 보강 근거로 확인되어 Phase 2([Issue #9](https://github.com/roboco-io/project-hivemind/issues/9))에 직접 반영함.
