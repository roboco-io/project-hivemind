# ADR 0004: 인증 전달 전 실행 코드 버전 확인

상태: 구현·원격 수용 통과.

## 관찰

배포 제어면은 Worker `44410716-0e23-4294-bb78-dc0c01d56a3e`와 새 이미지를
100% 활성 상태로 보고했다. 그러나 캐시를 배제한 실제 `/health`는 이전 버전
`6dc95be6-d48f-48c7-b08f-2fb52c352d8e`를 보고했고, 작업도 이전 결과 판정 규칙으로 실행됐다.
두 배포의 Worker 스크립트 etag는 같고 이미지 참조는 달랐다.
같은 스크립트의 재사용이 관련됐을 가능성은 있으나, 이 관찰만으로 플랫폼 내부 원인을 단정하지 않는다.

[관측 기록](../verification/runtime-deployment-mismatch-20261110.json)을 참조한다.

## 결정

공개 실행 소스와 명시한 빌드 입력의 해시로 `backend/runtime-build.json`을 생성한다.
시간, 비밀 파일과 작업 폴더는 포함하지 않는다. CI는 파일 목록과 해시가 현재 입력과 일치하는지 검사한다.

Worker와 컨테이너가 같은 지문을 읽고 health 응답에 표시한다.
실행 코드가 바뀌면 Worker 번들에도 새 지문이 포함된다.
새 작업은 컨테이너의 health 지문이 예상값과 일치한 뒤에만 인증을 전달한다.
지문이 없거나 다르면 준비·CLI 실행을 진행하지 않는다.

확인한 지문은 인증 전달 전에 해당 시도에 고정해 저장한다.
재배포 후에도 진행 중인 시도는 고정한 버전을 기준으로 결과와 인증을 회수한다.
지문이 없는 기존 준비·실행 상태는 새 인증 전달이나 CLI 재실행 없이 조회·취소·정리한다.

이 지문은 소스·빌드 입력의 동일성을 나타낸다. 배포 이미지의 digest는 별도로 기록한다.
기본 이미지와 APT 저장소 같은 외부 입력의 바이트 동일성까지 증명하지 않는다.
[Cloudflare의 named image 갱신](https://developers.cloudflare.com/containers/guides/image-management/#roll-out-a-named-image-update)과
[Worker 버전 메타데이터](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/)를 함께 대조한다.
