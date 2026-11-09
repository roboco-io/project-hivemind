# 외부 도구와 실행 환경 통합

현재 구현은 모의 워커와 실제 로컬 Codex·Claude Code CLI 워커를 지원한다.
ChatGPT MCP·ECS·Cloudflare 연결은 후속 범위다.
공식 문서 확인 기준일은 2026-11-09다. CLI 옵션은 설치된 Codex 0.166.0과 Claude Code 2.1.319에서 확인했다.
계정 권한·모델 제공 범위·인증 상태는 실제 실행 환경에서 확인한다.

## 공통 실행 계약

`AgentAdapter.execute(task, signal)`은 결과 요약, diff, 금액과 선택적 실행 근거를 반환한다.
실제 실행에는 저장소 ID·고정 base commit·테스트 프로필과 작업에 복사한 테스트 argv가 필요하다.
두 제공자는 같은 `local-execution` 계층에서 worktree 생성·준비·테스트·diff 수집·종료 판정을 수행한다.
각 CLI 어댑터는 제공자의 출력만 `AgentRunEvidence`로 변환한다.

`ExecutionEvidence`는 base/HEAD, worktree 경로, 준비·테스트의 argv·상태·종료 코드·소요 시간·출력을 보존한다.
Codex 실행은 `execution.codex`, Claude 실행은 `execution.claude`에 세션·모델·사용량·오류를 저장한다.
기존 Codex 기록을 변환하거나 삭제하지 않는다. 작업 제공자와 다른 메타데이터나 두 제공자가 섞인 결과는 거절한다.

실제 제공자의 `actualCostMicros`는 `null`이다. 토큰 수나 Claude CLI의 `total_cost_usd`를 실제 청구액으로 확정하지 않는다.
Claude 입력 토큰은 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`로 정규화한다.
캐시 읽기는 별도 필드로 보존하며 출력 토큰도 제공된 값만 저장한다.
후속 확장에는 도구 승인·가격표 버전·patch 해시·시도별 실행 기록·멱등성 키가 필요하다.

## Codex: 현재 로컬 실행

[공식 Codex CLI 문서](https://learn.chatgpt.com/docs/cli/reference)의 비대화형 `codex exec`를 사용한다.
설치된 CLI와 워커 계정의 `codex login` 인증을 재사용한다. 기존 ChatGPT 로그인도 사용할 수 있다.
새 SDK 의존성을 추가하지 않고 실행 파일을 호출하며 명령은 argv와 stdin으로 전달한다.

CLI는 `--json`, `--ephemeral`, `--ignore-user-config`, `workspace-write`와 비대화형 승인 정책을 사용한다.
권한 우회 옵션을 사용하지 않는다. 추가 권한이 필요한 작업은 자동 승격하지 않는다.
JSONL의 최종 성공 이벤트와 프로세스 결과를 함께 확인한다.
CLI 실패·시간 초과·잘못된 출력을 모의 성공으로 대체하지 않는다.

[Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)와
[App Server](https://learn.chatgpt.com/docs/app-server)는 지속 대화·인증·도구 승인·상세 이벤트가 필요할 때 검토한다.
현재 CLI 어댑터가 App Server나 도구별 승인 UI를 구현했다는 뜻은 아니다.

## Claude Code: 현재 로컬 실행

[공식 프로그램 실행 문서](https://code.claude.com/docs/en/headless)와
[CLI 참조](https://code.claude.com/docs/en/cli-reference)의 `claude --print --output-format json`을 사용한다.
워커 계정에서 `claude auth login`을 완료하며 CLI의 기존 로그인을 재사용한다.
`HIVEMIND_PROVIDER=claude`와 제공자별 실행 파일·모델·시간 제한을 설정한다.
공통 저장소·테스트·준비 명령은 Codex와 같은 설정을 사용한다.
구체적인 명령은 [README](../README.md#실제-claude-code-실행)에 있다.

Claude는 `--restricted`, `--safe-mode`, `acceptEdits`와 Read·Edit·Write·Glob·Grep 목록으로 실행한다.
파일 도구의 범위를 작업 디렉터리로 제한하고 Bash·웹·에이전트·MCP 도구를 제공하지 않는다.
빈 MCP 구성과 strict 설정, 훅 비활성화와 세션 비보존 옵션을 전달한다.
사용자·프로젝트의 자동 확장을 실행에 포함하지 않으며 권한 우회 옵션도 사용하지 않는다.
인증은 Claude CLI의 정상 경로를 사용한다. 이 정책을 Codex `workspace-write`와 같은 OS sandbox로 간주하지 않는다.

종료 코드 0만으로 성공을 판정하지 않는다.
JSON의 `type=result`, `subtype=success`, `is_error=false`와 정상 결과를 확인한다.
권한 거절·refusal·오류 subtype·손상되거나 잘린 JSON은 성공으로 저장하지 않는다.
세션 ID와 모델·사용량은 Claude가 보고한 값만 사용한다.
준비 명령과 테스트는 Claude의 도구가 아닌 공통 워커가 별도로 수행한다.

## 저장소·인증 경계

운영자는 서버와 각 실제 워커에 같은 저장소 루트와 테스트 명령을 설정한다.
서버가 노출한 제공자 목록은 지원 범위이며 CLI 설치·로그인·워커 연결 여부의 확인은 아니다.
워커는 자신의 제공자 작업만 claim하며 고정 base와 승인 당시 테스트 argv를 사용한다.
정책이 다르면 실행 전에 거절한다. 결과의 argv도 해당 작업 snapshot과 대조한다.

제공자별 인증 환경은 해당 CLI에만 전달한다. 관제 토큰은 모델·준비·테스트 프로세스에 전달하지 않는다.
준비·테스트는 추론 인증을 제외한 최소 환경과 별도 HOME으로 실행한다.
worktree는 Git 파일 변경을 분리하지만 저장소 코드가 실행되는 호스트의 보안 격리를 보장하지 않는다.
현재는 신뢰하는 로컬 저장소가 전제다.

## ChatGPT와 MCP

ChatGPT는 목표 입력과 작업 조회를 위한 대화 인터페이스로 연결할 계획이다.
MCP 서버는 중앙 API에 위임하고 자체 작업 상태나 별도 승인 저장소를 만들지 않는다.
제안 도구는 `list_tasks`, `get_task`, `create_task`다.
승인·취소 도구는 사용자의 신원과 권한을 전달하는 인증 경로를 먼저 구현한 뒤 추가한다.
워커 토큰으로 사람의 결정을 기록해서는 안 된다.

앱 내 UI가 필요하면 [공식 MCP 서버 구현 문서](https://developers.openai.com/plugins/build/mcp-server)를
기준으로 호스트의 UI·인증 계약을 확인한다. 기존 앱 화면을 임의로 수정하는 구조에 의존하지 않는다.

## AWS ECS

실제 원격 실행의 첫 대상이다. 작업당 컨테이너가 워커 프로토콜로 중앙에 연결하도록 설계한다.
런타임 드라이버는 외부 실행 ID를 저장하고 취소 시 해당 실행을 중지해야 한다.
임시 디스크·비밀·네트워크 정리와 실제 종료를 확인해야 한다.
[공식 ECS standalone task 문서](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/standalone-tasks.html)는
작업 수행 후 종료하는 실행 모델을 설명한다.

계정·레지스트리·클러스터·리전과 원격 인증 경로는 지정하지 않았다.
현재 Dockerfile·Compose 예시는 모의 실행용이며 Git·Codex·Claude CLI나 인증을 포함하지 않는다.

## Cloudflare Containers

경량 작업의 대체 런타임으로 후속 평가한다.
[공식 Cloudflare Containers 문서](https://developers.cloudflare.com/containers/)를 기준으로
Worker 측 제어·인스턴스 수명·파일시스템·네트워크 제약을 확인한다.
ECS와 같은 시작 API나 실행 수명을 가진다고 가정하지 않는다.
작업 시간·디스크·빌드 도구·외부 통신 요구를 검증한 뒤 도입한다.

`RuntimeDriver`는 실행 환경별 시작·중지의 경계다. ECS·Cloudflare 구현체는 아직 없다.
