# 구독 반복 정책 최종 보고

## 구현

명시적 `billingPolicy: {model:'subscription', budget:'external_actions'}`에서 중앙이 독립 reporter의 완료 receipt와 finish를 대조한다. 검증된 반복은 매회 사람의 비용 대사·재개 없이 이어진다. 기본 metered 정책은 기존 동작을 유지한다.

HTTP 워커 루프는 명시적 반복·총 대기 횟수 상한, 중단 가능한 sleep과 최소 상태 조회를 사용한다. 자동 승인이나 불확실한 실행의 자동 재시도는 하지 않는다. 워커 GET·POST는 redirect를 거절한다.

native 모델 비용은 `costMicros: null`로 보존한다. 외부 행동 예산은 모델·구독·플랫폼·runtime·R2 비용을 포함하지 않는다. 새 정책에서 운영자의 `reconcile-run` 금액 0은 실행 중단 확인이며, 모델 가격을 0으로 확정하는 처리가 아니다. 확인되지 않은 실행과 기존 외부 자원 정리 gate는 계속 자동 재개·종료를 차단한다.

## 최종 검증 근거

동결된 21개 파일 기준으로 다음 명령이 모두 exit 0으로 완료됐다.

- root `npm run check`: **325 passed / 0 failed / 0 skipped**.
- backend typecheck 성공, `npm test`: **323 passed / 0 failed / 0 skipped**.
- backend `npm run runtime:check`: **current**. 최종 manifest stamp 완료.
- 범주별 추가 검증: root **58 passed**, backend **17 passed**, 실패·생략 0. 코드는 변경하지 않았다.
- 독립 최종 리뷰: **APPROVED**.

범용 동적 probe 어댑터는 없어 실행하지 않았다. 상태·권한·숫자 경계·인코딩·직렬화 깊이·파일·취소·크기 제한을 명시적 회귀 테스트로 연결해 위 추가 검증을 실행했다. 최초 리뷰 자료의 출력 한도 문제는 필요한 코드와 범주별 근거를 포함한 제한된 크기의 자료로 다시 검토받아 해결했다.

실제 로컬 관제 HTTP·SQLite·별도 reporter HTTP 키·AES-GCM 파일 저장소·private bootstrap·native 실행 함수를 연결했다. 단일 승인으로 continue → wait → 서버·워커 재시작 → complete를 확인했다. 암호화된 세션·작업 복원, receipt sequence 1·2·3, outcome·wakeAt 결속과 비용 null 유지를 검사했다. 수동 비용 대사·재개 호출은 없었다.

CLI와 Linux boundary는 합성 대역이다. 실행마다 별도 디렉터리와 runtime ID로 새 컨테이너를 모의했으며 실제 컨테이너를 생성하지 않았다. 별도 24시간 시나리오는 가상 시계만 사용했다.

## 남은 운영 검증

`stopped` receipt는 CLI 호출과 프로세스 정리를 마쳤다는 신뢰된 runtime의 자체 보고다. 컨테이너 종료 attestation이나 제공자 청구 증거가 아니다. 합성 사용량은 실제 CLI 캐시 적중의 증거가 아니다.

실제 모델·구독·원격 격리·청구 상한·외부 클라우드 connector·자원 정리·24시간 및 8주 운영 검증이 남아 있다. 기존 정리 gate 보존은 새 AWS 자원 삭제나 컨테이너 종료 기능의 구현을 뜻하지 않는다. 실제 자원 생성·유료 호출·배포·커밋은 수행하지 않았다. 이슈 #1은 닫지 않는다.
