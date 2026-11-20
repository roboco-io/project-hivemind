# R3 웹 접근: 호스트 정책과 컨테이너별 outbound 권한

## 결정

- Ruling: 기존 로컬 구현 승인을 유지한다. core/contracts/native Claude/tool hook/managed settings는 다른 작업 소유다.
- 서버 `AUTONOMOUS_WEB_ENABLED === 'true'`와 쉼표로 구분한 `AUTONOMOUS_WEB_ALLOWED_HOSTS`가 모두 필요하다. 기본은 차단이다.
- 향후 `spec.web.allowedHosts`는 서버 상한과 교차 검증한다. 상한 밖 요청은 거절한다. 승인 시 정규화한 호스트 목록을 private approval에 고정한다.
- 승인 → private native job → Runner 메타데이터 → `ctx.exports.NativeClaudeOutbound({props})`로 전달한다. 요청 헤더는 권한이 아니다. 작업 ID·실행 시도·기한도 결속한다.
- provider/control의 기존 HTTPS·역할 토큰 경로는 별도로 유지한다. 웹 호스트에 provider/control 도메인이나 그 하위 도메인을 넣을 수 없다.

## 정책과 전송

- 정확한 ASCII DNS 이름과 HTTPS/443만 허용한다. IP 표기·축약/정수/16진수 IP·local/private 이름·와일드카드·사용자 정보·다른 포트·provider/control 별칭을 거절한다.
- 웹은 GET/HEAD만 허용하고 인증·쿠키·사용자 지정 헤더를 전달하지 않는다. 리다이렉트는 따라가지 않고 차단한다.
- transport는 완전한 DNS 별칭과 주소를 반환해야 한다. 모든 별칭은 승인 호스트여야 하고 모든 주소는 공개 주소여야 한다. 검증한 주소로만 전송해야 하며 재조회하면 안 된다.
- Worker fetch만으로 DNS 검사와 실제 연결 주소의 동일성을 보장했다고 주장하지 않는다. Worker는 서버 웹 활성화·상한 allowlist·컨테이너 grant·production connector 존재를 모두 확인한 뒤 transport를 전달한다. DoH 공개 주소 검증 후 literal IP:443 연결과 원래 호스트의 TLS/SNI를 결속한다. 테스트에서는 DNS·소켓을 합성한다.
- `web.allowedHosts`와 canonical WebFetch 도구를 core/native 정책에 결속한다. managed PreToolUse가 URL을 검사한다. 서버만 만드는 outer `allowWebFetch`가 true일 때 runtime이 WebFetch를 허용한다. 자식 Agent의 도구는 Bash만 유지한다. 서버 플래그는 기본 비활성이다.

## 구현과 검사

1. helper 실패 테스트: 호스트 문법, 서버 상한, URL, redirect, DNS 별칭/공개 주소, 인증 헤더 제거.
2. helper 구현과 승인/private job/Runner props 연결. 서버 웹 설정은 승인 fingerprint에 포함한다.
3. 실제 entrypoint의 기본 차단·헤더 권한 위조 거절, 서로 다른 컨테이너 props 격리를 합성 호출로 검사한다.
4. 집중 회귀와 backend typecheck. 실제 fetch·DNS·모델·배포·runtime stamp는 수행하지 않는다.

근거: Cloudflare Workers `ctx.exports` 문서 https://developers.cloudflare.com/workers/runtime-apis/context
현재 `worker-env.d.ts`의 LoopbackServiceStub(props), WorkerEntrypoint<Env, Props>, Container.interceptAllOutboundHttp/interceptOutboundHttps 타입을 대조했다. 원격 런타임 실증은 후속이다.


## native·quota·패키징 동결 계약

- Native request의 web/externalProfiles는 승인 spec과 deep equality로 대조한다. 외부 provider credential은 전달하지 않는다. trusted `options.actionChannel`의 origin/workerToken과 canonical 실행 lease만 전용 0600 action-input.json에 projection한다. top-level executionDeadline은 approved.deadline을 그대로 기록하며 heartbeat 때 파일을 다시 쓰지 않는다. config는 landed createAutonomousActionMcpConfig를 사용하고 argv/env에 token을 넣지 않는다.
- quotaPauseEnabled는 server outer 입력에서만 만들고 reporter/runtime에 함께 전달한다. fingerprint에 서버 활성 여부를 결속한다. receipt/run의 원래 resetsAt·wakeAt·usageUnavailable을 Worker가 core로 보존한다.
- daily+quota의 reset은 다음 실행의 하한이다. finish의 임시 raw wake를 제거한 뒤 중앙 scheduleNext가 마지막 occurrence 이후의 승인된 daily 시각을 계산한다. 5분 grace는 canonical daily occurrence에만 적용한다. CLI는 시간대를 계산하지 않는다.
- Docker context는 cloudflare로 유지한다. scripts/runtime-build.ts의 syncRuntimeAutonomousContract({sourceRoot,runtimeRoot,check})가 공유 계약을 backend/src/runtime-shared/autonomous.ts에 정확한 바이트로 생성·대조한다. CLI --write/--check에서 호출하고 원본 hash를 기록한다. runtime consumer는 image 내부 vendor만 값 import한다. 순수 buildRuntimeManifest(tempRoot)는 부모 저장소를 읽지 않는다.
- root packages가 없는 임시 image 구조에서 policy/authorizer/protocol import를 검증했다. 이는 실제 Docker bootstrap이나 Workers TLS canary 근거가 아니다. 모든 작업 동결 후 runtime stamp와 이미지의 모델 호출 없는 smoke가 남는다.
- C3 인계: actor external factory·profile hashes 선검사·core 승인 뒤 broker snapshot 승인·외부 route·취소/종료 hook·bounded cleanup alarm·설정/비밀 fingerprint를 연결한다. Volta/Dirac는 getSummary/historyPage와 세 private external operation의 저장·복구 쓰기를 연결한다.

## 2026-11-20 동결 근거와 인계

집중 검사: root 190 passed / 0 failed / 0 skipped, backend 156 passed / 0 failed / 0 skipped. backend `npm run typecheck` 종료 코드 0. 전체 검사와 runtime stamp는 coordinator가 모든 생산자 동결 후 실행한다.

```sh
npm run build && node --test dist/tests/autonomous-policy.test.js dist/tests/autonomous-accepted-external.test.js dist/tests/autonomous-quota-core.test.js dist/tests/autonomous.test.js dist/tests/autonomous-cloud.test.js dist/tests/autonomous-claude.test.js dist/tests/autonomous-native-integration.test.js dist/tests/autonomous-runner.test.js dist/tests/autonomous-api.test.js dist/tests/autonomous-external-api.test.js
node --test cloudflare/backend/test/autonomous-policy-runtime.test.ts cloudflare/backend/test/autonomous-claude-runtime.test.ts cloudflare/backend/test/autonomous-tool-hook.test.ts cloudflare/backend/test/autonomous-quota-runtime.test.ts cloudflare/backend/test/autonomous-web.test.ts cloudflare/backend/test/autonomous-web-transport.test.ts cloudflare/backend/test/autonomous-cloud-runtime.test.ts cloudflare/backend/test/autonomous-cloud-ports.test.ts cloudflare/backend/test/autonomous-cloud-integration.test.ts cloudflare/backend/test/autonomous-long-running-integration.test.ts cloudflare/backend/test/runtime-build.test.ts
```

본 작업 소유 변경 파일(이전 단계 변경을 포함한다):

- packages/contracts/src/autonomous.ts
- packages/contracts/src/autonomous-native.ts
- packages/core/src/autonomous.ts
- apps/control-plane/src/autonomous-api.ts
- packages/adapters/src/autonomous-claude.ts
- cloudflare/backend/src/cloudflare/worker.ts
- cloudflare/backend/src/cloudflare/api.ts
- cloudflare/backend/src/cloudflare/autonomous-ports.ts
- cloudflare/backend/src/runtime/autonomous-web.ts
- cloudflare/backend/src/runtime/autonomous-claude.ts
- cloudflare/backend/src/runtime/autonomous-tool-hook.ts
- cloudflare/backend/src/runtime/autonomous-authorize.ts
- cloudflare/backend/src/runtime/autonomous-from-file.ts
- cloudflare/backend/src/autonomous-cloud-protocol.ts
- cloudflare/backend/config/claude-managed-settings.json
- cloudflare/backend/scripts/runtime-build.ts
- cloudflare/backend/src/runtime-shared/autonomous.ts
- tests/autonomous-policy.test.ts
- tests/autonomous-accepted-external.test.ts
- tests/autonomous-quota-core.test.ts
- cloudflare/backend/test/autonomous-policy-runtime.test.ts
- cloudflare/backend/test/autonomous-quota-runtime.test.ts
- cloudflare/backend/test/autonomous-web.test.ts
- cloudflare/backend/test/runtime-build.test.ts
- docs/plans/2026-11-20-autonomous-web.md
- docs/plans/2026-11-20-autonomous-external.md

root autonomous.ts와 생성 vendor의 SHA-256은 `ae064013b1625e332094e96cdd0396611cf965cc3c7d5b3c8c61ce142502ef2b`이다. sync helper의 check:true로 정확한 바이트 일치를 검사했다. runtime-build.json은 이 작업에서 갱신하지 않았다.

확정된 private signature: acceptExternal(lease,actionId,resource|undefined,now), settleExternal(id,actionId,actualCostMicros,success,now), cleanedExternal(id,resourceId,now). 최종 검증 비용과 자원 부재가 확인된 reserved/unknown도 resource가 없으면 private 정산할 수 있다. accepted의 기존 자원은 cleaned가 되어야 정산한다. getSummary(id)·historyPage({id,kind,limit?,cursor?})는 persistence Reflect hook이다.

C3 actor 조합은 별도 미완료다. worker의 nativeApprovalReady externalProfiles 거절 및 approve 503은 조합 전 default-closed 경계다. factory·assertApproval·동일 core 승인 뒤 external approve·외부 routes·mutation hooks·bounded cleanup alarm·설정/비밀 fingerprint로 교체한다. root app의 private route auth 앞 404도 같은 경계를 유지해야 한다. Volta/Dirac의 저장 hook과 복구 operation 추가는 확인했지만 최종 교차 검증은 coordinator가 수행한다.

남은 실증: runtime stamp 후 실제 Docker image의 모델 호출 없는 bootstrap smoke, Workers의 실제 DNS/IP/TLS/SNI canary, provider·장기 실행·대용량 학습 산출물 종단 실증. 이 문서의 Node fixture·합성 CLI·DNS·소켓 근거는 실제 원격 실행을 증명하지 않는다.

## 리뷰 수정 P1/P2 및 core 메모리 작업 인계

- P1: reset 전 기록한 stopped quota receipt와 runtime/run binding·usage·checkpoint가 정확히 일치하면 verifier/finish가 reset 뒤 도착해도 원래 reset을 보존한다. 과거 일반 wait는 계속 거절한다. 기록 시 새 quota receipt의 reset은 미래여야 한다. 복원한 runtime-evidenced quota history는 reset > startedAt으로 검사하며 finishedAt 이후 reset을 요구하지 않는다. 다음 tick에 즉시 eligible 또는 다음 승인 daily occurrence로 진행한다.
- P2: 공개 cleaned는 MCP 외부 자원의 상태를 바꾸지 못하며 409를 반환한다. 실제 broker absence 뒤 private cleanedExternal만 사용한다. 일반 legacy 자원의 인간 확인 동작은 유지한다.
- red: 대상 21개 중 18 passed / 3 failed. 수정 후 root core/bridge 집중 회귀 142 passed / 0 failed, backend quota/native 집중 회귀 33 passed / 0 failed. root build 및 backend typecheck 종료 코드 0.

```sh
npm run build && node --test dist/tests/autonomous-quota-core.test.js dist/tests/autonomous-accepted-external.test.js dist/tests/autonomous.test.js dist/tests/autonomous-cloud.test.js dist/tests/autonomous-subscription.test.js dist/tests/autonomous-external-api.test.js
node --test cloudflare/backend/test/autonomous-quota-runtime.test.ts cloudflare/backend/test/autonomous-quota.test.ts cloudflare/backend/test/autonomous-claude-runtime.test.ts
```

packages/core/src/autonomous.ts는 이 수정 후 Volta 메모리 최적화 작업으로 인계한다. 기존 clone 전략은 유효한 24MiB 상태에서 OOM 근거가 있으므로 현재 상태를 R1 candidate로 주장하지 않는다. memory 수정·교차 검증·전체 proof는 별도 남은 작업이다. Worker 두 파일은 C3 소유이며 이 리뷰 수정에서 편집하지 않았다.
