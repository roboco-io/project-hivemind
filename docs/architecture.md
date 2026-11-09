# 아키텍처

## 비전과 현재 경계

사람이 목표를 정하고 실행과 결과를 승인한다. 중앙 관제 시스템이 작업 상태와 실행 근거를 관리한다.
워커는 승인된 작업을 가져와 결과를 보고한다.
현재는 단일 운영자용 로컬 실행이며 `mock/local`과 설정된 `codex/local`을 지원한다.
자연어 목표 분해·의존성 DAG·모델 선택과 Claude·ChatGPT 연결은 후속 기능이다.

```mermaid
flowchart TB
    Human[사람] --> Web[독립 Web 관제실]
    Web -->|REST / 2초 조회| API[중앙 API]
    API --> Policy[허용 저장소 / 고정 커밋 / 승인 / 분배]
    Policy --> DB[(SQLite 작업 / 이벤트 / 실행 근거)]
    MW[모의 워커] -->|claim / heartbeat / result| API
    CW[Codex 워커] -->|claim / heartbeat / result| API
    MW --> Mock[합성 diff / 모의 비용]
    CW --> WT[작업별 detached worktree]
    WT --> Codex[Codex CLI]
    Codex --> Test[준비 / 테스트 명령]
    Test --> Evidence[실제 diff / 종료 코드 / 출력 / 사용량]
    Evidence --> CW
    Future[Claude / ChatGPT / ECS / Cloudflare 후속] -.-> API
```

## 구성 요소

| 구성 요소 | 책임 | 의존성 |
|---|---|---|
| `packages/contracts` | 작업, 저장소 정책, 실행 근거와 어댑터 계약 | 없음 |
| `packages/core` | 승인·취소·실행 권한·분배, 결과 검증과 저장 | 공통 계약, SQLite |
| `apps/control-plane` | 요청 검증, 역할 인증, 저장소 정책 조회와 UI 제공 | core, 읽기 전용 Git 조회 |
| `apps/dashboard` | 작업·실제/모의 결과·비용·이력 표시, 사람의 결정 | HTTP API |
| `apps/worker` | 설정 로드, provider별 작업 요청, heartbeat와 결과 보고 | HTTP API, 어댑터 |
| `packages/adapters` | Codex 실행, worktree, 프로세스 제어, diff·테스트 수집 | Git, Codex CLI, 공통 계약 |

워커 프로세스 하나는 작업 하나를 처리한다. 워커마다 다른 ID를 사용한다.
중앙 SQLite 파일은 API만 열고, 워커는 HTTP로 연결한다.

## 저장소와 실행 정책

운영자가 서버와 워커에 로컬 저장소 루트와 테스트 argv를 설정한다.
서버는 시작할 때 `HEAD`를 full commit SHA로 고정하고 `local` 저장소 ID와 `default` 테스트 프로필로 노출한다.
관제실은 이 정책을 조회하며, Codex 작업에는 `repositoryId`, `baseCommit`, `testProfile`만 전달한다.
임의 경로나 실행 명령은 작업 API가 받지 않는다.

새 작업의 커밋은 서버가 노출한 값과 일치해야 한다. 새 기준을 쓰려면 서버를 재시작한다.
등록 시 테스트 argv도 작업에 복사해 고정하므로 서버 설정 변경·재시작이 기존 승인을 바꾸지 않는다.
워커는 작업에 고정한 argv와 설정이 일치해야 실행하며, 결과도 해당 작업의 argv와 대조한다.
실행 중 테스트 설정을 바꾸지 않는다.

워커는 제공자·실행 환경·저장소 ID에 맞는 작업만 가져온다.
모의 워커가 Codex 작업을 실행하지 않으며 heartbeat가 워커의 실행 능력 정보를 덮어쓰지 않는다.

## 작업 수명주기

```mermaid
stateDiagram-v2
    [*] --> awaiting_execution_approval: 등록
    awaiting_execution_approval --> queued: 실행 승인
    awaiting_execution_approval --> rejected: 반려
    queued --> running: 워커 claim
    running --> awaiting_review: 실행과 검증 성공
    awaiting_review --> completed: 결과 수락
    awaiting_review --> rejected: 반려
    running --> failed: 실행 / 테스트 / 권한 만료 / 비용 오류
    awaiting_execution_approval --> cancelled: 중단
    queued --> cancelled: 중단
    running --> cancelled: 중단
    awaiting_review --> cancelled: 중단
```

`completed`, `rejected`, `failed`, `cancelled`는 종료 상태다. 재시도는 새 작업으로 등록한다.
Codex·준비·테스트 실패도 가능한 실행 근거와 diff를 보존한다. 실패 작업은 결과 수락으로 완료할 수 없다.
실행 승인과 결과 수락은 별도 결정이며 단계·사유·시각을 저장한다.
결과 수락은 원본 저장소에 변경을 적용하거나 Git 커밋·병합·푸시를 수행하지 않는다.

## 실행 권한과 중단

SQLite `BEGIN IMMEDIATE` 트랜잭션에서 승인 작업의 선택과 상태 변경을 함께 처리한다.
각 실행에 `runId`, `workerId`와 무작위 `leaseToken`을 연결한다.
같은 작업의 중복 할당과 잘못된 실행 권한의 결과 제출을 거절한다.

실행 권한은 30초 후 만료된다. 워커는 실행 중 5초마다 heartbeat로 갱신한다.
상태 조회·실행 관련 요청에서 만료를 검사하고, 결과 수락 트랜잭션 안에서도 기한을 다시 검사한다.
취소·만료 후 도착한 결과는 거절한다.
워커는 heartbeat 거절·연결 오류·사용자 중단·시간 제한에 따라 자식 프로세스를 종료한다.
POSIX에서는 프로세스 그룹에 종료를 요청하고, 응답하지 않으면 강제 종료를 시도한다.
원격 컨테이너의 시작·강제 종료는 후속 런타임 어댑터의 책임이다.

## worktree와 실행 근거

고정 커밋에서 실행별 detached worktree를 만든다. 원본의 dirty 파일과 index를 실행 입력으로 복사하지 않는다.
기존 실행 디렉터리를 재사용하거나 덮어쓰지 않는다. 원본과 worktree는 Git 메타데이터를 공유한다.
Codex는 `workspace-write`, 비대화형 승인 정책, `--ignore-user-config`로 실행한다.
추가 권한이 필요한 명령을 자동으로 허용하지 않는다.

선택적 준비 명령 후 설정된 테스트를 실행한다. 각 프로세스의 argv, 상태, 종료 코드,
소요 시간과 stdout/stderr를 수집한다. Codex JSONL에서 제공된 세션 ID와 토큰 사용량을 수집한다.
금액을 제공하지 않으면 임의 가격을 곱하지 않는다.

별도 `GIT_INDEX_FILE`에 base tree와 작업 변경을 반영해 실제 diff를 얻는다.
추적 파일의 수정·삭제, 새 파일과 바이너리를 포함하며 원본 index를 바꾸지 않는다.
테스트 실행 후 diff를 수집하므로 테스트가 남긴 추적 대상 변경도 결과에 포함될 수 있다.
HEAD가 고정 base에서 바뀐 실행은 성공으로 인정하지 않는다.
변경 없는 실행의 diff는 빈 문자열이다. 미보고 `null`과 구분한다.

저장 한도는 diff 180,000자, 준비·테스트의 stdout/stderr 각각 16,000바이트다.
한도를 넘으면 잘림 여부를 표시한다. worktree를 자동 삭제하지 않으므로 전체 결과를 로컬에서 조사할 수 있다.
정리 절차는 [README](../README.md#실행보존-경계)를 따른다.

Git worktree는 파일 변경 격리이며 보안 컨테이너가 아니다.
준비·테스트는 최소 환경 변수와 별도 HOME을 사용하지만 로컬 호스트에서 실행한다.
저장소 코드는 신뢰하는 것을 전제로 한다. 관제 토큰은 Codex·준비·테스트 프로세스에 전달하지 않는다.
Codex 로그인·추론 인증은 Codex 프로세스에만 제공하며 테스트 프로세스에는 제공하지 않는다.

## 저장과 비용

- `Task`: 지시, 고정 저장소 정책, 예산, 상태, 실행 ID, 결과와 diff.
- `ExecutionEvidence`: base/HEAD, worktree, 실행·준비·테스트 상태와 출력, 사용량, 잘림 여부.
- `Worker`: 제공자·실행 환경·저장소 ID, 마지막 연결 시각.
- `HiveEvent`: 증가하는 sequence, taskId, runId, 종류, 시각과 부가 정보.
- `Lease`: 해당 실행 워커에게만 전달하는 작업별 권한. 관제 상태 응답에 토큰을 넣지 않는다.

작업과 관련 이벤트는 같은 트랜잭션으로 저장한다. SQLite WAL을 사용하고 같은 파일로 재시작하면 복원한다.
기존 모의 작업의 JSON 기록도 유지한다. 이벤트는 누적 저장하며 상태 API는 최근 200개를 반환한다.
이벤트는 운영 추적용이며 변조 방지 감사 저장소는 아니다.

비용 단위는 USD micros 정수이며 `1 USD = 1,000,000 micros`다.
모의 예상·보고 비용은 1,000 micros다. 모의 예산이 예상보다 작으면 등록을 거절하고 초과 보고액은 보존한다.
Codex 예상·보고 금액은 `null`이며 UI는 미확정으로 표시한다. 입력·캐시 입력·출력 토큰은 제공된 경우만 저장한다.
작업 예산은 실제 제공자의 외부 과금을 중지하거나 상한을 보장하는 장치가 아니다.

## HTTP API

응답은 envelope 없이 공통 계약 객체를 반환한다. 작업이 없는 claim은 JSON `null`이다.
모든 `/api` 요청에 역할별 `Authorization: Bearer <token>`이 필요하다.

| 권한 | 메서드와 경로 | 요청/응답 |
|---|---|---|
| 공개 | `GET /health` | 서버 상태 |
| 공개 | `GET /`, `/app.js`, `/styles.css` | 정적 관제 UI |
| 운영자 | `GET /api/capabilities` | `{providers,repository}`. 저장소 경로 없이 고정 커밋·프로필·명령 조회 |
| 운영자 | `GET /api/state` | `{tasks,workers,events}`와 저장된 실행 근거 |
| 운영자 | `POST /api/tasks` | 기본 작업 필드 + Codex의 `{repositoryId,baseCommit,testProfile}` → Task |
| 운영자 | `POST /api/tasks/:id/decision` | `{decision:"approve" 또는 "reject",reason}` → Task |
| 운영자 | `POST /api/tasks/:id/cancel` | `{reason}` → Task |
| 워커 | `POST /api/workers/register` | `{workerId,provider,runtime:"local",repositoryId?}` → Worker |
| 워커 | `POST /api/workers/claim` | `{workerId}` → Lease 또는 null |
| 워커 | `POST /api/tasks/:id/heartbeat` | `{workerId,leaseToken}` → Task |
| 워커 | `POST /api/tasks/:id/result` | 실행 권한 + `{summary,diff,actualCostMicros,execution?}` → Task |
| 워커 | `POST /api/tasks/:id/fail` | 실행 권한 + `{message}` → Task |

Codex 결과의 저장소·커밋·테스트 명령과 성공 상태의 일관성을 검사한다.
실행 근거는 인증된 워커의 보고이며, 독립적으로 검증된 증명이나 원격 attestation은 아니다.
워커 토큰으로 사람의 승인·취소를 수행할 수 없다.
현재는 공유 역할 토큰 두 개다. 사용자별 인증·조직 분리·토큰 회전·원격 TLS는 후속 범위다.

## 확장 방향

Claude·ChatGPT와 계획 에이전트도 같은 중앙 API를 사용한다.
AgentAdapter는 모델 실행, RuntimeDriver는 실행 환경의 시작과 중지를 담당한다.
PostgreSQL, 영속 워크플로, 원격 컨테이너와 이벤트 스트리밍은 [개발 로드맵](roadmap.md)에 따라 추가한다.
