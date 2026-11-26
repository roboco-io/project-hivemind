# 2026-11-26 이슈 #16 작업 1 검증 보고서 — 5개 리전 Spoke, 리전 네트워크 레지스트리, 스팟 자동 배치와 폴백

이 문서는 이슈 #16의 작업 1(나머지 3개 리전 Spoke 배포와 5개 리전 기본 네트워크 매핑)을 실 AWS에서 확인한 결과를 기록한다. 대상 계정은 `<AWS_ACCOUNT_ID>`이고 사용한 프로필은 `roboco`다. 아래 값은 모두 2026-11-26에 직접 조회하거나 실행해 얻었다.

## 1. 자동 검증 결과

`npm run check`는 1,232건이 모두 통과했다. `infrastructure/aws-runtime`의 `npm run typecheck`는 통과했고 `npm test`는 7건이 모두 통과했다. 이 작업으로 추가한 테스트는 `tests/model-factory-region-networks.test.ts`(4건), `tests/collab-multi-region-fanout.test.ts`(2건), `infrastructure/aws-runtime/test/aws-runtime-stack.test.ts`(2건)다.

## 2. 실 AWS에 배포한 구성

`scripts/aws-deploy-spoke.sh`로 무상태 Spoke 스택을 배포했다. 이 스크립트는 `worker-token`과 `model-subscription-auth`만 대상 리전에 복제한다. `operator-token`, `github-draft-pr`, `hf-release-token`이 대상 리전에 복제되어 있으면 배포를 중단한다. 배포 후 조회에서 이 세 비밀의 복제 리전은 없었다.

| 리전 | 스택 | VPC CIDR | 워커 보안 그룹(인바운드 0) | NAT Gateway |
|---|---|---|---|---|
| `us-east-2` | `HivemindAwsSpokeUsEast2Stack` (기존, 실행 역할 이름만 갱신) | `10.1.0.0/16` | `sg-0e3ac45935e27429c` | 0 |
| `us-east-1` | `HivemindAwsSpokeUsEast1Stack` (신규) | `10.2.0.0/16` | `sg-02c88111a9073a681` | 0 |
| `us-west-2` | `HivemindAwsSpokeUsWest2Stack` (신규) | `10.3.0.0/16` | `sg-03219f5a356b9f260` | 0 |
| `ap-northeast-1` | `HivemindAwsSpokeApNortheast1Stack` (신규) | `10.4.0.0/16` | `sg-0ca54423d266617cb` | 0 |

서울 Hub 스택(`HivemindAwsRuntimeStack`)은 Control Plane 작업 정의 `hivemind-runtime-control-plane:10`으로 갱신했다. 이 작업 정의의 환경 변수 `HIVEMIND_MF_REGION_NETWORKS_JSON`에는 4개 Spoke 리전의 공개 서브넷과 워커 보안 그룹, 그리고 5개 리전 공통의 AMI 조회용 공개 SSM 파라미터(`/aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-amazon-linux-2023/latest/ami-id`)가 들어 있다. Control Plane 역할에는 공개 SSM 파라미터 조회 권한과, 4개 Spoke 클러스터로 조건을 건 ECS 권한 및 Spoke 역할 3종에 대한 `iam:PassRole`을 추가했다.

## 3. 스팟 자동 배치와 폴백 실증 (`scripts/aws-five-region-registry-proof.ts`)

### 무엇을 확인했는가

작업이 `regionOverrides`, `subnetId`, `securityGroupIds`를 하나도 적지 않고 후보 리전만 적었을 때, 배포된 Control Plane이 스팟 배치 점수 순서로 리전을 시도하고, 레지스트리에서 서브넷과 보안 그룹을 고르고, SSM으로 최신 AMI를 조회해 비-서울 리전에 스팟 인스턴스를 기동하는지 확인했다. 첫 리전이 실패하면 다음 리전으로 넘어가는지도 확인했다.

### 폴백을 일으킨 방법

실제 용량 부족은 원할 때 만들 수 없다. 그래서 `us-east-2`에서 제공되지 않는 인스턴스 유형 `d3en.xlarge`를 요청했다(`describe-instance-type-offerings`로 확인). 스크립트는 같은 배치 점수 피드로 순위를 미리 계산해, 라우터가 `us-east-2`를 1순위로 두는 후보 조합 `["us-east-2", "us-west-2"]`를 골랐다. 따라서 Control Plane은 `us-east-2`를 먼저 시도해 EC2의 실제 오류를 받아야 한다.

### 결과

| 항목 | 값 |
|---|---|
| 작업 ID | `mf-a47d2e60-2c60-41ff-b44a-26b63975acbd` |
| 배치 점수 피드 생성 시각 | 2026-11-26 13:11 UTC |
| 라우터가 정한 순서 | `us-east-2` → `us-west-2` |
| `us-east-2` 시도 | 레지스트리의 서브넷 3개에서 모두 `Unsupported` 오류 |
| 최종 기동 리전 | `us-west-2` |
| 인스턴스 | `i-07b05cd55b30be372`, `d3en.xlarge`, 수명 주기 `spot` |
| AMI | `ami-0ef61de44b7e32b17` (같은 시각 `us-west-2`의 SSM 최신 값과 일치) |
| 서브넷 | `subnet-0270e259a3b61b6e3` (레지스트리의 `us-west-2` 항목) |
| 보안 그룹 | `sg-03219f5a356b9f260` (레지스트리의 `us-west-2` 항목) |
| 기동 시각 | 2026-11-26T13:42:14Z |
| 종료 요청 | 2026-11-26 13:42:17 GMT, 작업 취소 API가 인스턴스를 종료 |

시도 순서의 근거는 배포된 Control Plane이 CloudWatch Logs 그룹 `/hivemind/hivemind-runtime`에 남긴 `hivemind.model_factory.placement_attempt` 이벤트 4건이다. 앞의 3건은 `us-east-2`의 서브넷별 실패(`outcome: capacity_failover`, 오류 원문 `AWS EC2 RunInstances failed (Unsupported): The requested configuration is currently not supported.`)이고, 마지막 1건은 `us-west-2` 기동 성공(`outcome: launched`)이다. 인스턴스의 유형, AMI, 서브넷, 보안 그룹은 Control Plane의 응답이 아니라 `ec2 describe-instances`로 따로 조회했다.

### 실증 후 유휴 상태

스크립트 종료 시 `ControlPlaneService`는 `desiredCount 0`이었다. `hivemind:managed-by=hivemind-model-factory` 태그가 있고 상태가 `pending`, `running`, `stopping`, `stopped` 중 하나인 인스턴스는 5개 리전 모두 0대였다.

## 4. 한계와 미검증 항목

- **실제 용량 부족으로 인한 폴백은 확인하지 않았다.** 이번 폴백의 원인은 리전에서 제공되지 않는 인스턴스 유형(`Unsupported`)이다. 이 오류는 `InsufficientInstanceCapacity`와 같은 분기에서 처리되지만, 용량 부족 오류 자체를 이번 실행에서 관찰한 것은 아니다. 로그의 `outcome` 값 이름이 `capacity_failover`인 것은 이 분기의 이름이며, 이번 오류가 용량 부족이라는 뜻이 아니다.
- **GPU 인스턴스로는 실행하지 않았다.** 비용을 줄이려고 소형 x86 인스턴스를 썼다. GPU 유형에서의 배치는 같은 코드 경로를 쓰지만 이번에 실행하지 않았다.
- **학습 스크립트 실행과 영수증 검증은 이 실증의 범위가 아니다.** 인스턴스는 기동 약 3초 뒤 취소로 종료했다. 인스턴스가 S3 입력을 내려받아 실행하는 경로는 `docs/verification/2026-11-26-issue12-model-factory-spot-proof.md`에 기록된 이전 실증이 다룬다.
- **협업 워커의 Spoke 팬아웃은 켜지 않았다.** Spoke의 Fargate 워커는 Control Plane의 사설 IP(TCP 4310)에 접속해야 하는데, 2026-11-26 조회 기준 계정에 VPC Peering 연결이 없다. 그래서 배포된 Control Plane에는 `HIVEMIND_AWS_SPOKES_JSON`을 넣지 않았고, 협업 워커는 서울 Hub에서만 기동된다. Peering 배포는 사용자 결정이 필요하다.
- **비용은 실제 청구를 확인하지 않았다.** 인스턴스는 수 초간 실행됐고 스팟 상한가는 시간당 `$0.5`였다. EC2 Linux의 최소 과금 단위가 60초이므로 인스턴스 비용은 `$0.01` 미만으로 추정한다. 이 값은 추정치이며 청구서로 대조하지 않았다.
