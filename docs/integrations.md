# 외부 도구와 실행 환경 통합

현재 구현은 모의 워커와 실제 로컬 Codex CLI 워커를 지원한다.
Claude·ChatGPT MCP·ECS·Cloudflare 연결은 후속 범위다.
공식 문서 확인 기준일은 2026-11-09이며 CLI 옵션은 설치된 0.166.0에서 확인했다.
계정 권한·모델 제공 범위·인증 상태는 실제 실행 환경에서 확인한다.

## 공통 실행 계약

`AgentAdapter.execute(task, signal)`은 결과 요약, diff, 금액과 선택적 실행 근거를 반환한다.
Codex 실행에는 저장소 ID·고정 base commit·테스트 프로필이 필요하다.
`ExecutionEvidence`는 base/HEAD, worktree 경로, Codex 상태와 선택적 세션·사용량,
준비·테스트의 argv·종료 코드·소요 시간·출력을 보존한다.

비용을 모르면 `actualCostMicros:null`로 보고한다. 토큰 수만으로 금액을 확정하지 않는다.
모의 비용과 실제 제공자 사용량을 같은 값으로 처리하지 않는다.
후속 확장에는 제공자 도구 승인, 가격표 버전, patch 해시, 시도별 실행 기록과 멱등성 키가 필요하다.

## Codex: 현재 로컬 실행

[공식 Codex CLI 문서](https://learn.chatgpt.com/docs/cli/reference)의 비대화형 `codex exec`를 사용한다.
설치된 CLI와 워커 계정의 `codex login` 인증을 재사용한다. 기존 ChatGPT 로그인도 사용할 수 있다.
새 SDK 의존성을 추가하지 않고 로컬 실행 파일을 호출한다.
명령은 shell 문자열 대신 argv와 stdin으로 전달한다.

CLI는 `--json`, `--ephemeral`, `--ignore-user-config`, `workspace-write`와 비대화형 승인 정책을 사용한다.
권한 우회 옵션을 사용하지 않는다. 추가 권한이 필요한 작업은 자동 승격하지 않는다.
JSONL에서 제공된 세션 ID, 최종 메시지와 토큰 사용량을 수집한다.
CLI 실패·시간 초과를 모의 실행으로 대체하지 않는다.

운영자는 서버·워커에 같은 저장소 루트와 테스트 명령을 설정한다.
서버가 시작할 때 고정한 커밋으로 작업별 detached worktree를 만들고,
Codex 실행 후 선택적 준비 명령과 테스트를 실행한다.
기본 테스트 argv는 `["npm","run","check"]`다. 의존성이 필요하면 준비 argv를 별도로 지정한다.
설정 방법은 [README의 실제 실행 절차](../README.md#실제-codex-실행)를 따른다.

Codex 추론 인증은 Codex 프로세스에만 전달한다. 관제 토큰은 자식 프로세스에 전달하지 않는다.
준비·테스트 프로세스에는 추론 인증 변수를 전달하지 않으며 별도 HOME과 최소 환경을 사용한다.
worktree는 Git 파일 변경을 분리하는 장치다. 저장소 코드가 실행되는 호스트의 보안 격리를 보장하지 않는다.
현재는 신뢰하는 로컬 저장소를 대상으로 한다.

[공식 Codex SDK 문서](https://learn.chatgpt.com/docs/codex-sdk)는 향후 프로그램 실행 제어의 대안이다.
지속 대화·인증·도구 승인·이벤트를 제품 수준에서 다루려면
[Codex App Server](https://learn.chatgpt.com/docs/app-server)를 별도 검토한다.
현재 CLI 어댑터가 도구별 승인 UI나 App Server를 구현했다는 뜻은 아니다.

## Claude Code

Claude Agent SDK 기반 어댑터는 후속 범위다.
도구 권한, 승인 대기, 실행 이벤트와 취소를 공통 계약으로 변환해야 한다.
Codex와 동일한 세션·이벤트 모델을 가정하지 않는다.
구현 기준은 [공식 Claude Agent SDK 개요](https://code.claude.com/docs/en/agent-sdk/overview)다.

## ChatGPT와 MCP

ChatGPT는 목표 입력과 작업 조회를 위한 대화 인터페이스로 연결할 계획이다.
MCP 서버는 중앙 API에 위임하고 자체 작업 상태나 별도 승인 저장소를 만들지 않는다.
제안 도구는 `list_tasks`, `get_task`, `create_task`다.
승인·취소 도구는 사용자의 신원과 권한을 전달할 수 있는 인증을 먼저 구현한 뒤 추가한다.
워커 토큰으로 사람의 결정을 기록해서는 안 된다.

앱 내 UI가 필요하면 [공식 MCP 서버 구현 문서](https://developers.openai.com/plugins/build/mcp-server)를
기준으로 호스트의 UI·인증 계약을 확인한다. 기존 앱 화면을 임의로 수정하는 구조에 의존하지 않는다.

## AWS ECS

실제 원격 실행의 첫 대상이다. 작업당 컨테이너가 워커 프로토콜로 중앙에 연결하도록 설계한다.
런타임 드라이버는 시작한 외부 실행 ID를 저장하고, 취소 시 해당 실행을 중지해야 한다.
임시 디스크·비밀·네트워크 자원 정리와 실행 종료를 확인해야 한다.
[공식 ECS standalone task 문서](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/standalone-tasks.html)는
작업 수행 후 종료하는 실행 모델을 설명한다.

계정·레지스트리·클러스터·리전과 원격 인증 경로는 지정하지 않았다.
현재 로컬 컨테이너 예시는 모의 실행용이며 Codex 설치나 인증을 포함하지 않는다.

## Cloudflare Containers

경량 작업의 대체 런타임으로 후속 평가한다.
[공식 Cloudflare Containers 문서](https://developers.cloudflare.com/containers/)를 기준으로
Worker 측 제어, 인스턴스 수명, 파일시스템과 네트워크 제약을 확인한다.
ECS와 같은 시작 API나 실행 수명을 가진다고 가정하지 않는다.
작업 시간·디스크·빌드 도구·외부 통신 요구를 검증한 뒤 도입한다.

`RuntimeDriver`는 실행 환경별 시작·중지의 경계다. ECS·Cloudflare 구현체는 아직 없다.
