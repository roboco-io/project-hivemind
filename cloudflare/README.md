# Project HIVEMIND — Cloudflare 실행 백엔드

사람이 목표를 정하고 결과를 검토한다. 원격 컨테이너가 공식 Codex·Claude Code CLI와 별도 검증 작업을 실행한다.
이 폴더는 기존 로컬 관제 대시보드와 구분한 Cloudflare 구현이다.

- [실행 백엔드와 사용법](backend/README.md)
- [전체 아키텍처](ARCHITECTURE.md)
- [첫 구현 범위와 개발 계획](docs/plans/2026-11-10-cloudflare-backend.md)
- [실행·인증 경계 ADR](docs/adr/0001-cloudflare-first-runtime.md)
- [Claude 추가 격리](docs/adr/0002-claude-layered-sandbox.md) · [여러 턴 판정](docs/adr/0003-claude-terminal-turns.md) · [실행 버전 확인](docs/adr/0004-runtime-revision-fence.md)
- [최신 원격 수용 결과와 실제 diff](docs/verification/2026-11-10-cloudflare.md)
- [0단계 원격 검증 기록](docs/phase0/README.md)

## 현재 범위

인증된 작업 API, 불변 소스·결과 snapshot, 인증 스트림별 직렬화, 작업별 컨테이너,
인증 없는 별도 검증 컨테이너, 실제 실행 시간·출력·native subagent·MCP 증거, 로컬 결과 적용을 구현한다.
구독 인증을 API 과금 키로 바꾸지 않는다. CLI sandbox를 유지한다.

현재 계정에서 Codex·Claude의 동시 원격 실행과 별도 테스트를 통과했다.
두 제공자는 31,003ms 겹쳐 실행됐고, 제공자별 두 검증 보고서에서 각각 테스트 2건 통과를 확인했다.
원격 검증의 통과·실패와 배포 버전은 증거 문서로 구분한다.
Claude 호환 모드는 해당 계정의 파일·부모 프로세스·인증 경계 검증 후 활성화한다.
자신의 프로세스 상태를 읽는 것과 부모의 환경·명령·메모리·파일 별칭에 접근하는 것을 구분해 검증한다.

기존 관제 대시보드와 원격 API의 UI 연결, 전체 장애·재개 수용, 외부 Queue, 고급 MCP compute 제출은 후속 범위다.
AWS는 Cloudflare 원격 수용 후 별도로 구현한다. 현재 AWS 리소스를 생성하거나 배포하지 않는다.
