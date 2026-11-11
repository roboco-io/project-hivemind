# 네 클라이언트에서 시작한 Cloudflare 작업 검증

2026-11-11 KST. 대상은 전용 저장소 `dashboard-remote-fixture`, 기준 커밋은 `e481d2d26f43a194b4c0dbb13f28649df12eb6a3`이다. 각 검증은 같은 기준 커밋에서 `alpha.mjs`의 합과 `beta.mjs`의 곱을 고친다. `alpha.mjs`에 작업 제목을 주석으로 남겨 해당 실행의 diff를 식별한다.

| 클라이언트 | 워커 | 작업 ID | 승인 후 관찰한 원격 단계 | 최종 조회 |
|---|---|---|---|---|
| Codex CLI 0.167.0 | Codex | `cf-81bda6f1-e71e-45d4-8578-5babe50fbd32` | `QUEUED` | `awaiting_review / SUCCEEDED` |
| Codex CLI 0.167.0 | Claude | `cf-c1934f33-030d-41e7-9222-0b9d6329800e` | `RUNNING` | `awaiting_review / SUCCEEDED` |
| Claude Code CLI 2.1.321 | Codex | `cf-c11ab06b-20a8-40d2-a2e3-82b5cc285e4b` | `RUNNING` | `awaiting_review / SUCCEEDED` |
| Claude Code CLI 2.1.321 | Claude | `cf-f90a9099-2957-4955-850c-955fb408d935` | `RUNNING` | `awaiting_review / SUCCEEDED` |
| Codex 앱 | Codex·Claude | — | — | 기존 검증 채팅에 실행 지시를 보낼 사용자 응답 대기 |
| Claude Code 앱 | Codex·Claude | — | — | Mac 잠금 해제 대기 |

두 CLI는 실제 MCP에서 상태와 대상 커밋을 확인한 뒤 작업을 등록했다. 각 등록 및 승인 직전 조회는 `awaiting_execution_approval`과 원격 `jobId: null`을 반환했다. 작업별 `approve` 호출은 `queued / QUEUED`를 반환했다. 각 CLI의 후속 조회는 같은 ID로 `includeDiff`와 `includeLogs`를 켜고 결과를 가져왔다.

네 diff는 `alpha.mjs`의 `add`와 `beta.mjs`의 `multiply`를 수정하고 해당 작업의 고유 주석을 추가했다. 모든 에이전트 종료 코드는 0이었다. 각 작업의 `unit-a`와 `unit-b` 로그에서 `sum`·`product` 2개 통과, 실패 0개, 종료 코드 0을 확인했다. 결과의 인증 저장, 컨테이너 종료, 검증 단계의 인증 미주입과 소스 불변 표시가 모두 true였다. diff와 로그의 잘림 표시는 false였다. 각 작업의 예산 메타데이터는 100,000 micros이며 실제 비용은 미확정이다.

앱에서 기존 실행을 조회한 근거는 [별도 검증 기록](2026-11-10-claude-clients.md)에 있다. 이번 새 작업은 모두 결과 검토 대기 상태로 남겼다.

저장소의 `npm run check`도 통과했다. 테스트 148개 통과, 실패 0개다.
