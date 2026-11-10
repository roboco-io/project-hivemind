# Claude Code 등록·스킬과 실제 클라이언트 검증

검증일: 2026-11-10. macOS, Node.js 24.14.0. AWS와 Cloudflare 배포·인증 원본 재등록은 수행하지 않았다.

## 구현과 설정 보존

- `npm run mcp:configure:claude`가 프로젝트 `.mcp.json`의 `hivemind`만 관리한다. 기존 JSON 원문 값, 다른 서버와 Codex 설정을 보존한다.
- 관리 표식·원자적 저장·동시 변경 감지·실패 시 복구·개인 설정 Git 제외를 적용했다. 충돌과 중단 복구가 필요한 경우 덮어쓰기를 거부한다.
- `.claude/skills/hivemind/SKILL.md`는 `/hivemind`마다 공통 `.agents/skills/hivemind/SKILL.md`를 먼저 읽는다. 권한 자동 승인은 추가하지 않았다.
- 원래 프로젝트에도 API `http://127.0.0.1:4311`로 등록했다. 등록 직전·직후 해시 대조에서 기존 Codex 프로젝트 설정, Claude 사용자 설정, Desktop 설정이 동일했다. 개인 설정·로그·백업 내용은 공개하지 않는다.

## 실제 호스트 검증

| 접점 | 확인한 근거 | 남은 범위 |
|---|---|---|
| Codex CLI 0.167.0 | `$hivemind` 실제 세션: `hivemind_status`, `hivemind_list_tasks`, 기존 두 작업의 `hivemind_get_result` 성공·정상 종료 | 이 호스트에서 새 원격 실행·승인·취소·재시작 전체 수용 |
| Claude Code CLI 2.1.321 | `/hivemind` 실제 세션: 공통 원본 `Read`, status/list와 두 결과 도구 호출, `result.success` | 새 원격 실행·승인·취소·재시작 전체 수용 |
| Codex 앱 | 자동 조작 도구가 앱 접근을 보안상 거부함. 현재 세션에 HIVEMIND MCP 도구도 노출되지 않음 | 사용자 새 앱 세션의 실제 검증 필요 |
| Claude Code 앱의 로컬 Code 탭 | 사용자 승인 후 실제 로컬 Code 세션: `/hivemind` 발견·공통 원본 Read·status/list·두 get_result 호출 4회와 화면 결과 확인 | 새 원격 실행·승인·재시작 전체 수용 |

Claude 앱 세션 `local_213bfe72-3d91-4ed4-bf1a-55f264a12258`의 도구 이력을 펼쳐 실제 원본 경로와 도구 호출 네 건을 확인했다. 앱 응답은 2026-11-10T10:25:38Z 조회 기준 ready·작업 4건과 두 워커 결과를 표시했다. 사용자에게 승인받은 검증 폴더만 신뢰했으며 다른 전역 보안 설정은 바꾸지 않았다.

CLI 검증은 설치된 실제 클라이언트와 모델 세션으로 수행했다. SDK로 대체하지 않았다. 조회 전용 도구만 세션에 허용했고 권한 우회 옵션은 사용하지 않았다. 새 유료 원격 작업은 만들지 않았다.

## 실제 조회 결과

대상은 전용 `dashboard-remote-fixture` 저장소이며 base는 `e481d2d26f43a194b4c0dbb13f28649df12eb6a3`다. 현재 Hivemind 프로젝트 자체가 자동 제출된다는 뜻이 아니다.

| 워커 | 중앙 작업 ID | 반환된 결과 |
|---|---|---|
| Codex | `cf-e217d1da-4258-4a07-a91c-26183ed01873` | `completed` / `SUCCEEDED`, 실제 alpha·beta 함수 수정 diff |
| Claude | `cf-73aee5c9-910a-40a2-8f23-d6ff82fcb5d7` | `awaiting_review` / `SUCCEEDED`, 실제 add·multiply 함수 수정 diff |

두 CLI가 각 작업의 diff와 agent·check 로그를 조회했다. 두 작업 모두 agent 종료 코드 0, `unit-a`·`unit-b` 성공이다. 각 검증의 `node verify.mjs`는 테스트 2개 통과·실패 0·종료 코드 0을 반환했다. `credentialsAbsent`, `sourceUnchanged`, `authSynced`, `containerStopped`는 true다. 요청한 출력의 잘림 표시는 false였다. 비용은 null로 미확정이며, 상세 인증 저장 로그와 별도 종료 로그는 미제공이다.

## 자동 검사와 완료 경계

`npm run check`: 타입 검사 성공, 테스트 148개 통과·실패 0개. 추가 등록/스킬 테스트 14개와 독립 읽기 전용 코드 검토를 통과했다.

네 앱·CLI 접점 × 두 워커의 전체 종단 수용은 미완료다. 조회 성공을 새 작업 실행 성공으로 확대하지 않는다. [지원 기준과 남은 항목](../client-support.md)을 따른다.
