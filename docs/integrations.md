# 클라이언트·워커 통합

1차 클라이언트는 Codex 앱·CLI와 Claude Code 앱·CLI다.
지원 수준과 미구현·미검증 작업은 [지원 설계](client-support.md)를 기준으로 한다.
클라이언트가 누구인지와 원격 워커 제공자(Codex/Claude)는 독립된 축이다.

## 현재 구현

- 공통 MCP stdio 도구 6개와 중앙 운영자 HTTP API.
- Codex 프로젝트 등록 도구와 `.agents/skills/hivemind`.
- 승인·영속 요청·취소·실제 diff·테스트·검토를 관리하는 중앙 core.
- Cloudflare의 공식 Codex·Claude 구독 CLI 워커와 별도 검증 컨테이너.
- 기존 mock/local과 로컬 실제 CLI worktree 실행, 선택적인 웹 관리 화면.

[Codex 사용법](codex-integration.md), [아키텍처](architecture.md),
[원격 backend](../cloudflare/backend/README.md)와 [실제 검증](verification/2026-11-10-codex-integration.md)을 참조한다.

## 아직 완료하지 않은 통합

Claude Code의 `.mcp.json` 설치·기존 설정 보존과 `.claude/skills` 진입점이 없다.
Codex CLI 설정 인식과 공통 SDK 검증은 있지만 네 앱·CLI의 실제 사용자 세션 수용은 아직 없다.
공식 설정 공유 기능만으로 앱·CLI 모두 동작한다고 선언하지 않는다.
상시 HUD와 일반 Claude 채팅·Cowork·호스팅 cloud 세션은 별도 확장·검증 범위다.
AWS는 현재 MVP가 완전히 끝난 뒤 AWS CDK로 진행한다. Cloudflare가 현재 배포·검증된 원격 실행 환경이다.
