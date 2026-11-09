# Codex·Claude 병렬 실행 검증 절차

Codex 작업 1개와 Claude 작업 1개를 동시에 실행했는지,
각 결과가 서로 격리된 실제 실행 근거를 갖는지 확인하는 절차다.
이 문서는 절차만 설명한다. 측정한 시간·테스트 수치·성공 여부는
실제로 수행한 뒤 [verification.md](verification.md)에 기록한다.

## 준비

- 관제 서버에 저장소 정책(`repositoryId`·`baseCommit`·테스트 명령)을 설정한다.
- `codex` 워커와 `claude` 워커를 각각 하나씩 띄운다. 두 워커가 같은 저장소를 대상으로 해야 한다.
- 대시보드에서 제공자를 `codex`, `claude`로 각각 선택해 작업 2개를 등록한다.
- 두 작업을 실행 승인한다. 한 작업이 끝나기 전에 다른 작업도 `running`이 되도록
  두 승인을 연달아 수행한다.

준비 명령과 테스트는 워커가 실행한다. 검증자는 결과를 직접 고치지 않는다.

## 동시 실행 판정

각 작업의 `running` 구간은 이벤트 기록(`/api/state`의 `events`)에서 구한다.

- 시작: 해당 작업의 `run.started` 이벤트 `at`
- 종료: 해당 작업이 `running`을 벗어난 이벤트(`run.result`, `run.failed`,
  `run.expired`, `task.cancelled` 등)의 `at`

두 구간을 A=[A시작, A종료], B=[B시작, B종료]라 할 때
**`A시작 < B종료` 이고 `B시작 < A종료`인 경우에만 동시 실행으로 판정한다.**
구간이 겹치지 않으면 두 작업이 모두 성공했더라도 순차 실행이므로 병렬 검증으로 인정하지 않는다.
두 `run.started`의 `data.workerId`가 서로 다른지도 확인한다.

## 작업별 확인 항목

Codex 작업과 Claude 작업 각각에 대해 아래를 확인한다.

1. **제공자**: 작업의 `provider`가 등록 시 선택한 값과 같고,
   실행 근거에 해당 제공자 항목(`execution.codex` 또는 `execution.claude`)만 있다.
2. **고정 base**: `execution.baseCommit`이 해당 작업에 저장된 `baseCommit`과 같고,
   두 작업의 base가 서로 같다. 실행 후 `headCommit`이 base와 같은지도 확인한다.
3. **서로 다른 worktree**: 두 작업의 `execution.worktreePath`가 서로 다르다.
   원본 체크아웃이 검토 전까지 변경되지 않았는지 확인한다.
4. **실제 diff**: `diff`가 비어 있지 않고 작업 지시에 맞는 파일만 변경한다.
   `diffTruncated`가 `true`이면 전체 diff를 확인할 수 없음을 기록한다.
   두 작업의 diff가 서로의 변경을 포함하지 않는지 확인한다.
5. **테스트**: `execution.tests`의 `command`가 해당 작업의 `testCommand` snapshot과 같고,
   `exitCode`·`status`·`stdout`을 확인한다. 성공 판정은 종료 코드 0과
   stdout의 실제 테스트 결과로 한다. 준비 명령이 있으면 `execution.setup`도 같은 방식으로 확인한다.
6. **승인·결과 수락**: 이벤트에 실행 승인(`approval.decided`, 실행 단계)이
   `run.started`보다 먼저 있다. 결과가 `awaiting_review`일 때만 사람이 diff·테스트를 검토한 뒤
   결과를 수락하고, 수락 이벤트와 최종 `completed` 상태를 확인한다.
   실패 결과는 수락하지 않는다.

## 기록 원칙

- 실제 이벤트 시각, 테스트 수, 종료 코드는 확인한 값만 기록한다.
- 비용을 수집하지 못하면 `actualCostMicros=null`로 두고 추정하지 않는다.
- 공개 기록과 캡처에는 개인 정보와 절대 로컬 경로(`worktreePath` 등)를 숨긴다.
- 실패·재시도도 삭제하지 않고 원인과 함께 남긴다.
