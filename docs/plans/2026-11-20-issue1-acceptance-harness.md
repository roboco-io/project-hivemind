# 이슈 #1 후속 프로젝트 인수 도구

## 범위와 상태

사용자 요청으로 실제 24시간 실행, 외부 자원 시험, Fable 모델 확인은 후속 실제 프로젝트로 미뤘다. **검증 면제이며 검증 성공이 아니다.** 이번 A2는 로컬 계획·등록 복구·조회·보고 도구만 제공한다. 모델, 제공자, 유료 자원, 배포를 실행하지 않았다. 이 문서는 이슈 전체 완료를 선언하지 않는다.

소유 파일은 `cloudflare/backend/scripts/autonomous-acceptance.ts`, `cloudflare/backend/test/autonomous-acceptance.test.ts`, 이 문서다. 기존 dirty 파일은 수정하지 않는다.

## 명령

저장소 루트에서 Node 24로 실행한다. 아래 대문자 값은 운영자가 확정한 값으로 바꾼다. 모델 ID의 문법만 검사하며 실제 제공 여부는 확인하지 않는다. 목표 API에는 HTTPS origin만 지정한다. 자격 값 대신 등록된 자격 ID를 지정한다.

```sh
node cloudflare/backend/scripts/autonomous-acceptance.ts plan \
  --manifest /PRIVATE/acceptance.json \
  --origin https://EXPLICIT-WORKER-HOST \
  --request-id EXPLICIT-UNIQUE-ID \
  --model CONCRETE-MAIN-MODEL \
  --subagent-model CONCRETE-SUBAGENT-MODEL \
  --credential-id REGISTERED-CREDENTIAL-ID \
  --ends-at EXPLICIT-UNIX-MILLISECONDS \
  --budget-micros EXPLICIT-POSITIVE-INTEGER \
  --max-iterations EXPLICIT-INTEGER \
  --max-run-ms EXPLICIT-INTEGER
```

기간은 계획 생성 후 24시간 이상, 56일 이하다. 반복 한도는 3–65536, 회당 시간은 1000–120000ms다. 반복 한도·사용 한도·조기 종료로 24시간을 채우지 못할 수 있다. 주 모델과 서브에이전트 모델은 별도 고정한다. 초기 snapshot과 검사 명령도 manifest 해시에 고정한다.

등록은 다음 명령을 **명시적으로 호출할 때만** 수행한다. 인증 파일은 운영자 소유 일반 파일이며 하드링크 수는 1, 권한은 0600, 내용은 `{"controlToken":"..."}`다. 인증 값은 출력하거나 manifest에 저장하지 않는다. manifest의 부모 디렉터리도 운영자만 접근하도록 준비한다.

```sh
node cloudflare/backend/scripts/autonomous-acceptance.ts register --manifest /PRIVATE/acceptance.json --auth-file /PRIVATE/auth.json
node cloudflare/backend/scripts/autonomous-acceptance.ts observe --manifest /PRIVATE/acceptance.json --auth-file /PRIVATE/auth.json
node cloudflare/backend/scripts/autonomous-acceptance.ts report --manifest /PRIVATE/acceptance.json
```

등록은 snapshot PUT과 초안 POST만 수행한다. **approve를 호출하지 않는다.** 운영자는 반환된 작업 ID·revision과 고정 계획을 검토한 뒤 기존 승인 경로에서 별도로 승인한다. 이 도구에는 승인 인수가 없다.

manifest는 최초 덮어쓰기를 거절하고 0600으로 저장한다. 비공개 파일은 `O_NOFOLLOW | O_NONBLOCK`으로 열고 일반 파일·소유자·0600·nlink=1을 검사한다. FIFO와 심볼릭 링크·하드링크를 거절한다. 등록 전에 uncertain 상태를 원자적으로 저장한다. 응답 유실 후 같은 manifest로 register를 다시 호출하면 동일 requestId와 동일 spec을 사용한다. 서버의 requestId 중복 방지 계약에 의존하며 새 ID로 우회하지 않는다. 성공한 작업 ID·revision을 저장한 뒤에는 다시 등록하지 않는다.

동시 등록은 `.lock`으로 차단한다. 프로세스가 비정상 종료하면 잠금이 남을 수 있다. 잠금 안의 PID와 기존 프로세스 종료를 운영자가 확인한 뒤 잠금만 제거하고 같은 manifest를 재사용한다. 자동 잠금 만료나 새 작업 생성은 하지 않는다. manifest 임시 파일이 남으면 원본을 보존한다. 등록 상태가 모호하면 승인하지 않는다.

observe는 summary, 4종 history 전체 페이지, cloud-result를 GET으로 조회한다. revision/spec이 바뀌면 거절한다. spec은 객체 키 순서와 무관하게 깊은 동등성으로 비교하며 배열 순서와 실제 필드 값은 대조한다. 서버 기본값을 추측해서 채우지 않는다. 비밀·checkpoint·세션 데이터·자유 형식 메시지를 저장하지 않고 허용 필드만 `.observation`에 0600으로 저장한다. report는 네트워크 없이 이 파일을 읽고 planHash를 대조한다. history별 페이지는 고정 경계지만 여러 API 조회 전체가 하나의 트랜잭션은 아니므로 진행 중 집계 차이는 재조회한다.

## 근거와 한계

| 기준 | 사용 근거 또는 미검증 이유 |
|---|---|
| 24시간 | history/runs의 실제 시작·종료 시각 범위, 반복 3건 이상, history/interventions의 승인 1건만 허용. 로컬 대기 시간은 제외한다. 이 범위는 연속 가동 증명이 아니다. |
| 재시작 뒤 같은 세션·캐시 | 공개 history는 usage를 제공하지만 session/checkpoint와 재시작 근거를 제공하지 않는다. 캐시 토큰만으로 성공 판정하지 않는다. |
| 실제 Bash·Agent | 공개 API와 cloud-result에는 도구 transcript가 없다. 허용 목록·goal·counter 변경·actions 집계로 실행을 추론하지 않는다. 미검증이다. |
| 대기 중 무호출·예약 재개 | wait/wakeAt만으로 모델 호출 부재를 증명할 수 없다. 독립 dispatch 감사와 재개 시각 근거가 필요하다. 미검증이다. |
| 비용 중단·유료 자원 정리 | 현재 계획은 systems가 비어 있다. 외부 작업 예산만 지정하며 모델·플랫폼 금액 상한은 보장하지 않는다. 미검증이다. |
| 취소·정리 | 읽기 조회는 취소를 실행하지 않는다. 별도 승인된 취소와 제공자 종료 확인이 필요하다. stopped/authSynced는 유료 자원 종료 증명이 아니다. |
| 개입·도움 요청·행동 집계 | summary.counts와 interventions/actions 페이지를 함께 반환한다. help와 사람 개입을 분리한다. actions는 외부 행동 기록이며 전체 native 도구 호출 수가 아니다. |

보고서의 각 기준에는 source 또는 구체적인 미충족 이유가 있다. 실제 실행 면제 상태는 `actualProof: deferred_by_user`, 전체 검증은 `verified: false`다. 실제 근거를 제공하는 후속 확장 전에는 이를 성공으로 변경하지 않는다.

## 집중 검사

```sh
node --test cloudflare/backend/test/autonomous-acceptance.test.ts
```

이번 세션에서 기능 부재와 관측 파일 범위 불일치의 실패를 먼저 확인한 뒤 수정했다. 최종 집중 테스트 12건 통과, 실패 0건이다. 실제 `handleAutonomousApi`와 트랜잭션 메모리 저장소의 `AutonomousService`·엔진을 연결해 등록 응답 유실 후 동일 ID 복구, 서비스 재생성, 실제 summary 본문, history의 taskId/revision/kind, 101건의 100+1 페이지 조회를 검증했다. snapshot 저장과 cloud-result만 시험 응답을 사용하며 모델은 실행하지 않는다. 중첩 spec 키 순서 변경·하드링크·FIFO의 실패를 먼저 재현한 뒤 수정했다. 전체 검사·빌드·runtime stamp·배포·실제 모델 호출은 A2 지시에 따라 실행하지 않았다. 최종 통합 검사는 조율자가 담당한다.
