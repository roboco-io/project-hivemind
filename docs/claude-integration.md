# Claude Code 앱·CLI 연결

대상은 Claude Desktop 앱의 **로컬 Code 탭**과 Claude Code CLI다. 일반 Chat 탭 연결을 뜻하지 않는다. 두 접점은 프로젝트 `.mcp.json`을 읽는다. 다만 Code 탭에서 동명 서버는 `claude_desktop_config.json`이 우선하며, 사용자 범위 `~/.claude.json`의 stdio 서버도 프로젝트보다 우선한다. CLI의 우선순위는 local → project → user다. 동명 설정이 있으면 실제 연결 대상을 각각 확인한다. [Desktop 공식 안내](https://code.claude.com/docs/en/desktop#shared-configuration), [MCP 범위 안내](https://code.claude.com/docs/en/mcp#scope-hierarchy-and-precedence)

## 프로젝트에 등록

Node.js 24 이상에서 같은 프로젝트 루트를 사용한다. 중앙 서버의 대상 저장소·고정 커밋·필수 검증 정책을 먼저 설정하고 서버를 실행한다. [환경 변수 예시](../.env.example)와 [아키텍처](architecture.md)를 참고한다.

```sh
npm ci
npm run build
npm run mcp:configure:claude
```

다른 중앙 API 주소나 운영자 파일을 쓸 때는 경로만 지정한다.

```sh
npm run mcp:configure:claude -- --api-url http://127.0.0.1:4311 --operator-token-file /absolute/path/to/private/operator.json
```

운영자 파일은 중앙 서버와 같은 `OPERATOR_TOKEN`을 담은 JSON이며 권한은 `0600`이다. 설치 도구는 비밀 내용을 읽거나 복사하지 않는다. 기본 개발 인증은 loopback에서만 사용한다. 외부 API는 HTTPS와 운영자 인증이 필요하다.

설치 도구는 `.mcp.json`의 `mcpServers.hivemind`만 관리한다. Node와 빌드된 MCP 진입점의 절대 경로, API 주소와 선택적 운영자 파일 경로를 기록한다. 다른 JSON 설정은 보존한다. `.claude/hivemind-mcp.local.json`은 비밀 값이 없는 관리 표식이다. 생성 파일은 권한 `0600`으로 저장하고 Git 공통 `info/exclude`에 제외 규칙을 추가한다. 개인 절대 경로가 있으므로 이 생성 파일은 커밋하지 않는다.

관리 표식 없는 동명 서버, 사용자가 변경한 관리 항목, 잘못된 JSON·중복 키·추적 파일·symlink 경로는 덮어쓰지 않는다. Codex 설정·Claude 전역 설정·인증 파일은 변경하지 않는다. 충돌 때는 오류 원인을 확인하고 사용자 설정을 보존한다.

## 세션에서 확인

프로젝트를 신뢰하고 프로젝트 MCP 사용 승인을 확인한 뒤 새 세션을 연다. CLI는 프로젝트 루트에서 `claude`를 실행하고 `/mcp`로 연결을 확인한다. Code 탭도 같은 프로젝트의 로컬 세션에서 연결을 확인한다. 설정·도구가 보이지 않으면 해당 세션이나 앱을 다시 시작한다. 설치는 도구 사용 권한이나 원격 실행을 자동 승인하지 않는다. [프로젝트 MCP 승인 안내](https://code.claude.com/docs/en/mcp#project-server-approvals-and-workspace-trust)

프로젝트 스킬은 [Claude 진입점](../.claude/skills/hivemind/SKILL.md)에 있다. `/hivemind`로 호출한다. Codex에서는 `$hivemind`를 쓴다. Claude의 `/` 메뉴에서 발견 여부를 확인한다. 같은 이름의 개인·조직 스킬이 있으면 프로젝트 스킬을 가릴 수 있다. [스킬 공식 안내](https://code.claude.com/docs/en/skills#choose-where-skills-load)

> /hivemind 현재 연결 대상 저장소와 기준 커밋을 확인해 줘.
>
> /hivemind 이 프로젝트의 합계 함수 개선 작업을 Claude 초안으로 등록해 줘. 아직 실행하지 마.
>
> /hivemind 해당 작업의 실제 diff와 테스트 결과를 보여 줘.

스킬은 [공통 업무 원본](../.agents/skills/hivemind/SKILL.md)을 매 호출마다 읽는다. 등록 전에 서버의 저장소·`baseCommit`을 사용자의 대상과 대조하며, 불일치하면 작업을 만들지 않는다. 현재 폴더의 변경이 자동 제출되지 않는다.

초안 등록, 실행 승인과 결과 수락은 별도 동작이다. 실행을 명시적으로 요청한 작업만 승인한다. 도구 호출에 대한 호스트 승인은 원격 실행 의도를 대신하지 않는다. 결과 수락은 검토 기록이며 원본 적용·커밋·병합·push가 아니다. 취소 요청 후에는 실제 종료를 확인해야 취소 완료로 보고한다.

연결 실패 때는 빌드 결과·Node 경로·서버 주소·운영자 파일 권한을 확인한다. 전역 설정이나 권한을 임의로 변경하지 않는다. 기존 원격 credential stream을 사용하고 로컬 Codex·Claude 인증 시드를 재등록하지 않는다. 비밀 값과 인증 원본은 대화·로그에 붙여 넣지 않는다.

## 유지보수와 검증 범위

업무 규칙은 `.agents/skills/hivemind/SKILL.md`에서만 수정한다. Claude 진입점에는 호스트 안내와 원본 읽기 지시만 둔다. 원본을 옮기면 두 호스트의 참조와 문서 링크를 함께 갱신한다. `tests/claude-skill.test.ts`는 실제 상대 링크, 원본의 단계 경계와 읽기 실패 중단 지시를 확인한다. 문구나 줄 수를 복제해 동기화를 강제하지 않는다.

```sh
node --test tests/claude-skill.test.ts
npm run check
```

이 검사는 실제 호스트 세션 수용을 증명하지 않는다. CLI와 Code 탭에서 각각 스킬 발견·원본 로드·실제 MCP 호출을 확인해야 한다. [지원 상태와 수용 근거](client-support.md)에 버전·승인·호출 결과·차단 사유를 기록한다. SDK 호출만으로 앱 또는 CLI 검증 완료를 주장하지 않는다.

## 중단된 등록 복구

등록 중 프로세스가 중단되면 `.claude/hivemind-mcp.transaction.local/`에 권한이 제한된 복구 자료가 남을 수 있다. 다른 MCP의 비밀 설정도 포함될 수 있으므로 업로드하거나 출력하지 않는다. 해당 프로젝트의 등록 프로세스가 종료됐는지 확인하고, `manifest.json`의 해시를 현재 파일과 대조한 뒤 변경된 파일을 복구한다. 현재 파일이 저장된 전후 해시와 모두 다르면 사용자 편집을 먼저 보존한다. 복구가 끝난 뒤에만 transaction과 Git 공통 `info/.hivemind-claude.lock`을 정리하고 다시 등록한다. 활성 프로세스의 잠금을 지우지 않는다.

[공통 계약 워크플로](workflow-mcp.md)도 같은 앱·CLI 세션에서 사용한다.
