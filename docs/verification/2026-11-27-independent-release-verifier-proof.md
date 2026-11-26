# 2026-11-27 검증 보고서 — Model Factory 공개 전 독립 검증기

이 문서는 Model Factory 작업의 공개 전 검사를 독립 검증기가 실행하도록 구현한 내용과 실 AWS 실증 결과를 기록한다. 대상 계정은 `<AWS_ACCOUNT_ID>`, 프로필은 `roboco`다. 아래 값은 2026-11-27에 `scripts/aws-mf-independent-verifier-proof.ts`를 실행해 얻었다.

## 1. 구현 전의 상태

Control Plane에는 독립 검증기의 보고를 받는 경로(`POST /api/model-factory/jobs/:id/verifier-attestation`, 워커 토큰 전용)가 있었다. 그러나 그 경로로 보고하는 검증기 구현이 없었고, 검증기를 기동하는 방법도 없었다. 그래서 공개 전 검사 결과는 운영자가 직접 보고하는 경로로만 들어올 수 있었고, 항상 `operator_self_reported`로 기록됐다. 이 값은 HIVEMIND가 검사를 실행했다는 뜻이 아니다.

## 2. 구현한 내용

운영자가 `POST /api/model-factory/jobs/:id/dispatch-verifier`(MCP 도구 `hivemind_mf_dispatch_verifier`)를 호출하면 Control Plane이 검증기 작업을 Fargate Spot으로 기동한다. 작업이 `evaluating`이고 S3 영수증이 확인된 경우에만 기동된다. 검증기 작업 정의는 SW 전달의 검증기와 같은 것이며, 모델·GitHub·Hugging Face 비밀이 없다.

검증기는 다음 순서로 동작한다.

1. S3의 `receipt.json`을 읽는다. 영수증이 이 작업의 것인지, 영수증의 `manifestDigest`가 Control Plane이 기록한 값과 같은지, 파일 목록에서 다시 계산한 해시와도 같은지 확인한다.
2. 산출물 파일을 모두 내려받아 크기와 SHA-256을 영수증과 비교한다.
3. 고정 입력(`compute.inputs`)을 내려받아 SHA-256을 승인된 명세와 비교한다.
4. 고정 입력 디렉터리에서 승인된 `releaseCheckCommand`를 실행한다. 산출물 디렉터리는 환경 변수 `HIVEMIND_ARTIFACT_DIR`로 전달한다.
5. 종료 코드가 0이면 통과로 보고한다. 표준 출력의 마지막 줄이 JSON 객체이면 그 값을 지표로 함께 보고한다.

1번부터 3번에서 불일치가 나면 검증기는 증명을 보고하지 않고 실패로 끝난다. 작업은 `evaluating`에 남아 운영자가 확인할 수 있다. 4번의 검사만이 "검사 실패" 증명을 만들 수 있다. 검사 스크립트는 고정 입력에 들어 있어야 한다. 검증기는 저장소 소스를 받지 않기 때문이다.

검증기 역할에는 `models/*` 읽기 권한을 추가했다. 쓰기는 여전히 `attestations/*`에만 할 수 있다.

## 3. 자동 검증

`npm run check`는 1,272건이 모두 통과했다. `infrastructure/aws-runtime`의 테스트는 11건이 모두 통과했다. 추가한 테스트는 `tests/model-release-verifier.test.ts`(4건)와 CDK 테스트 1건이다. 단위 테스트는 실제 Node 프로세스로 검사 명령을 실행해 통과와 실패를 확인하고, 산출물 변조, 고정 입력 변조, 다른 작업의 영수증, 파일 목록이 바뀐 영수증, 크기 상한 초과가 모두 예외로 끝나는지 확인한다. 검사 명령에 작업 자격 증명 환경 변수와 워커 토큰이 전달되지 않는 것도 확인한다.

## 4. 실 AWS 실증 (작업 `mf-229773f5-a50a-4e65-afd6-231a54c62704`)

### 절차

고정 입력 4개(평가 스크립트, 표본 데이터, 검사 스크립트 `release-check.cjs`, 기준값 `threshold.json`)를 S3에 올렸다. Control Plane이 `us-east-2`에 `t4g.nano` 스팟 인스턴스 `i-00a7ffdd19d8b6ac6`을 기동했다. 인스턴스는 입력을 내려받아 평가를 실행하고, `eval-result.json`과 `receipt.json`을 올린 뒤 스스로 종료했다. Control Plane의 wake가 영수증을 확인해 작업이 `evaluating`이 됐다. 이어서 `dispatch-verifier`를 호출했다.

### 결과

| 확인 항목 | 값 |
|---|---|
| 검증기 기동 전의 증명 | 없음 (`null`) |
| 검증기 ECS 작업 | 작업 정의 `hivemind-runtime-verifier:2`, 용량 공급자 `FARGATE_SPOT`, 종료 코드 0 |
| 작업 최종 상태 | `awaiting_release_approval` |
| 증명의 출처 | `independent_verifier`, 고지 문구 없음(`verificationDisclaimer: null`) |
| 검사 통과 여부 | 통과 |
| 증명의 `manifestDigest` | 영수증의 값과 일치 (`55c0b64d…fa29c41`) |
| 검증기가 측정한 값 | 검사 종료 코드 0, 산출물 1개(129바이트), 고정 입력 4개 |
| 검사 스크립트가 보고한 지표 | 평균 점수 0.81, 기준값 0.8, 표본 3개 |
| 검증기의 S3 사본 | `attestations/model-factory/<작업 ID>.json`에 통과로 기록 |
| 정산 | 167 micros (스팟 상한가 기준 추정치) |
| 소요 시간 | 등록부터 증명 기록까지 약 148초 |

실증 후 Control Plane은 `desiredCount 0`이었고, 클러스터의 실행 ECS 작업은 0개, 5개 리전의 관리 대상 실행 인스턴스는 0대였다. 이 작업의 공개 방식은 `s3_artifact_only`이므로 외부에 공개된 것은 없다. 작업은 `awaiting_release_approval`로 남아 있다.

## 5. 한계와 미검증 항목

- **검사 명령은 샌드박스에서 실행되지 않는다.** 셸 없이, 작업 자격 증명 환경 변수 없이, 새 홈 디렉터리에서 실행된다. 그러나 검증기 컨테이너와 그 네트워크를 공유한다. 같은 사용자로 실행되므로 부모 프로세스의 환경을 읽는 것까지 막지는 못한다. 검증기 역할에는 비밀이 없고 쓰기는 `attestations/*`뿐이라는 점이 피해 범위를 줄인다.
- **실패하는 검사와 변조된 산출물은 실 AWS에서 실행하지 않았다.** 통과하는 경우만 실증했다. 실패와 변조는 단위 테스트로만 확인했다.
- **큰 산출물은 검증할 수 없다.** 검증기는 산출물을 메모리로 내려받으며 합계 4GiB까지만 받는다. 실제 모델 가중치 크기에서의 동작은 확인하지 않았다.
- **검증기 기동은 자동이 아니다.** 운영자가 도구를 호출해야 한다. 검증기 작업이 사라졌을 때 이를 감지하는 정리 경로도 없다. 그 경우 작업은 `evaluating`에 남고, 운영자가 다시 기동할 수 있다.
- **운영자 직접 보고 경로는 그대로 있다.** `verify-release`로 보고하면 이전처럼 `operator_self_reported`로 기록된다. 공개 승인이 독립 검증기의 증명만 받도록 강제하지는 않았다.
