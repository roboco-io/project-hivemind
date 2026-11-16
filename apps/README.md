# apps

## Overview

실행 가능한 프로세스와 운영자 화면을 모은 디렉터리다. 네 앱은 모두 관제 서비스(`control-plane`)의 HTTP API를 경계로 삼는다. 대시보드와 MCP 서버는 운영자 토큰으로, 워커는 워커 토큰으로 관제 서비스를 호출한다. 공용 계약, 상태 저장소, 어댑터는 이 디렉터리 밖의 `packages/`에 있다.

## Subdirectories & Boundaries

- control-plane: [./control-plane/README.md](./control-plane/README.md) - 중앙 관제 HTTP 서버. 운영자 API, 워커 API, 대시보드 정적 파일을 제공한다.
- dashboard: [./dashboard/README.md](./dashboard/README.md) - 운영자용 정적 웹 대시보드. 관제 서비스가 파일을 제공한다.
- mcp-server: [./mcp-server/README.md](./mcp-server/README.md) - 운영자 API를 `hivemind_*` MCP 도구로 감싼 stdio 서버. Cloudflare 작업과 워크플로만 다룬다.
- worker: [./worker/README.md](./worker/README.md) - 승인된 로컬 작업을 가져와 어댑터로 실행하고 결과를 보고하는 프로세스.
