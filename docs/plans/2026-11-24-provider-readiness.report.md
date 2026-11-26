# 실제 계정 검증 준비와 재현성 보완

## 변경

이전 전체 검사는 `/tmp/hivemind-source-loader.mjs`를 `NODE_OPTIONS`로 주입했다. 새 환경의 표준 `npm test`로는 shared TypeScript 소스의 `.js` import를 해석하지 못했다. 실제로 `delegated.js` 등의 모듈 누락과 56개 실패를 재현했다. 파일 로드가 중단되어 검사 수 자체도 줄었다.

테스트 전용 로더를 `cloudflare/backend/scripts/source-test-loader.mjs`에 추가하고 backend의 `npm test`에 연결했다. 실제 JavaScript 해석을 먼저 시도하며, 저장소 내부의 대응 TypeScript만 fallback한다. 저장소 밖 경로와 `node_modules`는 바꾸지 않는다. 이 로더는 테스트 실행에만 사용한다.

기능 추가 전 회귀 실패를 확인했고, cwd 독립 해석·기존 JavaScript 우선·저장소 밖 거부·의존성 거부 4개 검사를 추가했다. 패키지 변경으로 runtime manifest도 갱신했다. 기존 미커밋 변경은 유지했고 커밋·push·배포는 하지 않았다.

## 최종 검증

| 검사 | 결과 |
|---|---|
| root `npm run check` | 타입 검사·빌드 성공, 1,192 통과·0 실패 |
| backend 표준 `npm test` | 750 통과·0 실패, 임시 로더·추가 환경 설정 없음 |
| backend `npm run typecheck` | exit 0 |
| backend `npm run runtime:check` | current |
| `git diff --check` | exit 0 |

runtime digest: `d44bba00d5f3f31aae56cbd532be3dc003be8d8f11d95fa224649c8b5ff6e433`.

## 다음 실행 경계

[실제 AWS·HF 수용 검증 준비](2026-11-23-provider-acceptance.md)에 설정 목록, 단계별 합격 근거, 중단과 소유 버전 정리 절차를 정리했다. 사용자 결정에 따라 별도 수용 시험 대신 실제 프로젝트 작업에 검증을 결합한다. 해당 작업을 시작할 때 대상·예산·공개 범위를 확정하고, 첫 실행·업로드·종료의 실제 근거를 기록한다. 취소·권한 거부·키 교체는 별도 시나리오가 필요하며 정상 작업 성공으로 대체하지 않는다. 유료 자원 생성·공개 전환은 아직 실행하지 않았다.

#3·#4의 실제 계정 수용, #1의 실제 프로젝트 장기 검증은 완료되지 않았다. 이번 보완은 로컬 검사의 재현성을 확보하며 이슈 상태를 변경하지 않는다.
