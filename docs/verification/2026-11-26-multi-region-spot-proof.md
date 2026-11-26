# 멀티 리전 스팟 배치 실증 기록: 서울 Hub(`ap-northeast-2`) → 오하이오 Spoke(`us-east-2`)

- **실증 일시:** 2026-11-26 (KST 13:03–13:07)
- **관련 ADR:** [ADR-0009 서울 주 리전(Hub) + 멀티 리전 스팟(Spoke) 아키텍처](../adr/0009-multi-region-spot-placement-architecture.md)
- **AWS 계정 / 스택:** `roboco` (`779411790546`)
  - Hub: `HivemindAwsRuntimeStack` (`ap-northeast-2`, 서울, VPC `10.0.0.0/16`)
  - Spoke #1: `HivemindAwsSpokeUsEast2Stack` (`us-east-2`, 오하이오, VPC `10.1.0.0/16`, Stack ARN `arn:aws:cloudformation:us-east-2:779411790546:stack/HivemindAwsSpokeUsEast2Stack/8ce206a0-e94e-11f1-a7a7-02ffd52b9975`)

---

## 1. 스포크 인프라 및 보안 경계 실측 (`us-east-2`)

| 검증 항목 | 실측 결과 |
| --- | --- |
| CDK 배포 소요 시간 | **52.86초** (29개 리소스 `CREATE_COMPLETE`) |
| NAT Gateway / EIP / ALB / 상시 ECS Service | **모두 0개** (유휴 고정 컴퓨트·네트워크 비용 **`$0.00/hr`**) |
| 스포크 Worker SG (`sg-0e3ac45935e27429c`) 인바운드 규칙 | **`[]` (0개 — 퍼블릭 인바운드 완전 차단)** |
| Secrets Manager 복제 범위 | `worker-token`, `model-subscription-auth` 2종만 `us-east-2` 복제 (`operator-token`, `github-draft-pr`는 **서울 Hub 전용, 미복제**) |
| Spoke Verifier IAM Role (`SpokeVerifierTaskRole`) | 모델 인증·GitHub 토큰·운영자 토큰 **모두 0개**, 서울 KMS S3 `bundles/*`·`acceptance/*`·`patches/*` 읽기 및 `attestations/*` 쓰기만 허용 |

---

## 2. 실시간 스팟 배치 스코어 라우팅 → 오하이오 물리 AZ(`use2-az3`) 교차 리전 실행 증명

`scripts/aws-multi-region-verify.ts`가 실시간 피드(`https://d16jdvzof4zpo7.cloudfront.net/data.json`, `2026-11-26 00:11 UTC`)를 읽어 `i8g.mixed` 워크로드의 최적 리전과 물리 AZ를 선택하고, 서울 Hub KMS S3의 실제 `project-hivemind` 전체 저장소(840파일 · 7.83 MB `git bundle`)를 오하이오 `FARGATE_SPOT` 검증기로 교차 리전 실행했습니다.

| 항목 | 실측 값 |
| --- | --- |
| 피드 기반 선택 결과 | **`us-east-2` / 물리 AZ `use2-az3` (`us-east-2c`)** — 스코어 **9/10** (`stable`), **`$0.0244/hr`** (서울 `$0.0329/hr` 대비 **25.8% 절감**) |
| 실행 ECS 태스크 ARN | `arn:aws:ecs:us-east-2:779411790546:task/hivemind-runtime-us-east-2-cluster/8a3a28abea9d4bb49597671d9c1ebf57` |
| 실제 실행 용량 공급자 / AZ | **`FARGATE_SPOT`** / **`us-east-2c`** (`use2-az3` 핀 서브넷 정확 일치) |
| 컨테이너 이미지 풀 | 오하이오 `us-east-2`에서 서울 ECR(`779411790546.dkr.ecr.ap-northeast-2.amazonaws.com/hivemind-runtime-verifier:latest`) 교차 리전 풀 성공 |
| 교차 리전 S3 `git bundle` | 서울 KMS S3 → 오하이오 다운로드 **840파일 / 7,832,594 bytes (7.83 MB)**, SHA-256 검증 통과 |
| 수용 테스트 및 트리 해시 증명 | `checksPassed: true`, `acceptancePathsUnmodified: true`, `verifiedTreeHash`: `022b9532e59f77881c1aa6bac6d40977ef2f1f65` (로컬 `HEAD^{tree}` 바이트 일치, `patchSha256Matches: true`) |
| 총 소요 시간 | **72.4초** (`72,447 ms`, 교차 리전 이미지 풀 + 서울 S3 7.83 MB 전송 + 복원·검증·영수증 업로드 포함) |
| 참고 (독립 프로브 종료 코드) | 서울 `ControlPlaneService`가 유휴 중지(`desiredCount: 0`) 상태이므로, S3 `attestations/*` 업로드 성공 뒤 더미 콜백 URL(`https://control-plane.hivemind.internal`) 호출에서 `fetch failed`로 종료 코드 1이 기록됨. 상시 Control Plane 기동 + VPC Peering 연결 시 HTTP 콜백까지 완주한다. |

---

## 3. 자동 테스트 검증

- 루트 `npm run check`: **1,210 / 1,210 통과** (0 실패, 0 스킵)
- `infrastructure/aws-runtime` (`npm run typecheck && npm test`): **5 / 5 통과** (Hub 3 + Spoke 2)
