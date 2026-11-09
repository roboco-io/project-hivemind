# ADR 0007: Claude Code 워커와 공통 로컬 실행

- 상태: 로컬 실행에 채택
- 날짜: 2026-11-09
- 갱신 범위: [ADR 0006](0006-local-codex-worktrees.md)의 로컬 실행을 Claude Code까지 확장한다.

## 배경

사람이 Codex 또는 Claude Code를 선택하되 저장소 격리·승인·실행 근거는 같은 기준으로 확인해야 한다.
제공자마다 worktree·테스트·diff 흐름을 따로 구현하면 실패·취소 처리와 근거가 달라질 수 있다.
기존 Codex 실행 기록도 보존해야 한다.

## 결정

설치된 Claude Code의 `--print --output-format json`을 사용하고 새 SDK 의존성은 추가하지 않는다.
옵션은 CLI 2.1.319에서 확인했으며 [프로그램 실행 문서](https://code.claude.com/docs/en/headless)와
[CLI 참조](https://code.claude.com/docs/en/cli-reference)를 기준으로 한다.
워커 계정의 정상 CLI 로그인과 제공자별 실행 파일·모델·시간 제한을 사용한다.

worktree 생성·준비·테스트·diff 수집·최종 종료 판정은 `local-execution`에 둔다.
Codex와 Claude 어댑터는 각 CLI의 결과만 공통 `AgentRunEvidence`로 변환한다.
고정 커밋과 승인 당시 테스트 argv를 사용하며 다른 설정의 워커는 실행 전에 거절한다.

Claude에는 `--restricted`, `--safe-mode`, `acceptEdits`와 파일 도구만 제공한다.
Read·Edit·Write·Glob·Grep 외 도구와 MCP 실행을 제공하지 않으며 자동 확장을 제외한다.
권한 우회 옵션은 사용하지 않는다. 파일 도구는 작업 디렉터리로 제한하지만
이를 Codex `workspace-write`와 동일한 OS sandbox로 설명하지 않는다.
준비·테스트는 공통 워커가 신뢰하는 저장소의 코드를 호스트에서 실행한다.
각 제공자의 인증 환경은 해당 CLI에만 전달하며 관제 토큰·추론 인증은 테스트에 전달하지 않는다.
macOS CLI 키체인 계정 식별에 필요한 비밀이 아닌 `USER`는 Claude 프로세스에만 보존한다.
자격증명 파일을 직접 읽거나 복사하지 않는다.

Claude 프로세스 종료 코드와 JSON 성공 상태를 함께 확인한다.
JSON 객체와 메시지 배열을 지원하되 배열은 마지막 항목이 유일한 result일 때만 허용한다.
권한 거절·refusal·오류 subtype·손상되거나 잘린 JSON을 성공으로 보고하지 않는다.
Claude 토큰 입력은 직접 입력·캐시 읽기·캐시 생성의 합계로 정규화한다.
금액은 두 실제 제공자 모두 null이다. CLI의 비용 보고를 실제 청구액으로 사용하지 않는다.

## 결과와 대안

대시보드는 Codex·Claude를 선택하고 제공자별 세션·모델·사용량·오류를 표시한다.
워커 claim은 제공자별로 분리한다. 서버의 지원 목록은 CLI 설치·인증·연결 완료를 뜻하지 않는다.
기존 `execution.codex` 기록을 유지하고 Claude는 `execution.claude`에 저장한다.
다른 제공자의 메타데이터나 두 제공자가 섞인 실행 근거는 중앙에서 거절한다.

파일 격리·실제 diff·테스트·취소 흐름을 공유하며 worktree는 계속 검토용으로 보존한다.
결과 수락은 원본 적용·커밋·푸시를 수행하지 않는다.
지속 대화·세부 도구 승인·이벤트 제어가 필요하면 제공자 SDK를 평가한다.
원격 보안 격리와 자원 정리는 ECS 등 후속 런타임에서 구현한다.
