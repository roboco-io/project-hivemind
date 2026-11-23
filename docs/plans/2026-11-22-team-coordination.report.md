# 팀 작업 원장·안전 중단 1차 적용 결과

상태: 1차 구현·전체 검사·교차 검토·새 독립 최종 리뷰 완료. 최종 판정은 로컬 후보 범위의 APPROVED다. 실제 모델·유료 자원·배포·commit·push는 하지 않았다.

## 구현

- 기존 Cloudflare 두 워커 workflow에 선택적 TeamState를 연결했다. 기본 TEAM_COORDINATION_ENABLED는 false/미설정이며 기존 승인·CLI·credential 직렬화·독립 검사 경계를 유지한다.
- 중앙 typed DAG·claim·heartbeat·candidate·메모·페이지 조회를 구현했다. 중복 claim·쓰기 충돌·순환 의존성·타 팀/다른 attempt를 거절한다. 종료가 확인되지 않은 만료 lease는 recovery_required이며 중복 실행으로 재할당하지 않는다.
- 워커는 현재 job/attempt에 결속된 private capability로 자기 팀의 safe board를 읽고 쓴다. actor는 JSON에서 정하지 않는다. issuer는 private RPC이고 public HTTP·UI에 노출하지 않는다. capability registry는4096개로 bounded이고 재시작 시 기존 토큰을 거부한다.
- 정상 보고는 worker_report이고 후보다. root scope와 독립 검사·snapshot·실제 stop/auth를 확인한 gateway_observed만 작업을 검증한다. 동적 하위 작업을 root 완료만으로 검증하지 않는다. 실제 결과 객체 키는 opaque evidenceRef로 바꾼다.
- block은 원장과 workflow/하위 job의 취소 요청을 함께 저장하고 새 실행을 차단한다. 늦은 성공이 block을 지우지 않는다. review는 검토 기록이며 자동 재개하지 않는다. 동일 입력은 재생 가능하고 다른 사유로 기존 기록을 덮어쓰지 않는다.
- 같은 scheduler snapshot에서 COW·직렬화·commit 후 공개한다. 응답 유실로 commit 여부가 불명확하면 durable 상태를 다시 읽는다. 재읽기도 실패하면 전역 admission/write/dispatch fence를 유지한다. 복구 전 stale snapshot으로 block을 덮어쓰지 않는다.
- 운영자 API와 MCP3도구(get/block/review)를 등록된 workflow binding에 연결했다. 고정 원격 경로·인증·응답 크기·비밀 정제를 적용하고 localhost fallback을 두지 않았다.

## 검사

| 항목 | 최종 결과 |
|---|---|
| npm run check | 1020 passed,0 failed,0 skipped,exit0 |
| backend typecheck + npm test | 746 passed,0 failed,0 skipped,exit0 |
| runtime stamp/check | exit0 |
| Wrangler deploy --dry-run | exit0, 실제 deployment 아님 |
| git diff --check | exit0 |
| 동결 source | 45개 hash, 최종 drift 없음 |

처음 전체 검사1008/741 통과 후에도 교차 검토를 계속했다. capacity 발급 경합, JSON escape 비밀 노출, 기록 포화 후 실제 완료/새 integration 저장 실패, 과거 검증과 현재 attempt 결속 혼동, 실제 R2 key 형식, COW 갱신 손실·commit 응답 유실, 공유 board 읽기, 정상 쓰기의 전역 복구 예산 소비를 회귀와 함께 수정했다. 최종1020/746은 이 수정 뒤의 결과다. 해당 로그·baseline/source hash는 `.superlite/team-coordination/`에 보존한다.

기존 dirty HF·runtime·README·drift 문서를 보존했다. 의도한 root README/MCP README 링크와 generated runtime manifest 갱신을 제외한 baseline 파일의 바이트가 같음을 확인했다. 런타임 manifest에는 현재 입력을 반영했으며 새 이미지를 실제 배포하지 않았다.

## 범위

이것은 추천 적용 순서의 첫 단계다. 실제 실행 그래프는 기존 두 worker와 integration이다. 일반 DAG API가 추가 모델 실행을 생성하지 않는다. production CLI에 capability와 모델용 team 도구를 넣는 연결, 자동 사전 classifier, offline 행위 분석기, 실제2/4/8 비용·성능 실측은 후속이다. CLI 도구 연결 시에도 허용 범위를 workflow 승인에 결속해야 한다.

이 코드의 gateway 관측은 중앙이 본 job/workflow·검사 상태이며 모든 shell/edit를 샌드박스 밖에서 독립 감시한 증거가 아니다. worker_report나 운영자가 적은 사유를 자동 탐지 결과로 바꾸지 않는다. 실제 컨테이너 종료·auth 회수와 단순 block 상태도 구분한다.

한도는 task128·논리 member16·notes256개/각2KiB, 정상2048events/512KiB, trusted 복구512events/추가512KiB, private state hard1MiB다. 일반 worker write는 전역 정상 한도를 쓰고 block/review만 복구 한도를 요청한다. 실제 Worker 메모리·시간·대규모 처리량과1000agent 지원을 입증한 것이 아니다.

[사용법과 계약](../team-coordination.md) · [계획](2026-11-22-team-coordination.md)

## 최종 동결

새 최종 검토자가 현재 team-coordination 패킷의 권한 경계·private projection·복원·COW·불확실성 fence·할당량·증거 출처를 읽고 APPROVED로 판정했다. 이는 production CLI 연결이나 운영 수용의 승인이 아니다.

runtime digest: `1ab2fc05497ea60add34ec76d032e253962f4e12554d27a334ffc75a32f13cae`.
Worker dry-run bundle SHA-256: `6b8d7471b001f613c113d550257fd4f1ea7da1c94b6fbf093ae260969d74f8dc`.
