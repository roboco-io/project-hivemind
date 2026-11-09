# Cloudflare 우선 전환과 0단계 결과

2026-11-10 안전 인계: 최신 배포·Claude 실패·현재 설정·인증 동기화·남은 gate는 2026-11-10-safe-handoff.md를 기준으로 본다. 최신 Claude v2는 enableWeakerNestedSandbox: true를 포함하지만 아직 모델 시험을 실행하지 않았다. 아래 결과표는 Codex 성공 시점의 범위이며 Claude 전체 통과를 뜻하지 않는다.

작성일: 2026-11-09. 상태: Codex 원격 구독 fixture 통과, 전체 Cloudflare 0단계 미완료.

## 사용자 결정과 반영

- roboco-io 조직 저장소는 회사 프로젝트다. AWS 프로파일 roboco, 기본 리전 ap-northeast-2, AWS IaC는 CDK다. 전역 AGENTS.md에 조건부 기본값을 기록했다.
- 하이브마인드는 Cloudflare MVP를 먼저 완성하고 AWS backend를 후속 구현한다. 아키텍처·MVP 계획·프로젝트 규칙을 갱신했다. Git remote는 생성하거나 변경하지 않았다.
- Cloudflare는 Wrangler 네이티브 선언 구성으로 관리하고 AWS는 CDK stack으로 구현한다. Cloudflare MVP에 AWS 의존성을 추가하지 않는다.

## 확인한 증거

| 항목 | 결과 | 범위 |
|---|---|---|
| AWS STS | PASS | roboco/ap-northeast-2 인증 확인. 리소스 배포 없음 |
| Cloudflare 로그인 | PASS | 일반 브라우저 OAuth 승인 후 loggedIn true. 회사 계정 하나를 확인해 명시적으로 선택 |
| 자동 테스트 | PASS | npm test: 30 passed, 0 failed |
| Wrangler dry-run | PASS | Worker bundle·Durable Object 바인딩·이미지 빌드 성공, 원격 업로드 없음 |
| Wrangler 로컬 API | PASS | 익명 GET /phase0는 401. 인증된 요청은 200 및 프로세스 exitCode 0 |
| 로컬 Container 진단 | PASS | UID 1000, Node.js 24.14.0, Codex 0.166.0, Claude Code 2.1.319, 실제 MCP 서버 시험 1 passed |
| Cloudflare 원격 기동·MCP | PASS | 회사 계정에 인증된 진단 Worker 배포. 익명 401, 인증된 실행 200·exitCode 0, UID 1000·CLI 버전·stdio MCP 확인 |
| Codex 원격 sandbox | 일부 PASS | capabilities 제거 후 시작·workspace 쓰기 허용·외부 쓰기 거부·read-only 쓰기 거부 확인. Claude와 모델 호출은 별도 검증 필요 |
| Codex 구독 모델·편집·MCP | PASS | 원격 전용 ChatGPT 인증으로 실제 실행. API 키·AI Gateway 사용 없음. 파일 직접 검사와 MCP nonce 확인 |
| Codex 공식 서브에이전트 | PASS | 네이티브 thread DB ID·parent 관계·rollout 생명주기로 두 자식의 실행 구간 10,471ms 중첩 확인 |
| Codex 인증 회수 | PASS | 실행 후 인증을 AES-GCM으로 암호화하고 로컬 RSA 개인키로 회수. 원문은 일반 결과에서 제외 |
| Claude 구독 인증 발급 | 로컬 발급 완료 | 공식 setup-token 정상 종료. 토큰은 로컬 권한 0600 파일에만 보관. 원격 모델 검증은 아직 없음 |
| Cloudflare 전체 0단계 | 미완료 | Claude 원격 모델·서브에이전트·sandbox와 전체 자격증명·수명·복구 시험이 남음 |

Wrangler 4.158.0을 dev dependency에 고정했다. 회사 계정에 hivemind-phase0 Worker, Phase0Container Durable Object와 전용 container application·이미지를 생성했다. 로컬 서버는 종료했다. 원격 probe는 호출마다 120초 entrypoint 제한과 destroy를 사용한다. 실행 후 inactive 상태를 확인하며 배포 리소스와 이미지는 후속 검증을 위해 유지한다.

## 원격 실행 증거와 수정

- Worker: https://hivemind-phase0.roboco.workers.dev (인증 없는 실행 불가).
- 최초 Worker 버전: 78271e50-bbb7-46db-810e-43cd950943e3. 파일 경계 검증 버전: 81c0677f-b5f6-43bc-85d8-287e7735323c.
- 이미지 digest: sha256:81315adf731b0dfa36daccab51686486e704bc639c4303e4344eb4a2b25af7c5.
- cloudflare-remote-probe-20261109.json과 cloudflare-remote-probes-20261109.json: 실제 응답·CF-Ray·버전·기동·MCP 증거.
- cloudflare-sandbox-capabilities-20261109.json: UID 1000에서도 capability set이 00000000abac35fb, NoNewPrivs 0이며 bwrap이 거부한 원인 관측.
- cloudflare-sandbox-capabilities-dropped-20261109.json: setpriv로 모두 제거한 후 NoNewPrivs 1, Codex sandbox 시작 성공.
- cloudflare-sandbox-filesystem-20261109.json: workspace 쓰기 허용, 외부 경로 쓰기 거부, read-only 쓰기 거부, 지정한 관리 자격증명 환경변수 미전달, 정상 종료 확인.
- cloudflare-codex-subscription-20261109.json: 구독 모델·파일·MCP·실제 병렬 생명주기·인증 회수의 최종 판정. Worker ca5839b9-8f5b-4a45-a4bb-34a5693bd1d6, 이미지 sha256:776d9684ad3271591404a74d4de0dc2e6904ae87ff762397cc604c112817fa96.
- 자식 thread 01a1c0c5-adc3-7b81-a2e9-943c40f32ae9와 01a1c0c5-bbfd-7391-92f0-c380b320f5e2의 네이티브 task 구간이 10,471ms 겹쳤다. 파일 두 개나 모델의 완료 문장만으로 병렬 실행을 판단하지 않았다.

권한을 추가하거나 Codex sandbox를 끄지 않고 상속 권한을 제거해 수정했다. stdin을 통한 curl 헤더 전달로 제어 토큰이 명령줄·응답 증거에 포함되지 않도록 했다. 파일 경계 단독 시험은 구독 인증을 주입하지 않은 환경이다. 뒤이은 구독 fixture는 지정 작업과 인증 회수를 검증했으며 강제 종료 중 refresh 손실 복구, Claude sandbox나 모든 자격증명 경계를 증명하지 않는다.

## 구독 실행에서 발견한 문제와 수정

1. 기기 코드는 CLI가 계속 대기 중인데도 웹에서 거부됐다. 만료라고 단정하지 않고 일반 브라우저 OAuth로 전환했다. 별도 컨테이너와 loopback callback으로 원격 전용 번들을 발급해 기존 로컬 Codex 인증을 변경하지 않았다. 회수 후 인증용 컨테이너는 제거했다.
2. 첫 실행은 모델·MCP 호출에는 성공했지만 --ephemeral 때문에 자식이 부모 rollout을 찾지 못했다. 종료코드 0과 turn.completed도 작업 성공은 아니었다. 실패는 attempt1 증거에 보존했다.
3. 컨테이너 안에서는 rollout을 유지하고 종료 시 runtime 전체를 제거하도록 수정했다. 두 파일과 MCP가 성공한 attempt2도 자식 ID·실행 구간을 입증하지 못해 전체 통과로 판정하지 않았다.
4. child rollout은 부모 session_meta 헤더를 복사한다. attempt3의 같은 헤더 ID를 별도 자식 ID로 간주하지 않았다. 고정 CLI 버전의 thread DB를 읽기 전용으로 조회하고 파일·생명주기와 대조해 정식 ID·parent 관계를 확인했다. 프롬프트·본문·전사 내용은 metadata 영수증에 포함하지 않는다. 내부 형식에 의존하는 검증 보조 도구이며 제품 저장 계층으로 사용하지 않는다.
5. 시험은 인증된 POST, revision별 one-shot guard, 85초 CLI 제한·120초 컨테이너 제한을 사용한다. 이전 실행 종료와 인증 회수 확인 후 명시적으로 재시험했다. 현재 v4 guard는 소비됐으므로 같은 모델 요청을 자동 재제출하지 않는다.

구독 통신은 OpenAI 공식 HTTPS 호스트 allowlist로 제한했다. API 키를 주입하거나 공급자를 gateway로 바꾸지 않는다. 갱신된 인증은 공개키로 감싼 AES 키와 인증된 ciphertext로만 반환하며 개인키는 로컬에만 있다. 암호화 응답·원문 인증·개인키는 Git·Docker 빌드에서 제외한 제한 경로에 보관한다. 일반 JSON에는 알려진 원본·갱신 토큰을 제거한 이벤트와 검사 결과만 저장한다.

로컬 Wrangler는 컨테이너에 SYS_ADMIN, /dev/fuse, apparmor:unconfined를 사용한다고 경고했다. 제한된 독립 Docker의 namespace 실패와 이 로컬 에뮬레이터의 성공은 실행 경계가 다르다. 이 차이를 보안 통과 증거로 숨기거나 Cloudflare 원격에 일반화하지 않는다.

공식 Cloudflare 코딩 에이전트 문서는 API key·AI Gateway를 사용하는 예제다. 구독 토큰 동작은 그 예제가 아니라 위의 실제 원격 증거로 판단했다.

## 다음 단계

1. 로컬에서 발급한 Claude 구독 토큰으로 별도 Claude fixture를 구현한다. 원문을 채팅·일반 파일에 출력하지 않는다.
2. Claude 모델·편집·MCP·서브에이전트·sandbox를 원격 검증하고 수명·인증 갱신·실패 복구의 미검증 항목을 완료한다.
3. Cloudflare 0단계 통과 후 공통 계약과 제품 구현을 진행한다. AWS는 후속 gate·CDK·adapter·전체 수용 시험을 수행한다.

현재 원격 증거도 검사한 범위만 증명한다. 전체 0단계와 지속 목표의 완료는 아직 달성하지 않았다.
