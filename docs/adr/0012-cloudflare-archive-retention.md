# ADR-0012: 폐기된 `cloudflare/` 디렉터리의 보관 범위와 제거 조건

상태: 확정 (2026-11-26)

## 배경

Project HIVEMIND는 2026-11-25에 원격 실행을 AWS 단일 경로로 전환하고 Cloudflare 실행 백엔드를 폐기했다. 당시 운영 계정의 `hivemind-*` Cloudflare 리소스는 모두 삭제했고, `cloudflare/` 디렉터리는 "과거 검증 아카이브로만 보존"한다고 정했다([AWS 단일 실행 마스터 플랜](../plans/2026-11-25-realignment-aws-plan.md)).

이 결정에는 두 가지가 빠져 있었다. 디렉터리를 언제까지 두는지, 그리고 지금 디렉터리를 지우면 무엇이 깨지는지다. 이슈 #9의 "아카이브 정리" 항목은 이 두 가지를 정하라고 요구한다.

## 2026-11-26 기준 사실

`cloudflare/`에는 Git이 추적하는 파일이 409개 있다. 그중 295개가 `cloudflare/backend`다.

현행 코드가 이 디렉터리에 의존하는 지점은 다음과 같다. 2026-11-26에 저장소를 검색해 확인했다.

| 의존 지점 | 내용 |
|---|---|
| `packages/adapters/src/cloudflare.ts` | Cloudflare 실행 환경을 선택했을 때 `cloudflare/backend/src`의 모듈을 실행 시점에 동적으로 불러온다. |
| `packages/adapters/src/cloud-workflow.ts` | 원격 통합 워크플로에서 `cloudflare/backend/src`의 `client`, `files`, `snapshot` 모듈을 동적으로 불러온다. |
| `Dockerfile`, `infra/aws/Dockerfile.control-plane`, `infra/aws/Dockerfile.worker`, `infra/aws/Dockerfile.verifier` | 이미지 빌드 때 `cloudflare/backend/src`를 복사한다. 이 복사가 없으면 빌드가 실패한다. |
| `tests/` 아래 10개 파일 | Cloudflare 포트와 워크플로의 계약 테스트다. `npm run check`에 포함된다. |
| `.github/workflows/cloudflare.yml` | `cloudflare/` 패키지의 타입 검사와 테스트를 실행한다. 배포는 하지 않는다. |

AWS 단일 경로의 코드(`delivery`, `model-factory`, `collab`, `infrastructure/aws-runtime`)는 `cloudflare/`를 불러오지 않는다. 기본 MCP 프로필(`default`)의 Cloudflare 작업 도구와 중앙 관제의 Cloudflare 실행 환경 선택은 코드에 남아 있으나, 원격 리소스가 없으므로 실제 실행은 되지 않는다.

## 결정

1. **`cloudflare/`는 읽기 전용 아카이브로 유지한다.** 이 디렉터리에 새 기능을 추가하지 않는다. 보안 수정과 빌드를 유지하기 위한 수정만 허용한다. Cloudflare 리소스를 새로 만들거나 배포하지 않는다.
2. **아카이브에 대한 의존을 늘리지 않는다.** `apps/`와 `packages/`에서 `cloudflare/` 아래 코드를 참조할 수 있는 파일은 위 표의 어댑터 2개뿐이다. `tests/cloudflare-archive-boundary.test.ts`가 이 목록을 고정한다. 다른 파일이 아카이브를 참조하면 `npm run check`가 실패한다.
3. **지금은 디렉터리를 제거하지 않는다.** 제거하면 이미지 4종의 빌드와 테스트 10개 파일이 깨진다. 제거는 아래 조건을 채운 뒤 별도 작업으로 한다.

## 제거 조건

`cloudflare/`를 제거하려면 다음을 먼저 끝내야 한다.

1. 중앙 관제의 Cloudflare 실행 환경 선택, 기본 MCP 프로필의 Cloudflare 작업 도구, `packages/adapters`의 두 어댑터와 `packages/contracts/src/cloudflare.ts`를 제거하거나 AWS 경로로 대체한다. 이 작업은 공통 API와 어댑터 계약을 바꾸므로 소비자, 테스트, 문서를 함께 갱신해야 한다.
2. Dockerfile 4개에서 `cloudflare/backend/src` 복사를 지운다.
3. Cloudflare 계약 테스트 10개 파일과 `.github/workflows/cloudflare.yml`을 지운다.
4. `README.md`, `docs/mvp.md`, `docs/roadmap.md`에서 `cloudflare/` 아래 문서로 가는 링크를 Git 이력의 고정 커밋 링크로 바꾸거나 지운다.

이 조건을 채우는 작업의 담당자와 일정은 정하지 않았다. 사용자 결정이 필요하다.

## 영향

`cloudflare/`의 과거 검증 문서(`cloudflare/docs/verification`)는 계속 저장소에서 읽을 수 있다. 저장소 크기와 CI 시간은 줄지 않는다. 아카이브가 조용히 다시 쓰이는 일은 경계 테스트가 막는다.
