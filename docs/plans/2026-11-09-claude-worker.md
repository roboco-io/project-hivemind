# Claude Code 워커 추가

## 목표와 결정

대시보드에서 Codex와 Claude Code를 선택하고, 선택한 제공자의 워커만 작업을 가져간다.
같은 고정 커밋·테스트 명령·worktree·실제 diff·결과 수락 흐름을 재사용한다.
요청에 포함된 구현·실제 실행 검증·커밋·GitHub 푸시를 진행한다.

- 설치된 Claude Code CLI의 print JSON 출력을 사용한다. 새 SDK 의존성을 추가하지 않는다.
- `--restricted`, `--safe-mode`, 파일 도구 목록과 `acceptEdits`로 작업 공간의 파일 편집만 허용한다.
  Bash·웹·에이전트 위임·MCP 실행과 권한 우회 옵션은 사용하지 않는다.
- Claude 로그인은 CLI가 처리하며 인증 정보와 관제 토큰은 결과·테스트 환경으로 전달하지 않는다.
- worktree 생성·준비·테스트·diff 수집·실행 종료 판정은 공통 실행 계층으로 묶는다.
- 기존 `execution.codex` 기록을 보존하고 Claude 결과는 `execution.claude`로 구분한다.
  작업 제공자와 다른 실행 근거 또는 두 제공자가 섞인 결과는 거절한다.
- 실제 과금은 기존과 같이 미확정(null)으로 기록한다. CLI 토큰 사용량만 정규화해 표시한다.
- `HIVEMIND_PROVIDER=claude`, `HIVEMIND_CLAUDE_BIN/MODEL/TIMEOUT_MS`를 추가한다.
  공통 저장소·준비·테스트 설정과 기존 Codex 환경 변수는 유지한다.
- Windows와 원격 컨테이너 보안 격리는 확장하지 않는다. 테스트는 신뢰하는 저장소의 호스트 실행이다.

## 구현 순서

1. 공통 실행 근거 계약과 제공자별 검증·분배를 확장한다.
2. Claude JSON 성공·오류·권한 거절·취소·시간 초과를 실제 subprocess fixture로 검증한다.
3. 워커 설정·factory·대시보드 선택과 제공자별 메타데이터 표시를 연결한다.
4. 기존 Codex 실행·저장 기록을 회귀 검증하고 두 제공자의 HTTP 통합을 확인한다.
5. 임시 Git 저장소에서 실제 Claude 작업의 diff·테스트를 확인한다.
6. README·ADR·검증 기록을 갱신하고 검증된 변경을 논리적 커밋으로 푸시한다.

## 수용 조건

- 세 제공자 mock/codex/claude의 claim이 섞이지 않는다.
- 승인 전 실행 불가, 실행 명령 snapshot 유지, 취소·만료 후 결과 거절.
- 원본 파일·index를 보존하며 실제 새 파일·수정·삭제 diff와 테스트 결과를 저장한다.
- 실패·손상된 JSON·권한 거절을 성공으로 보고하지 않는다.
- 이전 Codex 기록을 그대로 조회하고 수락할 수 있다.
- 실제 Claude 실행 1회와 자동 테스트·브라우저·GitHub 검사 결과를 확인한다.
