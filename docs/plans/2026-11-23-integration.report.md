# I 공유 통합 검토 패킷

## 동결 상태

I 프로덕션 소스는 2026-11-23 최종 집중 검사 후 명시적으로 동결했다. C의 publication guard·cleanup 복구 계약을 통합하고 실제 core·concrete adapter 회귀를 재검증했다. 전체 작업 완료나 #3/#4 원격 수용 완료를 뜻하지 않는다.

## I 소유 변경

기존 dirty HF·Team 코드는 보존했다. 아래 기존 파일은 기존 변경 위에 I의 통합 부분만 추가했다.

- `packages/adapters/src/autonomous-external.ts`: 기본 서울 허용 목록, 선택 AZ 해시·배치 검증, 승인된 delegated IMDS 태그.
- `packages/contracts/src/autonomous-external.ts`: 비밀 없는 OIDC 감사 DTO.
- `packages/core/src/autonomous-external-sql.ts`: 비공개 과거 provider 정책의 OIDC·guard snapshot 허용.
- `cloudflare/backend/src/autonomous-external.ts`: canonical OIDC/GSC·과거 정리 정책·최종 자식 credential guard/cost·자동 launch별 admission·승인 metadata.
- `cloudflare/backend/src/cloudflare/worker.ts`: 비공개 signer/checker binding, delegated API, 실제 proof adapter와 credential callback 연결.
- `apps/control-plane/src/autonomous-external-api.ts`: 자동 admission hook와 safe profile metadata.
- `apps/control-plane/src/autonomous-cloud-proxy.ts`: 역할·subject·정책·descriptor와 bounded receipt 페이지 공개 투영.
- `apps/mcp-server/src/autonomous.ts`, `apps/dashboard/public/app.js`: 승인 metadata의 명시적 공개 필드 표시.
- 기존 `tests/autonomous-external-api.test.ts`, `tests/autonomous-external-providers.test.ts`: source resolver·Worker redirect·placement fixture 및 locator 회귀.

신규 파일:

- `cloudflare/backend/src/autonomous-oidc-runtime.ts`
- `cloudflare/backend/src/delegated-runtime.ts`
- `cloudflare/backend/src/delegated-s3-sign.ts`
- `apps/control-plane/src/delegated-api.ts`
- `tests/parallel-region-integration.test.ts`
- `tests/parallel-oidc-integration.test.ts`
- `tests/parallel-delegated-integration.test.ts`
- `docs/delegated-integration.md`, 이 검토 패킷

A guard/cost/region helper, B1 issuer/core policy, B2 STS/GSC, C controller/store/proof, D auth/bootstrap/uploader/IAM 모듈은 해당 담당자가 소유한다.

## 새 검증 근거

다음 7개 파일을 source loader와 `--experimental-transform-types`로 실행했다.

`tests/parallel-region-integration.test.ts`, `tests/parallel-oidc-integration.test.ts`, `tests/parallel-delegated-integration.test.ts`, `tests/autonomous-external-api.test.ts`, `tests/autonomous-external-providers.test.ts`, `tests/autonomous-mcp.test.ts`, `tests/autonomous-dashboard.test.ts`

결과: **158 passed, 0 failed**. 로그: `/tmp/hivemind-i-final-focused.log`.

- `npm run typecheck`: exit 0.
- `npx tsc -p cloudflare/backend/tsconfig.json --noEmit`: exit 0.
- `git diff --check`: exit 0.

실제 core·broker·신규 모듈을 연결하고 provider 경계만 fake-fetch로 대체했다. ARWI→GSC→concrete guard와 과거 CE reader의 최종 자식 credential, STS 중 취소·GSC 실패의 fallback 금지, 모델 WAIT/no lease 이후 bootstrap/HF envelope, 중앙 launch별 예산, native action→Spot 1회→lazy ledger→RSA bootstrap, 예산 초과 Spot 0회, 독립 증명과 신뢰된 checker release gate를 확인했다. Worker redirect:error를 거절하는 fetch도 사용했다. 실제 core 취소가 concrete HF metadata 조회 중 발생할 때 설정 PUT 0회, SQL에 남은 cleanup fence를 runtime 재구성 뒤 기존 operator cleanup route로 복구할 때 DELETE 0회를 확인했다. OIDC 발급·거부 감사의 영속성·태스크별 1024건 한도·운영자 인증과 페이지·비공개 필드 제거도 확인했다.

## 남은 통합 게이트

C의 최신 quality-expiry/cleanup-recovery 수정을 반영했다. 새로운 독립 I 리뷰와 coordinator의 전체 검사를 기다린다. I는 사용자의 병행 실행 경계에 따라 root `npm run check`, 빌드, runtime stamp를 실행하지 않았다. 실제 AWS·HF·모델·배포·push·commit도 수행하지 않았다.

실제 trusted AMI 격리·서비스 binding·계정 IAM·대용량 업로드·청구 검증은 로컬 검사와 별개다. 비용 null과 중앙 보수적 예약을 유지하며 성공·청구 0을 합성하지 않는다.

## 전체 검사 후 Spot fixture 보완

전체 검사에서 backend 4개·root 4개 실패를 source 검사로 모두 재현했다(`/tmp/hivemind-i-placement-red.log`: 0 passed, 8 failed). 네 fixture의 `DescribeInstances` 응답이 `placement.availabilityZone`을 생략했다. 따라서 실제 어댑터의 placement 검사가 의도대로 거절했고, 자원 receipt가 확정되지 않아 후속 정리·비용 테스트도 실패했다.

첫 probe는 cost-watch 응답에 `<placement><availabilityZone>ap-northeast-2a</availabilityZone></placement>`만 추가했다. 관련 3개가 통과했다. 같은 AWS 응답 보완을 다음 네 기존 파일에 각 한 줄씩 적용했다.

- `cloudflare/backend/test/autonomous-external-actor.test.ts`
- `cloudflare/backend/test/autonomous-external-cost-watch.test.ts`
- `tests/autonomous-external.test.ts`
- `tests/autonomous-remaining-integration.test.ts`

Production 변경과 기존 부정 assertion 완화는 없다. 이 패치는 기존 HF·Team 변경을 보존한다.

신규 검증: 해당 네 파일 **72 passed, 0 failed**(`/tmp/hivemind-i-placement-fixed.log`), region·provider의 거부 회귀 포함 **50 passed, 0 failed**(`/tmp/hivemind-i-placement-negative.log`). `npm run typecheck`, backend `tsc --noEmit`, `git diff --check` 모두 exit 0. I는 전체 빌드·stamp·배포를 실행하지 않았다. 추가 소스·fixture 편집 계획 없이 재동결했다.
