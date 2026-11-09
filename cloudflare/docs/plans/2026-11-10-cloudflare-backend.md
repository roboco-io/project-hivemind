# 첫 Cloudflare 백엔드 구현·검증

현재 폴더의 아키텍처와 0단계 증거를 기준으로 구현한다. AWS는 이번 배포에 사용하지 않는다.
사용자는 다른 채팅의 안전 인계와, 별도 경계 검증을 통과한 Claude 공식 nested 호환 모드 사용을 허용했다.

## 이번 실행 가능한 범위

인증된 작업 API → 불변 입력 snapshot → 인증 lane별 원격 CLI → 불변 출력 snapshot →
인증 없는 별도 컨테이너의 필수 검증 → 최종 결과 manifest → 로컬 검토·적용.
Codex·Claude 공식 구독 인증과 내부 서브에이전트를 유지한다. 과금 API 키로 대체하지 않는다.
필수 검증은 서버가 최종 snapshot에 대해 실행하며 모델이 생략할 수 없다.
초기 컴퓨팅은 선언된 검증 argv를 사용한다. 모델의 임의 자식 명령 제출은 초기 API에 노출하지 않는다.

## 구현 결정

- backend/를 독립 패키지로 만들어 기존 phase0 시험 코드와 의존성 변경을 분리한다.
- Worker API, Scheduler Durable Object, 작업별 Container Durable Object와 R2를 사용한다.
- Durable Object alarm을 영속 실행 대기열과 조정기로 사용한다. 외부 Queue 전송 adapter는 후속으로 추가한다.
- 컨테이너의 HTTP 제어기는 입력 배치·결과 회수만 담당한다. 실행은 고정된 runner로 시작한다.
- 모든 agent·compute 프로세스에 capability 제거와 no-new-privileges를 적용한다.
- CLI 종료와 인증 저장·컨테이너 종료를 확인하기 전 credential lane을 재할당하지 않는다.
  모호한 중단·인증 회수 실패는 AUTH_SYNC_FAILED로 격리하며 자동 재실행하지 않는다.
- 인증은 일반 snapshot과 분리하고 R2에서는 Worker Secret 키로 암호화한다.
  컨테이너의 인증 반환은 공개키 envelope로 암호화한다. Worker 관리 비밀은 컨테이너에 전달하지 않는다.
- Claude 호환 모드는 기본 filesystem/network sandbox와 strict 실패 정책을 유지하되 /proc 차이를 별도로 검증한다.
- 원격 전용 인증은 인계 종료 후에만 사용한다. 같은 Codex 번들의 외부 스트림을 직렬화한다.
- 기존 GitHub 로컬 대시보드의 소스를 삭제하거나 덮어쓰지 않는 방식으로 통합·게시한다.

## 병렬 구현과 검토

1. snapshot·안전한 파일 복원·로컬 client: 경로/해시/충돌/삭제/바이너리/모드 검증.
2. 순수 scheduler: 멱등성, lane, 자원 상한, 검증 귀속, 취소·중복·모호한 종료 검증.
3. 컨테이너 runner: CLI와 sandbox, 인증 반환, source/compute 분리, timeout·출력 제한 검증.
4. Worker와 R2·암호화·Durable Object 조정 연결, 로컬 계약 시험과 원격 배포.
5. 실제 remote 두 제공자, 독립 검증 컨테이너의 겹친 실행 구간, 종료·비밀 경계를 확인한다.
6. 새 final reviewer와 원격 증거 대조 후 논리적 커밋과 모든 설정 원격에 push한다.

## 완료 판단

원격 모델·실제 편집·sandbox·인증 저장·최종 snapshot 검증·결과 회수가 모두 확인되어야
첫 백엔드 수용을 통과한다. 로컬 성공이나 HTTP 200만으로 원격 성공을 선언하지 않는다.
현재 설계 전체의 장애·재개·고급 MCP compute 제출과 AWS 수용까지 완료했다고 주장하지 않는다.
