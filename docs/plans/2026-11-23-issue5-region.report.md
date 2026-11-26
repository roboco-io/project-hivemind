# #5 리전 설정 — A 검토 패킷

상태: A 소유 로컬 구현 완료, 공유 제공자·backend 연결은 I 담당. 실제 AWS 검증 및 GitHub 상태 변경 없음.

## 변경

- 신규 `packages/adapters/src/autonomous-aws-region.ts`: `assertAwsRegion(region, allowedRegions?)`, `awsPlacement(region, availabilityZoneId?)`, `assertAwsPlacement(region, observed, expectedZoneId?)`.
- 서버 허용 목록 생략 시 서울만 허용. 빈 목록·중복·잘못된 리전 거절. 자동 리전 fallback 없음.
- CDK region 문자열과 선택 allowedRegions, profile availabilityZoneId. Ohio manifest는 region/allowedRegions envelope를 포함한다. ARN·정책·Lambda 클라이언트·실제 client meta.region_name을 선택 리전과 대조한다.
- Python은 실제 instance Placement와 volume AZ ID를 승인 profile과 대조한다. 이름에서 ID를 추측하지 않는다.
- guard attestation은 전체 manifest digest로 리전/AZ ID에 결속한다. 새 선택 필드를 생략한 서울 manifest의 기존 shape/digest를 유지한다.
- Cost Explorer 청구 endpoint는 us-east-1, resource filter와 credential scope는 실제 선택 리전.
- I는 공유 provider/server config/hash/승인 표시/RunInstances/Describe 연결을 소유한다. 새 optional AZ ID hash와 기존 hash 보존도 I 검증 대상.

## 증거

- root 소스 집중: `node --import /tmp/hivemind-source-loader.mjs --test tests/autonomous-aws-guard.test.ts tests/autonomous-aws-region.test.ts tests/autonomous-external-cost.test.ts` — 34 통과, 0 실패.
- guard package `npm test` — CDK 4 통과, Python 22 통과, 0 실패. 서울 기존 회귀와 Ohio ARN/AZ/volume/client/handler 포함.
- guard package `npm run typecheck` — exit 0.
- 소유 diff `git diff --check` — exit 0.
- TDD: Ohio CDK 거절, guard admission 실패, CE null, 잘못된 client 허용, helper 검증 부재를 먼저 재현했다.
- root typecheck는 실행 시 병렬 OIDC 작업 오류가 있었다. A 소유 테스트 typing 두 오류는 수정했다. 조율자 최종 typecheck 필요.

## 경계와 사고

실제 AWS 호출·계정 조회·CDK lookup·자원 생성·시세/청구 조회·배포·commit·push 없음. dirty HF/Team/문서 보존. 기존 guard README 선행 변경에 리전 설명만 덧붙임. #3 IAM/CDK 파일은 수정하지 않음.

검사 경로 실수로 root `npm test`를 한 번 호출했다. 공유 tsc emit이 시작된 뒤 병렬 OIDC 타입 오류로 exit 2; 전체 테스트는 실행되지 않았다. 조율자에게 즉시 알렸다. dist는 조율자의 최종 재빌드 전까지 근거로 사용하지 않는다. root `npm run check`는 사용자 지정 병렬 경계에 따라 조율자 최종 단계로 이관한다.

남은 검토: fresh reviewer, I 통합 회귀, 조율자 전체 검사. 이 보고서는 A 로컬 근거이며 #3/#4 실제 수용 증거가 아니다.
