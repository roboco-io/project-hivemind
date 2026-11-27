# 2026-11-27 검증 보고서 — MCP에서 Control Plane 기동과 종료

이 문서는 MCP 도구 `hivemind_control_plane_start`와 `hivemind_control_plane_stop`의 구현과 확인 결과를 기록한다. 실 AWS 확인은 2026-11-27에 계정 `<AWS_ACCOUNT_ID>`, 프로필 `roboco`에서 했다.

## 1. 무엇을 만들었는가

AWS Control Plane은 평소 `desiredCount 0`으로 꺼져 있고, API는 SSM 포트 포워딩 터널로만 닿는다. 이전에는 HIVEMIND를 쓰려면 사람이 ECS 서비스를 올리고 터널 스크립트를 따로 실행해야 했다. 이제 기본 프로필의 MCP 서버가 두 도구로 이 일을 한다. 동작과 설정은 [MCP 서버 안내](../../apps/mcp-server/README.md)의 "Control Plane 기동과 종료" 절에 있다.

결정된 방식은 명시적 도구와 유휴 자동 종료다. 기동은 과금을 일으키므로 `hivemind_status`를 포함한 다른 도구가 대신 일으키지 않는다. 이 서버가 켠 Control Plane은 운영자 도구 호출이 15분 동안 없고 진행 중인 작업이 없으면 스스로 내려간다.

## 2. 자동 검증

`npm run check`는 1,292건이 모두 통과했다. `tests/control-plane-power-mcp.test.ts`(11건)는 AWS와 Control Plane을 가짜로 바꿔 다음을 확인한다.

- 기동은 서비스를 올리고, 작업을 기다리고, 터널을 연다. 다시 호출해도 서비스 변경과 터널이 한 번만 일어난다.
- 기동이 호출보다 오래 걸리면 `starting`을 돌려주고, 다음 호출이 같은 기동의 결과를 받는다.
- 기동이 실패하면 이 호출이 올린 서비스는 0으로 내리고, 다른 주체가 올린 서비스는 내리지 않는다.
- 종료는 진행 중인 작업이 있으면 거절하고, 막고 있는 기록의 ID를 돌려준다. `force: true`는 거절을 건너뛴다.
- API에 닿지 않으면 진행 중인 작업을 추측하지 않고 거절한다.
- 유휴 종료는 유휴 시간이 지난 뒤에만, 이 서버가 켠 경우에만 일어나고, 진행 중인 작업이 있으면 일어나지 않는다.
- MCP 서버가 닫힐 때 이 서버가 켠 Control Plane을 내린다. 진행 중인 작업이 있으면 내리지 않는다.
- 설정 파일은 엄격하게 읽는다. 파일이 없거나 잘못되면 도구는 아무것도 하지 않고 설정 방법을 안내한다.
- `hivemind_status`는 휴지 상태를 오류가 아닌 상태로 보고하며, 어떤 조회 도구도 Control Plane을 켜지 않는다.

## 3. 실 AWS 확인

MCP 서버 코드를 로컬에서 직접 띄워 도구를 호출했다. 이 세션에 연결된 MCP 서버 프로세스는 이전 코드로 떠 있어서 새 도구가 없었기 때문이다.

| 단계 | 결과 |
|---|---|
| `hivemind_status` (휴지 상태) | `connected: false`, `controlPlane.state: stopped`. 오류가 아닌 일반 응답 |
| `hivemind_control_plane_start` | 49초 만에 `state: running`, `started: true` |
| `hivemind_status` (기동 후) | `connected: true`, 세 저장소의 상태별 건수 반환 |
| `hivemind_control_plane_stop` | 거절. `inProgress.deliveryTasks: 1` |
| MCP 서버 종료 | 터널은 닫혔다. Control Plane은 내려가지 않았다 |

종료가 거절된 이유는 2026-11-25에 만든 전달 작업 `dlv-a3cbdbd7-65ca-4ad5-aae5-4932fba5a816`이다. 이 작업은 `running` 상태로 남아 있는데, ECS 작업 ARN을 기록하는 기능이 생기기 전에 만들어져 Control Plane이 워커의 생사를 확인할 근거가 없다. Control Plane의 정리 경로는 근거가 없는 작업을 `failed`로 바꾸지 않는다. 그래서 종료 도구는 이 작업을 진행 중으로 셌고, 설계대로 내리지 않았다.

이 실행에서 Control Plane이 켜진 채 남았으므로 AWS CLI로 직접 `desiredCount 0`으로 내렸다. 그리고 거절 응답이 막고 있는 기록을 알려 주도록 고쳤다. 응답에 `blockingIds`(진행 중으로 센 기록의 ID)와 `unverifiable`(근거가 없어 정리하지 못한 기록과 그 이유)을 넣었다. 이 수정은 단위 테스트로 확인했고, 실 AWS에서 다시 실행하지는 않았다.

### 오래된 작업 취소 후 재확인

사용자의 지시로 위 전달 작업을 취소하고 같은 날 다시 확인했다.

| 단계 | 결과 |
|---|---|
| `hivemind_control_plane_stop` (취소 전) | 거절. `blockingIds`와 `unverifiable`에 `dlv-a3cbdbd7-…`과 이유 `no ECS task recorded; cancel the task if its worker is gone` |
| `hivemind_delivery_cancel` | 작업이 `cancelled`로 바뀜 |
| `hivemind_control_plane_stop` (취소 후) | `stopped: true`. AWS CLI로 확인한 `desiredCount`는 0 |
| 유휴 자동 종료 (유휴 시간을 1분으로 줄인 설정) | 기동 후 도구를 호출하지 않았고, 64초 뒤 `desiredCount`가 0이 됨 |
| 종료 후 | 로컬 포트 4311 닫힘, 남은 `session-manager-plugin` 프로세스 0개 |

이 실행에서 결함 하나가 드러나 고쳤다. 기동이 호출 대기 시간(50초)을 넘긴 뒤 끝나면, 다음 `start` 호출이 `started: true` 대신 `alreadyRunning: true`를 돌려줬다. 이제 그런 기동의 결과를 다음 호출에 한 번 전달한다. 이 수정은 단위 테스트로 확인했다.

## 4. 한계와 미검증 항목

- **유휴 자동 종료는 유휴 시간 1분 설정으로 확인했다.** 기본값 15분으로는 기다려 보지 않았다. 진행 중인 작업이 있을 때 자동 종료가 미뤄지는 것은 단위 테스트로만 확인했다.
- **근거 없는 `running` 기록은 자동 종료를 계속 막는다.** 운영자가 취소해야 풀린다. 이 상태에서는 Control Plane이 켜진 채 남을 수 있다.
- **이 서버가 켠 Control Plane을 다른 클라이언트가 함께 쓰는 경우**, 이 서버는 그 사용을 알지 못해 유휴로 판단하고 내릴 수 있다.
- **클라이언트가 MCP 서버를 강제 종료하면** 종료 처리가 실행되지 않아 Control Plane이 켜진 채 남는다.
- **Claude Code와 Codex의 실제 MCP 연결에서 새 도구를 호출하지는 않았다.** 두 클라이언트를 다시 시작해야 새 도구가 보인다.
