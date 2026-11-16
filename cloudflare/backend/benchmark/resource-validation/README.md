# RealWorld 자원·병렬 개발 고정 과제

app은 이전 무과금 기준 앱을 고정한 것이다. hurl은 기존 13파일·154요청 suite의 바이트를 그대로 보존한다. B의 초기 app에는 새 정렬·페이지네이션 요구가 아직 구현되지 않았다. contract.md가 두 작업의 공통 계약이다.

## 실행 인터페이스

- A의 샤드는 node run-shard.mjs 0, 1, 2, 3이다. 각 샤드는 별도의 앱·DB·npm 캐시와 포트를 만든다. node run-shard.mjs all은 전체 13파일·154요청 통합 검사다.
- B의 작업별 검사는 node acceptance.mjs articles 또는 comments다. node integration.mjs는 두 기능 수용 검사와 전체 Hurl suite를 실행한다. tasks.json은 워커별 허용 파일과 명령을 제공한다.
- node build-fixture.mjs OUTPUT_DIRECTORY는 새 snapshot 디렉터리를 만들고 manifest.json에 파일별 SHA-256과 바이트 수를 기록한다. 출력 디렉터리는 입력 fixture 밖에 있어야 한다.

Hurl 8.0.1을 `PATH`에서 찾는다. 다른 위치에 설치했다면 `HURL_BIN`에 실행 파일 경로를 지정한다. 로컬 실행기는 격리 환경에서도 npm을 찾을 수 있도록 Node 24.14.0의 bin 경로를 `PATH` 앞에 둔다.

각 명령은 snapshot의 app을 임시 작업 폴더로 복사하고 npm ci, Prisma generate, TypeScript build, DB migration을 실행한다. 입력 fixture를 수정하지 않는다. 설치·생성·빌드·DB·Hurl 시간과 검사 결과를 마지막 JSON 줄로 출력한다. cache는 실행마다 비어 있다.

기본 데이터는 작은 RealWorld 앱이다. 자원 압박이 관측되지 않으면 해당 결과는 작은 과제의 실행·계측 검증 범위로 해석한다.

## 로컬 사전 검증

기준 앱의 전체 Hurl은 13파일·154요청을 통과했다. 신규 기능 수용 검사는 기준 앱에서 53개 중 30개가 실패해 구현 필요성을 확인했다. 임시 검증용 구현에서 허용된 두 route 파일만 수정하자 53개가 모두 통과했고 공식 Hurl도 13파일·154요청을 통과했다. 검증용 정답 구현은 fixture에 포함하지 않는다.
