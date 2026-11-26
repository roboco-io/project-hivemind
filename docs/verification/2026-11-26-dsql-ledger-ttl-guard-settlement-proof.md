# 2026-11-26 이슈 #16 작업 3 검증 보고서 — Model Factory 원장·SW 전달 저장소의 Aurora DSQL 전환과 TTL Guard Lambda 정산

이 문서는 이슈 #16의 작업 3(`ModelFactoryStore`와 `DeliveryStore`의 Aurora DSQL 지원, TTL Guard Lambda의 DSQL 정산)을 실 AWS에서 확인한 결과를 기록한다. 대상 계정은 `<AWS_ACCOUNT_ID>`, 프로필은 `roboco`다. 아래 값은 모두 2026-11-26에 직접 실행해 얻었다.

두 저장소는 같은 저장소 포트(`DocumentRepository`, `packages/core/src/document-repository.ts`)를 쓴다. 2절부터 4절은 Model Factory 원장과 TTL Guard를, 5절은 SW 전달 저장소(`DeliveryStore`)를 다룬다. 확인 수준이 서로 다르므로 6절의 한계를 함께 읽어야 한다.

## 1. 자동 검증 결과

`npm run check`는 1,246건이 모두 통과했다. `infrastructure/aws-runtime`의 `npm run typecheck`는 통과했고 `npm test`는 9건이 모두 통과했다. 이 작업으로 추가한 테스트 파일은 `tests/model-factory-repository.test.ts`, `tests/model-factory-dsql-repository.test.ts`, `tests/model-factory-ttl-guard.test.ts`다.

## 2. 실 AWS에 배포한 구성

`scripts/aws-deploy-hub.sh deploy`로 서울 Hub 스택을 배포했다. 배포 전 `cdk diff`에서 바뀌는 자원은 Control Plane 작업 정의, TTL Guard 역할의 정책, TTL Guard Lambda 함수 3개였다. 배포 후 상태는 다음과 같다.

| 항목 | 값 |
|---|---|
| Control Plane 작업 정의 | `hivemind-runtime-control-plane:11`, 환경 변수 `HIVEMIND_MF_STORAGE=aurora-dsql` |
| TTL Guard Lambda | `hivemind-runtime-mf-ttl-guard`, 런타임 `nodejs22.x`, 번들 자산(코드 크기 67,235바이트), 제한 시간 60초, 메모리 256MB |
| TTL Guard 역할 추가 권한 | 서울 DSQL 클러스터에 대한 `dsql:DbConnectAdmin` |
| Control Plane 서비스 | 배포 직후 `desiredCount 0`, `runningCount 0` |

## 3. 저장소 단독 검증 (`scripts/aws-dsql-model-factory-proof.ts`)

Control Plane을 거치지 않고 로컬 IAM 인증으로 서울 DSQL 클러스터 `h5uil5myqct7chhnr7qrbtbwiq`에 직접 접속했다. 실제 원장과 섞이지 않도록 별도 테이블 `hm_mfproof_*`를 쓰고 끝에 삭제했다.

상한 500,000 micros인 원장에서 400,000 micros 작업 2건의 학습 승인을 실제로 동시에 호출했다. 1건만 승인됐고, 다른 1건은 `Central cost cap exceeded: requested 400000 micros, remaining 100000 micros (global cap 500000)`로 거절됐다. 이어서 승인된 작업에 인스턴스 기동과 1,234 micros 정산을 기록했고, 원장은 예약 0, 정산 1,234, 잔여 498,766 micros였다. 이벤트 6건의 순번은 중복 없이 단조 증가했다.

이 결과는 DSQL이 스키마와 upsert 구문을 받아들이고, 동시 승인이 비용 상한을 함께 통과하지 못함을 보여 준다. 동시 승인 2건을 한 번 실행한 결과이며, 반복 실행이나 더 많은 동시 요청으로는 확인하지 않았다.

## 4. Control Plane이 꺼진 상태에서의 정산 실증 (`scripts/aws-ttl-guard-dsql-settlement-proof.ts`)

### 절차와 결과 (작업 `mf-0b4c7f5b-5925-42be-976b-12cda0bed346`)

| 단계 | 확인한 내용 | 결과 |
|---|---|---|
| 1 | Control Plane을 기동하고 `GET /api/model-factory/jobs`의 `storageBackend`를 조회 | `aurora-dsql` |
| 1 | Control Plane 기동 로그의 SQLite 이관 건수 | `importedJobs: 4`, API에서도 작업 4건 조회 |
| 1 | 수명 3분인 작업을 등록·승인 | `us-east-2`에 `t4g.nano` 스팟 `i-06db2deb2a89aef21` 기동, 만료 시각 `2026-11-26T14:38:55.140Z` |
| 2 | Control Plane을 `desiredCount 0`으로 내리고 작업 0개가 될 때까지 대기 | 만료 시각 전에 중지 완료 |
| 2 | DSQL에서 직접 읽은 작업의 정산 금액 | `null` (아직 정산 전) |
| 3 | 만료 시각이 지난 뒤 배포된 Lambda를 직접 호출 | HTTP 200, 함수 오류 없음, `us-east-2`에서 `i-06db2deb2a89aef21` 종료, 정산 결과 `settled` |
| 4 | Control Plane 작업이 0개인 상태에서 DSQL을 직접 조회 | 정산 509 micros, 과금 시간 183초, 인스턴스 상태 `shutting-down`, 강제 종료 사유 `TTL Guard Lambda forced termination: TTL Guard expired at 2026-11-26T14:38:55.140Z` |
| 4 | `ec2 describe-instances`로 본 인스턴스 상태 | `shutting-down` |
| 5 | Control Plane을 다시 기동하고 해당 작업을 wake | 상태 `failed`(S3 영수증 없음), 정산 금액 509 micros 그대로 |
| 5 | 작업의 `model_factory.cost_settled` 이벤트 수 | 1건 (두 번 정산하지 않음) |
| 종료 | Control Plane `desiredCount`와 5개 리전의 관리 대상 실행 인스턴스 | `desiredCount 0`, 5개 리전 모두 0대 |

4단계의 값은 Control Plane의 API가 아니라 로컬 IAM 인증으로 DSQL의 실제 원장 테이블(`hm_mf_jobs`)을 직접 읽은 것이다. 그 시점에 Control Plane 서비스의 실행 작업은 0개였다.

### 정산 금액의 의미

509 micros는 183초에 작업의 스팟 상한가 시간당 `$0.01`을 곱한 추정치다(183 ÷ 3600 × 0.01 × 1,000,000 = 508.3, 올림). 실제 스팟 청구액이 아니다. 실제 청구액은 조회하지 않았다.

### 4-1. EventBridge 스케줄에 의한 정산 (2026-11-27, 작업 `mf-97e713bc-32f3-4914-969b-4706ce6c2a08`)

같은 스크립트를 스케줄 대기 방식으로 다시 실행했다. 이 방식에서 스크립트는 Lambda를 호출하지 않는다. 인스턴스 만료 뒤 DSQL 원장을 20초마다 읽으며 정산이 나타나기를 기다린다. 이 실행 시점에 TTL Guard Lambda는 제한된 DB 역할 `hm_ttl_guard`와 IAM 권한 `dsql:DbConnect`로 접속하도록 배포되어 있었다([제한 역할 전환 기록](2026-11-27-dsql-restricted-roles.md)).

| 단계 | 결과 |
|---|---|
| 기동 | `us-east-2`에 `t4g.nano` 스팟 `i-0c285b4e9a94ecb6f`, 만료 시각 `2026-11-26T17:35:10Z` |
| Control Plane 중지 | 만료 전에 `desiredCount 0`, 실행 작업 0개 |
| 만료 전 원장 | 정산 없음(`null`) |
| 정산이 원장에 나타난 시점 | 만료 66초 뒤 |
| Lambda의 로그 이벤트 | `2026-11-26T17:36:10Z`의 `hivemind.mf_ttl_guard.sweep`, 원장 `aurora-dsql`, 이 인스턴스를 종료하고 이 작업을 `settled`로 기록, 오류 없음 |
| 함수를 대상으로 하는 규칙 | `hivemind-runtime-mf-ttl-guard-5m` 하나 |
| 정산 뒤 원장 (Control Plane 작업 0개인 상태에서 DSQL 직접 조회) | 정산 659 micros, 과금 시간 237초, 강제 종료 사유 기록 |
| Control Plane 재기동 후 wake | 상태 `failed`, 정산 659 micros 그대로, 정산 이벤트 1건 |
| 종료 시 | `desiredCount 0`, 5개 리전의 관리 대상 실행 인스턴스 0대 |

이 결과는 두 가지를 보여 준다. 사람이 호출하지 않아도 5분 스케줄이 만료된 인스턴스를 종료하고 원장에 정산한다. 그리고 제한된 DB 역할 `hm_ttl_guard`로 그 쓰기가 실제로 된다.

스케줄이 호출했다는 판단의 근거는 스크립트가 Lambda를 호출하지 않았다는 점과 이 함수를 대상으로 하는 규칙이 하나뿐이라는 점이다. 호출 주체를 CloudTrail에서 직접 조회하지는 않았다. 659 micros는 스팟 상한가 기준 추정치다.

## 5. SW 전달 저장소(`DeliveryStore`)의 DSQL 전환

### 저장소 단독 검증 (`scripts/aws-dsql-delivery-proof.ts`)

로컬 IAM 인증으로 서울 DSQL 클러스터에 직접 접속해, 별도 테이블 `hm_deliveryproof_*`에서 실행하고 끝에 삭제했다. 전달 작업 1건을 등록하고 승인한 뒤(상태 `queued`), 두 워커가 같은 반복을 시작하는 호출을 실제로 동시에 보냈다. 1건만 성공했고 다른 1건은 `Cannot start iteration in state running`으로 거절됐다. 작업의 반복 횟수는 1, 담당 워커는 `worker-a`, `delivery.iteration_started` 이벤트는 1건이었다. 이어서 취소가 `cancelled`로 기록됐다.

### 배포된 Control Plane 확인 (`scripts/aws-storage-backend-check.ts`)

`HIVEMIND_DELIVERY_STORAGE=aurora-dsql`을 넣어 Hub를 다시 배포한 뒤(바뀐 자원은 Control Plane 작업 정의와 Lambda 번들), Control Plane을 기동해 운영자 API로 각 저장소가 보고하는 저장소 종류를 읽었다.

| 저장소 | API | `storageBackend` | 조회된 건수 |
|---|---|---|---|
| Model Factory 원장 | `GET /api/model-factory/jobs` | `aurora-dsql` | 작업 5건 |
| SW 전달 작업 | `GET /api/delivery/tasks` | `aurora-dsql` | 작업 4건 |
| 협업 세션 | `GET /api/collab/sessions` | `aurora-dsql` | 세션 3건 |

같은 기동의 로그에는 `delivery_dsql_enabled`의 `importedTasks: 4`와 `model_factory_dsql_enabled`의 `importedJobs: 0`이 남았다. 전달 작업 4건은 이번 기동에서 SQLite로부터 이관됐다. Model Factory 원장은 이전 기동에서 이미 이관되어 DSQL에 작업이 있었으므로 다시 복사하지 않았다. 5건은 이전에 이관된 4건과 4절의 실증 작업 1건이다. 확인 후 Control Plane은 `desiredCount 0`이고, 5개 리전의 관리 대상 실행 인스턴스는 0대였다.

## 6. 한계와 미검증 항목

- **DSQL 위에서의 SW 전달 작업 전 과정은 실행하지 않았다.** 전달 저장소는 저장소 단독 검증과 배포된 Control Plane의 조회까지만 확인했다. 실제 워커가 작업을 수행하고 독립 검증을 거쳐 Draft PR을 만드는 전 과정을 DSQL 저장소 위에서 실행하지는 않았다.
- **4절의 실증에서는 Lambda를 직접 호출했다.** 스케줄에 의한 실행은 2026-11-27에 따로 확인했다(아래 4-1절).
- **이관은 건수만 확인했다.** Model Factory 작업 4건과 전달 작업 4건이 DSQL로 복사됐음을 로그와 API의 건수로 확인했다. 작업별 내용과 이벤트를 원본과 대조하지는 않았다. 이관 로직의 내용 일치는 단위 테스트로만 확인했다.
- **DSQL 접속은 관리자 역할을 쓴다.** Control Plane과 Lambda 모두 `dsql:DbConnectAdmin`으로 `admin` 사용자에 접속한다. 테이블 단위로 권한을 좁힌 DB 역할은 만들지 않았다.
- **Lambda가 DSQL에 접속하지 못하는 경우는 실 AWS에서 일으키지 않았다.** 이 경우에도 인스턴스가 종료되고 오류가 요약에 남는 동작은 단위 테스트로만 확인했다.
- **비용은 실제 청구를 확인하지 않았다.** `t4g.nano` 스팟 1대가 약 3분, Control Plane이 두 차례 합쳐 수 분간 실행됐다. DSQL 사용량과 Lambda 호출 비용도 청구서로 대조하지 않았다.
