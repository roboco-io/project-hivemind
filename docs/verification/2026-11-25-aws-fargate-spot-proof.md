# AWS ECS Fargate Spot 실전 검증 기록 (2026-11-25)

## 요약

Cloudflare 백엔드 폐기 및 원격 리소스 전량 정리 후, AWS 단일 실행 경로(`infrastructure/aws-runtime`)를 실제 계정(`roboco` / `<AWS_ACCOUNT_ID>` / `ap-northeast-2`)에 배포하고 **`project-hivemind` 전체 저장소(790파일 · 7.71 MB `git bundle`)**를 실제 AWS ECS `FARGATE_SPOT` 독립 검증 컨테이너에서 복원·검증했다.

## 배포 및 실행 근거

| 항목 | 실측 값 |
|---|---|
| AWS 계정 / 리전 | `<AWS_ACCOUNT_ID>` (`roboco`) / `ap-northeast-2` |
| CloudFormation Stack | `HivemindAwsRuntimeStack` (`53/53 CREATE_COMPLETE`, 139.6s) |
| ECS Cluster | `arn:aws:ecs:ap-northeast-2:<AWS_ACCOUNT_ID>:cluster/hivemind-runtime-cluster` |
| KMS·버전 관리 S3 버킷 | `hivemind-runtime-<AWS_ACCOUNT_ID>-ap-northeast-2-artifacts` |
| ECR 이미지 (ARM64 Graviton) | `hivemind-runtime-{control-plane,worker,verifier}:latest` 푸시 완료 |
| 실행된 Fargate Spot Task ARN | `arn:aws:ecs:ap-northeast-2:<AWS_ACCOUNT_ID>:task/hivemind-runtime-cluster/41f0196717a44acba867b7796cc17845` |
| Capacity Provider | **`FARGATE_SPOT`** (`ARM64` Linux, private subnet, `assignPublicIp: DISABLED`) |
| 입력 저장소 (`project-hivemind`) | `baseCommit`: `e16316b9da08c9625ca9923f11d7133277beff22`, **790파일 · 7,709,765 bytes (7.71 MB)** |
| `bundleSha256` | `043022eb11a9e24f1c7caa7903b2c02601a91a2e9c8fd486745283238ca02ee7` |
| `acceptanceDigest` | `f617f4295de3c591cd93abc16c74c861dfe1b07a608519d7bcbaba51448d7453` |
| 컨테이너 종료 코드 / 전체 소요 시간 | `exitCode: 0` / **62,394 ms** (컨테이너 기동·이미지 풀·7.71 MB 복원·검증 포함) |
| 독립 검증 결과 | `checksPassed: true`, `acceptancePathsUnmodified: true`, `patchSha256Matches: true` |
| `verifiedTreeHash` | `26600d3c9374b65f463a8d695e1b2cfe928820b1` |

## NAT-free 퍼블릭 서브넷 + 3중 보안 그룹 전환 실측 (2026-11-25)

NAT Gateway(월 약 $32+)와 Elastic IP를 제거하고, 퍼블릭 서브넷 + 3중 보안 그룹 + 격리 EFS 서브넷(`PRIVATE_ISOLATED`)으로 `HivemindAwsRuntimeStack`을 업데이트한 뒤 재검증했다.

| 항목 | 실측 결과 |
|---|---|
| 활성 NAT Gateway / EIP | **0개 / 0개** (`aws ec2 describe-nat-gateways` 결과 `[]`) |
| `WorkerSecurityGroup` (`sg-0a18cb6ff6367a741`) | **인바운드 규칙 0개** (외부 접속 전면 차단, 아웃바운드 HTTPS 443 + Control Plane 4310만 허용) |
| `ControlPlaneSecurityGroup` (`sg-0bc48ea4f857b0290`) | 인바운드 TCP `4310`을 **명시적 운영자 `/32` CIDR + `WorkerSecurityGroup`만 허용** (`0.0.0.0/0` 코드 레벨 차단) |
| `EfsSecurityGroup` | 격리 서브넷(`PRIVATE_ISOLATED`), NFS `2049`를 `ControlPlaneSecurityGroup`에서만 허용 |
| NAT-free `FARGATE_SPOT` 실측 태스크 | `arn:aws:ecs:ap-northeast-2:<AWS_ACCOUNT_ID>:task/hivemind-runtime-cluster/581d40fec4f34285a684faa191e069c0` |
| 실행 결과 / 트리 해시 | `exitCode: 0`, **68,051 ms**, `checksPassed: true`, `verifiedTreeHash: 26600d3c9374b65f463a8d695e1b2cfe928820b1` (일치) |

## AWS SSM 포트 포워딩 · 퍼블릭 인바운드 0개 상시 Control Plane 실측 (2026-11-25)

운영자 접근 경로를 **AWS SSM 포트 포워딩**으로 전환해 `ControlPlaneSecurityGroup`의 퍼블릭 CIDR 인바운드 규칙까지 제거하고, EFS Access Point(UID/GID 1000 · IAM 마운트)와 Secrets Manager 자동 생성 토큰(`OperatorTokenSecret` / `WorkerTokenSecret` 분리)으로 `ControlPlaneService`(`desiredCount: 1`)를 실제 기동·검증했다.

| 항목 | 실측 결과 |
|---|---|
| NAT Gateway / EIP / ALB / 퍼블릭 CIDR 인바운드 | **모두 0개** (`LIVE_SG_PUBLIC_CIDRS: []`) |
| 상시 `ControlPlaneService` | `hivemind-runtime-control-plane:3` — `containerStatus: RUNNING`, `ExecuteCommandAgent: RUNNING` |
| EFS SQLite 마운트 | `PRIVATE_ISOLATED` 서브넷, EFS Access Point(`uid=1000`, `gid=1000`, `0750`, IAM `ENABLED`) |
| 실제 AWS SSM 포트 포워딩 터널 호출 (`127.0.0.1:14310 -> Fargate:4310`) | `GET /health` **200 OK**, 무인증 `GET /api/delivery/tasks` **401**, `OperatorTokenSecret` 인증 `GET /api/delivery/tasks` **200 OK** |
| 로컬 터널 실행 도구 | `scripts/aws-ssm-tunnel.ts` (`session-manager-plugin` 사용) |

## 검증된 항목과 미검증(남은 Milestone 1) 항목

- **실제 AWS 환경에서 확인 완료:**
  1. `HivemindAwsRuntimeStack` CDK 배포 및 3자 IAM 분리 역할·KMS S3·ECR·ECS `FARGATE_SPOT` 클러스터 동작.
  2. 기존 Cloudflare 4 MiB 한도를 넘는 `project-hivemind` 전체 저장소(790파일 · 7.71 MB)의 KMS S3 `git bundle` 업로드 → SHA-256 검증 복원 → 불변 수용 테스트 실행 → `verifiedTreeHash` 산출 및 S3 영수증 저장.
  3. 모델 인증·GitHub 토큰이 전혀 없는 독립 검증 컨테이너(`VerifierTaskRole`)에서의 격리 실행.
- **로컬 E2E 자동 테스트로만 확인(실제 AWS 실행 대기 — Milestone 1 완료 조건):**
  1. 실제 Codex/Claude 구독 CLI가 AWS Fargate Spot AI 워커 컨테이너에서 `project-hivemind`의 실제 개발 이슈 1건을 수정하고(실패→수정 랄프 루프 포함) S3 패치 업로드.
  2. 신뢰된 PR Publisher가 실제 GitHub `roboco-io/project-hivemind`에 격리 브랜치 **Draft PR**을 생성하고 `verifiedTreeHash === prTreeHash` 일치 확인.
  3. 운영자가 diff를 열지 않고 검증·정책 근거만으로 승인/반려를 결정하고 판단 소요 시간(분)을 기록.
  4. 상시 `ControlPlaneService`의 운영자/워커 비밀 주입 및 `desiredCount: 1` 기동.
