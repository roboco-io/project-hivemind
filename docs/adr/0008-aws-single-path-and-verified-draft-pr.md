# ADR-0008: AWS 단일 실행 경로 전환과 불변 검증 기반 자동 Draft PR

- 상태: 수락 (2026-11-25)
- 근거 계획: [방향 재정렬 및 AWS 전환 마스터 플랜](../plans/2026-11-25-realignment-aws-plan.md)

## 배경

초기 HIVEMIND는 Cloudflare Workers·Durable Object·Containers에서 원격 실행·랄프 루프·연결 단절 지속성을 검증했다. 그러나 다음 두 가지 구조적 한계가 드러났다.

1. 결과 수락이 검토 이력 기록에만 머물러 있어, 사람이 diff를 읽지 않고 의도와 정책만으로 개발에 반영하는 핵심 가설을 끝까지 평가할 수 없었다.
2. Cloudflare 백엔드(DO KV 2MB, Workers 128MiB, 4MiB 소형 코딩 스냅샷과 별도 대형 compute 경로의 이중화)와 로컬 `apps/control-plane`의 이중 운영 구조가 유지보수 복잡도를 높였다.

## 결정

1. **AWS 단일 실행 경로로 수렴 (Spot 우선 2단계 혼합):**
   - 기존 `apps/control-plane`(Fastify + SQLite)을 AWS 상시 소형 서버 1대(영속 볼륨 + TLS)로 호스팅해 노트북 종료 후 지속성과 단일 코드베이스를 확보한다.
   - 1단계 실행·검증은 **AWS ECS Fargate Spot**(작업별 microVM 격리, 120초 `stopTimeout`으로 Spot `SIGTERM` 체크포인트 flush)을 사용하고, 대형 빌드에서 한계가 실측될 때만 2단계 **EC2 Spot**(기존 TTL Guard 재사용)을 추가한다.
   - 고정 커밋 `git bundle` + SHA-256을 버전 관리 KMS S3로 전달해 4MiB 스냅샷 한도를 제거한다.
2. **불변 수용 테스트 + 검증–게시 해시 결속 자동 Draft PR:**
   - 승인 시점에 고정한 수용 테스트 파일·해시·실행 argv를 워커가 수정할 수 없다.
   - 독립 검증 컨테이너가 통과한 트리 해시(`verifiedTreeHash`)와 신뢰된 PR Publisher가 게시하는 트리 해시(`prTreeHash`)가 일치할 때만 격리 브랜치에 **Draft PR**을 자동 생성한다. `main`/`master` 직접 푸시와 자동 병합은 코드 레벨에서 금지한다.
   - Milestone 1에서는 운영자가 diff를 열지 않고 판단할 수 있었는지(`openedDiff`)와 판단 소요 시간(`durationMinutes`)을 중앙 저장소에 함께 기록한다.
3. **제공자 범위 고정 및 Cloudflare 즉시 폐기·아카이브:**
   - 제공자는 **Codex · Claude Code** 2종을 유지하고 Gemini(`agy`)는 제외한다(구독 OAuth 헤드리스 클라우드 이식의 비공식·약관/정지 위험).
   - 2026-11-25 사용자 결정에 따라 `cloudflare/` 백엔드는 즉시 폐기·아카이브하고 계정의 `hivemind-*` Cloudflare Worker·Container·이미지·R2 버킷을 전량 삭제했다. 이후 원격 실행은 AWS 단일 경로로만 진행한다.

## 결과

- 3자 자격 분리(Control Plane / AI Worker / Verifier)와 중앙 `core` 단일 정책 원칙은 AWS CDK(`infrastructure/aws-runtime`)와 `DeliveryStore`(`packages/core/src/delivery.ts`)에서 그대로 유지된다.
- 2026-11-25 실전 배포 및 검증을 완료했다: `HivemindAwsRuntimeStack`(NAT Gateway 0 · EIP 0 · ALB 0 · 퍼블릭 인바운드 CIDR 0 · AWS SSM 포트 포워딩)에서 `project-hivemind` 실제 과제([PR #10](https://github.com/roboco-io/project-hivemind/pull/10))를 무인 완주(3분 1.6초, Spot ~$0.0025)해 `verifiedTreeHash === prTreeHash` 3자 일치를 확인했고, 운영자가 diff 미열람(`openedDiff: false`) 30초(`0.5분`) 만에 승인·병합했다.
- Milestone 1B 운영자 피드백에 따라 구조화 변경 요약(`DeliveryChangeSummary`)을 Draft PR 본문과 중앙 이력에 추가했고, `HIVEMIND_MCP_PROFILE=delivery`의 AWS SSM 종단 연결 검증을 완료했다. 2단계 EC2 Spot은 Fargate Spot 성능이 충분해 보류(Deferred)했다.
