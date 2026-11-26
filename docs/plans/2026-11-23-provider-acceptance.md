# AWS·HF 실제 수용 검증 준비

## 현재 단계

#3·#4의 로컬 구현 다음 단계는 실제 계정 수용 검증이다. 이 문서는 실행 준비이며 실행 근거가 아니다. #1 장기 실증은 사용자가 실제 프로젝트 검증으로 이관한 결정을 유지한다. #5의 서울·Ohio 로컬 검증은 완료했으며 실제 배포는 하지 않았다.

사용자 결정(2026-11-24)에 따라 별도 시험 작업보다 실제 프로젝트의 첫 AWS 실행·S3/HF 업로드·작업 종료에 검증을 결합한다. 각 실제 작업의 승인 범위를 확정한 뒤 아래 근거를 수집한다. 취소·권한 거부·키 교체는 해당 시나리오를 실행할 때까지 미검증으로 유지한다.

## 실행 전에 고정할 값

운영자가 아래 설정 파일의 경로와 실행 범위를 지정한다. 비밀 값은 문서·채팅·공개 증거에 복사하지 않는다.

| 대상 | 필요한 값 |
|---|---|
| 실행 범위 | 비용 상한 USD, 종료 시각, 허용 작업·공개 효과, 실패 시 정리 책임 |
| AWS | `roboco` profile, 계정 ID, 리전 허용 목록, AMI·서브넷·AZ ID, workload role/profile |
| S3 | versioning 활성 버킷, 전용 prefix, canonical owner ID, 용량·보존·요청·전송 비용 예약 |
| OIDC | 공개 issuer origin, audience, execute·inspect·cleanup subject/역할, signer 전용 secret 저장 위치, 키 교체용 두 kid |
| Cloudflare | backend 대상, signer private service binding, 비공개 checker binding, 운영자 인증 파일 위치 |
| HF | 기존 대상 repo, 승인 visibility, 제한된 조직 쓰기 token 참조, 공개 전환 허용 여부 |
| 인스턴스 | trusted bootstrap hash, 입력 manifest hash, IMDS·credential 파일 격리 구현, 고정 학습 entrypoint |

실제 실행은 이 값들을 승인 fingerprint에 고정한 후 시작한다. AMI·계정·버킷·repo를 추측하거나 기존 운영 데이터를 시험 대상으로 사용하지 않는다. 기본 기능 비활성 상태는 명시한 후보 배포까지 유지한다.

## 로컬 준비 순서

1. root에서 `npm run check`를 실행한다.
2. `cloudflare/backend/`에서 `npm test`, `npm run typecheck`, `npm run runtime:check`를 실행한다. 테스트 로더는 저장소에 포함되어 있으며 임시 파일이 필요 없다.
3. guard·OIDC IAM package의 타입 검사와 CDK 테스트, `scripts/delegated/` Python 테스트를 실행한다.
4. [OIDC 설정](../oidc-issuer.md), [AWS 인증](../aws-web-identity.md), [인스턴스 준비](../delegated-instance.md), [통합 경로](../delegated-integration.md)를 설정 파일과 대조한다.
5. deployment dry-run 결과와 runtime digest를 후보 기록에 저장한다. dry-run 성공은 실제 배포·실행 성공이 아니다.

## 실제 검증 순서와 합격 근거

| 단계 | 실행 | 필요한 근거 |
|---|---|---|
| 1 | signer 공개 discovery/JWKS와 private RPC 구성 | 정확한 issuer/audience, 공개키만 노출, HTTP 서명 거부, 실제 AWS 도달성 |
| 2 | 승인 task의 OIDC→ARWI→GSC→Spot 호출 | canonical task/revision/action, role·kid·scope 정책 hash, 인스턴스 소유 확인, 장기 키 미사용 |
| 3 | 별도 시험 task의 subject 불일치·취소·기한 만료 | 실제 역할 수임 거부와 실행 토큰 발급 차단, 새 실행 0회, 소유 자원 정리 유지 |
| 4 | old/new JWKS overlap 후 active kid 교체 | 교체 전·중·후 실제 역할 수임 성공, 이전 키 제거 시각·TTL·전파 대기 기록 |
| 5 | 승인된 인스턴스 bootstrap과 입력 검증 | 실제 IMDS·credential 파일 격리 검사, 입력·bootstrap hash 일치, 잘못된 바인딩·키 교체 거부 |
| 6 | 수백 MB 산출물의 인스턴스→S3/HF 직접 업로드 | 크기·checksum·실제 S3 version·HF commit, 중앙 응답에 데이터 본문 없음, API 독립 대조 |
| 7 | 별도 잘못된 영수증과 공개 범위 시험 | mismatch 또는 unknown 기록, 승인 밖 repo·공개 효과 거부, 모델의 passed:true로 전환 불가 |
| 8 | 허용한 경우에만 별도 공개 전환 | trusted quality 증명·현재 권한, PUT 직전 만료·취소 차단, 실제 HF visibility postcondition |
| 9 | 취소·인스턴스 종료·보존 만료 후 정리 | EC2 종료 확인, 정확한 소유 S3 version 삭제·재조회, 응답 유실 시 조회 복구, 과거 OIDC cleanup 유지 |

단계 7의 불일치 시험은 시험 영수증을 사용한다. 다른 소유자의 실제 객체나 repo를 변경하지 않는다. 단계 8이 승인 범위에 없으면 실행하지 않고 미검증으로 남긴다. 기능 비활성화는 이미 생성한 자원의 정리 완료를 뜻하지 않는다.

## 중단과 기록

승인 범위 변경, 소유권 불일치, 비용 예약 부족, 예상 밖 공개 효과 또는 비밀 노출이 확인되면 새 작업을 중단한다. 기존 자원의 guard와 historical cleanup은 유지한다. DELETE·공개 전환 응답이 유실되면 동일 요청을 무조건 재전송하지 않고 원장의 복구 경로로 실제 상태를 먼저 조회한다.

근거에는 실행 시각·후보 digest·task/revision/action·역할 ARN·kid·감사 sequence·S3 version·HF commit·크기·검증 상태·정리 상태만 남긴다. JWT, STS credentials, 서명된 인증 요청, HF token, private JWK와 인증 파일 본문은 저장하지 않는다. 실제 청구 근거가 없으면 비용은 null이고 보수적 예약을 유지한다.

#3·#4는 실제 계정 근거를 이슈별 완료 조건과 대조한 뒤에만 완료로 판정한다. 로컬 테스트, fake-fetch, 요청 성공 코드만으로 원격 수용을 대신하지 않는다.
