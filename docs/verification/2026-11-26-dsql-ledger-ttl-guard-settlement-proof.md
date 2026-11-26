# 2026-11-26 이슈 #16 작업 3 검증 보고서 — Model Factory 원장의 Aurora DSQL 전환과 TTL Guard Lambda 정산

이 문서는 이슈 #16의 작업 3 가운데 Model Factory 원장(`ModelFactoryStore`)에 해당하는 부분을 실 AWS에서 확인한 결과를 기록한다. 대상 계정은 `<AWS_ACCOUNT_ID>`, 프로필은 `roboco`다. 아래 값은 모두 2026-11-26에 직접 실행해 얻었다.

**범위를 먼저 밝힌다.** 작업 3은 `ModelFactoryStore`와 `DeliveryStore` 두 저장소의 DSQL 지원을 요구한다. 이 문서가 다루는 것은 `ModelFactoryStore`와 TTL Guard Lambda뿐이다. `DeliveryStore`는 아직 SQLite만 지원한다.

## 1. 자동 검증 결과

`npm run check`는 1,245건이 모두 통과했다. `infrastructure/aws-runtime`의 `npm run typecheck`는 통과했고 `npm test`는 9건이 모두 통과했다. 이 작업으로 추가한 테스트 파일은 `tests/model-factory-repository.test.ts`, `tests/model-factory-dsql-repository.test.ts`, `tests/model-factory-ttl-guard.test.ts`다.

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

## 5. 한계와 미검증 항목

- **`DeliveryStore`는 DSQL로 옮기지 않았다.** 작업 3의 세부 항목 1은 두 저장소 모두를 요구한다. `DeliveryStore`의 저장소 포트 분리와 DSQL 구현은 남아 있다.
- **Lambda는 직접 호출했다.** EventBridge 5분 스케줄이 같은 함수를 호출하지만, 이 실증에서 스케줄에 의한 실행이 정산을 수행하는 것까지 기다려 관찰하지는 않았다.
- **이관은 건수만 확인했다.** SQLite의 작업 4건이 DSQL로 복사됐음을 로그와 API의 건수로 확인했다. 작업별 내용과 이벤트를 원본과 대조하지는 않았다. 이관 로직의 내용 일치는 단위 테스트로만 확인했다.
- **DSQL 접속은 관리자 역할을 쓴다.** Control Plane과 Lambda 모두 `dsql:DbConnectAdmin`으로 `admin` 사용자에 접속한다. 테이블 단위로 권한을 좁힌 DB 역할은 만들지 않았다.
- **Lambda가 DSQL에 접속하지 못하는 경우는 실 AWS에서 일으키지 않았다.** 이 경우에도 인스턴스가 종료되고 오류가 요약에 남는 동작은 단위 테스트로만 확인했다.
- **비용은 실제 청구를 확인하지 않았다.** `t4g.nano` 스팟 1대가 약 3분, Control Plane이 두 차례 합쳐 수 분간 실행됐다. DSQL 사용량과 Lambda 호출 비용도 청구서로 대조하지 않았다.
