# Claude quota 증거 파서

## 스키마 근거와 한계

- Dockerfile은 Claude Code 2.1.319를 고정한다. 버전을 변경하지 않는다.
- 캐시 이미지 `sha256:7cec24a41858ee820050e6d3fb0f772e30a0bc432fe95c52ff640de9333f8497`의 `/usr/local/lib/node_modules/@anthropic-ai/claude-code/package.json`에서 2.1.319를 확인했다.
- 같은 패키지 `bin/claude.exe`를 실행하지 않고 Node fs로 읽었다. 내장 `qvo=` 스키마는 status allowed/allowed_warning/rejected, 선택 정수 resetsAt, 선택 rateLimitType을 정의한다. 내장 설명은 resetsAt을 Unix epoch 초로 명시하며 실제 비교식도 `resetsAt*1000`이다.
- 검사는 node entrypoint, --pull=never, --network=none, --read-only, --cap-drop=ALL, no-new-privileges로 수행했다. 호스트 마운트·인증·Claude 실행은 없었다.
- 로컬 2.1.328의 Sus/n6/Qia/SGr도 같은 핵심 필드를 사용한다. 이 버전만으로 런타임 지원을 판정하지 않는다.
- 실제 체크인 기록: cloudflare/docs/phase0/cloudflare-claude-single-context-20261110.json:50(2.1.319), :178(rate_limit_event). 테스트는 해당 이벤트만 추출하며 다른 로그·인증을 사용하지 않는다. allowed와 overageStatus rejected가 함께 있다. 실제 blocked 기록은 미검증이다.

## 판정 계약

입력은 최대 UTF-8 4 MiB, 물리적 줄 5000개인 JSONL이다. 마지막 줄바꿈 하나를 허용한다. 모든 줄은 type 문자열을 가진 JSON 객체여야 한다. 잘못된 JSON·빈 내부 줄·혼합 session·오류 레코드·잘못된 quota 필드는 전체를 undefined로 만든다. session_id가 있는 모든 레코드는 UUID이며 인자로 받은 UUID와 정확히 일치해야 한다. quota 이벤트는 uuid와 session_id가 필수이며 child scope는 거절한다. 중복 quota uuid도 거절한다.

동일 세션의 마지막 유효한 최상위 status가 현재 증거다. allowed/allowed_warning은 앞선 rejected 대기를 지운다. 이후 rejected는 새 증거가 된다. overage/window 상태와 문자열 진단으로 대기를 만들지 않는다. 선택 필드 전체를 복제하거나 반환하지 않는다.

now/endsAt은 안전한 비음수 정수 밀리초다. rejected의 resetsAt은 안전한 양의 정수 epoch 초이며 밀리초 변환도 안전해야 한다. now < resetsAt*1000 < endsAt 조건을 요구한다. 반환 resetsAt의 단위는 밀리초다. malformed/noquota는 undefined이며 성공을 뜻하지 않는다.

파서 반환은 제한된 구조화 증거일 뿐 native authoritative wait가 아니다. 자동 재시도는 실제 중단·세션·사용량과 완전한 pause 프로토콜 증명이 필요하다. 이 절은 최초 독립 파서의 범위다. 후속 승인으로 확장한 범위는 아래 R6/core 절에 기록한다.

## R6 private pause 구현 설계

NativeClaudeResponse에 quota?:{kind:'rejected';resetsAt:number;evidence:'claude_rate_limit_event'}, usageUnavailable?:true를 추가한다. 입력 wire에는 활성화 옵션을 추가하지 않는다. 런타임의 신뢰된 in-process quotaPauseEnabled와 reporter의 quotaPauseEnabled가 모두 true이고 승인 billingPolicy가 subscription일 때만 새 경로를 허용한다. HTTP reporter도 서버 설정으로만 capability를 선언한다. 기본값은 비활성이다. executor와 runner는 검증된 quota 필드를 전달한다. worker/server gate 연결은 별도 담당자가 하며 자동 경로는 여전히 꺼져 있다.

기존 runProcess의 종료·process group stop await를 유지한다. 정상 exit 종료(0 또는 1), nontruncated capture만 후보로 삼는다. timeout/cancel/signal/spawn/capture 오류는 quota로 전환하지 않는다. 모든 init의 정확한 모델·세션·root scope와 private authorizer, 경계 증명을 유지한다. quota에 의해 종료된 오류 result도 성공 응답으로 해석하지 않는다.

2.1.319의 bin/claude.exe 내장 ia 스키마는 assistant.error에 rate_limit와 authentication_failed 등을 구분한다. result r1은 error_during_execution, 정수 duration_ms/duration_api_ms/num_turns, boolean is_error, stop_reason, usage, modelUsage, permission_denials, errors, uuid, session_id를 정의한다. n1 success에도 is_error:true가 가능하다. o1 설명은 API 오류가 success/is_error:true로 나올 수 있다고 명시한다. 오류 허용은 같은 세션의 구조화된 root assistant.error=rate_limit와 엄격한 terminal result 형태를 함께 요구한다. 다른 오류·인증 실패·permission denial·startup/runner 실패는 거절한다. 문자열 진단으로 quota를 추론하지 않는다. 실제 blocked 이벤트 조합은 아직 미검증이다.

quota pause는 실제 collectAutonomousSession을 호출해 parent transcript와 snapshot을 검증한 경우에만 sequence+1로 반환한다. 기존 checkpoint나 빈 transcript를 합성하지 않는다. 수집 후에도 reset 미래·endsAt 이전과 abort 상태를 다시 검사한다. 신뢰된 result usage가 없으면 모든 usage 숫자는 0 placeholder이며 usageUnavailable:true를 반드시 동반한다. 정상 응답은 기존 usage 필수 규칙을 유지한다.

receipt는 기존 실행 identity/sequence/usage/outcome/stopped와 quota, usageUnavailable을 함께 전송한다. reporter 성공 ack 전에 응답하지 않는다. 동결 후 추가 승인을 받아 main receipt 계약도 같은 공통 quota 타입으로 확장했다. core는 후속 작업에서 wait+checkpoint+subscription_runtime+trusted receipt를 결속해야 한다. unknown lease failed 변형은 변경하지 않는다.

private output 검증은 quota safe 필드만 허용하고 wait/wakeAt 일치, 미래 reset, nonnull 수집 bundle, usageUnavailable=true일 때 0 placeholder를 요구한다. request를 아는 adapter는 동일 session/model, sequence+1, endsAt 이전을 확인한다. cloud output envelope만으로 이전 sequence와 endsAt을 확인할 수 없으므로 그 검증은 request-bound adapter와 runtime에서 수행한다.

### 동결 후 core 계약

공통 AutonomousQuotaProof를 NativeResponse/RunResult/NativeReceipt가 공유한다. quota는 subscription Claude wait+checkpoint+정확한 다음 sequence+stopped receipt에서만 허용한다. finish는 quota 세 필드와 usageUnavailable을 receipt와 정확히 비교한다. 복원 시에도 quota+subscription_runtime+실제 checkpoint identity/sequence와 0 placeholder를 검증한다. 기존 lease 만료 failed usageUnavailable 변형은 그대로 유지한다. P1 recovery hard cap은 변경하지 않는다.

일일 스케줄 조합은 이번 구현에서 보수적으로 거절한다. runtime과 core 모두 schedule+quota를 차단한다. 향후 담당자는 reset 원본을 유지하고 effective wake=max(reset,nextDaily)를 결속하는 통합 테스트를 추가해야 한다. 현재 구현으로 scheduled quota pause 지원을 주장하지 않는다. main worker/API bridge는 후속이며 자동 경로는 여전히 기본 비활성이다.

### P1 예약 occurrence 지연 dispatch

이미 승인되어 nextRunAt에 저장된 정확한 일일 occurrence는 5분(300000ms) 동안 claim할 수 있다. 실제 startedAt은 실제 claim 시각을 기록한다. Task.activeScheduleAt과 Run.scheduledAt은 원래 occurrence 시각을 보존한다. claim 직후 pending nextRunAt을 제거하고 occurrence의 civil key를 lastScheduleKey로 소비한다. restore는 scheduledAt이 canonical occurrence이고 실제 startedAt이 [scheduledAt, scheduledAt+300000] 범위이며 civil key가 증가하는지 검증한다. 예약 시각은 승인 이전일 수 없다. 최초 승인 뒤 이미 지난 목표 시각은 계속 다음 날로 계산한다. 예약 후 지연이 5분을 초과하면 nextRunAt을 다음 occurrence로 재계산한다. endsAt이 남아 있으면 단지 지연 때문에 expire하지 않는다. 다음 날과 fold에서도 한 civil date에 한 번만 claim한다. 과거 exact-start 기록은 scheduledAt이 없는 형태로 계속 읽는다.
