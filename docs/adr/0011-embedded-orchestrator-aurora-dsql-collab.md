# ADR-0011: Control Plane 내장 오케스트레이터(Option B) · Aurora DSQL 협업 저장소 · 5개 리전 GPU 스팟 자동 라우팅

- **상태:** 구현·AWS 배포·실증 완료 (`npm run check` 1,226건 + CDK 5건 통과, 서울 실 Amazon Aurora DSQL 종단 검증 완료)
- **관련 ADR:** [ADR-0008](./0008-aws-native-sw-delivery-realignment.md), [ADR-0009](./0009-multi-region-spot-placement-architecture.md), [ADR-0010](./0010-model-factory-aws-delivery-and-gpu-spot.md)

## 결정 요약

1. **Control Plane 내장형 오케스트레이터 에이전트 (Option B + 프로세스 비밀 격리):**
   - `infra/aws/Dockerfile.control-plane`에 공식 `claude`(`@anthropic-ai/claude-code`) 및 `codex`(`@openai/codex`) CLI와 `ripgrep`을 포함해 Control Plane ECS 컨테이너 안에서 에이전트가 직접 동작할 수 있게 한다.
   - 운영자가 SSM 암호화 터널을 통해 `POST /api/collab/sessions/:id/run-orchestrator`로 전달한 로컬 Claude/Codex 인증 토큰은 임시 디렉터리로만 물질화해 즉시 삭제하며(DB·로그·이벤트 미저장), 자식 에이전트 프로세스 환경에서 모든 AWS IAM·GitHub·HF·Operator·DSQL 환경 변수를 제거한다. 내장 에이전트는 오직 로컬 HTTP 협업 API(`127.0.0.1:4310`)를 통해서만 게시판 통신과 하위 ECS `FARGATE_SPOT` 병렬 팬아웃을 요청한다.
2. **멀티 에이전트 병렬 협업 & 공유 저장소 — Amazon Aurora DSQL + S3:**
   - 서울(`ap-northeast-2`)에 서버리스 분산 PostgreSQL 클러스터 `AWS::DSQL::Cluster`를 CDK로 배포한다(유휴 시 DPU 0, `$0/hr` 유휴).
   - 무의존 SigV4 IAM 인증 토큰(`packages/adapters/src/aws-dsql.ts`)과 OCC 충돌(`40001`/`OC000`/`OC001`) 자동 재시도로 `hm_collab_sessions`, `hm_collab_subtasks`(DAG 의존성·배타적 claim), `hm_collab_messages`(순차 커서 `seq`·멘션·스레드), `hm_collab_work_logs`(S3 URI + SHA-256 포인터)를 저장한다.
   - 대용량 번들·체크포인트·모델 가중치는 KMS 암호화 S3에 유지한다.
   - `dsql:DbConnectAdmin`/`DbConnect` 권한은 Control Plane 역할에만 부여하며, Fargate Spot 워커는 HTTP API만 사용한다.
3. **병렬 ECS Fargate Spot 에이전트 클러스터 팬아웃:**
   - `POST /api/collab/sessions/:id/fan-out`이 DAG 의존성이 해소된 준비 완료 하위 작업들을 `maxParallelWorkers` 한도 내에서 병렬 `FARGATE_SPOT` 워커(`HIVEMIND_COLLAB_MODE=true`)로 동시 기동하고, 각 워커가 공유 게시판·작업 기록을 읽고 결과를 기록한다.
4. **5개 리전 GPU 스팟 자동 선택 및 용량 부족 자동 전환:**
   - `TrainingComputeSpec`에 `candidateRegions`(`us-east-1`, `us-east-2`, `us-west-2`, `ap-northeast-1`, `ap-northeast-2`)와 리전별 `regionOverrides`(`amiId`, `subnetIds`, `securityGroupIds`)를 추가했다.
   - `ModelFactoryOrchestrator.approveAndLaunchTraining`은 `d16jdvzof4zpo7.cloudfront.net/data.json` Spot Placement Score 추세로 후보 리전을 순위화해 기동을 시도하며, `InsufficientInstanceCapacity` 등 용량 오류 시 다음 최적 리전·서브넷으로 자동 전환한다.
