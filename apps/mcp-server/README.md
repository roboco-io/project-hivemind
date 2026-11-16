# mcp-server

## Overview

MCP 클라이언트용 stdio 서버 앱이다. 관제 서비스의 운영자 HTTP API를 MCP 도구로 감싼다. 소스는 `src/` 한 곳에 있다.

## Subdirectories & Boundaries

- src: [./src/README.md](./src/README.md) - `createHivemindMcpServer`, `loadMcpSettings`와 실행 진입점. Cloudflare 작업과 워크플로용 `hivemind_*` 도구 10개를 등록하고, 출력에서 비밀 값을 가린다.
