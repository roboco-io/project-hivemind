# scripts/phase0/cloudflare

## Overview

이 폴더는 0단계 타당성 probe를 Cloudflare Container에서 실행하는 Worker다.
`handler.ts`가 bearer 인증과 경로를 처리하고, `worker.ts`의 `Phase0Container`가 컨테이너를 시작해 상위 폴더의 probe 스크립트를 실행한다. `outbound.ts`는 컨테이너의 외부 요청을 허용 호스트로 제한한다.
배포 설정은 `wrangler.json`과 `wrangler.boundary.json`이다. 검증 기록은 [0단계 문서](../../../docs/phase0/README.md)를 따른다.

## Interface

- `[handler.ts:handleProbe]` - `(request, token, run)`을 받아 JSON 응답을 반환한다.
- `[handler.ts:ProbeKind]` - `runtime`, `sandbox`, `codex`, `claude`, `claude-boundary`, `codex-boundary`, `landlock`, `claude-layer`, `compute-stdio`, `claude-concurrency`.
- `[outbound.ts:codexOutbound]`, `[outbound.ts:claudeOutbound]` - 허용되지 않은 요청에 403을 반환하고 나머지는 전달한다.
- `[worker.ts:Phase0Container]` - Durable Object. 공개 메서드 `diagnostics(kind)`는 동시 호출을 진행 중인 실행 하나로 합친다.
- `[worker.ts:CodexOutbound]`, `[worker.ts:ClaudeOutbound]` - outbound 진입점.
- `[worker.ts:default]` - Worker `fetch` 처리기. `handleProbe`를 호출한다.

| 메서드·경로 | 실행하는 probe |
|---|---|
| `GET /phase0` | `runtime` |
| `GET /phase0/sandbox` | `sandbox` |
| `POST /phase0/codex` | `codex` (실제 구독 모델 호출) |
| `POST /phase0/claude` | `claude` (실제 구독 모델 호출) |
| `GET /phase0/claude-boundary` | `claude-boundary` |
| `GET /phase0/codex-boundary` | `codex-boundary` |
| `GET /phase0/landlock` | `landlock` |
| `GET /phase0/claude-layer` | `claude-layer` |
| `GET /phase0/compute-stdio` | `compute-stdio` |
| `GET /phase0/claude-concurrency` | `claude-concurrency` |

경로의 근거는 모두 `[handler.ts:handleProbe]`다.

## Invariants

- 모든 경로는 `Authorization: Bearer <PROBE_TOKEN>`이 정확히 일치해야 한다. 토큰이 설정되지 않으면 503, 다르면 401이다. 인증을 경로·메서드 검사보다 먼저 확인한다. `[handler.ts:handleProbe]`
- 알 수 없는 경로는 404, 메서드가 다르면 405, probe 실행 실패는 내용을 숨긴 502다. `[handler.ts:handleProbe]`
- Codex outbound는 `chatgpt.com`, `auth.openai.com`, `api.openai.com`만 허용한다. `[outbound.ts:codexOutbound]`
- Claude outbound는 `api.anthropic.com`, `claude.ai`, `claude.com`, `platform.claude.com`만 허용한다. `[outbound.ts:claudeOutbound]`
- outbound는 https이고 userinfo가 없으며 포트가 비어 있거나 443이어야 한다. `[outbound.ts:codexOutbound]`, `[outbound.ts:claudeOutbound]`
- `codex`와 `claude` probe는 Durable Object마다 한 번만 실행한다. 두 번째 호출은 오류다. `[worker.ts:Phase0Container]`
- 컨테이너는 `enableInternet:false`로 시작한다. 모든 명령은 `setpriv --no-new-privs --inh-caps=-all --ambient-caps=-all --bounding-set=-all`로 실행한다. `[worker.ts:Phase0Container]`

## Side Effects

- Cloudflare 컨테이너를 시작하고 명령을 실행한 뒤 종료한다. `[worker.ts:Phase0Container]`
- `codex`와 `claude` probe는 구독 인증을 컨테이너 환경으로 전달해 실제 모델을 호출한다. 다른 probe는 모델을 호출하지 않는다. `[worker.ts:Phase0Container]`
- Durable Object storage에 일회 실행 표시를 쓴다. `[worker.ts:Phase0Container]`
- Worker가 컨테이너를 대신해 허용된 제공자 호스트로 요청을 전달한다. `[worker.ts:CodexOutbound]`, `[worker.ts:ClaudeOutbound]`
- 이름으로만 읽는 비밀: `PROBE_TOKEN`, `CODEX_AUTH_JSON`, `AUTH_RETURN_PUBLIC_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`. 값은 이 문서에 기록하지 않는다.

## Verification

- Run: `npm test` (`cloudflare/`에서 실행. `node --test tests/*.test.ts`)
- 배포와 원격 probe 호출은 테스트 명령에 포함하지 않는다.
