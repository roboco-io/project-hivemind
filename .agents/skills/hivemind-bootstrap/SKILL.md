---
name: hivemind-bootstrap
description: HIVEMIND를 AWS 계정에 처음 설치하거나 빠진 구성을 채운다. 클라우드 리소스 생성, 인증 등록, 로컬 MCP 클라이언트 설정, 동작 확인을 `npm run bootstrap`으로 순서대로 수행하고, 사람이 웹에서 해야 하는 단계를 안내한다. 이미 설치된 HIVEMIND에서 작업을 등록하거나 조회하는 일에는 `hivemind` 스킬을 쓴다.
---

# HIVEMIND 부트스트랩

부트스트랩은 HIVEMIND의 AWS 단일 경로를 쓸 수 있는 상태로 만드는 한 번의 설치 절차다. 명령은 `npm run bootstrap`이다. 각 단계가 먼저 현재 상태를 확인하고 빠진 것만 수행하므로, 중간에 실패했거나 인증 값을 나중에 준비했을 때 같은 명령을 다시 실행하면 된다.

이 스킬은 과금되는 클라우드 리소스를 만들고 인증 값을 등록한다. **사용자가 부트스트랩 실행을 명시적으로 요청한 경우에만 실제 실행을 한다.** 요청이 불분명하면 `--dry-run`으로 무엇이 실행될지만 보여 준다.

## 진행 순서

1. **먼저 `--dry-run`을 실행한다.** `npm run bootstrap -- --dry-run`은 아무것도 바꾸지 않고 단계별로 "이미 됨", "실행 예정", "건너뜀"을 보고한다. 이 결과를 사용자에게 보여 주고, 대상 AWS 계정 번호가 사용자가 의도한 계정인지 확인한다. 계정이 다르면 멈춘다.
2. **사람이 준비할 값을 안내한다.** 아래 "사람이 해야 하는 일"의 항목 가운데 dry-run이 "건너뜀"으로 보고한 것을 알려 준다. 값이 없어도 부트스트랩은 진행되며, 그 기능만 동작하지 않는다. 사용자가 지금 준비할지 나중에 할지 정하게 한다.
3. **실제 실행을 한다.** 사용자가 실행을 지시했으면 준비된 값을 옵션으로 넘겨 실행한다. 처음 설치는 20분 넘게 걸릴 수 있다.
4. **결과 표를 그대로 전달한다.** "실패"와 "미실행"이 있으면 그 단계의 내용을 보여 준다. "아직 동작하지 않는 기능" 목록이 있으면 함께 전달한다. 실패를 성공처럼 요약하지 않는다.
5. **MCP 클라이언트를 다시 시작하라고 알린다.** 설정 파일을 쓴 뒤에는 Claude Code와 Codex를 다시 시작해야 새 설정을 읽는다.

## 명령과 옵션

```bash
npm run bootstrap -- [옵션]
```

| 옵션 | 뜻 |
|---|---|
| `--profile <이름>` | AWS 프로필. 생략하면 `AWS_PROFILE`, 그것도 없으면 `roboco` |
| `--region <리전>` | Hub 리전. 기본 `ap-northeast-2` |
| `--spokes <리전,리전>` | 추가로 배포할 Spoke 리전. `us-east-2`, `us-east-1`, `us-west-2`, `ap-northeast-1` 중에서 고른다 |
| `--model-auth-file <경로>` | 모델 구독 인증 JSON 파일 |
| `--github-app-id <ID>` | GitHub App ID |
| `--github-app-key-file <경로>` | GitHub App private key(`.pem`) 파일 |
| `--github-app-repositories <a,b>` | Draft PR을 만들 저장소(`owner/name`) |
| `--hf-token-file <경로>` | Hugging Face 토큰이 든 파일 |
| `--rebuild-images` | 이미지가 있어도 다시 빌드해 푸시 |
| `--skip-client-config` | 로컬 MCP 클라이언트 설정을 쓰지 않음 |
| `--skip-verify` | Control Plane을 켜서 확인하는 단계를 생략 |
| `--dry-run` | 아무것도 바꾸지 않고 각 단계가 할 일만 보고 |

인증 값은 항상 **파일 경로**로 넘긴다. 토큰이나 키의 내용을 명령줄 인자, 대화, 로그에 넣지 않는다. 사용자가 값을 대화에 붙여 넣으려 하면 파일로 저장해 경로를 알려 달라고 한다.

## 부트스트랩이 하는 일

| 단계 | 내용 |
|---|---|
| 사전 점검 | AWS 계정, Docker, CDK, `infrastructure/aws-runtime`의 의존성 설치 여부를 확인한다 |
| CDK 부트스트랩 | Hub와 Spoke 리전에 `CDKToolkit` 스택이 없으면 만든다 |
| Hub 첫 배포 | 서울 Hub 스택을 만든다. Control Plane 서비스는 Fargate Spot에서 상시 1개로 운영한다 |
| 컨테이너 이미지 | Control Plane, 워커, 검증기 이미지를 빌드해 ECR에 올린다 |
| Spoke 배포 | `--spokes`로 고른 리전에 무상태 Spoke를 만든다 |
| DSQL 테이블과 DB 역할 | 테이블과 제한된 DB 역할 2개를 만들고 권한을 준다 |
| Hub 최종 배포 | 서비스가 제한된 DB 역할로 접속하도록 Hub를 다시 배포한다 |
| 인증 등록 | 모델 구독 인증, GitHub App, Hugging Face 토큰을 Secrets Manager에 등록한다 |
| 로컬 MCP 클라이언트 설정 | 운영자 토큰 파일(권한 600), Control Plane 기동 설정 파일(`~/.hivemind/aws-control-plane.json`, 비밀 없음)과 `.mcp.json`, `.codex/config.toml`을 쓴다 |
| 동작 확인 | Control Plane에 연결해 세 저장소의 응답을 확인하고, 확인 전 desiredCount로 되돌린다 |

순서에는 이유가 있다. Hub를 처음 배포할 때는 DSQL에 관리자 역할로 접속하는 설정을 쓴다. 제한된 DB 역할이 아직 없기 때문이다. DB 역할을 만든 뒤에야 제한된 설정으로 다시 배포한다. 순서를 바꾸면 서비스가 DB에 접속하지 못한다. 그래서 단계를 골라 수동으로 실행하지 말고 `npm run bootstrap`에 맡긴다.

리소스 단계 하나가 실패하면 그 뒤의 리소스 단계는 실행하지 않는다. 인증 등록은 다르다. 한 항목이 없거나 잘못돼도 나머지 단계는 계속 진행한다.

이미 배포된 Spoke는 `--spokes`에 적지 않아도 유지된다. Spoke를 지우는 기능은 없다.

## 사람이 해야 하는 일

아래 값은 부트스트랩이 만들 수 없다. 사용자가 웹에서 발급해 파일로 준비한다.

| 값 | 준비 방법 | 없으면 동작하지 않는 것 |
|---|---|---|
| 모델 구독 인증 | Codex 또는 Claude에 로그인한 뒤 `{"codex":{"authJson":"<~/.codex/auth.json의 내용>"}}` 또는 `{"claude":{"apiKey":"..."}}` 형식의 JSON 파일을 만든다 | 워커의 모델 호출. SW 전달과 협업 워커가 실행되지 않는다 |
| GitHub App | 조직의 Settings → Developer settings → GitHub Apps에서 App을 만든다. Webhook은 끄고, Repository permissions는 Contents와 Pull requests를 `Read and write`로 준다. private key를 내려받고, App을 대상 저장소에만 설치한다 | Draft PR 게시 |
| Hugging Face 토큰 | Hugging Face 설정에서 쓰기 권한 토큰을 발급해 파일에 저장한다 | Model Factory 산출물의 Hugging Face 공개 |

AWS 로그인(SSO 포함)도 사용자가 한다. 인증 오류가 나면 사용자에게 로그인을 요청하고, 다른 프로필이나 자격으로 우회하지 않는다.

사용자의 로컬 인증 파일(`~/.codex/auth.json` 등)을 임의로 찾아 쓰지 않는다. 사용자가 그 파일을 쓰라고 명시했을 때만 쓴다.

## 끝난 뒤

- Control Plane은 Fargate Spot에서 상시 1개로 운영한다. MCP 서버가 터널을 열고, Spot 회수로 작업이 바뀌면 다음 호출에서 다시 연다. 손으로 여는 절차와 비용 추정은 [MCP 서버 안내](../../../apps/mcp-server/README.md)와 [Model Factory 연동 안내](../../../docs/guides/model-factory-integration.md) 2절에 있다.
- 작업 등록과 조회는 `hivemind` 스킬을 쓴다.
- 부트스트랩은 리소스를 지우지 않는다. 제거는 이 스킬의 범위가 아니다.
