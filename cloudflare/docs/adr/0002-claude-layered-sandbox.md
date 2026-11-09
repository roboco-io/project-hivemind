# ADR 0002: Claude Bash의 추가 격리

상태: 무인증 경계와 실제 main·native worker 경로의 원격 수용 통과.

## 관찰

공식 nested 호환 모드는 기존 `/proc`를 공유한다. 해당 실행 환경에서는
filesystem의 `/proc` 차단만으로 부모 명령 정보가 가려지지 않았다.
추가 Landlock 호출은 `ENOSYS(38)`로 실패했다.
부모 PID만 가리는 방식은 thread·sibling root 별칭을 충분히 다루지 못한다.

## 결정

공식 Claude sandbox를 켜고 실패 시 중단한다. 관리 `PreToolUse` 훅은 모든 Bash 명령을
공식 Codex의 로컬 `sandbox` 실행과 추가 namespace 필터 안에서 실행하도록 바꾼다.
`codex sandbox`는 모델을 호출하지 않으며 Codex 구독 인증을 전달하지 않는다.
실제 모델 제공자는 Claude Code와 사용자의 Claude 구독이다.

외부 sandbox는 내부 격리 초기화에 필요한 namespace 생성을 허용한다.
내부 Codex 격리가 작업 공간·비공개 파일·`/proc` 접근을 제한한 뒤,
추가 seccomp 필터가 실제 명령과 모든 자식의 namespace·mount 변경을 다시 차단한다.
필터는 권한을 추가하거나 기존 SDK 필터를 제거하지 않는다.
잘못된 ABI, x32, namespace clone, unshare·setns·mount 계열은 차단한다.
일반 자식 프로세스와 스레드는 허용한다.

내부 네트워크 설정은 Node 프로세스의 정상 IPC를 허용한다.
외부 Claude sandbox와 Cloudflare 통신 제한은 유지한다.
SRT가 지정한 임시 경로는 내부 실행에서 정상 `/tmp`로 연결한다.
전용 guard cache는 초기화에만 쓰고 실제 명령에서는 읽기 전용으로 제한한다.

관리 훅은 `onFailure: block`을 사용한다. 실패·시간 초과·잘못된 출력은 실행을 막는다.
`--restricted`와 관리 설정은 저장소 설정으로 이 경로를 바꾸지 못하게 한다.
훅 감사 기록은 명령 원문 없이 식별자·해시·시각만 저장한다.
감사 기록은 준비 증거이며 실행 성공과 혼동하지 않는다.

## 수용 기준

[무인증 원격 증거](../phase0/cloudflare-claude-layer-cb39754e-20261110.json)는
파일·부모·thread·sibling 별칭, 인증 환경, namespace 재생성, cache와 원본 파일 보호,
통신 제한 등 29개 명명 조건과 UID·권한·정상 종료 조건을 확인했다. 일반 Node 실행도 유지했다.
반복 실행의 proc 메타데이터 조회 문제는 [Bubblewrap 호환 빌드](../bubblewrap-compatibility.md)로 수정했다.
[실제 Claude 경로](../phase0/cloudflare-claude-subscription-20261110.json)에서도 두 native worker,
main Bash 경계 검사, MCP와 종료를 확인했다. 해당 계정에서 Claude 실행을 활성화했다.

이 구현은 신뢰하는 본인 저장소의 단일 운영자용 초기 범위다.
전체 장애·재개 수용과 공개 다중 사용자 서비스의 보안 수용을 대신하지 않는다.
