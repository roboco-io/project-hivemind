# Codex 앱·CLI 연결

이 문서는 현재 구현된 Codex 등록 어댑터의 사용 안내다.
1차 지원 대상은 Codex·Claude Code의 앱·CLI 네 접점이며, [지원 설계·미완료 목록](client-support.md)을 따른다.
Claude Code용 등록·스킬 어댑터는 아직 구현되지 않았다.
웹 관제실은 선택적인 검증·관리 보조 화면이다. 이 연동은 상시 앱 HUD가 아니다.

MCP는 기존 중앙 HTTP API만 호출한다. SQLite, Cloudflare 제어 토큰과 제공자 인증에는 직접 접근하지 않는다.
원격 실행 전 승인과 결과 수락은 기존 core 정책을 따른다.

## 프로젝트에 등록

Node.js 24 이상이 필요하다. 중앙 서버의 원격 저장소·고정 커밋·필수 검증 설정을 먼저 확인하고 서버를 실행한다.
설정은 [환경 변수 예시](../.env.example)와 [아키텍처](architecture.md)를 참고한다.
서버와 연결할 같은 프로젝트 루트에서 실행한다.

```sh
npm ci
npm run build
npm run mcp:configure
```

설치 도구는 현재 프로젝트의 `.codex/config.toml`에 `hivemind` 생성 블록을 추가한다.
실행한 Node의 절대 경로, 프로젝트의 컴파일된 MCP 진입점과 작업 디렉터리를 기록한다.
기본 중앙 API 주소는 `http://127.0.0.1:4310`이다.
다른 로컬 포트나 운영자 토큰 파일을 쓰면 다음과 같이 지정한다.

```sh
npm run mcp:configure -- --api-url http://127.0.0.1:4311 --operator-token-file /absolute/path/to/private/operator.json
```

운영자 파일은 `OPERATOR_TOKEN`을 담은 JSON이며 권한은 `0600`이어야 한다.
중앙 서버의 운영자 토큰과 같은 값을 사용한다. 설치 도구는 파일 경로만 기록하며 토큰 내용을 읽거나 복사하지 않는다.
Cloudflare `CONTROL_TOKEN`과 제공자 인증 파일은 MCP 설정에 넣지 않는다.
토큰 파일을 생략한 기본 개발 인증은 loopback 주소에만 사용한다. 외부 서버는 HTTPS와 운영자 인증이 필요하다.

컴파일된 설치 도구 없이 Node 24의 TypeScript 실행 기능으로도 등록할 수 있다.
다음 경로는 모두 사용자 환경에 맞게 바꾸는 예시다. MCP 서버 자체는 먼저 빌드해야 한다.

```sh
/absolute/path/to/node /absolute/path/to/project/scripts/configure-hivemind-mcp.ts --project-root /absolute/path/to/project --node-path /absolute/path/to/node --api-url http://127.0.0.1:4310
```

다른 Codex 설정은 보존하며 같은 생성 블록만 갱신한다. 반복 실행해도 내용이 중복되지 않는다.
사용자가 직접 만든 같은 이름의 MCP 설정, 잘못된 생성 블록, 추적 중인 프로젝트 설정 또는 symlink 경로는 안전하게 중단한다.
생성 파일은 원자적으로 교체하고 권한을 `0600`으로 설정한다.
생성 설정은 같은 저장소의 Git 공통 `info/exclude`에 등록한다. 연결된 worktree에서도 같은 제외 규칙을 사용한다.
기존 `.gitignore`와 사용자 전역 `~/.codex` 설정은 수정하지 않는다.

프로젝트를 신뢰한 상태에서 열어야 프로젝트 설정이 적용된다.
설정 후 새 Codex 세션을 열고, 도구나 스킬이 보이지 않으면 앱 또는 CLI를 다시 시작한다.
스킬은 저장소의 `.agents/skills/hivemind/SKILL.md`에 있으며 `$hivemind`로 호출할 수 있다.
프로젝트 설정과 스킬 탐색은 [공식 MCP 안내](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)와 [공식 스킬 안내](https://learn.chatgpt.com/docs/build-skills)를 따른다.

## 사용하는 도구

| 도구 | 역할 |
|---|---|
| `hivemind_status` | 연결, 고정 저장소 정책과 작업 상태 수 확인 |
| `hivemind_list_tasks` | 최대 20개 작업 요약 |
| `hivemind_create_task` | Codex·Claude 원격 작업 초안 생성 |
| `hivemind_decide_task` | 실행 승인 또는 검토 결과 수락·반려 기록 |
| `hivemind_cancel_task` | 작업 중단 요청 |
| `hivemind_get_result` | 상태와 실제 diff·검증 로그 조회 |

설치 설정의 `default_tools_approval_mode = "writes"`는 읽기 전용으로 표시되지 않은 도구에 호스트 승인 정책을 적용한다.
따라서 생성·결정·취소 도구는 승인 화면이 나올 수 있다. 상태·목록·결과 조회는 읽기 전용이다.
이는 [공식 MCP 도구 승인 정책](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)에 따른다.
호스트의 도구 승인과 HIVEMIND의 실행 승인은 별개다. 초안 생성은 원격 실행이 아니다.

예를 들어 다음처럼 요청한다.

> $hivemind 현재 연결 대상과 기준 커밋을 확인해 줘.
>
> $hivemind 이 프로젝트에서 합계 함수 개선 작업을 Codex 초안으로 등록해 줘. 아직 실행하지 마.
>
> $hivemind 방금 등록한 작업을 실행 승인하고 상태를 확인해 줘.
>
> $hivemind 해당 작업의 실제 diff와 테스트 결과를 보여 줘.

스킬은 등록 전에 사용자의 대상 저장소·커밋과 서버 정책을 대조한다.
다르면 작업을 만들지 않고 차이를 알린다. 현재 작업 폴더가 자동 업로드된다고 가정하지 않는다.
원격 작업은 서버에 고정된 커밋의 별도 worktree에서 실행한다.

중단 요청은 실제 종료가 확인될 때까지 `running / CANCELLING`일 수 있다.
실패·미보고·잘린 로그를 구분하며, 금액을 모르면 미확정으로 표시한다.
결과 수락은 검토 기록이며 원본 적용·커밋·병합·push가 아니다.
MCP나 Codex를 종료해도 이미 제출한 원격 작업을 자동 취소하지 않는다.

## 공유 설정 예시

실제 생성 파일에는 개인 절대 경로가 있으므로 커밋하지 않는다. 다음은 형식 확인용 placeholder다.

```toml
[mcp_servers.hivemind]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/project/dist/apps/mcp-server/src/main.js"]
cwd = "/absolute/path/to/project"
default_tools_approval_mode = "writes"

[mcp_servers.hivemind.env]
HIVEMIND_API_URL = "http://127.0.0.1:4310"
# 필요할 때만 경로를 등록한다. 토큰 값을 넣지 않는다.
HIVEMIND_OPERATOR_TOKEN_FILE = "/absolute/path/to/private/operator.json"
```

연결 문제는 먼저 `hivemind_status`로 확인한다. MCP 시작 자체가 실패하면 빌드 결과, Node 경로, 중앙 서버 주소와 운영자 파일 권한을 점검한다.
비밀 값이나 인증 원본을 대화에 붙여 넣지 않는다. 기존 원격 credential stream을 사용하며 로컬 인증 시드를 재등록하지 않는다.
