# 순수 일일 일정 계산

- 소유: `packages/core/src/autonomous-schedule.ts`, `tests/autonomous-schedule.test.ts`와 이 설계만 수정한다. core·계약 연결은 후속 작업이다.
- 공개 계약: `DailySchedule {kind:'daily'; timeZone:string; localTime:string}`와 `nextDailyOccurrence(schedule, afterMs, lastKey?) -> {wakeAt:number; key:string}`. key는 현지 날짜 YYYY-MM-DD다.
- 입력 객체는 세 필드만 허용한다. HH:mm, IANA zone, 안전한 정수 epoch milliseconds와 실제 날짜 key를 검사한다. epoch 범위는 1970년 시작부터 9998년 말까지다. 날짜 key는 0001..9999를 허용한다.
- Intl의 명시적 Gregorian/Latin/h23 설정을 사용한다. UTC 날짜 산술과 날짜별 ±48시간의 시간 단위 offset 표본을 사용하고 후보를 역검증한다. 최대 8개 현지 날짜만 조사하며 범위 내 결과가 없으면 거절한다. 분 단위 장기 순회는 하지 않는다.
- gap은 해당 날짜를 건너뛴다. fold는 가장 이른 인스턴스만 인정한다. afterMs와 같은 시각은 허용한다. 지난 일정은 소급 실행하지 않는다. lastKey 이하의 날짜는 재실행하지 않는다.
- clock·환경·모델·네트워크·저장소를 사용하지 않는다. 테스트는 고정 시각만 사용한다. 먼저 실패를 기록한 뒤 focused build/test로 검증한다. stamp와 전체 검사는 coordinator freeze 이후다.

## 로컬 검증 기록

## 중앙 연결 설계

`AutonomousSpec.schedule`은 core 의존 없는 inline daily 계약이며 `AutonomousTask.lastScheduleKey`는 claim 시 현지 날짜를 영속한다. 승인·claim·continue 완료 시 helper로 다음 허용 시각을 계산한다. wait는 요청 시각 이상인 다음 일정만 선택한다. equality만 ready이며 지난 일정은 catchup하지 않는다. 첫 실행 뒤 schedule은 불변이다. 일정이 종료 시각 이상이면 expired로 중단한다. 취소·만료·비용·미확정 실행 처리가 우선한다. 복원은 key 형식과 실행 이력의 날짜·중복을 검증한다. API strict validator 변경은 C3/coordinator 소유이며 이 작업은 수정하지 않는다. 기존 long_running의 56일 제한을 유지한다.

- `npm run build` → 성공. `node --test dist/tests/autonomous-schedule.test.js` → stub 단계 9건 중 7실패·2통과(미구현 오류).
- 계산 구현 후 같은 build/test → 7통과·2실패(입력 검증의 Missing expected exception). 초기 stub의 검증 통과는 구현 근거로 사용하지 않는다.
- 검증 구현 후 같은 build/test → 9통과·0실패. UTC/KST·NY gap/fold·Lord Howe 반시간 fold·Apia 날짜 생략·재시작 key·윤년/연말·잘못된 입력을 검사했다.
- 실제 제공자·클라우드 호출, core 통합, 전체 검사와 runtime stamp는 수행하지 않았다. Intl/ICU의 설치된 시간대 데이터에 의존하며 실제 장기 운용의 근거는 아니다.

## 중앙 연결 및 P1 검증 기록

- 중앙 daily 통합 최초 red: 9실패·0통과(Unknown field). 승인·claim·continue/wait·복원 연결 후 관련 4파일 72통과. 복원 wake 위조 회귀 추가 red: 11통과·1실패; 검증 추가 후 관련 4파일 75통과.
- P1 포화 상태(131073개 개입·미확정 구독 run)에서 취소 전후 reconcileRun 회귀: 2실패(Intervention limit) → 2통과. 복구 예약 소진 상태 복원 회귀: 1실패 → 통과.
- 일반 개입 65536, help 등 기존 복구 envelope 131073은 유지한다. 전체 hard cap은 262146이며 최대 run/action 각 65536건 대사와 취소 슬롯을 유한하게 예약한다. 복원과 note 모두 실제 미확정 run/action·활성 lease·취소 필요 슬롯을 보존한다. 정산된 action 재전송은 개입을 추가하지 않는다. 이력 절단·저장소 용량 상한 변경은 없다.
- 최종 focused 4파일: 78통과·0실패. `npm run build`는 병행 작업의 `tests/autonomous-external.test.ts` 타입 오류로 실패했다. 첫 별도 컴파일은 implicit `node 2` 타입 탐색으로 실패해 `--types node`를 명시했다. 아래 별도 컴파일은 성공했다.

```sh
./node_modules/.bin/tsc --target ES2023 --module NodeNext --moduleResolution NodeNext --rewriteRelativeImportExtensions --types node --strict --noUncheckedIndexedAccess --noUnusedLocals --noUnusedParameters --skipLibCheck --rootDir . --outDir dist tests/autonomous-daily-integration.test.ts tests/autonomous-schedule.test.ts tests/autonomous-long-running.test.ts tests/autonomous.test.ts
node --test dist/tests/autonomous-daily-integration.test.js dist/tests/autonomous-schedule.test.js dist/tests/autonomous.test.js dist/tests/autonomous-long-running.test.js
```

- coordinator/C3 연결 계약: 공개 spec `schedule?:{kind:'daily';timeZone:string;localTime:string}`, 영속 task `lastScheduleKey?:string`. API strict validator는 C3 소유로 남긴다. quota·제공자 실행·전체 검사·runtime stamp는 수행하지 않았다. 이 단락의 core 통합 기록은 앞선 순수 helper 단계의 미통합 기록 이후다.
