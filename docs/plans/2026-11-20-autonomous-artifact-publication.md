# 외부 아티팩트 게시

## 계약

워커 전용 `POST /v1/autonomous-tasks/:id/external-artifact`는
`{lease,runtimeId,profileId,artifact:{files:[{path,contentBase64}]}}`를 받아
`{artifactDigest}`를 반환한다. 기존 action 도구는 선택적 artifact를 먼저 게시하고
반환된 digest로 HF/GitHub action을 요청한다. 지정한 digest는 게시 결과와 같아야 한다.

공유 검증기는 정규 base64(빈 파일 포함), 안전한 경로, 중복 경로와 비밀을 검사한다.
파일당 256KiB, 합계 1MiB, 최대 32파일이다. 보호값에는 설정된 제공자 비밀,
기존 extraSecretValues의 관리·세션·인증 비밀, lease token과 runtimeId가 포함된다.
base64·URL·문자 escape의 제한된 중첩도 검사한다. 오류는 입력을 반환하지 않는다.

R2 키는 `external-artifacts/<digest>`로 고정한다. 조건부 생성만 허용하며
기존 객체는 정규 JSON 바이트가 같아야 한다. 임의 URL·prefix·삭제는 받지 않는다.

## 권한과 저장 한도

nativeStart, 실행 상태, 현재 승인된 선택 프로필, 설정 fingerprint와 admission을 확인한다.
비동기 저장 직전과 저장 후 grant 확정 전에 다시 확인한다.

기존 external SQL manifest/chunks 트랜잭션 안에 artifactGrants를 추가했다.
키는 taskId/revision/profileId/artifactDigest 튜플의 SHA-256이다.
값은 해당 튜플, profileHash, configurationFingerprint, 디코딩 bytes와 published다.
별도 SQL 테이블은 만들지 않았다. 허용 필드와 키 일치를 복원 시에도 검사한다.
모델 파일·lease·runtimeId·인증 비밀은 grant에 보존하지 않는다.

revision당 최대 32개·디코딩 합계 32MiB를 저장 전에 예약한다.
실패한 게시도 예약을 유지한다. 같은 바인딩의 재시도는 슬롯을 추가하지 않는다.
취소 후 grant 확정을 거절한다. 기존 키의 다른 바인딩은 덮어쓰지 않는다.
HF/GitHub execute는 broker 호출 전에 published grant와 현재 승인 바인딩을 확인한다.
명시적인 trusted `allowPreseededArtifacts:true` 외에는 grant 없는 객체를 차단한다.
기존 fixture는 grant를 직접 예약·확정하며 이 예외를 사용하지 않는다.

## 수정 파일

- packages/adapters/src/autonomous-external.ts: 공유 검증기와 불변 게시자, 제공자 검증 재사용.
- apps/control-plane/src/autonomous-external-api.ts: 워커 게시 경로, 재인증, grant와 실행 검사.
- cloudflare/backend/src/autonomous-external.ts: R2 게시자와 기존 비밀 입력 연결.
- packages/core/src/autonomous-external-sql.ts: grant 예약·확정·충돌·한도·복원 검증.
- tests/autonomous-artifact-publication.test.ts: 신규 게시·권한·한도·실제 core 통합 검증.
- tests/autonomous-external-api.test.ts: 기존 HF/GitHub fixture에 명시적 grant 추가.
- cloudflare/backend/test/autonomous-external-actor.test.ts: 기존 실행 fixture grant 추가.
- tests/autonomous-cloud-proxy.test.ts: service fixture에 publishArtifact 추가.

worker.ts와 sidecar는 수정하지 않았다. 활성화 기본값과 실제 비용 기록은 변경하지 않았다.

## 검증

초기 게시 함수·grant·경로 부재를 실패 테스트로 확인했다.
최종 집중 실행: 141 passed, 0 failed, 약 12.5초.

```sh
node --experimental-transform-types --import /tmp/hivemind-source-loader.mjs --test \
 tests/autonomous-artifact-publication.test.ts \
 tests/autonomous-external-api.test.ts \
 tests/autonomous-external-providers.test.ts \
 tests/autonomous-cloud-proxy.test.ts \
 cloudflare/backend/test/autonomous-external-actor.test.ts
npx tsc -p tsconfig.json --noEmit
```

임시 loader는 소스 실행 시 상대 .js import를 존재하는 .ts 파일로 연결한다.
타입 검사는 종료 코드 0이었다. 실제 core → 게시 → 실행 → R2 loader → HF fake
검증을 포함한다. 제공자 네트워크·모델 호출·배포·빌드·stamp는 실행하지 않았다.
루트 npm run check와 최종 통합 gate는 coordinator가 수행한다.
