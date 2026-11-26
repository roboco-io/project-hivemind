# scripts/phase0

## Overview

이 폴더는 0단계 타당성 검증용 스크립트다. 0단계는 공식 Codex·Claude Code CLI를 컨테이너에서 구독 인증으로 실행할 수 있는지, 그리고 파일·프로세스·인증 경계가 지켜지는지를 확인하는 단계다.
파일은 네 종류다. 판정 로직(`gate.ts`, `collect.ts`, `assess-*.ts`), 모델을 호출하지 않는 경계 probe(`*-boundary-probe.ts`, `landlock-probe.ts` 등), 실제 구독으로 CLI를 실행하는 fixture(`codex-probe.ts`, `claude-probe.ts`), 그리고 배포된 probe를 호출하는 운영자 스크립트(`request-*.ts`)다.
`auth-envelope.ts`, `claude-agent-hook.ts`, `mcp-server.ts`, receipt 모듈 일부는 backend 런타임 이미지에도 복사되어 쓰인다. 검증 기록은 [0단계 문서](../../docs/phase0/README.md)를 따른다.

## Interface

### 하위 폴더

- [cloudflare](./cloudflare/README.md) - probe를 Cloudflare Container에서 실행하는 Worker와 HTTP 경로.

### 판정과 공용 모듈

- `local.ts` CLI - `npm run phase0:local`이 실행한다. 인자는 `--backend`(cloudflare 또는 aws), `--account`, `--profile`, `--region`이다. gate가 PASS면 종료 코드 0, 아니면 2다.
- `[collect.ts:collectLocal]` - 주입받은 runner로 로컬 도구 버전과 계정 상태를 확인해 checks와 gate 판정을 반환한다.
- `[gate.ts:evaluateGate]`, `[gate.ts:requiredChecksFor]`, `[gate.ts:requiredChecks]` - backend별 필수 check 목록과 판정.
- `[assess-codex.ts:assessCodexFixture]`, `[assess-claude.ts:assessClaudeFixture]` - fixture 결과를 CLI 성공, 파일, MCP nonce, 병렬 subagent 기준으로 판정한다.
- `[auth-envelope.ts:sealAuth]`, `[auth-envelope.ts:redactKnownTokens]` - 인증 문자열을 공개키로 봉인하고, 알려진 토큰 문자열을 `[REDACTED]`로 바꾼다.
- `[run-bounded.ts:runBounded]` - 시간과 출력 바이트를 제한해 프로세스를 실행한다.
- `[claude-receipts.ts:claudeAgentReceipt]`, `[rollout-receipts.ts:summarizeRollout]`, `[native-thread-receipts.ts:readNativeThreads]` - subagent와 thread의 실행 receipt를 해석한다.
- `mcp-server.ts` - stdio MCP 서버 `hivemind-phase0`. 도구 `phase0_probe`는 32자리 hex nonce를 고정 marker와 함께 돌려준다.
- `claude-agent-hook.ts` - stdin의 훅 JSON을 읽어 receipt 한 줄을 비공개 JSONL에 추가한다.

### 모델을 호출하지 않는 probe

- `[claude-boundary-probe.ts:runClaudeBoundary]`, `[claude-boundary-probe.ts:assessClaudeBoundary]` - Claude 바깥 sandbox의 파일·`/proc`·환경·네트워크 격리를 확인한다.
- `[codex-boundary-probe.ts:runCodexBoundary]`, `[codex-boundary-probe.ts:assessCodexBoundary]` - `codex sandbox`의 쓰기·`/proc`·인증 파일 차단을 확인한다.
- `[claude-codex-layer-probe.ts:runClaudeCodexLayerProbe]`, `[claude-codex-layer-probe.ts:assessClaudeCodexLayer]` - guard를 거친 겹친 sandbox의 경계와 namespace syscall 차단을 확인한다.
- `[claude-command-concurrency-probe.ts:runClaudeCommandConcurrencyProbe]`, `[claude-command-concurrency-probe.ts:assessClaudeCommandConcurrency]` - 훅이 바꾼 Bash 명령의 병렬 실행을 확인한다.
- `[compute-stdio-probe.ts:runComputeStdioProbe]`, `[compute-stdio-probe.ts:assessComputeStdio]` - compute sandbox에서 `node --test`의 TAP 출력을 확인한다.
- `[landlock-probe.ts:runLandlockProbe]` - `proc-guard`의 Landlock ABI와 fd·비공개 읽기 차단을 확인한다.
- `check-claude-boundary.ts` - Claude의 sandbox Bash 안에서 실행한다. 경계가 지켜지면 `CLAUDE_SANDBOX_BOUNDARIES_VERIFIED`를 출력하고, 아니면 종료 코드 31이다.

### 실제 구독을 쓰는 스크립트

- `codex-probe.ts` - `HIVEMIND_CODEX_AUTH_JSON`, `HIVEMIND_AUTH_RETURN_PUBLIC_KEY`를 읽어 실제 `codex` CLI를 실행한다.
- `claude-probe.ts` - `HIVEMIND_CLAUDE_OAUTH_TOKEN`을 읽어 실제 `claude` CLI를 실행한다.
- `request-codex.ts`, `request-claude.ts` - 로컬 운영자 스크립트. 배포된 probe Worker를 `curl`로 호출하고 판정 결과를 기록한다.

### 보조 인터페이스와 판정 범위

- `codex-boundary-probe.ts:codexBoundaryArgs`, `parseCodexBoundaryObservation`은 고정 sandbox 명령과 제한된 관측값 해석을 제공한다. stdout marker가 정확히 하나이면 우선 사용하고, marker가 없을 때만 workspace receipt로 대체한다. 입력 길이는 128,000자로 제한한다.
- `compute-stdio-probe.ts:computeStdioArgs`, `computeStdioTestSource`는 고정 TAP 검사 명령과 소스를 제공한다. `runComputeStdioProbe`는 정상 단언과 실패 단언을 모두 실행해 양성·음성 대조를 확인한다.
- `claude-codex-layer-probe.ts:assessNativeNamespaceProbe`는 네이티브 namespace 결과를 허용 필드로 줄이고 반환 코드·UID·거부 errno를 대조한다. 같은 파일의 `claudeCodexLayerSettings`, `claudeCodexLayerEnvironment`, `claudeCodexLayerArgs`, `claudeCodexLayerCommand`는 고정 probe 구성을 만든다.
- `claude-command-concurrency-probe.ts:collectConcurrencyDiagnostics`, `collectConcurrencyWaitState`는 제한된 guard trace·파일 metadata·프로세스 대기를 읽는다. 인증·비밀 이름 항목은 첫 함수의 캐시 목록에서 제외한다. `concurrencyBashCommand`, `claudeCommandConcurrencyArgs`, `claudeCommandConcurrencyEnvironment`는 고정 명령을 구성한다.
- `claude-command-concurrency-probe.ts:warmupNestedBwrapPid`, `nestedBwrapCauseArgs`, `nestedBwrapCauseScript`, `assessNestedBwrapCause`는 원인 가설을 위한 별도 무인증 probe다. `hypothesisMatched`는 특정 stderr와 부모 종료·고아 프로세스 관측의 일치를 뜻한다. 일반 sandbox 수용을 의미하지 않는다.
- `native-thread-receipts.ts:readNativeThreads`는 주어진 SQLite를 읽기 전용으로 열고 `threads` 테이블의 `id`, `rollout_path`, 선택적 `source`를 최대 16행 조회한 뒤 닫는다. 중앙 작업 DB에 접근하는 함수가 아니다.
- `claude-agent-hook.ts`는 stdin을 최대 1MiB까지 받고 `claudeAgentReceipt` 검증을 통과한 항목만 기록한다. `auth-envelope.ts:sealAuth`는 난수를 생성하지만 파일이나 네트워크에 접근하지 않는다.

## Invariants

- gate는 필수 check가 각각 정확히 한 번 PASS일 때만 PASS다. `[gate.ts:evaluateGate]`
- `local-tools` check는 Node 메이저 24의 24.14 이상(25 이상은 FAIL)과 모든 도구, Docker 서버 버전이 있어야 PASS다. `[collect.ts:collectLocal]`
- 인증 봉인은 AES-256-GCM과 RSA-OAEP(SHA-256)를 쓰고 AAD는 `hivemind-phase0-auth-return-v1`이다. `[auth-envelope.ts:sealAuth]`
- `runBounded`는 시간 초과나 출력 초과 시 프로세스 그룹에 SIGTERM을 보내고 1,500ms 후 SIGKILL을 보낸다. stdout과 stderr는 하나의 바이트 예산을 나눠 쓴다. `[run-bounded.ts:runBounded]`
- Claude receipt는 `agent_type`이 `worker`이고 이벤트가 `SubagentStart` 또는 `SubagentStop`일 때만 인정한다. `[claude-receipts.ts:claudeAgentReceipt]`
- fixture 판정은 컨테이너 종료 확인(`containerStopped`)과 겹치는 병렬 subagent 구간을 요구한다. `[assess-codex.ts:assessCodexFixture]`, `[assess-claude.ts:assessClaudeFixture]`
- 경계 probe는 uid 1000, `NoNewPrivs` 1, 모든 capability 0을 요구한다. `[claude-boundary-probe.ts:assessClaudeBoundary]`, `[codex-boundary-probe.ts:assessCodexBoundary]`
- 겹친 sandbox probe는 인증 제공과 모델 호출이 모두 없어야 통과한다. `[claude-codex-layer-probe.ts:assessClaudeCodexLayer]`
- Codex fixture는 `auth_mode`가 `chatgpt`인 인증만 받는다. `codex-probe.ts`
- `mcp-server.ts`의 도구는 nonce가 `/^[0-9a-f]{32}$/`와 일치해야 한다. `mcp-server.ts`

## Side Effects

- `local.ts`는 `node`, `npm`, `wrangler`(또는 `aws`), `docker`, `codex`, `claude`의 버전·계정 조회 명령을 실행한다. 모델을 호출하지 않는다.
- `codex-probe.ts`와 `claude-probe.ts`는 구독 인증으로 실제 모델을 호출한다. `codex-probe.ts`는 홈 디렉터리에 인증·설정 파일을 쓴다. `claude-probe.ts`는 인증 파일을 쓰지 않고 토큰을 환경 변수로 넘기며, 홈 디렉터리에는 설정 파일과 더미 파일을 쓴다.
- `request-codex.ts`와 `request-claude.ts`는 `.hivemind/`의 비공개 파일을 읽고 배포된 Worker를 호출해 실제 모델 호출을 일으킨다. `request-codex.ts`는 회수한 인증으로 로컬 비공개 파일을 갱신한다. 두 스크립트는 `docs/phase0/`에 기록 파일을 쓴다.
- 경계 probe는 `/workspace`, `/runtime`, `/home/node`에 fixture 파일을 쓰고 `srt`, `codex sandbox`, `bwrap`, `proc-guard`를 실행한다. 일부는 차단 확인을 위해 외부 TCP 연결을 시도한다. `[claude-boundary-probe.ts:runClaudeBoundary]`, `[claude-codex-layer-probe.ts:runClaudeCodexLayerProbe]`
- `claude-agent-hook.ts`는 비공개 JSONL 파일에 한 줄을 추가한다.
- `gate.ts`, `assess-*.ts`, `claude-receipts.ts`, `rollout-receipts.ts`는 파일·프로세스·네트워크에 접근하지 않는다.

## Verification

- Run: `npm test` (`cloudflare/`에서 실행. `node --test tests/*.test.ts`)
- `npm run phase0:local`은 `wrangler whoami` 또는 AWS STS 계정 조회를 수행하므로 기본 오프라인 검증에서 제외한다 (`collect.ts:collectLocal`).
- `codex-probe.ts`, `claude-probe.ts`, `request-*.ts`는 테스트 명령에 포함하지 않는다. 실제 모델 호출이 발생하므로 운영자가 명시적으로 실행한다.
- `auth-envelope.ts`, `claude-agent-hook.ts` 등 backend 이미지에 복사되는 파일을 바꾸면 `backend/runtime-build.json`의 `digest`가 달라진다. `cloudflare/backend/`에서 `npm run runtime:check`로 확인한다.
