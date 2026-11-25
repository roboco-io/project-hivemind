# aws-runtime

AWS 단일 실행 경로용 CDK 패키지다(profile `roboco`, 기본 리전 `ap-northeast-2`). NAT Gateway·ALB·퍼블릭 인바운드 포트 없이 **AWS SSM 포트 포워딩**과 3중 보안 그룹으로 고정비를 최소화하면서 네트워크 격리를 유지한다.

## 구성

- **NAT-free · 퍼블릭 인바운드 0개 VPC (`natGateways: 0`, EIP 0개, ALB 0개):**
  - 퍼블릭 서브넷: Control Plane(`enableExecuteCommand: true`, 아웃바운드 SSM 터널)과 Fargate Spot AI 워커·독립 검증 컨테이너. **어떠한 퍼블릭 CIDR 인바운드 규칙도 열지 않는다.**
  - 격리 서브넷(`PRIVATE_ISOLATED`): EFS SQLite 마운트 타깃(인터넷 경로 없음, NFS `2049`를 `ControlPlaneSecurityGroup`에서만 허용).
- **운영자 접속 (AWS SSM 포트 포워딩, `$0`):**
  - 로컬에서 `./infrastructure/aws-oidc/node_modules/.bin/tsx scripts/aws-ssm-tunnel.ts`로 `http://127.0.0.1:4310` 암호화 터널을 열고, 기존 `apps/mcp-server`(`HIVEMIND_MCP_PROFILE=delivery`)를 그대로 연결한다.
  - 작업 승인 후 터널이나 노트북을 닫아도 AWS 내부 Control Plane과 Fargate Spot 실행은 계속 진행된다.
- **3자 IAM 및 비밀 분리:**
  - `OperatorTokenSecret` · `WorkerTokenSecret`을 Secrets Manager에서 자동 생성하며, `ControlPlaneExecutionRole`만 `OperatorTokenSecret`에 접근한다(워커·검증 실행 역할은 `WorkerTokenSecret`만 접근).
  - `ControlPlaneTaskRole`(GitHub Draft PR 비밀 + ECS + SSM Exec), `AiWorkerTaskRole`(모델 구독 비밀만), `VerifierTaskRole`(두 비밀 모두 접근 불가).

## 검증 및 배포

```sh
npm run typecheck && npm test
HIVEMIND_AWS_ACCOUNT_ID=<12자리계정> HIVEMIND_AWS_REGION=ap-northeast-2 \
  cdk deploy --profile roboco --app 'node --import tsx bin/app.ts'
```
