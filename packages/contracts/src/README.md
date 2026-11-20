# contracts/src

## Overview

이 디렉터리는 HIVEMIND의 중앙 core, 모델 어댑터, 워커, UI가 함께 쓰는 공통 계약을 정의한다. `index.ts`와 `cloudflare.ts`는 TypeScript 타입과 인터페이스만 내보낸다. 실행 코드는 `workflow.ts`의 `zod` 스키마뿐이다. 이 디렉터리의 파일은 저장소나 네트워크에 접근하지 않는다.

파일은 세 가지 범위로 나뉜다. `index.ts`는 로컬 작업(task)의 상태, 실행 근거, 어댑터 계약을 정의한다. `cloudflare.ts`는 Cloudflare 런타임에서 실행하는 작업의 근거와 포트 계약을 정의한다. `workflow.ts`는 Codex와 Claude 두 워커가 한 계약 파일을 기준으로 나눠 작업하는 워크플로의 입력 스키마와 조회 스키마를 정의한다.

## Interface

`index.ts` (로컬 작업 계약):

- `[index.ts:TaskStatus]`: 작업 상태 8개. `awaiting_execution_approval`, `queued`, `running`, `awaiting_review`, `completed`, `rejected`, `cancelled`, `failed`.
- `[index.ts:Provider]`: `mock`, `codex`, `claude`. `[index.ts:Runtime]`: `local`, `ecs`, `cloudflare`.
- `[index.ts:CreateTask]`, `[index.ts:Task]`: 작업 생성 입력과 저장되는 작업 레코드.
- `[index.ts:Worker]`, `[index.ts:HiveEvent]`, `[index.ts:State]`, `[index.ts:Lease]`: 워커 등록 정보, 이벤트, 전체 상태 조회 결과, claim 결과(작업과 `leaseToken`).
- `[index.ts:ProcessEvidence]`, `[index.ts:AgentRunEvidence]`, `[index.ts:ExecutionEvidence]`: 프로세스 실행 근거, 에이전트 실행 근거, 실제 실행 전체 근거.
- `[index.ts:RepositoryPolicy]`, `[index.ts:Capabilities]`: 고정 저장소 정책(`baseCommit`, `testProfile`, `testCommand`)과 서버 기능 응답.
- `[index.ts:RunResult]`: 어댑터가 반환하는 결과(`summary`, `diff`, `actualCostMicros`, `execution`).
- `[index.ts:AgentAdapter]`: `provider`와 `execute(task, signal)`을 가진 어댑터 계약.
- `[index.ts:RuntimeDriver]`: `launch`와 `stop`을 가진 런타임 계약. 소스 주석에 따르면 대상 런타임 프로비저닝은 아직 구현되지 않은 미래 어댑터다.

`cloudflare.ts` (Cloudflare 작업 계약):

- `[cloudflare.ts:CloudProcess]`: `ProcessEvidence`에서 `command`를 뺀 타입.
- `[cloudflare.ts:CloudCheck]`, `[cloudflare.ts:CloudEvidence]`: 원격 검사 한 건의 근거와 원격 실행 전체 근거(`phase`, `jobId`, 스냅샷 ID, `containerStopped`, `authSynced`).
- `[cloudflare.ts:CloudTask]`: `provider`가 `codex` 또는 `claude`이고 `runtime`이 `cloudflare`이며 `execution`이 `null`인 `Task`.
- `[cloudflare.ts:CloudConnection]`, `[cloudflare.ts:CloudCapabilities]`, `[cloudflare.ts:CloudState]`: 연결 상태와 브라우저에 반환하는 조회 결과.
- `[cloudflare.ts:CloudSubmission]`, `[cloudflare.ts:CloudPrivateTask]`: 재전송에 쓰는 비공개 제출 데이터와 그 저장 레코드.
- `[cloudflare.ts:CloudPort]`: `connection`, `prepare`, `submit`, `poll`, `cancel`. 원격 백엔드와 통신하는 어댑터가 구현한다.
- `[cloudflare.ts:CloudPoll]`: 폴링 한 번의 결과(`terminal`, `success`, `cancelled`, `evidence`, `diff`).
- `[cloudflare.ts:CloudControl]`: `capabilities`, `state`, `create`, `decision`, `cancel`, `tick`, `start`, `close`. 중앙 core가 구현한다.

`workflow.ts` (워크플로 계약):

- `[workflow.ts:workflowId]`: UUID 스키마. `[workflow.ts:workflowDigest]`: 소문자 16진수 64자 스키마.
- `[workflow.ts:workflowDraft]`, `[workflow.ts:WorkflowDraft]`: 워크플로 초안 입력 스키마와 그 타입.
- `[workflow.ts:workflowApproval]`: 승인 입력 스키마(`workflowId`, `contractHash`).
- `[workflow.ts:WorkflowBinding]`: 워크플로를 식별하는 세 값(`id`, `inputSnapshotId`, `contractHash`).
- `[workflow.ts:CloudWorkflowPort]`: `draft`, `approve`, `read`. 원격 백엔드와 통신하는 어댑터가 구현한다.
- `[workflow.ts:CloudWorkflowControl]`: `draft`, `approve`, `list`, `read`, `close`. 중앙 core가 구현한다.
- `[workflow.ts:workflowList]`, `[workflow.ts:workflowRegistration]`, `[workflow.ts:workflowView]`: 목록, 등록 결과, 상세 조회 응답 스키마.

## Invariants

- `[workflow.ts:workflowDraft]`는 `z.strictObject`이므로 정의되지 않은 필드가 있으면 검증에 실패한다. `[workflow.ts:workflowApproval]`도 같다.
- `[workflow.ts:sourcePath]`는 길이 1-512자의 상대 경로만 허용한다. 역슬래시, 제어 문자, 드라이브 문자 접두사, 빈 구간, `.`, `..` 구간이 있으면 거부한다. NFC로 정규화된 문자열만 허용한다.
- `[workflow.ts:workflowDraft]`의 `contractPath`, `codex.writes`, `claude.writes`는 서로 겹치지 않아야 한다. 대소문자를 무시하고 비교하며, 한 경로가 다른 경로의 상위 디렉터리인 경우도 거부한다.
- `[workflow.ts:assignment]`의 `instructions`는 1-8000자, `writes`는 1-16개다. `[workflow.ts:workflowDraft]`의 `baseCommit`은 소문자 16진수 40자다.
- `[workflow.ts:workflowView]`의 `actualCostMicros`는 `z.null()`이다. 워크플로 조회는 비용 값을 반환하지 않는다.
- `[workflow.ts:workflowView]`의 상한: `workers` 2개, 워커당 `rounds` 4개, 라운드당 `checks` 4개, `diff` 180000자, `stdout`과 `stderr` 각 32000자. `[workflow.ts:workflowList]`는 최대 20건이다.
- `[cloudflare.ts:CloudSubmission]`은 비공개 데이터다. 소스 주석은 이 객체를 브라우저에 반환하지 말라고 명시한다.

## Side Effects

- None. 이 디렉터리의 코드는 파일, 네트워크, 데이터베이스에 접근하지 않는다. `workflow.ts`는 모듈을 불러올 때 `zod` 스키마 객체만 만든다.

## Verification

- Run: `npm run check` (저장소 루트에서 실행한다. `tsc --noEmit` 다음에 `npm test`를 실행한다. 테스트는 루트의 `tests/` 디렉터리에 있다.)

## 장기 자율 작업 계약

`autonomous.ts`는 장기 작업, 승인 범위, 짧은 lease, 체크포인트 참조, 반복 사용량, 행동 예약과 자원 원장의 타입을 정의한다. 실제 인증과 세션 본문은 포함하지 않는다. [실행 경계와 API](../../../docs/autonomous-tasks.md)를 참고한다.

`autonomous-native.ts`는 native snapshot·Claude 요청/응답·private runtime 포트의 타입을 정의한다. 요청은 중앙 작업 ID와 현재 `executionLease`, 비공개 세션·구독 인증을 포함한다. 응답은 검증된 경계·반복별 사용량·복원 bundle을 담는다. 이 wire는 인증된 private 전송 전용이며 공개 작업 상태에 넣지 않는다.
