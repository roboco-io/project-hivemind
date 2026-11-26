# 열린 이슈 병렬 구현 검증 기록

## 범위와 현재 상태

2026-11-23 GitHub 조회에서 #1·#3·#4·#5는 모두 OPEN이다. 이 기록은 로컬 구현과 검증을 구분한다. 이슈 상태·댓글, 커밋·push·배포는 변경하지 않았다. 실제 AWS·HF·모델 호출도 수행하지 않았다.

| 이슈 | 구현 범위 | 원격 수용 조건 |
|---|---|---|
| #1 | 기존 장기 실행·HF·팀 변경을 보존 | 사용자가 실제 프로젝트에서 검증하도록 이관 |
| #3 | 별도 OIDC signer, 중앙 승인 결속, ARWI→GSC, IAM CDK, 승인 표시 | 실제 AWS 역할 수임·거절·취소·키 교체 미검증 |
| #4 | 승인 manifest, launch별 예산, 인스턴스 인증·직접 업로드, 독립 영수증 검증·품질 조건 공개 전환 | 실제 AMI 격리·수백 MB 업로드·AWS/HF 대조 미검증 |
| #5 | 서울 기본값, 서버 리전 허용 목록, Ohio와 AZ ID, guard·비용·CDK·Python 연결 | 로컬 기준 검증, 배포하지 않음 |

## 검증 중간 기록

공통 빌드 전 source loader로 실행했다. 아래 수치는 최종 전체 검사 결과가 아니다.

- OIDC·ARWI·GSC 집중 테스트: 58 통과.
- 위임 controller·proof·인스턴스·업로드 집중 테스트: 67 통과.
- 리전·OIDC·위임 통합 테스트: 18 통과.
- guard CDK: 6 통과, guard Python: 24 통과.
- OIDC IAM CDK: 10 통과.
- 인스턴스 Python: 10 통과.
- root·backend·guard·OIDC IAM·signer 타입 검사: exit 0.

독립 검토에서 품질 증명의 비동기 만료, 조회 중 취소 후 공개 전환, 재시작 후 삭제 작업 잠금 복구 결함을 재현했다. 실제 PUT 직전 권한·만료 검사와 삭제 상태의 조회 전용 복구를 추가했다. 업로더의 비동기 권한 조회 후 만료도 다시 검사한다. 수정 후 controller·proof·SQLite·publisher 집중 테스트 54개가 통과했고 독립 검토자가 원래 두 복구·만료 결함과 업로더 수정을 해소로 판정했다. B2의 실제 자식 세션 만료·redirect 수정도 별도 검토자가 43개 소스 테스트와 10개 IAM 테스트로 재확인했다. 실제 runtime 취소·OIDC 감사 연결의 집중 회귀도 통과했다. 독립 검토자는 실제 Worker의 private guard 전달과 취소 후 PUT 0회, OIDC 감사 callback·SQL·운영자 조회 연결을 추가 회귀 3개로 확인하고 모두 해소로 판정했다. 동결 소스의 해당 검토 범위에 남은 P1/P2는 없다. 전체 검사 결과는 아래에 기록한다.

초기 병행 작업 중 root 빌드가 실수로 실행되어 타입 오류로 종료됐다. 당시 dist는 근거로 사용하지 않는다. 담당 소스 동결 후 `npm run check`로 새로 빌드하고 검증한다.

## 최종 전체 검사

담당 소스 동결과 fixture 수정 후 coordinator가 새로 실행했다.

| 명령·범위 | 결과 |
|---|---|
| root `npm run check` | 타입 검사·빌드 성공, 1,192 통과·0 실패 |
| backend `NODE_OPTIONS='--import=/tmp/hivemind-source-loader.mjs' npm test` | 746 통과·0 실패 |
| `cloudflare/`의 `npm test` | 61 통과·0 실패 |
| guard package `npm test` | CDK 6 통과, Python 24 통과 |
| OIDC IAM package `npm test` | 10 통과·0 실패 |
| `scripts/delegated/` Python unittest | 10 통과·0 실패 |
| backend·guard·OIDC IAM·signer 타입 검사 | 모두 exit 0 |
| backend `runtime:stamp`, `runtime:check` | 갱신 후 current |
| backend·signer `wrangler deploy --dry-run` | 모두 exit 0, 원격 배포 없음 |
| `git diff --check` | exit 0 |

첫 전체 검사에서는 root 6개·backend 4개가 실패했다. 원인은 기존 Spot 모의 DescribeInstances 응답의 `placement.availabilityZone` 누락과 OIDC 테스트의 빌드 후 fixture 경로였다. 실제 AWS 가용 영역 검증은 유지했다. 관련 fixture만 보완했고 source 72개 및 리전·provider 음성 테스트 50개 통과 후 전체 검사를 재실행했다. 이 표는 두 번째 전체 검사의 결과다. 로그는 `/tmp/hivemind-root-final-check-2.log`, `/tmp/hivemind-backend-final-2.log`다.

backend source loader는 저장소의 TypeScript 소스가 내부 `.js` import를 사용할 때 대응 `.ts` 파일을 찾도록 한다. 전체 root 검사는 이 loader 없이 실제 빌드 결과로 실행했다. backend runtime digest는 `52f5128c6f11591a0c9dbbb09179cf1622724d3ee1a4b8a8bb32f82ae5ef0cdd`다.

실제 계정 검증은 완료되지 않았다. #3의 실제 역할 수임·거절·키 교체와 #4의 trusted AMI 격리·대용량 HF/S3 업로드·청구 대조는 별도 실행 근거가 필요하다. 따라서 이 기록으로 #3/#4를 완료 처리하지 않는다. #5는 로컬 구현 기준을 검증했으며 GitHub 상태는 변경하지 않았다.

## 관련 문서

- [실제 AWS·HF 수용 검증 준비](2026-11-23-provider-acceptance.md)
- [후속 테스트 재현성·준비 검증](2026-11-24-provider-readiness.report.md)
- [병렬 구현 계획](2026-11-23-parallel-issues.md)
- [공유 통합 검토 패킷](2026-11-23-integration.report.md)
- [리전 검증 기록](2026-11-23-issue5-region.report.md)
- [OIDC 서명 구성](../oidc-issuer.md)
- [AWS 임시 인증](../aws-web-identity.md)
- [위임 실행 통합](../delegated-integration.md)
- [위임 영수증·공개 전환](../delegated-publication.md)
- [인스턴스 bootstrap](../delegated-instance.md)
