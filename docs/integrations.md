# 외부 도구와 실행 환경 통합

이 문서는 후속 구현의 경계와 검증 항목을 정한다.
현재 설치한 실행 제공자는 `mock`뿐이다. SDK, MCP 서버와 클라우드 호출은 연결하지 않았다.
공식 문서의 확인 기준일은 2026-11-09다. 계정 권한·제공 범위·API 버전은 실제 연결 전에 다시 확인한다.

## 공통 실행 계약

`AgentAdapter.execute(task, signal)`은 제공자 실행을 `summary`, `diff`, `actualCostMicros`로 변환한다.
현재 계약은 최소 형태다. 실제 실행 시에는 다음 정보를 확장해야 한다.

- 제공자 세션과 실행 ID, 원본 이벤트의 참조.
- 도구 실행 승인과 사람의 결정 연결.
- 입력·출력 토큰 등 사용량 원본, 가격표 버전, 비용의 확정 여부.
- 저장소 base/head commit, patch 해시, 테스트 결과와 결과물 위치.
- 취소 요청·실제 종료의 구분, 재시도 시도 번호와 멱등성 키.

제공자 API 키와 로그인 토큰은 워커에 주입한다. Web UI나 작업 이벤트에 저장하지 않는다.
구독 계정과 API 인증 방식을 서로 대체할 수 있다고 가정하지 않는다.

## Codex

후속 1차 실행 어댑터 후보로 둔다. 단순 작업 자동화와 지속 대화·승인 이벤트를 포함하는
제품 통합은 필요한 제어 수준이 다르다. 실제 어댑터 도입 시 지원되는 SDK 또는 App Server의
전송·인증·승인 방식을 선택하고 버전을 고정한다.

[공식 Codex App Server 문서](https://learn.chatgpt.com/docs/app-server)는
인증, 대화 이력, 승인과 스트리밍 이벤트를 다루는 깊은 통합 경로를 설명한다.
HIVEMIND는 제공자별 이벤트를 중앙 실행과 연결하되, 중앙 작업 상태와 승인 정책을 유지한다.

## Claude Code

Claude Agent SDK 기반 어댑터를 후속으로 구현한다.
도구 권한, 승인 대기, 실행 이벤트와 취소를 공통 계약으로 변환한다.
Codex와 동일한 세션 모델이나 이벤트 형식을 갖는다고 가정하지 않는다.
구현 기준은 [공식 Claude Agent SDK 개요](https://code.claude.com/docs/en/agent-sdk/overview)다.

## ChatGPT와 MCP

ChatGPT는 목표 입력과 작업 조회를 위한 대화 인터페이스로 연결한다.
MCP 서버는 중앙 API에 위임하고, 자체 작업 상태나 별도 승인 저장소를 만들지 않는다.
제안 도구는 `list_tasks`, `get_task`, `create_task`다. 승인·취소 기능은 사용자의 신원과
권한을 전달할 수 있는 인증 경로를 먼저 구현한 뒤 추가한다.

대화 도구가 워커 토큰으로 사람의 결정을 수행해서는 안 된다.
앱 내 UI가 필요하면 [공식 MCP 서버 구현 문서](https://developers.openai.com/plugins/build/mcp-server)를
기준으로 호스트의 UI·인증 계약을 확인한다. 기존 Codex·Claude 앱 화면을 임의로 수정하는 방식에 의존하지 않는다.

## AWS ECS

실제 원격 실행의 첫 대상으로 설계한다. 작업당 격리된 컨테이너가 워커 프로토콜로 중앙에 연결한다.
런타임 드라이버는 시작한 외부 실행 ID를 저장하고, 취소 시 해당 실행을 중지해야 한다.
작업 종료 후 임시 디스크·비밀·네트워크 자원 정리를 확인한다.
[공식 ECS standalone task 문서](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/standalone-tasks.html)는
일을 수행한 후 종료하는 작업 실행 모델을 설명한다.

인증·공개 API·이미지 레지스트리·클러스터·리전은 아직 지정하지 않았다.
초기 골격에서 AWS 자원을 만들거나 특정 계정에 배포하지 않는다.

## Cloudflare Containers

경량 작업의 대체 런타임으로 후속 평가한다.
[공식 Cloudflare Containers 문서](https://developers.cloudflare.com/containers/)를 기준으로
Worker 측 제어, 인스턴스 수명, 파일시스템과 네트워크 제약을 확인한다.
ECS와 같은 시작 API나 실행 수명 모델을 가진다고 가정하지 않는다.
지원할 작업의 실행 시간·디스크·빌드 도구·외부 통신 요구를 검증한 뒤 도입한다.

`RuntimeDriver`는 이 차이를 감추는 최소 경계다. 현재 ECS·Cloudflare 구현체는 없다.
저장소 URL, 배포 대상과 비밀을 사용자가 지정하기 전에는 예시 값을 실제 자원으로 만들지 않는다.
