# 2026-11-26 이슈 #16 작업 2 검증 보고서 — MCP 협업 도구와 병렬 Fargate Spot 워커 실증

이 문서는 이슈 #16의 작업 2를 실 AWS에서 확인한 결과를 기록한다. 대상 계정은 `<AWS_ACCOUNT_ID>`, 프로필은 `roboco`다. 아래 값은 모두 2026-11-26에 `scripts/aws-collab-live-e2e.ts`를 실행해 얻었다.

**결론부터 적는다.** MCP `collab` 프로파일로 세션을 등록하고 Fargate Spot 워커 2대를 병렬로 기동해 Aurora DSQL 게시판으로 통신하는 경로는 실 AWS에서 완주했다(2절과 3절). Control Plane 내장 오케스트레이터가 목표를 하위 작업으로 나누는 단계까지 포함한 실행도 이어서 완주했다(4절). 4절의 실행은 사용자가 2026-11-27에 로컬 인증 파일을 새로 만들어 전달하라고 지시한 뒤 수행했다. 확인하지 않은 범위는 6절에 적었다.

## 1. 자동 검증 결과

`npm run check`는 1,235건이 모두 통과했다. 이 작업으로 추가한 테스트는 `tests/collab-mcp.test.ts`(2건)와 `tests/collab-worker-setup.test.ts`(1건)다.

## 2. 실증 절차

스크립트는 서울 `ControlPlaneService`를 `desiredCount 1`로 올리고, SSM 포트 포워딩 터널로 Control Plane에 연결한다. 그다음 운영자 쪽 조작을 모두 MCP `collab` 프로파일의 도구로 수행한다. 스크립트는 MCP 서버를 같은 프로세스 안에서 만들고 MCP 클라이언트로 도구를 호출한다. 즉 stdio로 연결한 Claude Code나 Codex 앱에서 호출한 것은 아니다.

1. `hivemind_collab_list`로 협업 저장소가 `aurora-dsql`인지 확인한다.
2. `hivemind_collab_create`로 세션을 등록한다(제공자 `codex`, 병렬 워커 상한 2, 허용 리전 `ap-northeast-2`).
3. `hivemind_collab_add_subtask`로 서로 의존하지 않는 하위 작업 2개를 추가한다.
4. `hivemind_collab_fan_out`으로 하위 작업마다 ECS 워커를 기동한다.
5. `hivemind_collab_get`으로 두 하위 작업이 끝날 때까지 조회한다.
6. 워커 작업을 중지하고 `ControlPlaneService`를 `desiredCount 0`으로 되돌린다.

## 3. 결과 (세션 `ses-1815c87e-3836-4d2c-9f59-ffe02d73ace5`)

| 항목 | 값 |
|---|---|
| 협업 저장소 | `aurora-dsql` (서울 클러스터 `h5uil5myqct7chhnr7qrbtbwiq`) |
| 기동한 워커 | 2대, 두 작업 모두 용량 공급자 `FARGATE_SPOT` (`ecs describe-tasks`로 조회) |
| 워커 리전 | 둘 다 `ap-northeast-2` |
| 하위 작업 상태 | `Agent A` `completed`, `Agent B` `completed` |
| 게시판 메시지 | 총 6건: 조정자의 배정 메시지 2건, 에이전트 메시지 4건 |
| 모델이 실행 중에 직접 남긴 메시지(`chat`) | 2건, 에이전트 2명이 각 1건 |
| 작업 로그 | 2건 |

에이전트 `spot-agent-b2f5fdcd`는 "AWS Fargate Spot runs Amazon ECS tasks on spare AWS capacity."를, 에이전트 `spot-agent-1e5429d4`는 "Amazon Aurora DSQL is compatible with PostgreSQL."를 게시판에 남겼다. `chat` 메시지는 모델이 실행 도중 Control Plane의 HTTP API를 직접 호출해 남긴 것이고, `handoff` 메시지는 모델 실행이 끝난 뒤 워커 래퍼가 남긴 것이다.

실증 후 `ControlPlaneService`는 `desiredCount 0`이었고, `hivemind:managed-by=hivemind-model-factory` 태그가 있는 실행 중 EC2 인스턴스는 5개 리전 모두 0대였다.

## 4. 내장 오케스트레이터를 포함한 실행 (세션 `ses-1fbc1f89-6d37-47e4-b1fc-ae6910822508`)

### 인증 값의 전달 방식

로컬 Codex 로그인 파일(`~/.codex/auth.json`)의 내용을 `{"codex":{"authJson":"..."}}` 형식으로 감싼 임시 파일을 세션 전용 임시 디렉터리에 권한 `600`으로 만들었다. MCP 서버는 환경 변수 `HIVEMIND_COLLAB_LOCAL_AUTH_FILE`로 이 파일의 경로를 받아, `hivemind_collab_run_orchestrator` 호출 시점에 파일을 읽어 SSM 터널 너머의 Control Plane에 전달했다. 인증 값은 도구 입력, 로그, 이슈, 저장소 어디에도 넣지 않았다. 실행이 끝난 뒤 임시 파일을 삭제했고, 삭제됐음을 확인했다.

### 결과

| 항목 | 값 |
|---|---|
| 오케스트레이터 실행 | 제공자 `codex`, 상태 `completed`, 2026-11-26T15:08:34Z 시작, 15:09:06Z 종료(약 32초), 오류 없음 |
| 오케스트레이터가 만든 하위 작업 | `Agent A`, `Agent B` 2건, 의존 관계 없음, 생성 시각 15:09:02Z |
| 워커 | 2대, 용량 공급자 모두 `FARGATE_SPOT`, 리전 `ap-northeast-2` |
| 하위 작업 상태 | 둘 다 `completed` |
| 게시판 메시지 | 총 7건, 에이전트 메시지 4건(에이전트 2명) |
| 실증 후 | `ControlPlaneService` `desiredCount 0`, 5개 리전의 관리 대상 실행 EC2 인스턴스 0대 |

오케스트레이터 실행 기록과 하위 작업은 Control Plane의 응답이 아니라 DSQL의 협업 테이블을 직접 읽어 확인했다. 하위 작업의 지시문은 스크립트가 넣는 예비 지시문("curl is not installed" 문구 포함)이 아니라 오케스트레이터가 쓴 문장("Verify one fact about AWS Fargate Spot using AWS documentation...")이었다. 즉 스크립트의 예비 경로가 아니라 오케스트레이터가 하위 작업을 만들었다.

두 에이전트는 각각 "Amazon Aurora DSQL is compatible with PostgreSQL 16."과 "AWS sends a two-minute warning before stopping an Amazon ECS task due to a Fargate Spot interruption."을 AWS 문서 출처와 함께 게시판에 남겼다. 이 문장들의 사실 여부는 이 실증에서 검증하지 않았다.

## 5. 실증 중 발견해 고친 문제

**워커 준비 단계 실패 시 하위 작업이 `running`으로 남았다.** 첫 실행(세션 `ses-f3eb21f7-1ad1-43e8-8444-24e42deacbd5`, 제공자 `claude`)에서 워커 2대가 모두 `ModelSubscriptionAuthSecret is missing claude credentials` 오류로 종료했다. 워커는 모델 인증을 읽는 단계에서 예외가 나면 Control Plane에 실패를 보고하지 않고 끝났기 때문에, 두 하위 작업이 `running`으로 남아 병렬 워커 자리를 계속 차지했다. 커밋 `339821e`에서 준비 단계가 실패하면 하위 작업을 `failed`로 보고한 뒤 종료하도록 고쳤고(`apps/worker/src/collab-worker-setup.ts`), 워커 이미지를 다시 푸시했다. 이 수정은 단위 테스트로만 확인했고, 실 AWS에서 준비 실패를 다시 일으켜 확인하지는 않았다.

**SSM 터널 프로세스가 스크립트 종료 뒤에도 남았다.** `aws ssm start-session`은 `session-manager-plugin`을 자식 프로세스로 띄우는데, 스크립트가 `aws` 프로세스만 종료해 플러그인이 남았다. 터널을 별도 프로세스 그룹으로 띄우고 그룹 전체를 종료하도록 두 실증 스크립트를 고쳤다. 남아 있던 플러그인 프로세스는 이 실증이 띄운 것임을 포트 번호로 확인한 뒤 종료했다.

## 6. 한계와 미검증 항목

- **내장 오케스트레이터는 Codex로 1회 실행했다.** Claude 제공자의 오케스트레이터는 실행하지 않았다. 반복 실행이나 의존 관계가 있는 하위 작업의 분해는 확인하지 않았다.
- **로컬 Codex 로그인의 사본을 클라우드에서 썼다.** Control Plane은 전달받은 인증 값을 임시 디렉터리에만 두고 실행 뒤 지운다. 다만 같은 로그인을 두 곳에서 쓰면 한쪽의 토큰 갱신이 다른 쪽 로그인을 무효로 만들 수 있다. 이번 실행 뒤 로컬 Codex 로그인이 정상인지는 확인하지 않았다.
- **Claude 제공자 워커는 확인하지 않았다.** Secrets Manager의 `hivemind-runtime/model-subscription-auth`에는 `codex` 자격만 있다(키 구조만 조회했고 값은 읽어 출력하지 않았다). Claude 워커를 쓰려면 사용자가 이 비밀에 `claude` 자격을 추가해야 한다.
- **Spoke 리전의 워커는 확인하지 않았다.** VPC Peering이 없어 Spoke 워커가 Control Plane에 접속할 수 없으므로 세션의 허용 리전을 서울로 한정했다.
- **실패한 첫 실행의 세션이 DSQL에 남아 있다.** 세션 `ses-f3eb21f7-1ad1-43e8-8444-24e42deacbd5`의 하위 작업 2개는 `running` 상태 그대로다. 해당 ECS 작업은 종료했으므로 실행 중인 자원은 없다. 기록은 지우지 않았다.
- **비용은 실제 청구를 확인하지 않았다.** Fargate Spot 워커 2대(각 4 vCPU, 8 GiB)가 각각 수 분간 실행됐고, 실패한 실행 2회를 포함해 Control Plane이 약 40분간 기동됐다. 모델 호출은 Codex 구독 인증으로 실행했으며 토큰 사용량은 기록하지 않았다. 청구서나 사용량 지표로 대조하지 않았다.
