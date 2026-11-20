# Cloudflare 자율 실행 후보 검증

현재 상태: 사용자의 실행 승인 후 기존 Cloudflare Worker 배포와 실제 Claude 구독 CLI 두 반복을 완료했다. 제한된 Claude 자율 반복 경로를 실증했다. 실제24시간·AWS/HF·대규모 운영과 비용 절감은 미검증이다. 로컬 amd64 에뮬레이션 sandbox 실패 기록은 유지하며 실제 Cloudflare 성공과 구분한다.

## 검증 결과

| 검사 | 결과 | 입증 범위 |
|---|---|---|
| root `npm run check` | 363 통과, 실패·취소·건너뜀 0 | 타입·빌드·전체 root 테스트 |
| backend `npm test` | 438 통과, 실패·취소·건너뜀 0 | 기존 기능과 신규 상태·런타임·통합 계약 |
| backend `npm run typecheck` | 통과 | backend 타입 |
| backend `npm run runtime:check` | current | 동결 소스와 runtime manifest 일치 |
| Linux amd64 Docker build | 통과 | 로컬 이미지 패키징 |
| `wrangler deploy --dry-run` | exit 0 | Worker·Container 로컬 배포 패키징 |
| 최종 이미지의 무모델 Docker probe | **실패** | UID·capability·NoNewPrivs·관리 설정·native 인증 경계는 통과. 실제 sandbox는 실패 |
| 배포 전 운영 서버 readiness | ready=false | 이전 버전의 기록 |
| 배포 후 readiness | ready=true | version40d25e9f·runtime bb6a2b 일치, 역할·암호화 설정 확인 |
| 실제 Cloudflare CLI 2회 반복 | **통과** | 필수 경계 gate·암호화 세션 복원·counter1/2·별도 검사·종료·인증 회수 |

로컬 환경은 ARM 호스트에서 amd64 이미지를 에뮬레이션한다. 최소 sandbox 실행에서도 `bwrap: No permissions to create new namespace`가 발생했다. QEMU·Docker 보안 설정·커널 중 어느 요소가 원인인지는 분리 입증하지 않았다. 샌드박스를 완화하지 않았다. 로컬 결과를 Cloudflare 근거로 사용하지 않는다.

## 구현한 경계

중앙 controller는 기존 Scheduler JobRecord·credential activeJobId·RunnerDO를 재사용한다. 실행 의도를 먼저 저장하고, 제출 응답을 잃으면 같은 job을 조회한다. 공개 워커는 cloud lease를 claim하거나 finish할 수 없다. 승인에는 task revision·control origin·runtime·인증 설정 fingerprint를 고정한다.

Runner는 runtime revision 확인과 실제 무모델 파일 접근 차단 검사를 통과한 뒤에만 제공자 인증을 전달한다. probe는 namespace guard·작업 경로 쓰기·외부 경로 쓰기 거부·private runtime/Claude/proc 읽기 거부·인증 환경 제거·cleanup을 모두 요구한다. 실패·응답 유실·불명확 상태에서 모델을 실행하지 않는다.

파일 실행기는 0600 private 입력·출력, 제한된 읽기·파일 교체 감지, 배타적 시작 의도, fsync 후 원자적 결과 게시와 완료 marker를 사용한다. 중복 시작을 재실행하지 않는다. Worker 관리 토큰·암호화 키·RSA private key는 Container에 전달하지 않는다. worker/reporter 토큰은 private 입력에만 전달하고 CLI 환경에서 제외한다.

private session은 암호화된 R2에 보관한다. 실제 Container 종료와 기존 인증 세대 반영 뒤 별도 compute 검사 및 core 완료 처리를 진행한다. 모델 비용은 실제 근거가 없으면 null이다. 검사가 실패하면 모델 outcome과 별개로 task는 실패한다. 시작하지 않았다는 proof와 실제 종료가 있는 실패만 기존 credential 세대를 유지해 lane을 반환한다. 불명확한 실행은 격리한다.

플랫폼 fake를 사용하는 24개 backend 통합 테스트는 두 반복·session 연속성·세대23→24→25·암호화·별도 검사·종료·취소·만료·미시작 실패를 검증한다. 실제 Cloudflare/모델 실행의 증거가 아니다. 교차 검토에서 승인 경계·세대 경합·부분 제출·결과 게시 경합을 수정하고 회귀 테스트를 추가했다.

## 고정 후보

- 대상: 기존 `hivemind-cloudflare-backend`, `https://hivemind-cloudflare-backend.roboco.workers.dev`.
- 계정: `f7f7c7474ced58ec160ab9a775bf2bfe`.
- 운영 기준 version: `43196043-8ad4-4a3e-96e0-60c074789a52`; runtime: `911c443ed7d99f20e1af8391417474f347d3372a28fc465cbc01cca25464e4c7`.
- 후보 runtime: `bb6a2b157f11465fc1f68ec7449977074944734335a2b7d25570674b1463d44d`.
- 로컬 이미지: `sha256:7cec24a41858ee820050e6d3fb0f772e30a0bc432fe95c52ff640de9333f8497`.
- Worker bundle SHA256: `4cbed2335ed7126c6bd44d272b953a8b786af54034c816af0077c6cb121c5492`.

로컬 근거는 `.superlite/cloud-release/`의 candidate-manifest.json·pilot-plan.json·docker-proof.json·live-readiness.json·worker/에 보관했다. runtime 기준 대비 23개 파일이 추가·변경됐고 제거된 파일은 없다. 기존 DuckDB 변경을 보존했다. secret 값은 근거에 포함하지 않는다.

2026-11-19 21:54 KST 읽기 전용 재조회: 기존 job334개 중 진행 작업0·종료 미확인0. Claude/Codex credential은 generation23·격리 아님·점유 없음이었다. 이 조회는 배포 직전 재확인을 대신하지 않는다.

## 승인 후 실제 원격 실행

사용자가 “진행시켜”로 위 후보의 배포·secret 추가·활성화·조건부 두 반복을 승인했다. 사전 조회에서 기준 version 일치·진행 작업0·종료 미확인0·credential generation23 idle을 확인하고 배포했다. 새 Worker·bucket은 생성하지 않았다. 기존 secret 다섯 개를 보존하고 신규 세 개만 추가했으며 값은 출력하지 않았다. 로컬 설정의 기본값false는 유지하고 배포 인자로 원격 feature만 활성화했다.

- 배포 version: `40d25e9f-d374-47cd-b2d5-6b3e93dd0825`.
- 배포 Container image digest: `sha256:517e9d3b0036a25ad9456eb3d9718a1acfd5843e3ab0683c24eca1487d9bc65e`. 로컬 이미지의 manifest list ID와 형식이 다르며 runtime 소스 revision은 동일하다.
- task: `1ce2146c-5132-44c8-a357-5684b8db5fb4`, 상태completed·반복2·등록부터 완료까지80.430초.
- 첫 model job: `7bb343c5-4559-4ecb-833c-6108b7b16ed7`, outcome continue, counter.txt는 정확히 `1\n`.
- 둘째 model job: `51fa626e-745e-4be1-9b4b-e5929a525593`, outcome complete, counter.txt는 정확히 `2\n`.
- 별도 compute 검사 두 개 모두 SUCCEEDED. 응답 output snapshot을 validate하고 기대 파일 bytes·hash와 각각 대조했다.
- 두 native 실행은 인증 전달 전 필수 runtime-bound 실제 경계 gate를 통과했다. raw private probe report는 공개하지 않았다.
- 둘째 실행은 암호화 R2 복원·`--resume`·같은 session ID·sequence 검증을 통과했다. private 세션 내용과 인증은 내보내지 않았다.
- 실제 Container 두 개와 compute 두 개가 종료됐으며 인증 세대23→24→25, 마지막 credential idle·격리 아님, 전체 미완료 작업0·종료 미확인0이었다.
- CLI init model 일치 검증과 결과 projection에서 `claude-opus-5-5`를 확인했다. 두 run 모두 subscription_runtime 근거·costMicros null이다.
- CLI 보고 cacheReadTokens는7984·11828이었다. 캐시 읽기 보고값이며 토큰/비용 절감 효과의 비교 실험은 아니다. 모델·플랫폼 실제 합계 비용은 미확정이다.

실제 근거는 `.superlite/cloud-release/remote-proof.json`·actual-pilot-status.jsonl·deployed-readiness.json·deployed-secret-names.json·deploy.log에 보존했다. 첫 읽기 전용 검증은 결과 응답의 result 외피를 잘못 해석해 실패했고, 기존 API 구조에 맞춰 검증기만 수정해 다시 대조했다. 원격 모델을 다시 실행하거나 product 소스를 변경하지 않았다. 이번 턴의 `npm run check`도363개 통과·실패0·건너뜀0이었다.

## 승인한 원격 시험 범위

로컬 기본 설정은 비활성이다. 승인받은 기존 Worker 갱신·신규 secret 세 개 추가(AUTONOMOUS_WORKER_TOKEN·AUTONOMOUS_REPORTER_TOKEN·AUTONOMOUS_SESSION_KEY)·원격 feature 활성화·조건부 CLI 두 반복을 수행했다. 기존 secret은 모두 보존했다. 생성한 secret은 0600 private 파일에만 보관하며 Docker context에서 제외했다.

배포 직전 version·계정·진행 작업·미확인 Container 종료·credential 소유 상태를 재조회한다. 다른 작업을 취소하지 않는다. 고정 source의 counter.txt를 0→1→2로 변경하고 고정 Node 검사로 검증한다. 모델 pin은 기존 성공 기록의 요청·보고값인 `claude-opus-5-5`다. 승인 전에는 현재 가용성이 미검증이었으며 이번 두 반복에서 실제 실행을 확인했다. 각 반복120초·전체10분·standard-1·native 동시 실행 하나·검사10초·source64KiB/32파일로 제한한다. Cloudflare 경계 probe 실패 시 모델 호출 없이 중단한다.

pilot-plan.json은 로컬 검토용이다. 실제 등록 직전에 request ID와 시작 시각 기준10분의 endsAt만 새로 만들고 source·검사·모델·반복/시간 한도는 그대로 유지한다. 만료된 초안을 실행하지 않는다.

외부 시스템은 허용하지 않는다. 1 micro 외부 행동 예산은 모델·플랫폼 금액 상한이 아니다. 구독/플랫폼 비용은 미확정이다. 24시간·AWS·HF 실행은 포함하지 않는다.

중단·복구는 신규 dispatch 차단 → 중앙 취소 → 실제 종료·인증 회수·세대 반영 확인 → 이전 코드/runtime 복원 순서다. 불명확한 lane은 격리하고 private session·근거를 보존한다. private 상태 삭제나 ready 강제 변경은 복구 절차가 아니다.

최종 독립 source 검토: APPROVED. 검토 범위는 경계 실패 시 실행을 차단하는 조건부 배포 후보의 소스 안전성이다. 검토 packet에서 소스 결함은 발견되지 않았다. 검토 당시 로컬 actualSandbox=false와 원격 미검증 상태를 유지했다. 이후 위 승인된 두 반복의 실제 성공 근거를 별도로 추가했다. 대규모 운영·24시간 실증 판정은 아니다. 실제 Cloudflare boundary probe의 모든 항목 통과는 인증 전달·모델 실행 전 필수 gate다.
