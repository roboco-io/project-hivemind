# Cloudflare 실행 검증 — 2026-11-10

현재 계정의 실제 Cloudflare Worker·Containers·R2에서 수행했다. 로컬 검증은 별도 표기한다.
AWS 리소스는 생성하거나 배포하지 않았다.

## 최신 원격 수용

첫 Cloudflare 실행 범위를 통과했다. 공식 Codex·Claude 구독 인증과 CLI sandbox를 유지했다.
Worker `68a5c8de-de3d-4ca4-83d0-b27fdc5ca760`,
실행 소스 지문 `dac58a4ec80ef8e5874e0bdc9a609f90031eb4188c2d9fa56ee1f8a2f598444e`을 확인했다.
[실제 서비스 버전](runtime-revision-acceptance-20261110.json)과
[전체 원격 결과](dual-provider-remote-acceptance-20261110.json)를 함께 기록했다.

| 검증 | Codex | Claude |
|---|---|---|
| 작업 | `240c6b66-6798-4c13-be2f-e5a7b093ec73` | `59b3b47d-753c-4a61-a3c3-84016596661d` |
| 최종 상태 | SUCCEEDED | SUCCEEDED |
| 두 native worker의 겹친 실행 | 14,790ms | 16,228ms |
| 두 별도 검증 프로세스의 겹친 실행 | 10,365ms | 3,378ms |
| 각 검증 보고서 | 테스트 2 · 통과 2 · 실패 0 | 테스트 2 · 통과 2 · 실패 0 |
| 인증 세대 | R2 g5 → g6 · 준비 상태 | R2 g5 → g6 · 준비 상태 |

두 제공자의 실제 실행 프로세스는 31,003ms 겹쳤다.
각 제공자는 서로 다른 두 native worker를 완료하고 요청 nonce에 연결된 MCP 성공 응답을 반환했다.
제출 프로그램이 종료된 뒤 별도 조회 프로그램에서 결과를 회수했다.
동일 요청의 재제출은 같은 작업을 반환했고, 같은 키의 다른 요청은 HTTP 409로 거부했다.

검증 컨테이너 네 개는 제공자 인증 없이 실행했다. 제공자별 두 검증은 같은 최종 snapshot을 사용했다.
테스트 파일과 검증 스크립트의 무결성을 확인했고 모든 agent·검증 컨테이너의 종료를 확인했다.
CLI 사용량은 보고된 값이며 실제 구독·클라우드 청구 내역을 대신하지 않는다.

## 실제 Claude 결과의 로컬 적용

성공한 Claude 결과를 별도 detached Git worktree의 입력 fixture에 공식 클라이언트로 적용했다.
적용 전 테스트 2건 실패, 적용 후 2건 통과를 확인했다.
실제 Git diff는 `add`와 `multiply` 두 구현만 바꿨다.
원본 프로젝트 index를 수정하지 않았고 임시 worktree를 정리했다.

[실제 Git diff](claude-actual-worktree.diff) · [적용 기록](local-claude-apply-20261110.json).
이는 로컬 적용 증거이며 위 원격 실행 기록과 구분한다.

## Codex 초기 실행

Worker 버전 `b04be7b9-8696-495b-bda1-eeffa2957b42`,
작업 `d965aef3-3341-4937-b03d-418aa9693032`.
로컬 제출 프로세스가 종료된 뒤 작업을 새 프로세스에서 조회하고 결과를 회수했다.

| 검증 | 관찰 |
|---|---|
| 실제 코드 변경 | `add(a,b)`와 `multiply(a,b)` 구현 |
| 공식 native 서브에이전트 | 서로 다른 두 자식의 완료 구간이 12,960ms 겹침 |
| MCP | 요청 nonce와 연결된 성공 응답·고정 마커 확인 |
| 별도 검증 컨테이너 | 두 실행 프로세스가 10,404ms 겹침 |
| 검증 귀속 | 두 컨테이너 모두 동일한 최종 출력 snapshot 사용 |
| 인증 경계 | 검증 컨테이너의 제공자 인증 부재 확인 |
| 소스 무결성 | 두 검증 컨테이너 모두 입력 소스 변경 없음 |
| 인증 반환 | 새 인증 세대 저장·컨테이너 종료·lane 해제 후 g1 준비 상태 확인 |
| 최초 테스트 출력 한계 | 종료 코드는 0이었지만 표준 출력이 비어 있어 보고서 건수는 별도 재검증 |

[최초 실행 원본과 범위](codex-initial-transport-20261110.json),
[실제 Git diff](codex-actual-worktree.diff).

## 테스트 출력 대조 검증

Worker `7e711991-b3d4-4410-ade5-8349e4753d31`에서 구독 인증 없이 수행했다.
일반 파일로 출력 수집을 바꾸고 계산용 named permission profile에 network를 명시했다.
Cloudflare의 외부 통신 제한은 그대로 유지한다.

- 기존 옵션은 Node 테스트 파일 단위 1건만 보고했다.
- 수정한 옵션은 실제 테스트 2건·통과 2건·실패 0건을 보고했다.
- 같은 옵션에서 의도적으로 틀린 assertion은 종료 코드 1·실패 1건으로 보고했다.

[같은 환경에서의 대조 결과](../phase0/cloudflare-compute-stdio-7e711991-20261110.json).
수정한 경로의 전체 실제 모델 작업도 재검증했다.
Worker `90d31bcb-fe16-4759-92e3-5fc6d46b4750`, 작업 `dfaedc74-54b4-4513-bb31-c8a444f0cc54`가 성공했다.
두 native 자식은 13,380ms, 두 검증 프로세스는 10,422ms 겹쳤다.
각 검증 보고서에서 실제 테스트 2건·통과 2건·실패 0건을 확인했다.
R2의 g1 인증을 재사용한 뒤 g2 저장·종료·준비 상태를 확인했다. 이전 로컬 시드는 재등록하지 않았다.
[최신 전체 원격 수용 기록](codex-remote-acceptance-20261110.json).

## 로컬 결과 적용

실제 원격 입력 snapshot을 별도 detached Git worktree에 복원했다.
클라이언트로 실제 성공 결과를 적용했다. 적용 전 테스트 2건 실패, 적용 후 2건 통과를 확인했다.
원본 프로젝트 파일과 index를 수정하지 않았다. 임시 worktree는 정리했다.
이는 로컬 적용 증거이며 Cloudflare 실행 증거를 대신하지 않는다.

[적용 기록](local-codex-apply-20261110.json).

## Claude 격리와 오류 수정

공식 nested 호환 모드의 공유 `/proc`를 단독 사용했을 때 부모 정보 노출을 확인했다.
Landlock 추가 호출은 `ENOSYS(38)`로 실패했고, 부모 PID만 가리는 방식도 채택하지 않았다.
공식 CLI sandbox에 추가 격리를 조합해 파일·프로세스·인증·통신 등 29개 명명 조건과
UID·권한·정상 종료 조건을 검증했다.
[경계 검사](../phase0/cloudflare-claude-layer-9fb46990-20261110.json)를 참조한다.

반복 명령의 멈춤은 Bubblewrap의 사용하지 않는 proc 메타데이터 조회와 연결됐다.
원본 도구의 실제 오류·남은 자식과, 같은 이미지에서 수정 경로의 동시·반복 성공을 확인했다.
[대조 시험](../phase0/cloudflare-claude-concurrency-9fb46990-20261110.json),
[호환 빌드](../bubblewrap-compatibility.md),
[실제 Claude main·native worker 경로](../phase0/cloudflare-claude-subscription-20261110.json)를 참조한다.
이 시험의 두 native worker는 11,913ms 겹쳤고 파일·MCP·Bash 경계 검사와 종료를 통과했다.
임시 진단 Worker의 Claude 인증은 제거했다.

운영 API 연결에서는 같은 세션의 서로 다른 정상 종료 3건을 한 건 조건으로 거부했다.
[진단](claude-terminal-shape-20261110.json)을 바탕으로
[세션·결과별 검증](../adr/0003-claude-terminal-turns.md)을 적용했다.
모든 결과의 성공·루트 세션·고유 UUID·최종 이벤트·정상 프로세스 종료를 요구한다.

이미지 갱신만 한 배포에서 제어면과 실제 버전 관측이 달랐다.
[관측](runtime-deployment-mismatch-20261110.json)에 따라
[인증 전달 전 버전 확인](../adr/0004-runtime-revision-fence.md)을 추가했다.
현재 서비스의 소스 지문 일치와 위 두 제공자의 성공을 새로 검증했다.
초기 동시 시험에서 metadata 조회가 일시적으로 HTTP 503을 반환했다.
같은 작업을 재조회했으며 모델 작업을 다시 제출하지 않았다.

## 로컬 회귀 검사와 범위

Node.js 24.14에서 기존 대시보드 65개, Cloudflare 시험 61개, 백엔드 142개가 통과했다.
최종 독립 코드 검토를 통과했고, 저장 실패 시 인증 차단과 공식 오류 이벤트 거부도 회귀 검사했다.
타입 검사, 실행 버전 파일 검사, Linux 보호 실행 파일과 Bubblewrap 호환 빌드를 확인했다.

첫 실행 범위의 수용 결과다. 기존 관제실의 원격 UI 연결, 전체 장애·재개 수용,
외부 Queue, 고급 MCP compute 제출과 AWS는 후속 범위다.
