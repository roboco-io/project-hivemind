# 2026-11-26 이슈 #16 작업 4 검증 보고서 — 이슈 #9(Phase 2 운영 마감) 정리 상태

이 문서는 이슈 #16의 작업 4, 곧 이슈 #9의 남은 항목을 2026-11-26에 확인하고 처리한 결과를 기록한다. 결론은 다음과 같다. 문서와 코드로 끝낼 수 있는 항목은 끝냈다. 사람이 직접 해야 하는 항목 2개가 남아 있어 이슈 #9는 닫지 않았다.

## 1. 이슈 #9 항목별 상태

| 이슈 #9의 항목 | 상태 | 근거 |
|---|---|---|
| 4개 클라이언트 접점의 MCP 연결 확인 | 부분 완료 | CLI 2종(Claude Code CLI, Codex CLI)의 실제 대화는 2026-11-27에 사용자가 확인했다(아래 2-1절). 데스크톱 앱 2종은 남아 있다. |
| 무검토 판단 근거 보강 | 완료 (2026-11-25) | 이슈 #9의 2026-11-25 코멘트와 `docs/verification/2026-11-25-phase3-evidence-and-mcp-ssm.md`에 기록되어 있다. 이번에 다시 검증하지 않았다. |
| 2단계 EC2 Spot 검증 워커 평가 | 보류로 결론 (2026-11-25) | 같은 코멘트에 기록되어 있다. 이번에 다시 평가하지 않았다. |
| `cloudflare/` 아카이브 정리 | 완료 | 아래 3절. |
| 미커밋 작업 파일 정리 | 해당 없음 | 2026-11-26 작업 시작 시점에 작업 트리가 깨끗했다. |
| `github-draft-pr` 비밀을 단일 저장소 Fine-Grained PAT로 교체 | 미완료 | 새 토큰을 발급해 등록하는 일은 사용자만 할 수 있다. |

## 2. stdio MCP 연결 재확인 (`scripts/aws-ssm-mcp-verify.ts`)

이번 작업에서 전달 저장소를 SQLite에서 Aurora DSQL로 옮겼으므로, 옮긴 뒤에도 클라이언트 접점이 동작하는지 다시 확인했다. Control Plane을 기동하고, SSM 포트 포워딩 터널을 연 다음, MCP 서버를 별도 프로세스로 띄워 stdio로 연결했다. Codex CLI와 Claude Code CLI가 MCP 서버에 연결하는 방식과 같은 전송 방식이다.

- `HIVEMIND_MCP_PROFILE=delivery`에서 도구 6개가 조회됐다.
- `hivemind_delivery_list`가 전달 작업 4건을 반환했다. 이 4건은 SQLite에서 DSQL로 이관된 작업이다.
- `hivemind_delivery_get`으로 작업 `dlv-6aa481f0-ac5e-4f75-990c-c8b1424ecea3`을 조회했다. Draft PR 주소(`https://github.com/roboco-io/project-hivemind/pull/10`), 검증 트리 해시와 PR 트리 해시의 일치, 2026-11-25의 사람 판단 기록이 그대로 있었다. 이관이 건수뿐 아니라 이 작업의 내용도 보존했음을 보여 준다.
- 도구 출력에 운영자 토큰은 없었다.
- 확인 후 Control Plane은 `desiredCount 0`이다.

협업 프로필(`collab`)의 도구는 `docs/verification/2026-11-26-collab-mcp-fargate-spot-live-proof.md`의 실증에서 같은 Control Plane을 상대로 호출했다. 그 실증은 MCP 서버를 같은 프로세스 안에서 연결했으며 stdio는 쓰지 않았다.

### 2-1. CLI 2종에서의 실제 대화 확인 (2026-11-27, 사용자 수행)

사용자가 Claude Code CLI와 Codex CLI에서 각각 "HIVEMIND MCP를 호출해서 응답이 오는지 확인해"라고 요청했다. 두 CLI 모두 `hivemind_status` 도구를 호출해 오류 없는 응답을 받았다. 응답은 `runtime: cloudflare`, `configured: false`, 작업 0건이었다. 기본 MCP 프로필의 이 도구는 폐기된 Cloudflare 경로의 상태를 보고하므로, AWS Control Plane에 연결했을 때 나오는 정상 값이다. 이 확인은 MCP 연결과 운영자 인증이 동작함을 보여 주며, AWS 경로의 데이터 조회(`delivery` 프로필)는 이 대화에서 호출하지 않았다.

첫 시도는 두 CLI 모두 실패했다. 원인과 조치는 다음과 같다.

| 클라이언트 | 설정 파일 | 실패 원인 | 조치 |
|---|---|---|---|
| Claude Code CLI | 프로젝트의 `.mcp.json` | `127.0.0.1:4311`에 터널이 없었고, 운영자 토큰이 MCP 서버에 전달되지 않았다. | Control Plane을 기동하고 4311 포트로 SSM 터널을 열었다. `HIVEMIND_OPERATOR_TOKEN_FILE`을 추가했다. |
| Codex CLI | 프로젝트의 `.codex/config.toml` | 운영자 토큰이 없어 Control Plane이 401을 반환했다. | 같은 `HIVEMIND_OPERATOR_TOKEN_FILE`을 추가했다. |

운영자 토큰은 설정 파일에 직접 쓰지 않았다. Secrets Manager의 값을 `~/.hivemind/aws-operator-token.json`(권한 `600`, `{"OPERATOR_TOKEN":"..."}` 형식)에 저장하고, 두 설정 파일에는 이 파일의 경로만 넣었다. 두 설정 파일은 `.git/info/exclude`로 Git 추적에서 제외된 로컬 파일이다. 설정을 바꾼 뒤에는 클라이언트를 다시 시작해야 했다. 이미 떠 있던 MCP 서버 프로세스가 이전 환경 변수를 들고 있었기 때문이다.

확인 후 터널을 닫고 Control Plane을 `desiredCount 0`으로 내렸다. 5개 리전의 관리 대상 실행 인스턴스는 0대였다.

## 3. `cloudflare/` 아카이브 정리

`cloudflare/` 디렉터리는 지우지 않았다. 지우면 컨테이너 이미지 4종의 빌드와 계약 테스트 10개 파일이 깨지기 때문이다. 대신 보관 범위와 제거 조건을 [ADR-0012](../adr/0012-cloudflare-archive-retention.md)로 정했다. 현행 코드가 아카이브에 의존하는 지점(어댑터 2개, Dockerfile 4개, 테스트 10개 파일, CI 워크플로 1개)을 2026-11-26에 검색해 ADR에 적었다.

아카이브에 대한 의존이 늘지 않도록 `tests/cloudflare-archive-boundary.test.ts`를 추가했다. `apps/`, `packages/`, `infrastructure/aws-runtime`의 소스 가운데 `cloudflare/` 아래 코드를 참조하는 파일이 어댑터 2개와 다르면 `npm run check`가 실패한다. AWS 단일 경로의 모듈이 Cloudflare 포트를 불러오지 않는다는 것도 같은 테스트가 확인한다.

현행 상태와 어긋나던 문장 3개를 고쳤다. `README.md`의 "Cloudflare 경로가 이 프로젝트의 목표인 원격 실행이다"와 "전체 AWS 실행 백엔드는 후속 범위다", `docs/roadmap.md`의 "Cloudflare에서 먼저 검증하고", `cloudflare/README.md`의 "현재 AWS 리소스를 생성하거나 배포하지 않는다"다. `README.md`와 `docs/mvp.md`에는 Cloudflare 구조를 설명하는 과거 서술이 더 남아 있다. 이번에는 현행 상태와 정면으로 어긋나는 문장만 고쳤고, 나머지는 과거 기록으로 표시한 머리말 아래에 그대로 두었다.

## 4. 남은 항목 (사용자 조치 필요)

1. **데스크톱 앱에서의 실제 대화 확인.** Codex 앱과 Claude Code 데스크톱 앱 화면에서 MCP 도구를 1회씩 호출해 보는 일이다. CLI 2종은 2-1절에서 확인했고, 데스크톱 앱 2종은 확인하지 않았다. 두 앱은 CLI와 같은 설정 파일을 읽으므로 Control Plane 기동과 4311 포트 터널만 다시 준비하면 된다.
2. **`hivemind-runtime/github-draft-pr` 비밀 교체.** 단일 저장소 Fine-Grained PAT를 발급해 등록하는 일이다. 새 토큰은 사용자만 발급할 수 있다.

자동 검증 결과는 `npm run check` 1,248건 통과, `infrastructure/aws-runtime` 테스트 9건 통과다.
