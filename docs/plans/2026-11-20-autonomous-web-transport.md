# WEB 고정 IP TLS transport

기존 R6/core/worker 파일은 변경하지 않는다. 새 transport를 기존 dispatchAutonomousWeb에 전달하는 연결은 C1 담당이다. 연결과 모든 승인 gate가 완료되기 전에는 WEB 기본 차단을 유지한다.

## 네트워크 경계

DNS는 고정 HTTPS Cloudflare DoH `/dns-query?name=<canonical hostname>&type=A|AAAA&do=true`만 사용한다. URL·인증·쿠키·resolver는 모델 입력으로 선택하지 않는다. JSON 응답은 크기·Question·Status·truncation·Answer/CNAME chain·주소를 검증한다. CNAME은 그대로 helper에 반환하여 모든 alias가 승인된 host인지 검사하게 한다. 응답 내 private/special IP, unrelated Answer, loop, 충돌하는 chain은 거절한다. do=true는 DNSSEC 검증 성공을 의미하지 않는다.

Workers public network 기본 제한만으로 IP 고정을 주장하지 않는다. production connector는 함수 실행 시에만 `cloudflare:sockets`를 import한다. 검증된 public IP literal의 443으로 secureTransport=starttls 연결 후 `startTls({expectedServerHostname: originalHost})`를 호출한다. 원래 hostname으로 인증서를 검증하는 TLS가 필수이며 hostname DNS 재조회·일반 fetch 대체·인증서 검증 해제는 없다. 설치된 worker-env.d.ts:3310 및 TlsOptions의 expectedServerHostname이 로컬 API 근거다. 지원하지 않는 런타임이나 socket/TLS 실패는 차단한다. 실제 Workers 원격 canary는 수행하지 않는다.

## HTTP와 자원 한도

GET/HEAD, HTTPS/443, canonical DNS hostname만 허용한다. 요청은 Host, Connection: close, Accept-Encoding: identity와 검증한 accept/accept-language만 보낸다. 인증·쿠키·caller framing 헤더는 전달하지 않는다. redirect를 추적하지 않고 3xx를 거절한다. 응답의 set-cookie와 인증 관련 헤더를 반환하지 않는다.

HTTP/1.0 또는 1.1의 단일 최종 응답을 엄격하게 파싱한다. 헤더/트레일러 각각 64 KiB, body 1 MiB, 전체 read 횟수 10000, chunk size line 128바이트, HTTP status line 1024바이트로 제한한다. content-length, chunked 또는 EOF framing을 지원하고 CL/TE 혼용·중복 framing·잘못된 CRLF·truncation·과대 길이를 거절한다. HEAD/204는 body를 반환하지 않는다. 압축 응답은 거절한다.

resolve와 fetch 각각 기본 10초, 서버 설정 상한 30초다. fetch의 request AbortSignal도 적용한다. open/read/write와 DNS body를 deadline에 묶는다. 완료·오류·취소 시 reader cancel, writer abort, TLS/raw socket close를 호출하고 cleanup 대기를 250ms로 제한한다. 외부 오류/주소/헤더/본문은 오류 메시지에 포함하지 않는다. 테스트 connector와 DoH fetch seam은 로컬 합성 검증용이며 모델 wire 옵션이 아니다.

## 검증 계획

먼저 소켓 연결 주소와 TLS expected hostname, HTTP bytes를 캡처하는 합성 테스트를 실패로 확인한다. 이후 DNS/CNAME/private IP, HTTP framing/크기/truncation, timeout/abort/정리를 검증한다. 실제 원격 연결·모델·인증·배포는 수행하지 않는다. production connector는 구현하되 Workers에서의 실제 TLS/SNI 지원은 원격 canary 전까지 미검증이다.

## 구현·인계

C1은 `createAutonomousWebTransport()`를 production entrypoint에서 생성하여 기존 dispatchAutonomousWeb의 transport 인자로 전달할 수 있다. factory 자체는 활성화 gate를 추가하거나 기존 WEB 기본 차단을 해제하지 않는다. connector/fetchImpl/timeoutMs는 신뢰된 서버 설정이며 모델 wire로 노출하면 안 된다. resolve 계약에는 요청 AbortSignal이 없으므로 DNS 단계는 자체 deadline에 묶이고, socket fetch 단계는 요청 취소도 받는다.

새 transport 테스트 16개 통과. 새 source/test와 설치 worker-env.d.ts만 대상으로 한 strict TypeScript 검사 통과. 로그는 `/tmp/hivemind-web-transport-tests.log`, `/tmp/hivemind-web-transport-types.log`다. 전체 suite, 실제 DNS/TCP/TLS 연결, 모델, 인증, 배포는 실행하지 않았다. 실제 Workers에서 IP literal 연결 후 원래 hostname의 인증서 검증·SNI가 동작하는지는 원격 canary 전까지 미검증이다. 지원 실패 시 일반 fetch나 인증서 검증 우회로 대체하지 않는다.
