# mcp-server/src

## Overview

MCP(Model Context Protocol) 클라이언트가 HIVEMIND의 Cloudflare 작업과 워크플로를 다루도록 해 주는 stdio 서버다. 관제 서비스의 운영자 HTTP API만 호출하는 클라이언트이며, 데이터베이스나 제공자 인증 정보를 직접 열지 않는다. 로컬 워커 작업은 다루지 않는다.

## Interface

- `[server.ts:createHivemindMcpServer]` - `HivemindMcpOptions`를 받아 도구가 등록된 `McpServer`를 반환한다.
- `[server.ts:loadMcpSettings]` - `HIVEMIND_API_URL`, `HIVEMIND_OPERATOR_TOKEN`, `HIVEMIND_OPERATOR_TOKEN_FILE`에서 `McpSettings`를 만든다.
- `[server.ts:McpSettings]` - `apiUrl`, `operatorToken`.
- `[server.ts:HivemindMcpOptions]` - `McpSettings`에 테스트용 `fetchImpl`을 더한 타입.
- `[main.ts]` - 실행 진입점. `StdioServerTransport`로 서버를 연결한다.

`[server.ts:createHivemindMcpServer]`가 등록하는 MCP 도구는 다음과 같다.

| 도구 | 종류 | 호출하는 관제 API |
| --- | --- | --- |
| `hivemind_status` | 읽기 | `GET /api/capabilities`, `GET /api/state` |
| `hivemind_list_tasks` | 읽기 | `GET /api/state` |
| `hivemind_get_result` | 읽기 | `GET /api/state` |
| `hivemind_create_task` | 변경 | `GET /api/capabilities`, `POST /api/cloudflare/tasks` |
| `hivemind_decide_task` | 변경 | `POST /api/cloudflare/tasks/:id/decision` |
| `hivemind_cancel_task` | 변경 | `POST /api/cloudflare/tasks/:id/cancel` |
| `hivemind_create_workflow` | 변경 | `POST /api/cloudflare/workflows` |
| `hivemind_approve_workflow` | 변경 | `POST /api/cloudflare/workflows/:id/approve` |
| `hivemind_list_workflows` | 읽기 | `GET /api/cloudflare/workflows` |
| `hivemind_get_workflow` | 읽기 | `GET /api/cloudflare/workflows/:id`, 상태가 `SUCCEEDED` 또는 `FAILED`일 때만 `GET /api/cloudflare/workflows/:id/result` |

## Invariants

- `apiUrl`은 경로·인증 정보가 없는 원점이어야 한다. loopback 호스트가 아니면 `https:`여야 하고 개발용 기본 토큰을 쓸 수 없다 `[server.ts:validateSettings]`.
- `HIVEMIND_OPERATOR_TOKEN`과 `HIVEMIND_OPERATOR_TOKEN_FILE`은 함께 지정할 수 없다. 토큰 파일은 심볼릭 링크가 아닌 일반 파일이고 권한이 `0600`이며 64000바이트 이하여야 한다 `[server.ts:loadMcpSettings]`.
- 설정 오류는 원인과 무관하게 `Invalid HIVEMIND MCP configuration.` 한 가지 메시지로만 드러난다.
- 도구 출력의 모든 문자열은 `redact`를 거친다. 운영자 토큰 값, `Bearer` 뒤의 값, `access_token`·`refresh_token`·`api_key`·`control_token`·`operator_token`·`authorization`·`password`·`secret` 키에 붙은 값을 `[REDACTED]`로 바꾼다 `[server.ts:createHivemindMcpServer]`.
- 도구 실패와 프로토콜 오류는 `toolError` 한 가지 문구로 바뀐다. SDK의 스키마 오류 내용이 프로토콜 출력에 나가지 않게 하기 위해서다 `[server.ts:SafeMcpServer]`, `[server.ts:run]`.
- 작업 ID는 `taskIdPattern`(`cf-` 접두사)과 일치해야 한다. `runtime`이 `cloudflare`인 작업만 반환한다 `[server.ts:cloudTasks]`, `[server.ts:summary]`.
- `hivemind_create_task`는 초안만 등록한다. 연결 상태가 `ready`가 아니거나, 등록 응답의 상태가 `awaiting_execution_approval`이 아니거나, 저장소·커밋·테스트 프로필이 서버 정책과 다르면 실패로 처리한다. 반환값의 `executionApproved`는 항상 `false`다.
- 요청 본문은 64000바이트, 응답 본문은 2,000,000바이트를 넘을 수 없다. HTTP 리다이렉트는 오류로 처리한다 `[server.ts:api]`.
- `hivemind_get_result`와 `hivemind_get_workflow`의 diff와 로그는 `includeDiff`, `includeLogs`로 명시해야 포함된다. diff·로그·요약은 `maxChars` 문자 수 상한을 함께 쓴다 `[server.ts:budget]`.
- `[server.ts:summary]`는 `actualCostMicros`를 항상 `null`로 반환한다.
- `hivemind_get_workflow`는 결과 응답의 `id`, `contractHash`, `inputSnapshotId`가 진행 상태 응답과 다르면 실패로 처리한다.

## Side Effects

- 관제 서비스로 HTTP 요청을 보낸다. 제한 시간은 워크플로 경로가 30초, 그 밖의 경로가 10초다 `[server.ts:api]`.
- 변경 도구는 관제 서비스의 상태를 바꾼다. `hivemind_decide_task`의 실행 승인과 `hivemind_approve_workflow`는 유료 원격 실행을 시작하게 한다(도구 설명에 명시됨).
- `HIVEMIND_OPERATOR_TOKEN_FILE`이 지정되면 그 파일을 읽는다.
- `[main.ts]`는 stdin·stdout을 MCP 전송에 쓰고, 오류 문구를 stderr에 쓴다. stdin 종료, `SIGINT`, `SIGTERM`에 서버를 닫으며, 시작에 실패하면 `process.exitCode`를 1로 설정한다.

## Verification

- Run: `npm run check` (저장소 루트에서 실행한다. 테스트는 루트 `tests/` 디렉터리에 있다.)
