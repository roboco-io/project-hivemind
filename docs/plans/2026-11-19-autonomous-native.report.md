# Claude native 실행·세션 복원 최종 검증

## 구현

- 중앙 claim은 credential ID가 겹치는 native 작업을 직렬화한다. active·stopping lease와 만료 후 미대사 실행을 차단하며 mock은 제외한다.
- runner는 실제 작업 ID와 호출 시점의 lease 복사본을 전달한다. native는 `durable === true`인 비공개 세션 저장소를 요구한다.
- private runtime은 중앙 native-start로 lease를 runtime 하나에 결속한다. 중앙의 정규 정책·체크포인트·deadline을 요청과 대조하고 실행 중 heartbeat 거절 시 중단한다. private 포트 인증만으로 중앙 승인을 대신할 수 없다.
- 허용 도구는 Bash 또는 Bash·Agent이고 외부 시스템은 연결하지 않는다. 주 모델과 자식 모델은 구체적인 모델 ID로 고정하며 별칭을 사용하지 않는다. 실제 제공자의 모델 가용성은 미검증이다.
- AES-GCM 저장소는 파일 또는 private R2에 세션을 보존한다. 작업·세션·모델·sequence·객체 키를 AAD로 결속하며 인증 파일과 비밀을 bundle·공개 응답에서 제외한다.
- native 비용은 null로 보존한다. 계속 실행 결과는 비용 대사와 명시적 resume 후에만 재개한다. 정상 실행 중 complete·failed는 stopping에 종료 의도를 보존하며 비용·행동·자원 정리 대사 후 추가 모델 호출 없이 종료한다. 취소·예산 중단이 우선하며 범위 중단을 워커 결과로 해제하지 않는다.

## 검증 근거

동결된 소스 35개 파일에 대한 조정자의 최종 전체 검증 결과다.

| 검사 | 결과 |
|---|---|
| 루트 `npm run check` | 273 통과, 0 실패, 0 생략; exit 0 |
| backend `npm run typecheck && npm test` | 306 통과, 0 실패, 0 생략; exit 0 |
| backend `npm run runtime:check` | current |
| 독립 최종 리뷰 | APPROVED |

통합 테스트는 실제 중앙 HTTP·native HTTP 포트·private bootstrap·backend 실행 함수·암호화 파일 저장소를 연결했다. 반복마다 새 워커·저장소 인스턴스·runtime 디렉터리에서 같은 세션 UUID·모델·주/자식 transcript·작업 파일을 복원했다. 파일 객체에 해당 평문이 없고 공개 상태에 비밀·private URL·세션 본문이 없음을 검사했다.

중앙 authorizer는 실제 HTTP를 사용했다. 미승인 lease, 다른 runtime으로의 재결속, 유효한 lease의 goal·도구 변조는 CLI 전에 차단했다. 프로세스·Linux 경계·설치 검사는 가짜다. 합성 캐시 수치와 정산 0은 실제 캐시 적중·제공자 청구 근거가 아니다.

범용 동적 probe 어댑터는 없어 실행하지 않았다. 위 결과는 명시적 단위·HTTP·파일·상태·경합 회귀 테스트의 근거다.

## 남은 운영 게이트

실제 Claude 구독 실행·모델 가용성·캐시 적중·원격 격리와 파일 경계는 별도 실증이 필요하다. 기존 Docker rollout 게이트는 유지한다. 실제 24시간·8주 무인 운영, 구독 제한 자동 대기, 외부 비용 집행·자원 정리, AWS/HF 연결과 장기 기록 보존은 완료하지 않았다. 이슈 #1은 열어 둔다.

실제 모델 호출·유료 자원 생성·배포·커밋은 수행하지 않았다.
