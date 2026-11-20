# Private 외부 행동 MCP sidecar

## 범위

새 runtime/autonomous-action-mcp.ts, test/autonomous-action-mcp.test.ts와 이 문서만 소유한다. native Claude, tool hook, Worker, API, core와 bootstrap은 수정하지 않는다. standalone 구현이며 실제 모델 실행 연결이나 원격 격리를 완료했다고 보고하지 않는다. 공용 네트워크·모델·제공자·비밀 조회·배포·커밋은 수행하지 않는다. 테스트만 loopback HTTP와 MCP SDK를 사용한다.

## 공개 연결 계약

서버 이름은 hivemind, 도구 이름은 action, Claude 도구 식별자는 mcp__hivemind__action으로 고정한다.

createAutonomousActionMcpConfig({command,args,privateInputPath})는 mcpServers.hivemind의 stdio command/args 설정을 만든다. args에는 신뢰하는 bootstrap이 정한 sidecar module 경로를 넣으며 helper는 --private-input과 경로를 덧붙인다. helper는 프로세스나 shell을 실행하지 않는다. command/args/path는 bootstrap 설정이지 모델 입력이 아니다. env에는 인증을 넣지 않는다. bootstrap 담당자는 별도로 정확한 도구 이름을 허용하고 기존 Bash/Agent의 경계를 보존해야 한다.

createActionTool(privateInput, {fetchImpl?,now?,timeoutMs?,signal?})은 모델 입력만 받는 비동기 함수를 반환한다. createActionMcpServer(privateInput,options)는 테스트와 다른 transport 연결용 MCP server를 만든다. startActionMcpStdio({privateInputPath,...options})는 private 파일을 읽고 stdio server에 연결한다. 명시적 main(argv)은 --private-input 경로만 받는다. 직접 실행한 경우에만 main을 호출하고 import로 실행하지 않는다.

## Private 파일

bootstrap이 canonical 승인/실행 요청에서 전용 최소 파일을 작성한다. 기존 native-input 전체를 읽거나 autonomous-from-file을 import하지 않는다. 이 분리로 순환 import와 불필요한 구독 인증 접근을 피한다.

파일 형식:

```ts
{version:1,runtimeId:string,executionDeadline?:number,
 request:{taskId:string,executionLease:AutonomousLease,maxRunMs:number,
          externalProfiles?:string[]},
 control:{origin:string,workerToken:string}}
```

externalProfiles는 canonical request의 미래 필드에서 복사한다. 누락/빈 배열은 disabled이며 systems/환경 변수/다른 credential 설정으로 대체하지 않는다. 파일과 부모는 symlink를 거절한다. 부모는 현재 UID 소유이며 group/world writable이 아니어야 한다. 파일은 현재 UID 소유, regular, nlink=1, 정확히 0600, 최대 64KiB다. descriptor로 bounded read하고 전후 inode/size/mode/owner/mtime/ctime를 검사한다. Linux는 열린 부모 directory fd에 결속한다. 파일 문자열은 strict UTF-8/JSON으로 해석한다.

실행 identity와 workerToken은 private closure에만 유지한다. MCP 설정, 모델 입력/출력, stderr에는 포함하지 않는다. 이 파일의 디렉터리를 모델 sandbox에 mount하지 않는 것은 bootstrap 담당자의 필수 조건이다.

## 모델 입력과 HTTP

profileId/requestId/operation/parameters만 받는다. operation은 aws.spot.start, aws.spot.inspect, hf.model.commit, github.branch.push의 판별 유니온이다. lifetimeMs, startActionId, artifactDigest/message, artifactDigest/expectedHead를 엄격히 검사한다. unknown field, URL, token, task/revision/lease/runtime identity, command와 임의 옵션은 거절한다. profileId는 private externalProfiles에 포함되어야 한다. profile의 실제 대상·권한·상한 검사는 중앙 broker가 수행한다.

POST 대상은 private control.origin의 정확한 /v1/autonomous-tasks/:taskId/external-action 하나뿐이다. origin은 HTTPS만 허용하며 loopback HTTP는 로컬 테스트/개발에 한정한다. path/query/hash/userinfo가 붙은 origin은 거절한다. JSON body는 {lease:executionLease,runtimeId,request:{profileId,requestId,operation,parameters}}다. taskId는 path와 outer lease에만 두며 중앙이 taskId/revision을 결속한다. revision은 모델이 보내지 않으며 중앙이 lease와 승인 상태에서 결정한다. 인증은 Bearer workerToken이다. redirect:error를 사용하며 응답 origin 변경과 redirected 응답도 거절한다.

모델 JSON·HTTP body·응답은 각각 최대 64KiB다. 신뢰 설정 timeoutMs의 기본값은 55초로 SDK의 통상 60초 한도보다 짧게 둔다. 신뢰 bootstrap만 최대 120초까지 설정할 수 있고 모델 args에서는 거절한다. 실제 대기는 매 요청 min(timeoutMs, executionDeadline - currentTime)이며 CLI maxRunMs도 최대 120초다. executionDeadline은 canonical nativeStart의 approved.deadline을 새 private writer가 항상 기록한다. 생성 시 future safe integer, start+maxRunMs 이하를 검사한다. 필드가 없는 legacy 입력만 초기 lease/maxRun 한도로 fail-closed다. parent heartbeat로 갱신된 중앙 lease를 매 요청 중앙에서 검증하며 sidecar는 lease나 절대 실행 한도를 갱신하지 않는다.

Provider 준비의 최악 경로는 guard attest 25초, arm 15초, Run/inspect 약 5초로 약 45초다. 모델이 이미 실행 시간을 사용했다면 그 합보다 남은 native window가 짧을 수 있다. 이 경우 남은 시간에서 반드시 중단하며 준비 완료를 위해 새 120초 구간을 만들지 않는다. 응답을 받은 뒤에도 절대 실행 한도를 다시 확인한다. fetch/body가 AbortSignal을 무시해도 sidecar 대기는 중단한다.

Timeout/HTTP 실패는 side effect 부재의 근거가 아니다. broad retry나 새 requestId의 자동 생성·재전송은 하지 않는다. 중앙 원장 조회 또는 사용자가 명시한 복구에서는 같은 requestId와 동일 입력을 유지하여 유료 효과가 중복되지 않게 한다. SDK 60초 한도를 넘어 신뢰 timeout을 늘릴 경우 그 호출자의 SDK 대기도 별도로 맞춰야 하며 native hard deadline은 계속 우선한다.

## 응답과 오류

중앙 응답은 ExternalPublicAction이다. requestId/phase를 보존하고 actionId/status/operation/effect/cleanupStatus/verifiedCostMicros/billingFinal/upperBoundMicros/reservedMicros는 실제 반환한 경우에만 투영한다. 미측정 값을 0으로 만들지 않는다. 잘못된 금액·예약 조합과 requestId/operation 불일치는 generic error로 거절한다. 실제 초과 금액은 예산이나 0으로 clamp하지 않는다. evidenceId/raw broker id/ownership/idempotency/auth/parameters는 노출하지 않는다. 알려진 worker/lease token/runtime identity가 공개 문자열에 들어 있으면 전체 응답을 거절한다. 오류는 고정 문구이며 HTTP 본문·SDK validation detail·예외 메시지를 반사하지 않는다.

선택적 providerResult는 엄격한 판별 유니온으로만 노출한다. github_commit/hf_commit은 소문자 16진수 40·64자리 oid, aws_instance는 i- 뒤 소문자 16진수 8~32자리 id만 허용한다. 추가 필드와 잘못된 값은 전체 응답을 거절한다. requestId와 operation이 요청과 일치하고 actionId가 있으며, status가 succeeded이고 phase가 broker/settled/cleaned인 경우만 허용한다. github.branch.push와 hf.model.commit은 각각 해당 commit 종류와 retained 효과, aws.spot.start는 aws_instance와 resource 효과, aws.spot.inspect는 aws_instance와 none 효과가 필요하다. 누락한 providerResult는 만들지 않는다.

모델은 첫 GitHub push의 providerResult.oid를 다음 push의 expectedHead로 사용한다. CLI에 제공자 인증을 전달하거나 인증된 읽기 도구를 추가하지 않는다. raw providerReceipt·근거·소유권·인증·운영자 billing 권한은 계속 제외한다. providerResult에도 기존 알려진 비밀의 부분 문자열 검사를 적용한다.

MCP SDK registerTool의 기본 validation 오류가 입력 값을 반사하지 않도록 raw callTool 처리에서 검증하고 고정 오류로 응답한다. tools/list는 엄격한 JSON Schema 하나만 공개한다. stdio에는 MCP protocol 외 출력이 없다. frame 자체도 64KiB 상한을 적용하며 oversized/잘못된 UTF-8 입력은 transport를 닫는다. 정상 SDK Client를 통한 handshake/list/call과 실제 stdio 경로를 검사한다.

## 자체 검토와 후속 작업

기본 disable, identity 주입, unknown field/operation, lease/실행 만료, 파일 모드/symlink/hardlink, HTTP redirect/실패/잘못된 JSON/과대 응답/timeout, 알려진 비밀 canary와 SDK 오류 반사 부재를 검사한다. 모의 provider나 모델은 호출하지 않는다.

중앙 external-action의 body 계약, worker 인증/native runtime 결속, canonical externalProfiles 전달과 취소/heartbeat의 연결은 API/bootstrap 소유자 범위다. 이 sidecar는 권한을 만들지 않으며 중앙의 lease·runtime·revision·profile·예산 검사를 대체하지 않는다. 이 문서의 로컬 테스트는 실제 격리·Cloudflare 배포·모델 도구 노출의 근거가 아니다.

## 로컬 검증 근거

2026-11-20: 이 두 TypeScript 파일과 의존 계약만 대상으로 tsc --noEmit(NodeNext, strict, noUncheckedIndexedAccess, noUnusedLocals, noUnusedParameters, allowImportingTsExtensions, erasableSyntaxOnly)를 실행해 통과했다. backend에서 node --test test/autonomous-action-mcp.test.ts는 21개 통과·0개 실패였다. 실제 loopback HTTP, MCP SDK in-memory/stdio handshake와 call, malformed frame 종료, 비밀 canary 비노출과 import 무동작을 검사했다. root 전체 검사는 병행 작업 때문에 수행하지 않았다. 공용 네트워크·실제 모델/제공자·원격 런타임의 근거가 아니다.

executionDeadline이 있는 새 입력은 초기 lease의 expiresAt 이후에도 중앙의 실제 갱신 lease 검증을 거쳐 호출할 수 있다. 이 절대 실행 한도 이후에는 항상 거절한다. 누락한 legacy 입력만 초기 lease 만료를 사용한다.

2026-11-20 R7 연속 push 회귀: 수정 전 새 테스트 2건이 providerResult 누락으로 실패했다. 수정 후 backend의 `node --test test/autonomous-action-mcp.test.ts`는 32개 통과·0개 실패다. SDK in-memory transport와 실제 action 함수에서 두 번의 GitHub 요청을 연결하고, 두 번째 expectedHead가 첫 응답 oid와 일치함을 확인했다. 제공자 결과의 종류·길이·추가 필드·operation·성공 상태·효과 경계, 알려진 비밀 포함과 모델 billing 호출 차단을 검사했다. 외부 HTTP는 주입한 fetch로 대체했다. 기존 테스트의 loopback·stdio 외 네트워크, 실제 모델·제공자·배포·stamp·공유 dist는 사용하지 않았다. 변경 범위는 sidecar·해당 테스트·이 문서로 동결한다.

최종 두 파일 대상 `tsc --noEmit`도 통과했다. 설정은 ES2023/NodeNext, strict, noUncheckedIndexedAccess, noUnusedLocals, noUnusedParameters, allowImportingTsExtensions, erasableSyntaxOnly, skipLibCheck와 Node 타입이다. 전체 `npm run check`는 소스 동결·공유 dist 금지 조건에 따라 실행하지 않았다.
