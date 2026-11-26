# scripts

## Overview

이 디렉터리는 HIVEMIND MCP 서버를 사용자 프로젝트의 로컬 설정에 등록하는 설치 스크립트 2개와 [세션 분할 실험](./experiments/README.md)을 담는다. `configure-hivemind-mcp.ts`는 Codex 설정 파일 `.codex/config.toml`에 등록하고, `configure-hivemind-claude.ts`는 Claude Code 설정 파일 `.mcp.json`에 등록한다. 두 스크립트 모두 빌드된 MCP 서버 진입점 `dist/apps/mcp-server/src/main.js`를 Node로 실행하는 항목을 만들고, 그 설정 파일이 Git에 추적되지 않도록 `info/exclude`에 규칙을 추가한다.

두 스크립트는 운영자 토큰 값을 읽거나 저장하지 않는다. `operatorTokenFile` 옵션으로 받은 파일의 경로만 환경 변수 `HIVEMIND_OPERATOR_TOKEN_FILE`에 기록한다.

## Interface

- `configureHivemindMcp(options: HivemindMcpConfigOptions): HivemindMcpConfigResult`: Codex용 설정을 쓴다. `.codex/config.toml`에 `# BEGIN HIVEMIND MCP (managed)`와 `# END HIVEMIND MCP (managed)` 주석으로 감싼 `[mcp_servers.hivemind]` 블록을 추가하거나 교체한다. [configure-hivemind-mcp.ts:`configureHivemindMcp`]
- `configureHivemindClaude(options: HivemindClaudeConfigOptions): HivemindClaudeConfigResult`: Claude Code용 설정을 쓴다. `.mcp.json`의 `mcpServers.hivemind` 항목을 추가하거나 교체하고, 항목의 해시를 `.claude/hivemind-mcp.local.json`에 기록한다. [configure-hivemind-claude.ts:`configureHivemindClaude`]
- `HivemindMcpConfigOptions`, `HivemindClaudeConfigOptions`: 두 타입 모두 `{ projectRoot: string; nodePath?: string; apiUrl?: string; operatorTokenFile?: string }` 형태다. `nodePath`의 기본값은 `process.execPath`, `apiUrl`의 기본값은 `http://127.0.0.1:4310`이다. [configure-hivemind-mcp.ts:`HivemindMcpConfigOptions`] [configure-hivemind-claude.ts:`HivemindClaudeConfigOptions`]
- `HivemindMcpConfigResult`, `HivemindClaudeConfigResult`: 두 타입 모두 `{ configPath: string; changed: boolean }` 형태다. [configure-hivemind-mcp.ts:`HivemindMcpConfigResult`] [configure-hivemind-claude.ts:`HivemindClaudeConfigResult`]
- CLI: `npm run mcp:configure`(Codex)와 `npm run mcp:configure:claude`(Claude Code)로 실행한다. 플래그는 `--project-root`, `--node-path`, `--api-url`, `--operator-token-file`이고 각 플래그는 값을 하나 받는다. `--project-root`를 생략하면 현재 작업 디렉터리를 쓴다. [configure-hivemind-mcp.ts:`cli`] [configure-hivemind-claude.ts:`cli`]
- 하위 디렉터리: [experiments](./experiments/README.md) - Claude Code 세션 분할 방식의 시간과 비용을 측정하는 실험 스크립트.

## Invariants

두 스크립트에 공통으로 적용되는 조건은 다음과 같다.

- `projectRoot`는 Git 저장소의 최상위 디렉터리여야 한다. `git rev-parse --show-toplevel` 결과가 `projectRoot`의 실제 경로와 다르면 실패한다. [configure-hivemind-mcp.ts:`configureHivemindMcp`] [configure-hivemind-claude.ts:`configureHivemindClaude`]
- `nodePath`는 절대 경로인 일반 파일이어야 하고, `dist/apps/mcp-server/src/main.js`가 이미 있어야 한다. 따라서 설치 전에 빌드가 끝나 있어야 한다. [configure-hivemind-mcp.ts:`entryParts`] [configure-hivemind-claude.ts:`entryParts`]
- 검사하는 경로에 심볼릭 링크가 있거나 파일과 디렉터리 종류가 기대와 다르면 `Unsafe HIVEMIND configuration path.` 오류로 실패한다. [configure-hivemind-mcp.ts:`checkPath`] [configure-hivemind-claude.ts:`safe`]
- `apiUrl`은 사용자 정보, 쿼리, 해시가 없고 경로가 `/`인 `http:` 또는 `https:` URL이어야 한다. `http:`는 loopback 호스트(`127.0.0.1`, `localhost`, `[::1]`)에서만 허용한다. loopback이 아닌 호스트는 `operatorTokenFile`이 있어야 허용한다. [configure-hivemind-mcp.ts:`loopback`] [configure-hivemind-claude.ts:`loopback`]
- Git이 추적하는 설정 파일은 수정하지 않고 `Tracked project configuration cannot be modified.` 오류로 실패한다. [configure-hivemind-mcp.ts:`tracked`] [configure-hivemind-claude.ts:`untracked`]
- `info/exclude`에 규칙을 추가한 뒤 `git check-ignore`로 설정 파일이 실제로 무시되는지 확인하고, 무시되지 않으면 실패한다. [configure-hivemind-mcp.ts:`configureHivemindMcp`] [configure-hivemind-claude.ts:`configureHivemindClaude`]
- 설치 스크립트가 관리하지 않는 기존 `hivemind` MCP 서버 설정이 있으면 덮어쓰지 않고 `An unmanaged HIVEMIND MCP server already exists.` 오류로 실패한다. [configure-hivemind-mcp.ts:`refuseConflict`] [configure-hivemind-claude.ts:`configureHivemindClaude`]
- 설정 파일은 같은 디렉터리의 임시 파일에 쓰고 `fsync`한 뒤 `rename`으로 교체하며, 권한은 `0o600`이다. 내용과 권한이 이미 같으면 쓰지 않고 `changed`가 `false`다. [configure-hivemind-mcp.ts:`atomicWrite`] [configure-hivemind-claude.ts:`atomic`, `write`]
- Git 하위 프로세스는 시스템과 전역 Git 설정, hooks, fsmonitor를 끄고 제한된 환경 변수만 넘겨 5초 제한 시간으로 실행한다. [configure-hivemind-mcp.ts:`git`] [configure-hivemind-claude.ts:`git`]
- CLI는 실패 시 고정된 문구만 stderr에 쓰고 `process.exitCode`를 1로 설정한다. 원래 오류 메시지는 출력하지 않는다. [configure-hivemind-mcp.ts:`cli`] [configure-hivemind-claude.ts:`cli`]

`configure-hivemind-mcp.ts`(Codex)에만 적용되는 조건은 다음과 같다.

- 관리 블록의 시작 주석과 끝 주석은 각각 정확히 1개여야 하고 시작이 끝보다 앞에 있어야 한다. 그렇지 않으면 `Invalid managed HIVEMIND MCP block.` 오류로 실패한다. [configure-hivemind-mcp.ts:`managed`]
- 관리 블록 바로 뒤에 테이블 헤더가 아닌 설정 줄이 오면 `Unmanaged settings follow the HIVEMIND MCP block.` 오류로 실패한다. [configure-hivemind-mcp.ts:`managed`]
- 기존 TOML의 테이블 헤더를 해석할 수 없으면 `Cannot safely inspect existing Codex configuration.` 오류로 실패한다. 할당문 키를 해석할 수 없으면 그 줄을 건너뛴다. [configure-hivemind-mcp.ts:`refuseConflict`, `keyParts`]
- 생성하는 블록은 `default_tools_approval_mode = "writes"`를 포함한다. [configure-hivemind-mcp.ts:`configureHivemindMcp`]

`configure-hivemind-claude.ts`(Claude Code)에만 적용되는 조건은 다음과 같다.

- `.mcp.json`은 중복 키가 없는 JSON 객체여야 하고 `mcpServers`가 있으면 객체여야 한다. [configure-hivemind-claude.ts:`inspectJson`]
- `hivemind` 항목 이외의 내용은 원본 문자열 구간을 그대로 유지하고 다시 직렬화하지 않는다. [configure-hivemind-claude.ts:`inspectJson`, `appendProperty`]
- 표식 파일 `.claude/hivemind-mcp.local.json`은 `version`이 1이고 `entryHash`가 현재 `hivemind` 항목의 SHA-256 지문과 같아야 한다. 다르면 `Managed HIVEMIND MCP settings were changed outside the installer.` 오류로 실패한다. [configure-hivemind-claude.ts:`fingerprint`, `configureHivemindClaude`]
- 쓰기 전후에 대상 파일의 식별 정보(`dev`, `ino`, 크기, 시각, 권한)와 내용, 상위 디렉터리의 `dev`와 `ino`를 다시 확인한다. 달라졌으면 동시 변경으로 보고 실패한다. [configure-hivemind-claude.ts:`unchanged`, `parents`]
- 잠금 파일 `info/.hivemind-claude.lock`을 배타 생성(`wx`)으로 잡은 동안에만 쓴다. [configure-hivemind-claude.ts:`lock`]
- 트랜잭션 디렉터리 `.claude/hivemind-mcp.transaction.local`이 남아 있으면 `An interrupted HIVEMIND configuration transaction requires recovery.` 오류로 실패한다. 쓰기 도중 오류가 나면 이미 쓴 파일을 역순으로 되돌리고, 되돌리기에 실패하면 트랜잭션 디렉터리를 남긴다. [configure-hivemind-claude.ts:`transactionName`, `configureHivemindClaude`]

## Side Effects

- `git` 하위 프로세스를 실행한다(`rev-parse`, `ls-files --error-unmatch`, `check-ignore`). 저장소 내용을 바꾸는 Git 명령은 실행하지 않는다. [configure-hivemind-mcp.ts:`git`] [configure-hivemind-claude.ts:`git`]
- Git 공통 디렉터리의 `info/exclude`에 무시 규칙을 추가한다. Codex용은 `/.codex/config.toml`, Claude Code용은 `/.mcp.json`, `/.claude/hivemind-mcp.local.json`, `/.claude/hivemind-mcp.transaction.local/`이다. [configure-hivemind-mcp.ts:`rule`] [configure-hivemind-claude.ts:`rules`]
- Codex용 스크립트는 `.codex/` 디렉터리(`0o700`)와 `.codex/config.toml`을 만들거나 수정한다. 이 스크립트는 `info/exclude`를 먼저 쓰고 `.codex/config.toml`을 나중에 쓰며, 되돌리기 절차는 없다. [configure-hivemind-mcp.ts:`configureHivemindMcp`]
- Claude Code용 스크립트는 `.claude/` 디렉터리(`0o700`), `.mcp.json`, `.claude/hivemind-mcp.local.json`을 만들거나 수정한다. 실행 중에는 잠금 파일과 트랜잭션 디렉터리(`manifest.json`, `<n>.before`, `<n>.after` 백업)를 만들고 성공하면 지운다. [configure-hivemind-claude.ts:`configureHivemindClaude`]
- 두 스크립트는 대상 디렉터리에 `.hivemind-*.tmp` 임시 파일을 만들고 `finally`에서 지운다. [configure-hivemind-mcp.ts:`atomicWrite`] [configure-hivemind-claude.ts:`atomic`]
- 네트워크 호출은 하지 않는다. `apiUrl`은 형식만 검사해 설정에 기록한다. CLI는 성공 시 stdout에 안내 문구 한 줄을 쓴다. [configure-hivemind-mcp.ts:`cli`] [configure-hivemind-claude.ts:`cli`]

## Verification

- Run: `npm run check` (저장소 루트에서 실행한다. `tsc --noEmit` 뒤에 `npm test`를 실행한다.)
- 관련 테스트는 저장소 루트의 `tests/mcp-config.test.ts`와 `tests/claude-mcp-config.test.ts`다.
