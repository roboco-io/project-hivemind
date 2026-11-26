# 2026-11-27 검증 보고서 — 실행 주체가 사라진 뒤 남는 진행 중 상태의 정리

이 문서는 워커, 검증기, 학습 인스턴스가 결과를 보고하지 못하고 사라졌을 때 HIVEMIND의 기록이 "진행 중"으로 남던 문제를 고친 내용과, 실 AWS에 남아 있던 기록으로 확인한 결과를 적는다. 대상 계정은 `<AWS_ACCOUNT_ID>`, 프로필은 `roboco`다. 아래 값은 2026-11-27에 직접 실행해 얻었다.

## 1. 문제

세 저장소 모두 같은 문제가 있었다. 실행 주체는 보통 자신의 결과를 직접 보고한다. 스팟 회수, 메모리 부족, 준비 단계 이전의 충돌로 보고하지 못하고 사라지면 기록을 바꿀 주체가 없어 상태가 그대로 남았다.

| 대상 | 남던 상태 | 영향 |
|---|---|---|
| 협업 하위 작업 | `running` | 병렬 워커 자리를 계속 차지한다. 세션을 끝낼 MCP 도구도 없었다. |
| SW 전달 작업 | `running` | 실패가 드러나지 않는다. 취소해도 ECS 작업은 계속 돌았다. |
| Model Factory 작업 | 인스턴스 `running`, 정산 없음 | EC2가 종료된 인스턴스를 약 1시간 뒤 조회 결과에서 지우면, wake가 매번 "instance not found" 오류로 끝나 예약 금액이 원장에 계속 남았다. |

## 2. 고친 내용

**공통 원칙.** 실행 주체가 사라졌다는 근거가 있을 때만 기록을 바꾼다. 근거는 ECS가 작업을 `STOPPED`로 답하거나 더 이상 모르는 것, EC2가 인스턴스를 더 이상 나열하지 않는 것이다. 상태 조회 자체가 실패한 경우는 근거로 보지 않고 건드리지 않는다. 그사이 결과가 보고됐으면 덮어쓰지 않는다.

**협업.** `hivemind_collab_reconcile`이 워커가 사라진 하위 작업을 `failed`로 바꾸고 게시판에 사유를 남긴다. `hivemind_collab_complete`가 세션을 끝낸다. `completed`는 `running` 하위 작업이 남아 있으면 거절하고, `failed`와 `cancelled`는 실행 중인 워커를 먼저 중지한다.

**SW 전달.** 작업이 실행 중인 ECS 작업(워커 또는 검증기)의 ARN을 기록한다. `hivemind_delivery_reconcile`이 ECS 작업이 사라진 작업을 `failed`로 바꾼다. 워커는 종료 직전에 결과를 넘기고 그 직후 검증기가 기동되므로, ECS 작업이 끝난 뒤 2분 동안은 바꾸지 않는다. 취소는 기록된 ECS 작업도 중지한다. ARN 기록이 없는 예전 작업은 자동으로 바꾸지 않는다.

**Model Factory.** wake가 "인스턴스 없음"을 종료로 처리해 정산한다. 실제 종료 시각을 알 수 없으므로 실행 시간은 만료 시각을 넘지 않는 것으로 계산한다. 다른 EC2 오류는 종료의 근거로 보지 않고 그대로 실패시킨다.

자동 검증은 `npm run check` 1,262건 통과, `infrastructure/aws-runtime` 테스트 9건 통과다. 추가한 테스트 파일은 `tests/collab-session-end.test.ts`(5건)와 `tests/orphan-reconcile.test.ts`(3건)다.

## 3. 실 AWS에 남아 있던 기록으로 확인한 결과

배포된 Control Plane에 프로젝트의 `.mcp.json` 설정 그대로 stdio MCP로 연결해 확인했다.

### 협업 세션 `ses-f3eb21f7-1ad1-43e8-8444-24e42deacbd5`

2026-11-26 실증에서 워커 2대가 모델 인증 단계에서 죽어 하위 작업 2건이 `running`으로 남아 있던 세션이다.

- `hivemind_collab_complete`의 `completed` 요청은 거절됐다.
- `hivemind_collab_reconcile`이 2건을 확인해 모두 `failed`로 바꿨다. 사유는 "Worker task is no longer known to ECS and never reported a result"다.
- `hivemind_collab_complete`로 세션을 `failed`로 끝냈다.

### Model Factory 작업 `mf-8360532b-9f6b-4977-9944-305d604d646a`

2026-11-26의 이슈 #12 실증 작업이다. 인스턴스 `i-01ecc42438f759369`가 `running`으로 기록되어 있었지만 EC2에는 없었고, 예약 50,000 micros가 남아 있었다.

- 새 이미지를 기동하자 Control Plane의 주기 wake가 이 작업을 정산했다. 따로 호출한 것은 없다.
- 정산 금액은 831 micros, 과금 시간은 299초, 인스턴스 상태는 `terminated`가 됐다. 진단에 "Settled for an instance EC2 no longer lists; run time is bounded by the expiry time"가 남았다.
- 원장의 예약 합계는 50,000 micros에서 0이 됐다.

831 micros는 수명 상한 299초에 스팟 상한가를 곱한 추정치다. 실제 실행 시간은 이보다 짧았을 수 있으며 실제 청구액은 조회하지 않았다.

### SW 전달 작업 `dlv-a3cbdbd7-65ca-4ad5-aae5-4932fba5a816`

2026-11-25부터 `running`인 작업이다. `hivemind_delivery_reconcile`은 이 작업을 바꾸지 않고 "no ECS task recorded; cancel the task if its worker is gone"이라고 답했다. 이 작업은 ECS 작업 ARN을 기록하기 전에 만들어졌기 때문이다. 이 작업은 취소하지 않았다. 사용자의 이전 실행 기록이고, 취소는 `hivemind_delivery_cancel`로 할 수 있다.

확인 후 터널을 닫고 Control Plane을 `desiredCount 0`으로 내렸다. 5개 리전의 관리 대상 실행 인스턴스는 0대였다.

## 4. 한계와 미검증 항목

- **ECS 작업이 실제로 사라진 전달 작업을 `failed`로 바꾸는 경로는 실 AWS에서 실행하지 않았다.** 남아 있던 전달 작업에는 ARN 기록이 없어 대상이 아니었다. 이 경로는 단위 테스트로만 확인했다.
- **살아 있는 워커를 취소로 중지하는 경로도 실 AWS에서 실행하지 않았다.** 협업과 전달 모두 단위 테스트로만 확인했다.
- **정리는 사람이 도구를 호출해야 실행된다.** 협업과 전달의 정리는 주기 실행이 아니다. Model Factory만 Control Plane의 주기 wake가 처리한다. Control Plane이 꺼져 있으면 그 wake도 돌지 않는다.
- **전달 작업의 실패 처리는 재시도하지 않는다.** 워커가 스팟 회수 신호를 받아 직접 보고하면 재시도하지만, 보고 없이 사라진 경우는 원인을 알 수 없어 `failed`로 끝낸다.
