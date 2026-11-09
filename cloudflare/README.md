# Project HIVEMIND — Cloudflare 실행 백엔드

사람이 목표를 정하고 결과를 검토한다. 원격 컨테이너가 공식 Codex·Claude Code CLI와 별도 검증 작업을 실행한다.
이 폴더는 기존 로컬 관제 대시보드와 구분한 Cloudflare 구현이다.

- [실행 백엔드와 사용법](backend/README.md)
- [전체 아키텍처](ARCHITECTURE.md)
- [첫 구현 범위와 개발 계획](docs/plans/2026-11-10-cloudflare-backend.md)
- [실행·인증 경계 ADR](docs/adr/0001-cloudflare-first-runtime.md)
- [0단계 원격 검증 기록](docs/phase0/README.md)

## 현재 범위

인증된 작업 API, 불변 소스·결과 snapshot, 인증 스트림별 직렬화, 작업별 컨테이너,
인증 없는 별도 검증 컨테이너, 실제 실행 시간·출력·native subagent·MCP 증거, 로컬 결과 적용을 구현한다.
구독 인증을 API 과금 키로 바꾸지 않는다. CLI sandbox를 유지한다.

원격 검증의 통과·실패와 배포 버전은 증거 문서로 구분한다.
Claude 호환 모드는 파일·부모 프로세스·인증 경계 검증 전까지 차단한다.
자신의 프로세스 상태를 읽는 것과 부모의 환경·명령·메모리·파일 별칭에 접근하는 것을 구분해 검증한다.

기존 관제 대시보드와 원격 API의 UI 연결, 전체 장애·재개 수용, 외부 Queue, 고급 MCP compute 제출은 후속 범위다.
AWS는 Cloudflare 원격 수용 후 별도로 구현한다. 현재 AWS 리소스를 생성하거나 배포하지 않는다.
