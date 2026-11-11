# 앱·CLI에서 원격 워크플로 사용

Codex 앱의 프로젝트 로컬 채팅, Codex CLI, Claude Code 앱의 로컬 Code 세션과 CLI가 같은 워크플로 도구를 사용한다. 등록은 [Codex 연결 안내](codex-integration.md)와 [Claude Code 연결 안내](claude-integration.md)를 따른다. 새 도구를 로드하려면 중앙 서비스를 최신 빌드로 실행하고 새 세션을 연다.

## 운영자 설정

기존 Cloudflare 브리지 설정에 워커별 검사와 통합 검사를 추가한다. 값은 JSON 한 줄이다.

```sh
export HIVEMIND_CLOUDFLARE_WORKFLOW_CHECKS='{"codex":[{"id":"add","argv":["node","check-add.mjs"],"timeoutMs":35000}],"claude":[{"id":"multiply","argv":["node","check-multiply.mjs"],"timeoutMs":35000}],"integration":{"id":"integration","argv":["node","check-integration.mjs"],"timeoutMs":35000}}'
```

위 명령은 예시다. 대상 저장소의 고정 커밋에 계약과 검사 파일을 포함하고, 검사가 사용하는 파일을 워커의 쓰기 범위 밖에 둔다. 중앙 서비스는 고정 커밋에서 snapshot을 만들고 계약 파일의 SHA-256을 구한다. MCP 호출에 전달한 명령, URL, 인증 값은 받지 않는다.

## MCP 사용 흐름

1. `hivemind_status`에서 `workflowsAvailable`과 저장소·기준 커밋을 확인한다.
2. `hivemind_create_workflow`에 요청 UUID(`requestId`), 제목, `baseCommit`, 계약 상대 경로(`contractPath`), `codex`와 `claude` 각각의 `instructions`·`writes`를 지정한다. 계약 해시와 워크플로 ID가 있는 초안이 반환된다.
3. 사용자가 실행을 승인한 경우 `hivemind_approve_workflow`에 `workflowId`와 `contractHash`를 전달한다. 등록 응답을 받지 못하면 같은 요청 UUID와 내용으로 확인한다.
4. `hivemind_get_workflow`에서 워커 상태와 각 라운드의 독립 검사 상태를 읽는다. 완료된 뒤 `includeDiff`, `includeLogs`를 켜면 통합 변경과 검사 로그가 반환된다. 통합 검사의 종료 코드와 인증 부재·소스 불변 근거를 확인한다.
5. 창을 닫고 다시 연 뒤에는 같은 ID로 조회한다. ID를 잊었으면 `hivemind_list_workflows`를 사용한다. 중앙 서비스와 등록 정보를 저장한 SQLite 파일은 같은 구성을 사용한다.

원격 스케줄러가 승인 뒤 실행과 통합을 진행한다. 중앙 서비스는 등록 정보를 보존하고 조회 요청 시 결과를 가져온다. 조회용 Git diff는 임시 경로에 복원한 고정 입력·출력 snapshot에서 생성한다. 현재 작업 폴더를 수정하지 않는다.

[실제 접점별 검증 기록](verification/2026-11-12-workflow-mcp.md)에서 확인한 범위를 볼 수 있다.
