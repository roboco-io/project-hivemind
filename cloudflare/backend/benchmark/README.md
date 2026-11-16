# Gemini Carbon 원격 벤치마크 준비

이 경로는 Gemini 4 Carbon과 pi 0.87.1의 RealWorld 비교용이다. 기존 Codex·Claude 인증과 워커 계약은 유지한다.

- 운영자 API `POST /v1/carbon-benchmarks`는 고정 snapshot ID, 요청 ID, `probe`를 받는다. `GET /v1/carbon-benchmarks/:id`는 두 비교 실행과 후속 실행의 상태·비용·채점을 반환한다.
- 무과금 점검은 두 Linux 컨테이너에서 pi·Orange Hurl 버전, 비공개 경로 차단, 셸 환경의 호출 권한 제거를 확인한다. 알려진 정상 RealWorld 코드의 13파일·154요청과 빈 앱의 실패를 검증한다. 같은 snapshot과 런타임 지문의 점검 두 건이 통과해야 유료 캠페인을 제출할 수 있다.
- 유료 캠페인은 Medium·Low를 두 컨테이너에서 동시에 시작한다. 완주와 독립 재검증 두 건을 통과한 effort 중 최초 합격까지 더 빠른 쪽을 두 번 병렬 반복한다. 합격이 없으면 종료한다.
- Google API 키는 Worker의 `GEMINI_BENCHMARK_KEY` secret에 둔다. 컨테이너에는 실행과 effort에 묶인 호출 권한만 전달한다. 모델이 실행하는 셸은 이 권한을 제거한다.
- pi 0.87.1은 Carbon에 기본 thinking budget 형식을 보낸다. 게이트웨이는 승인된 실행의 effort를 Google `thinkingLevel`에 넣고 budget 필드를 제거한다. 실제 Google 응답의 입력·캐시·출력·추론 토큰을 정산한다.
- 요청 전에 입력의 바이트 길이와 최대 출력을 기준으로 비용을 예약한다. 한 실행에 요청 하나만 허용하고 전체 캠페인의 진행 중 예약을 합산한다. 회당 $5·전체 $20 추정 중단 기준을 적용한다. 사용량이 확인되지 않은 요청은 예약액을 보수적으로 반영하고 해당 실행의 추가 호출을 막는다. 제공자 청구액의 확정 상한과는 구분한다.

실험 시작 전에 연구 저장소의 PROMPT v2, 지속 지침, Hurl 정본과 검증된 정상 참고 앱을 별도 snapshot으로 묶는다. 참고 앱과 채점 파일은 모델 작업 공간 밖에 둔다. 실제 벤치마크는 매 실행마다 새 코드·DB·세션으로 시작한다. 기준 입력, 런타임 버전과 캠페인 ID를 기록한다.

## 현재 검증 상태

TypeScript 검사와 Linux 이미지 빌드를 통과했다. Cloudflare의 무과금 점검 두 건에서 파일 경계와 Orange Hurl 13파일·154요청 채점을 확인했다. 실제 Gemini Medium·Low를 병렬 실행하고 확인 가능한 토큰 사용량을 집계했다. 초기 실행에서는 미확인 사용량 요청으로 중단됐다. SSE를 스트리밍하도록 수정한 뒤 원격 합성 응답 두 건(약 280초·1.26MB)에서 비용 예약과 종료 정산을 확인했다. 실제 재실행에서는 Medium과 Low 모두 20분 상한으로 종료됐다. 완주 비교와 후속 반복은 남아 있다.

## GPT-6.1 Terra 원격 벤치마크

`POST /v1/terra-benchmarks`는 같은 고정 과제와 pi 0.87.1로 Medium 한 건을 등록한다. `GET /v1/terra-benchmarks/:id`로 상태와 사용량, Hurl 결과를 조회한다. 같은 snapshot과 런타임의 무과금 검증이 먼저 통과해야 한다.

- 전용 로그인에서 얻은 단기 OAuth 액세스 토큰, 계정 ID, 만료 시간, 승인된 캠페인 요청 ID는 Worker secret `TERRA_BENCHMARK_AUTH`에 저장한다. 리프레시 토큰을 저장하지 않는다. API 키로 대체하거나 기존 Codex 인증을 재사용하지 않는다.
- 런타임은 실행에 묶인 권한으로 Responses SSE 게이트웨이를 호출한다. 게이트웨이는 Terra Medium 요청만 전달한다. 실행을 종료하기 전에 입력·캐시 읽기·출력·추론 토큰을 기록한다. 최종 사용량이 누락되면 추가 요청을 막는다.
- 구독 한도 안에서 실행한다. 구독 외 과금 설정은 운영자가 시작 전에 확인한다. 집계한 토큰과 Cloudflare 실행 비용은 별개다.

Cloudflare 실측에서 Bubblewrap으로 `/proc`와 비공개 경로를 차단하고 합성 SSE 집계와 Hurl 양성·음성 채점을 통과했다. Terra Medium 실행 `c9aff492-35fb-4e3e-b002-66786b523fdb`는 첫 랄프 루프의 Hurl 채점까지 6분 3초가 걸렸다. 독립 재검증 두 번도 각각 13파일·154요청을 통과했다.


캠페인 결과의 `roundTimings`는 회차별 `piSessionMs`와 외부 채점 목록을 기록한다. pi 세션은 샌드박스 프로세스 실행부터 종료까지다. pi가 자체 실행한 도구와 테스트도 포함한다. `gradeMs`는 워커가 앱을 시작하고 채점한 뒤 종료할 때까지다. `hurlProcessMs`는 Hurl 프로세스만 측정하며 앱이 준비되지 않으면 `null`이다. 독립 재검증 두 번은 같은 회차에 별도 채점으로 기록한다.

계측을 추가한 Terra Medium 실행 `e18b254d-3843-430e-b69f-a990bb1d32c1`의 첫 회차 pi 세션은 298.648초였다. 최초 채점과 재검증 두 번의 외부 채점 시간은 10.241초, 9.842초, 10.068초였다. Hurl 프로세스 자체는 각각 4.009초, 4.138초, 4.015초였으며, 매회 13파일·154요청을 통과했다. 로컬 EXP-057의 세션 세 건은 107초, 98초, 104초였고 원격 한 건은 로컬 중앙값의 약 2.87배였다.

## Cloudflare 인스턴스 비교

- `POST /v1/terra-benchmarks`에서 무과금 점검은 `probe: true`와 `instance: "standard-1"` 또는 `"standard-3"`을 받는다. 같은 snapshot·런타임의 두 점검이 통과한 뒤 `probe: false, sizing: true`로 본실험을 등록한다.
- 캠페인은 앞 작업의 컨테이너 종료를 확인한 뒤 `standard-1 → standard-3`을 세 쌍 실행한다. 모든 작업에서 새 컨테이너와 작업 디렉터리를 사용한다. 취소 또는 모델 사용량 검증 실패가 발생하면 이후 실행을 중지한다.
- `modelWaitMs`는 게이트웨이가 허용한 모델 요청부터 응답 스트림 정산까지 걸린 시간의 합이다. 회차별 `toolMs`는 pi 도구 실행 구간의 합집합이다. 겹쳐 실행되는 도구 시간은 한 번만 계산한다. 모델 대기와 도구 시간을 빼고 남은 시간에는 런타임 준비와 pi 내부 처리가 포함될 수 있다.
- `resources`의 CPU 사용·스로틀링 시간과 메모리 피크는 컨테이너 cgroup에서 수집한다. 커널 피크를 읽을 수 없으면 결과에 표본 출처를 표시한다. 읽을 수 없는 CPU 값은 생략한다.
- `hvm-bench-job` 라벨로 Cloudflare Containers 사용량을 조회해 CPU·메모리·디스크·전송량을 실행별로 대조한다. 완주당 비용은 크기별 전체 본실험 비용을 완주 수로 나눈다.

서울 ICN 캠페인 `c855c0a3-0e8b-47a8-90e1-dcda94d57c06`에서 크기별 3회씩 완주했다. pi 세션 중앙값은 `standard-1` 337.02초, `standard-3` 291.64초였다. 외부 채점 세 번의 합계 중앙값은 26.49초와 12.16초였다. Cloudflare 사용량에 공개 단가를 적용한 컨테이너 완주당 추정 비용은 각각 $0.00557과 $0.00822였다.

## Terra 전송 지연 측정

`POST /v1/terra-benchmarks`의 `latency: true`는 도구를 끈 pi로 고정 Terra Medium 요청 한 건을 실행한다. 같은 snapshot·런타임에서 `latency: true, probe: true` 무과금 점검이 먼저 통과해야 한다.

pi는 제공자 요청 준비 시작을 기준으로 클라이언트 송신, 첫 응답, 첫 토큰, 첫 텍스트와 완료 오프셋을 기록한다. SSE 송신은 HTTP 본문 송신 이벤트, WebSocket 송신은 요청 프레임의 `send()` 호출 시점이다. 두 이벤트는 원격 서버가 요청을 수신한 시각과 구분한다. Cloudflare 게이트웨이는 자체 요청 수신을 기준으로 제공자 호출, 응답 헤더, 첫 토큰·텍스트, 종료 프레임과 정산 시점을 기록한다. 서로 다른 시계를 직접 빼서 단방향 네트워크 시간을 계산하지 않는다.

고정 요청 실측에서 로컬 기본은 WebSocket을 사용했다. 전체 응답 시간은 로컬 기본 4.876초, 로컬 SSE 4.410초, Cloudflare SSE 4.478초였다. Cloudflare 실행 `e3851f9a-eba4-4bbd-a408-d323483541d4`에서 게이트웨이 수신부터 제공자 호출까지 55 ms, 제공자 호출부터 첫 텍스트까지 1,395 ms였다.

`latency: "sequence"`는 한 pi 세션에서 같은 Terra Medium 요청 네 턴을 순서대로 보낸다. 매 턴에 80개의 RealWorld 형식 참고 레코드를 추가하고 정수 500개 출력을 검증한다. `latencyTurns`에 클라이언트 구간과 토큰 사용량을, `gatewayTimings`에 요청별 게이트웨이 구간을 저장한다. 로컬 WebSocket 계측은 같은 소켓 객체의 재사용과 이전 응답 ID의 사용 여부를 각각 기록한다.

다중 턴 실측 `943b81cd-ff77-470a-89d6-58dc2d71b8ca`에서 세 경로의 턴별 출력이 모두 일치했다. 네 턴의 응답 시간 합계는 로컬 WebSocket 79.358초, 로컬 SSE 80.848초, Cloudflare SSE 81.659초였다. WebSocket은 2-4턴에서 같은 소켓과 이전 응답 ID를 사용했다.

`latency: "realworld"`는 고정 지연용 프롬프트 대신 RealWorld 랄프 루프와 독립 Hurl 검증을 실행한다. 각 회차의 `profile.turns`와 `profile.tools`에 응답·도구 시간과 토큰량을 저장한다. 첫 토큰은 텍스트·추론 요약·도구 인자 중 처음 관측한 스트리밍 델타다. 모델 요청 구간은 제공자 요청 준비부터 완료까지며, 게이트웨이의 요청별 시간은 `gatewayTimings`에 따로 보관한다. 도구 명령, 모델 본문과 인증 정보는 프로파일에 포함하지 않는다.

실측 `ca0e7d1c-2c3a-475b-b770-81a6e83087d6`과 로컬 비교에서 세 경로는 모두 첫 회차에 Hurl 13파일·154요청과 재검증 두 번을 통과했다. pi 세션은 로컬 WebSocket 218.10초, 로컬 SSE 224.43초, Cloudflare SSE 348.38초였다.

### 고정 명령 재실행

운영자 API에서 `probe: true, latency: "replay"`를 보내면 같은 snapshot의 기준 앱을 사용해 고정 명령을 세 번 실행한다. 매번 새 작업 폴더와 HOME, npm 캐시를 만들고 Git 로컬 작업·고정 커밋 fetch, npm 의존성 설치, Prisma 생성·마이그레이션, TypeScript 빌드, Hurl 채점을 각각 측정한다. npm 설치에는 `--ignore-scripts`를 사용해 Prisma의 설치 후 작업을 별도로 측정한다. Hurl 프로세스 시간과 앱을 시작·종료하는 외부 채점 시간은 별도 값이다. 모델 호출 권한은 이 모드에서 사용할 수 없다.

캠페인 `61d51f05-759e-4d0e-9b38-bcd5fba82822`에서 모델 호출 없이 로컬·Cloudflare 각각 세 번 측정했다. 비중복 명령 합계 중앙값은 11.735초와 35.746초였다. 두 환경에서 Hurl 13파일·154요청을 모두 통과했다. Cloudflare Git은 컨테이너 CA를 명시해 인증서 검증을 유지했다.

### npm 캐시 비교

`probe: true, latency: "cache-replay"` 요청은 `instance: "standard-1"` 또는 `"standard-3"`에서 cold/warm 세 쌍을 실행한다. 각 쌍은 비어 있는 npm 캐시로 시작한다. 같은 쌍의 두 번째 실행에는 npm 캐시만 넘기며 앱 작업 폴더, HOME, Prisma 캐시는 새로 만든다. 두 실행은 같은 lockfile과 `npm ci --ignore-scripts --no-audit --no-fund --prefer-offline`을 사용한다. npm 설치, Prisma 생성, TypeScript 빌드, npm HTTP GET 수와 cgroup CPU 사용량을 기록한다. 프로브는 모델을 호출할 수 없다.

Cloudflare `standard-3` 실행 `4b309f53-4502-4cc4-a67b-2b356abb7d00`에서 cold/warm 세 쌍을 완료했다. npm 설치 중앙값은 4.860초에서 3.921초로 줄었고, TypeScript 빌드는 2.411초와 2.359초였다. npm 로그의 HTTP GET은 cold 110건, warm 0건이었다.

같은 snapshot과 런타임으로 `standard-1` 실행 `41375e17-23f7-4279-91e7-e45117827c7d`의 cold/warm 세 쌍을 완료했다. npm 설치 중앙값은 17.028초와 13.196초, TypeScript 빌드는 7.493초와 7.599초였다. npm HTTP GET은 110건에서 0건으로 줄었다.

### 실제 Terra RealWorld의 npm 캐시 준비

`latency: "realworld-warm"`은 벤치마크 작업의 컨테이너를 `standard-3`으로 고정한다. 기준 lockfile로 `npm ci --ignore-scripts`를 실행해 캐시를 채운 뒤 임시 기준 앱을 제거한다. pi는 빈 작업 폴더에서 같은 과제를 수행한다. 캐시 준비 시간과 실제 npm 설치·빌드·타입 검사 타이밍은 각각 저장한다. 같은 런타임의 무과금 Hurl 검증을 먼저 통과해야 한다.

실제 캐시 준비 실행 `e7e83ec1-14d8-4f24-b5ed-1eb7496b871d`은 pi 세션 232.118초와 외부 Hurl 11.406초를 기록했다. 최초 채점과 두 재검증에서 각각 13파일·154요청을 통과했다. 캐시 준비는 5.538초였고, 실제 npm 설치는 17.233초와 HTTP GET 171건을 기록했다. 캐시 준비를 포함한 컨테이너 비용 추정치는 $0.00690이었다.

`latency: "realworld-cache-pairs"`는 `standard-3`의 빈 캐시·재사용을 세 쌍 순차 실행한다. 같은 snapshot의 `benchmark-lock/package.json`과 `package-lock.json`을 두 조건의 빈 앱에 제공한다. 재사용 조건은 동일 lockfile로 캐시를 채우고 준비 폴더를 지운다. pi는 동일한 npm ci 지침을 받는다. 최종 lockfile과 의존성 목록이 유지됐는지 확인하고, npm 명령별 시간·HTTP GET 수와 Hurl 최초 채점·두 재검증을 기록한다.

캠페인 `c8bc9d59-d90b-4908-b4e0-10c2e7c6a450`에서 양쪽 3회 모두 Hurl 최초 채점과 독립 재검증 두 번을 통과했다. 첫 npm ci의 중앙값은 빈 캐시 5.447초와 재사용 4.641초, HTTP GET은 각각 108건과 0건이었다. pi 세션 중앙값은 229.798초와 218.065초였다.

`latency: "realworld-r2-cache"`는 동일 lockfile의 npm 캐시를 기존 비공개 R2 아티팩트 버킷에 보관한다. 키는 캐시 형식, 런타임 호환 버전과 lockfile SHA-256으로 결정한다. 무과금 프로브는 캐시가 비어 있을 때만 채우고 R2 왕복과 npm 재설치를 확인한다. 실제 실행은 새 컨테이너에서 복원한 캐시로 시작한다. 캐시 공개·복원·설치 시간은 별도로 기록하며, 실제 실행의 원격 요청에는 캐시 쓰기 권한을 주지 않는다. 캐시에는 npm의 콘텐츠와 인덱스만 저장하며 체크섬과 파일 경로를 검증한다.

실제 R2 실행 `2e557c4b-8004-42c2-8e3a-954d426458ee`은 새 `standard-3` 컨테이너에서 68,039,922바이트를 복원했다. 복원 1.213초, 첫 npm ci 4.009초, HTTP GET 0건이었다. pi 세션은 266.383초였고, Hurl 최초 채점과 두 재검증에서 각각 13파일·154요청을 통과했다. 실제 실행의 컨테이너 비용 추정치는 $0.00714였다.

### RealWorld 요청 재생

`latency: "wire-replay"`는 고정 snapshot의 `requests.json`에 저장된 Terra Medium SSE 요청 26개를 순서대로 전송한다. 원래 턴의 모델 응답과 도구 결과는 다음 요청에 들어 있는 고정 입력으로 사용한다. 재생 중 생성된 도구 호출은 실행하지 않는다. `wireReplay`에 요청 본문 해시, 송신·첫 델타·완료 오프셋과 토큰을 기록하고 `gatewayTimings`에 Cloudflare 전달·상류 응답 구간을 저장한다. 무과금 프로브는 첫 요청에 합성 응답을 반환한다.

## pi 구독 인증 재사용

macOS 운영자는 `node scripts/auth/pi-oauth.ts login`으로 HIVEMIND 전용 인증을 한 번 연결한다. refresh token을 포함한 인증은 macOS Keychain에 저장한다. 이후 `node scripts/auth/pi-oauth.ts export /private/path/access.json`은 유효 토큰을 재사용하고 필요하면 pi 제공자 구현으로 갱신한다. 기본 최소 유효 시간은 25분이다. 임시 파일에는 access token·계정 ID·만료 시각만 기록한다. `status`는 비밀을 출력하지 않고 연결 상태를 확인하며 `forget`은 전용 Keychain 항목을 제거한다.

동시 실행은 운영자 단위 파일 잠금으로 인증 조회·갱신·저장을 직렬 처리한다. 갱신 시작을 Keychain에 먼저 기록하고 새 refresh token을 저장한 뒤 access token을 반환한다. 갱신이 중단되거나 제공자가 인증을 거부하면 명시적 `login`이 필요하다. 일반 내보내기에서는 브라우저를 자동으로 열지 않는다.

pi가 현재 Node의 글로벌 패키지 경로 밖에 있으면 `HIVEMIND_PI_PACKAGE_ROOT`로 설치 루트를 지정한다. Swift Keychain 도우미는 `~/Library/Application Support/HIVEMIND`에 컴파일한다. Keychain 접근 확인이 표시되면 해당 도우미를 확인한다. 토큰 값은 명령행 인자와 환경변수로 전달하지 않는다.

Keychain 연결 후 같은 lockfile·빈 캐시의 6회 비교를 추가 웹 로그인 없이 실행했다. 로컬 SSE 세 번의 pi 세션은 244.785초, 159.541초, 195.233초였고 Cloudflare standard-3은 353.958초, 228.998초, 302.306초였다. 여섯 실행 모두 Hurl 13파일·154요청의 최초 채점과 두 재검증을 통과했다. Cloudflare에서 과거 199.033초 이하 기록은 재현되지 않았다.

### Git CA와 bash 진단

실제 Terra 워커는 컨테이너 CA 경로를 `GIT_SSL_CAINFO`에도 적용한다. 프로브에서 같은 셸을 통해 GitHub HTTPS 조회가 성공하는지 확인한다. `profile.tools`의 bash 기록에는 모델 요청 번호, 명령 종류, 종료 코드와 정해진 문구의 오류 요약을 추가했다. 원문 명령과 출력은 정상 아티팩트로 전달하지 않는다. 복합 명령에서는 여러 종류가 함께 표시되며 요약은 출력 패턴에 기반한다.

수정 후 standard-3·빈 캐시·고정 lockfile의 세 실행은 126.248초 완료, 169.274초 프로세스 실패, 139.144초 완료였다. 성공한 두 건은 Hurl 13파일·154요청의 최초 채점과 두 재검증을 통과했다. 모델 요청 합계는 이전 98건에서 47건, 도구 오류는 35건에서 11건으로 줄었지만 완주율은 3/3에서 2/3이므로 실패를 포함한 총량 감소를 완주 성능 개선율로 해석하지 않는다.

각 랄프 회차의 `piProcess`는 실제 pi 자식 프로세스의 종료 코드·시그널·종료 사유를 기록한다. 벤치마크 전체의 성공·실패 코드와 별도로 보존한다. 정제된 stderr는 허용된 런타임 오류 문구, 생략된 줄 수, 원래 바이트 수와 SHA-256으로 구성한다. 인증 정보·임의 경로·원문 메시지는 정상 결과에 보관하지 않는다. 시그널 없이 종료한 경우 signal은 null이다.

종료 진단 추가 후 동일 조건의 세 실행은 pi 251.905초, 315.996초, 155.191초에 모두 완주했다. 실제 자식 프로세스 종료는 모두 exitCode 0, signal null, terminationReason exit였고 출력 잘림이나 런타임 오류 문구는 없었다. 각 실행은 Hurl 13파일·154요청의 최초 채점과 두 재검증을 통과했다. 과거 실패 실행의 원래 종료 정보가 남아 있지 않아 원인을 소급 확정하거나 실패 원인이 해결됐다고 단정할 수 없다.

## Interface

아래 절은 이 폴더의 파일이 현재 정의한 계약을 기록한다. 위 절의 API 경로와 실측 수치는 `src/`의 구현과 원격 실행 기록에 속한다.

- `pi-shell` - 인자를 그대로 `/bin/bash`에 넘기는 셸 래퍼. pi가 모델의 셸 명령을 실행할 때 쓴다. 런타임 이미지에 복사된다.
- `agent/` - pi용 설정 JSON(`models.json`, `settings.json`). 코드가 없으며 런타임 이미지에 복사된다.
- [resource-validation](./resource-validation/README.md) - RealWorld 고정 과제와 검사 스크립트. 아래 항목은 그 폴더의 스크립트 계약이다.
  - `run-shard.mjs` - 인자는 `0|1|2|3|all`이다. `HURL_BIN`을 읽는다. 결과를 JSON 한 줄로 출력하고 실패하면 종료 코드 1이다.
  - `acceptance.mjs` - 인자는 `articles|comments|all`이다. 마지막 stdout 줄이 `{target, passed, checks}` JSON이다.
  - `integration.mjs` - 인자가 없다. `acceptance.mjs all`과 `run-shard.mjs all`을 순서대로 실행한다.
  - `build-fixture.mjs` - 인자는 `OUTPUT_DIR`이다. fixture를 복사하고 `manifest.json`을 쓴다.
  - `[resource-validation/fixture-runtime.mjs:prepare]`, `[resource-validation/fixture-runtime.mjs:serve]`, `[resource-validation/fixture-runtime.mjs:command]`, `[resource-validation/fixture-runtime.mjs:cleanup]`, `[resource-validation/fixture-runtime.mjs:readJson]` - 앱을 임시 폴더에 복사해 설치·빌드하고 서버를 시작·정리하는 공용 함수.
  - `tasks.json` - 워커별 허용 파일과 검사 명령. `articles`는 `app/src/routes/articles.ts`, `comments`는 `app/src/routes/comments.ts`만 쓸 수 있다.

## Invariants

- `pi-shell`은 bash를 시작하기 전에 `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `HIVEMIND_TERRA_CAPABILITY`, `HIVEMIND_TERRA_PROBE`, `NODE_OPTIONS`를 제거한다. 셸은 절대 경로 `/bin/bash`로 고정한다. `pi-shell`
- `pi-shell`과 `agent/`의 JSON은 런타임 빌드 버전의 고정 입력이다. 바꾸면 `runtime-build.json`의 `digest`가 달라진다. `[../scripts/runtime-build.ts:RUNTIME_FIXED_INPUTS]`
- `build-fixture.mjs`의 출력 폴더는 fixture 밖의 새 폴더여야 한다. 상한은 4MiB, 1,000파일이다. 심볼릭 링크, 점으로 시작하는 이름, `node_modules`, `dist`가 있으면 실패한다. `build-fixture.mjs`
- `resource-validation/manifest.json`은 그 폴더의 `README.md`를 포함한 파일의 SHA-256과 바이트 수를 기록하고 있다. 그 폴더의 파일을 바꾸면 기록된 값과 달라진다. 이 때문에 EGM 계약을 그 폴더가 아니라 이 문서에 둔다.
- `run-shard.mjs`는 샤드 4개가 13개 파일을 중복 없이 나누고 `suite.json`과 같아야 실행한다. `all`은 실행한 요청이 정확히 154개여야 통과다. `run-shard.mjs`
- 설치는 `npm ci --ignore-scripts --no-audit --no-fund`를 쓴다. 자식 프로세스는 부모 환경을 상속하지 않고 허용한 변수만 받는다. `[resource-validation/fixture-runtime.mjs:prepare]`
- 서버는 `127.0.0.1`에만 바인드한다. `[resource-validation/fixture-runtime.mjs:serve]`
- `integration.mjs`는 첫 실패에서 멈춘다. `integration.mjs`

## Side Effects

- `pi-shell`은 `exec`로 프로세스를 bash로 바꾼다. 파일을 만들지 않고 네트워크를 호출하지 않는다.
- 검사 스크립트는 OS 임시 폴더에 `hivemind-resource-*` 폴더를 만들어 앱을 복사하고, 끝나면 지운다. 입력 fixture는 수정하지 않는다. `[resource-validation/fixture-runtime.mjs:prepare]`, `[resource-validation/fixture-runtime.mjs:cleanup]`
- `npm ci`, Prisma generate·migrate, TypeScript build를 실행한다. `npm ci`는 npm registry에 접근할 수 있다. `[resource-validation/fixture-runtime.mjs:prepare]`
- 임시 포트에서 `node dist/server.js`를 실행하고 `hurl` 바이너리를 실행한다. `[resource-validation/fixture-runtime.mjs:serve]`, `run-shard.mjs`
- `build-fixture.mjs`는 출력 폴더를 만들고 fixture 파일과 `manifest.json`을 쓴다.

## Verification

- Run: `npm test` (`cloudflare/backend/`에서 실행. `node --test test/*.test.ts`)
- Run: `node run-shard.mjs all` 또는 `node integration.mjs` (`cloudflare/backend/benchmark/resource-validation/`에서 실행. Hurl 8.0.1과 npm registry 접근이 필요하다)
