# 0단계 실행 가능성 검증

이 폴더는 플랫폼 실행 가능성의 성공·실패 기록이다. 최신 수용 상태는 [Cloudflare 검증 기록](../verification/2026-11-10-cloudflare.md)을 기준으로 한다.
기존 `hivemind-phase0`의 구독 인증 바인딩은 사용을 종료했다. 소비된 one-shot guard와 이전 로컬 인증 시드를 다시 사용하지 않는다.
새 백엔드의 최신 Codex 인증은 비공개 R2에서 세대별로 관리한다. 실제 모델 시험은 운영자만 명시적으로 실행한다.

현재 순서는 Cloudflare 우선, AWS 후속이다. 로컬 Docker·Wrangler 로컬 런타임·Cloudflare 원격·AWS 원격 증거를 분리한다. 어느 로컬 실행도 원격 gate를 통과시키지 않는다.

## 재현 명령

- npm test: 사전 검사·플랫폼 gate·stdio MCP·인증된 Cloudflare probe의 자동 시험.
- npm run phase0:local: 기본 Cloudflare 사전 검사. Wrangler 인증과 명시적으로 선택한 회사 계정을 확인한다.
- npm run phase0:local -- --account ACCOUNT: 회사 계정 이름 또는 ID를 명시한다. 계정을 임의로 선택하지 않는다.
- npm run phase0:local -- --backend aws: 회사 기본값 roboco/ap-northeast-2로 읽기 전용 AWS 인증을 확인한다. profile·region 인수로 덮어쓸 수 있다.
- docker build --platform linux/amd64 --tag hivemind-phase0:20261109 --file scripts/phase0/Dockerfile .: 고정 버전 CLI·MCP 시험 이미지를 만든다.
- docker run --rm --platform linux/amd64 --network none --cap-drop ALL --security-opt no-new-privileges hivemind-phase0:20261109: 제한된 로컬 Docker에서 UID·CLI·stdio MCP를 확인한다.
- npm exec -- wrangler deploy --dry-run --config scripts/phase0/cloudflare/wrangler.json --outdir .hivemind/cloudflare-dry-run: Worker 번들·선언 구성·이미지 빌드를 검증한다. 원격 배포하지 않는다.

검사기는 원문 명령 오류·AWS identity·토큰을 보고서에 포함하지 않는다. 전체 원격 gate 미통과의 종료코드는 2다. 로컬 도구가 모두 준비됐더라도 원격 항목은 NOT_RUN이다. Node.js 내장 TypeScript 실행은 타입 검사를 대신하지 않는다.

## Cloudflare probe

scripts/phase0/cloudflare의 Worker와 Durable Object는 고정 시험만 수행한다. PROBE_TOKEN이 없으면 503, 인증이 틀리면 401이다. GET /phase0와 GET /phase0/sandbox는 구독 인증 없이 진단한다. POST /phase0/codex는 별도 one-shot 구독 fixture다. 임의 명령·프롬프트·요청 본문을 받아 실행하지 않는다. Cloudflare 관리 토큰이나 제어 토큰은 컨테이너에 전달하지 않는다.

컨테이너는 네트워크를 끄고 sleep 120으로 수명을 제한한 뒤 UID·공식 CLI 버전·MCP 시험을 실행한다. 정상·실패 경로에서 명시적으로 destroy한다. 응답은 container prerequisites 범위임을 표시하며 원격 모델·서브에이전트·sandbox 통과를 주장하지 않는다. HTTP 200도 진단 프로세스의 exitCode 0을 보장하지 않으므로 함께 확인한다.

sandbox 경로는 별도 고정 시험으로 capability set, workspace 쓰기 허용·외부 쓰기 거부, read-only 쓰기 거부와 지정한 관리 변수의 미전달을 확인한다. Cloudflare exec의 상속 권한 때문에 setpriv로 capabilities를 제거하고 no-new-privileges를 설정한다. stderr와 종료코드, containerStopped도 응답에 포함한다. 구독 토큰이 없는 고정 시험에서만 이 진단 출력을 사용하며 향후 모델 실행의 인증·출력 처리는 분리한다.

## Codex 구독 fixture와 회수

codex-probe.ts는 원격 전용 ChatGPT 번들을 private home에 쓰고 공식 CLI로 두 자식·파일·MCP를 시험한다. API 키는 child 환경에서 제거하고, OpenAI 공식 HTTPS origin만 Worker outbound가 허용한다. CLI에는 구독 인증이 필요하지만 Cloudflare 관리 자격증명은 필요하지 않다.

--ephemeral은 부모 rollout을 없애므로 이 고정 버전의 서브에이전트 시험에서는 사용하지 않는다. CLI 상태는 컨테이너 수명 동안만 유지하고 끝나면 제거한다. 기록 헤더가 fork된 부모 ID를 유지하므로 정식 thread DB·파일 식별자·생명주기를 대조한다. 메시지 내용 대신 최소 metadata만 receipt로 추출한다. 내부 형식 판독은 CLI 0.166.0에 고정한 검증 보조 수단이다.

실행 후 인증은 AES-GCM으로 암호화하고 일회 AES 키를 로컬 RSA 공개키로 감싸 반환한다. request-codex.ts는 curl stdin으로 제어 헤더를 보내고 개인키로 인증을 회수한 뒤 로컬 최신 번들과 다음 배포용 secret 파일을 갱신한다. 원문·개인키·암호화 응답은 .hivemind의 0600 파일에만 보관한다. 일반 증거에는 authReturn을 포함하지 않고 알려진 원본·갱신 토큰을 제거한다.

현재 v4 구독 fixture는 실제 통과했고 guard가 소비됐다. request-codex.ts를 그대로 다시 실행하지 않는다. authRecovered와 containerStopped를 확인하기 전에는 revision을 바꿔 재실행하지 않는다. 다음 작업은 별도 Claude fixture다. 로컬 발급 토큰은 .hivemind/claude-remote-token에 있고 원문 setup-token 로그는 제거했다. 값은 출력하지 않는다.

로컬 실행은 무작위 시험용 PROBE_TOKEN을 권한 0600의 .hivemind/phase0.env에 저장한 뒤 아래 명령으로 수행했다. 해당 파일은 Git·Docker 빌드 컨텍스트에서 제외한다.

npm exec -- wrangler dev --local --config scripts/phase0/cloudflare/wrangler.json --env-file .hivemind/phase0.env --port 8796

요청 시 파일의 토큰을 Authorization Bearer 헤더로 보내며 출력하거나 문서에 복사하지 않는다. 로컬 Wrangler는 SYS_ADMIN·/dev/fuse·apparmor:unconfined를 사용하는 컨테이너 실행을 알렸다. 이 에뮬레이터의 성공을 제한된 Docker 또는 Cloudflare 원격 보안의 증거로 대체하지 않는다. 사용한 로컬 서버는 검증 후 종료했다.

## MCP 시험 도구

scripts/phase0/mcp-server.ts는 공식 MCP SDK의 stdio 서버다. phase0_probe 하나만 제공하고 생성된 32자리 소문자 16진수 nonce를 고정 marker와 함께 반환한다. 임의 명령·파일 경로·환경변수 입력이나 추가 필드를 받지 않는다.

실제 별도 Node 프로세스와 초기화·도구 조회·nonce 호출·응답·잘못된 입력 거부·종료를 시험한다. 이는 전송 계층의 증거이며 공식 CLI의 모델 응답 중 도구 호출과는 다르다. 실환경에서는 고유 nonce와 CLI 도구 이벤트를 대조한다.

## 플랫폼별 gate

공통 요구는 로컬 도구, 두 CLI의 실제 편집·서브에이전트, MCP, 자격증명 격리, sandbox다. Cloudflare gate는 cloudflare-identity·cloudflare-network와 각 cloudflare 실행 항목을 요구한다. AWS gate는 aws-identity·Fargate 실행 항목을 별도로 요구한다. 한 플랫폼이 통과해도 다른 플랫폼은 미검증으로 남는다.

원격 실행 증거에는 플랫폼·계정 식별·실행 ID·이미지 digest·CLI 버전·시간·입력 해시·검사 범위·결과를 포함한다. 구독 인증은 원격 전용 공식 로그인 흐름으로 등록하며 채팅에 원문을 요청하지 않는다. 기존 로컬 번들을 자동 복제하거나 API 과금으로 전환하지 않는다.

Cloudflare 제어 자격증명은 Worker에만 보관한다. AWS 후속 검증에서는 ECS task role endpoint를 별도로 시험하며 UID·환경변수 제거만으로 격리를 선언하지 않는다. 각 플랫폼의 파일·아웃바운드 경계도 실제로 확인한다.

## 현재 상태

Cloudflare-first 결과는 2026-11-09-cloudflare-results.md를 참조한다. 이전 AWS-first 로컬 증거는 2026-11-09-results.md에 이력으로 남겼다. 최신 계획은 프로젝트 루트 ARCHITECTURE.md와 MVP 구현 계획이다.
