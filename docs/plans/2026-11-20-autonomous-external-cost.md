# AWS 외부 행동 비용 조회 범위

기본값은 비활성이다. 신뢰된 서버가 승인 account·ap-northeast-2·workload·read-only credential source·SQL cache·조회 가격 상한을 구성한다. CE만 고정 `https://ce.us-east-1.amazonaws.com/`와 SigV4 service `ce`/region `us-east-1`을 사용한다. 자원 리전은 바꾸지 않는다. 태그 활성화의 사전 관측 증거가 없으면 verified-cost admission을 거절한다. 실제 조회에서도 owner/workload 비용 할당 태그의 Active 상태·활성화 시점을 확인한다.

조회 범위는 승인 account·region·고유 owner·workload의 EC2 Compute와 EC2-Other(EBS 포함) UnblendedCost다. UTC 일자 범위는 최대14일이다. 요청한 기간의 모든 일자가 있고 Estimated=false, 정확한 account/owner group, USD 비음수 decimal일 때만 자원 비용을 인정한다. 빈 결과·누락·추정·페이지 미완료·잘못된 범위는 0이 아니라 미확정이다. decimal은 BigInt로 합산하고 총액을 micro USD 단위로 올림한다. 종료 당일의 UTC 종료와 최소48시간 지연 이후에만 최종 자원 관측을 허용한다. 이는 AWS 청구 불변성 보장이 아니다.

CE 조회도 유료일 수 있다. SQL cache는 action별 슬롯을 네트워크 전에 원자적으로 예약한다. 한 관측은 태그 조회와 비용 조회 두 요청을 예약하며 최소24시간 간격, 전체 최대14요청이다. 실패·timeout도 슬롯을 돌려주지 않는다. 서버의 queryUpperBoundMicros×maxQueryCount를 자원 상한에 더해 profile 예약 범위에 포함한다. 현재 요금은 추측하지 않는다.

S3·공유 guard·CE 조회료·세금 등은 owner EC2/EBS 결과에 포함된다고 주장하지 않는다. 별도 신뢰된 최종 추가 비용 source가 실제 증거와 전체 사용 query 수를 확인하지 않으면 partial verified resource cost만 보고하고 final=false를 유지한다. HF/GH 비용도 source 없이는 미확정이다. reserved_ceiling_only는 신뢰된 서버의 명시적 미확정 비용 정책이며 hard cap 보장이 아니다. verified_cost_source 정책은 reader quote·가격 여유·태그 사전 증거가 없으면 start를 거절한다.

instance와 volume에 같은 owner/workload/request/parameters 태그를 붙인다. 종료/부재와 소유권을 확인하고 남은 소유 EBS가 없을 때만 reader를 호출한다. 재시작 후에는 broker에 보존한 자원 참조를 기존 ownedResource 필드로 전달한다. CE reader·guard·태그 활성화·실제 청구·원격 factory 연결은 실제 AWS에서 검증하지 않았다. 테스트는 합성 HTTP와 로컬 SQL만 사용한다.

## 연결 계약과 남은 조건

- `createExternalCostCache(sql:ExternalSqlPort)`는 동일 SQL의 action별 cache를 원자적으로 저장한다. 물리적 재시작 보존에는 실제 durable SQL을 주입한다. reader 재생성으로 슬롯을 초기화하지 않는다. 최초 부재 관측은 조회 가능한 시점 전에도 저장한다.
- `createAwsCostExplorerReader(options)`의 서버 설정은 `enabled`, `accountId`, `resourceRegion:'ap-northeast-2'`, `workloadId`, `queryUpperBoundMicros`, `maxQueryCount(2..14)`, `resourceUpperBoundMicros`, `tagActivation:{evidenceId,activeSince,observedAt,validUntil}`, `cache`, `credentials`다. credentials는 `purpose:'cost_read'`·billingRegion us-east-1·고정 자원 account/region을 받는다. credential은 artifact나 공개 결과로 전달하지 않는다.
- `ExternalCostReader.quote(invocation)`은 최대 CE 요청료와 자원 비용 상한을 반환한다. `read(invocation,{resourceConfirmedAbsent,observedStoppedAt})`는 `{verifiedCostMicros,final,evidenceId?}`를 반환한다. provider의 `costReader`에 reader를 주입한다. quote는 원격 요청을 하지 않는다.
- provider AWS 설정의 `billingPolicy`는 `verified_cost_source` 또는 신뢰된 운영자가 미확정을 수용한 `reserved_ceiling_only`다. 기본 생략은 start 거절이다. CE 최대 요청료와 자원 상한의 합이 승인 profile 상한을 넘으면 거절한다. 확인되지 않은 CE 요금은 상한만 예약하며 실제 비용으로 저장하지 않는다.
- 자원 비용 확인 뒤에는 새 CE 요청을 만들지 않는다. `supplement.read`는 이미 수집한 검증 영수증만 조회하며 새 유료 요청을 시작하면 안 된다. scopeHash·예약 request 슬롯 수·최종 추가 비용·별도 evidenceId가 맞을 때만 전체 final을 기록한다. 슬롯 수는 실제 AWS 청구 건수의 추정값이 아니다. 실패 뒤 실제 청구 여부는 별도 증거가 필요하다.
- provider `forbiddenValues?:readonly string[]`는 factory가 알고 있는 실제 비밀 값의 비공개 목록이다. 현재 credential 값과 함께 decoded 파일 bytes·경로·원문 메시지를 HTTP 전에 검사한다. regex만으로 installation token이나 opaque secret을 안전하다고 판단하지 않는다. model/SourceSnapshot은 이 설정을 바꿀 수 없다.
- 남은 EBS가 있으면 부재 확인과 최종 비용 조회를 막는다. 종료·부재가 확인된 소유 instance에 결속된 detached EBS는 아래 R11 규칙으로 정리한다. guard의 실제 EBS fallback·IAM 권한, 비용 태그 활성화, 가격 설정, CE 및 보조 영수증의 원격 수용은 운영 전 별도 검증 대상이다. AWS 전체 비용 hard cap이나 실제 billing 통합 검증 완료를 주장하지 않는다.

## 로컬 검증

### guard와 공유하는 launch configuration hash

`packages/adapters/src/autonomous-external.ts`의 `externalAwsConfigurationHash(config:ExternalAwsLaunchPolicy):string`을 provider·guard manifest·CDK 설정 작성자가 공통으로 사용한다. provider의 `AwsTtlGuardRequest.configurationHash`도 이 helper를 호출한다. 전체 AWS config의 `JSON.stringify` SHA256은 더 이상 계약이 아니다.

정규화 객체는 `schemaVersion:1`과 다음 고정 필드만 포함한다: `accountId`, `region`, `workloadId`, `imageId`, `instanceType`, `subnetId`, `instanceProfileArn`, `maxLifetimeMs`, `maxUpperBoundMicros`. 마지막 두 값은 양의 safe integer이며, profile ARN은 CDK가 최종적으로 생성할 값이어야 한다. 모든 key를 기본 문자열 오름차순으로 정렬한 JSON의 UTF-8 SHA256 hex가 결과다. 값은 trim·alias 변환하지 않는다. 이 flat 객체에 대한 `awsGuardDigest(normalizedPolicy)`와 같다.

`enabled`, credential 값과 `credentialRef`, `billingPolicy`, 비용 reader 설정·조회 가격, action UUID·parametersHash·expiry와 quote의 출처·유효기간은 이 launch hash에서 제외한다. credential/profile 승인은 별도 profileHash·resolver scope로, action/quote는 guard request·manifest quote와 billing admission으로 결속한다. launch 필드를 바꾸면 새 hash와 manifest가 필요하지만 단순한 키 순서·config spread·활성화 상태·billing policy 변경은 hash를 바꾸지 않는다.

Erdos/CDK 연결: `profiles[].configurationHash = externalAwsConfigurationHash(finalAwsConfig)`를 사용한다. 기존 `infrastructure/aws-external-guard/README.md`와 guard 설계 문서의 JSON.stringify 설명은 해당 소유자가 이 계약으로 교체해야 한다. guard/CDK 소스와 그 소유 테스트는 이 변경에서 수정하지 않았다.

공유 해시 회귀2건은 최초2실패 뒤2통과했다. 키 순서를 뒤집은 provider와 실제 `createAwsTtlGuardPort`를 연결한 fake AWS 검증에서 Rule/Lambda/IAM/DynamoDB/Scheduler read-back 뒤 RunInstances 순서를 확인했다. provider/guard 집중 emit과 직접 `.ts` import도 통과했다. 병행 추가된 Erdos fixture는 billingPolicy 누락으로1실패했으며 이를 숨기거나 admission을 완화하지 않았다. 해당 fixture가 미확정을 의도하면 명시적인 `reserved_ceiling_only`가 필요하다. 이 필드는 해시에서 제외된다. 실제 원격 canary는 계속 미검증이다.

공유 해시 단계의 실행 명령과 합계: 아래 emit 성공, 테스트53건 중52통과·1실패(위 Erdos fixture)다. provider35건은 모두 통과했고 guard17건 통과·1건 실패다.

```sh
./node_modules/.bin/tsc --target ES2023 --module NodeNext --moduleResolution NodeNext --rewriteRelativeImportExtensions --types node --strict --noUncheckedIndexedAccess --noUnusedLocals --noUnusedParameters --skipLibCheck --rootDir . --outDir dist tests/autonomous-external-providers.test.ts tests/autonomous-aws-guard.test.ts
node --test dist/tests/autonomous-external-providers.test.js dist/tests/autonomous-aws-guard.test.js
```

### 단계별 지연 예산

provider의 guard attest 전체 상한은25초, arm 전체 상한은15초다. 구체 guard port의20초/10초 제한보다 바깥 wrapper가 먼저5초에 끊지 않도록 한다. 각 실행 단계는 남은 action expiresAt과 현재 dispatch 취소 신호로 더 짧게 제한한다. 자원 HTTP는 계속 최대5초이며 실행 context의 남은 기한을 함께 적용한다. 재시도와 공개 timeout 설정은 추가하지 않는다.

CE의 읽기 전용 종료 후 복구 proof는 별도15초 상한이다. 종료된 action의 과거 expiresAt을 새 실행 권한으로 바꾸지 않으며, 이 읽기 경로는 모델 lease 갱신이나 VM 생성 권한을 부여하지 않는다. CE 내부 각 HTTP의5초 제한·영속 유료 조회 슬롯도 유지한다. native 모델 실행120초 상한과 중앙 authorizer의 현재 lease 검사는 변경하지 않았다. sidecar의 별도60초/실행 deadline 조정은 해당 소유자 범위다.

가짜 Date/setTimeout·deferred port·AbortSignal 회귀에서 기존 guard5초 조기 중단2건과 CE 무제한 대기1건의 실패를 재현했다. 수정 뒤6개 지연 회귀가 통과했다. attest/arm 각각6초 지연, attest25초 상한, 짧은 기한, arm 취소 시 VM 생성0, CE6초 완료·15초 중단을 실제 장시간 sleep 없이 확인했다. 이는 실제 AWS 네트워크 지연 수용 근거가 아니다.

최종 집중 emit 성공, provider41·broker40·cost11·guard18 합계110통과·0실패다. 제품 변경은 provider, 전용 provider 테스트와 이 문서에 한정했다.

```sh
./node_modules/.bin/tsc --target ES2023 --module NodeNext --moduleResolution NodeNext --rewriteRelativeImportExtensions --types node --strict --noUncheckedIndexedAccess --noUnusedLocals --noUnusedParameters --skipLibCheck --rootDir . --outDir dist tests/autonomous-external-providers.test.ts tests/autonomous-external.test.ts tests/autonomous-external-cost.test.ts tests/autonomous-aws-guard.test.ts
node --test dist/tests/autonomous-external-providers.test.js dist/tests/autonomous-external.test.js dist/tests/autonomous-external-cost.test.js dist/tests/autonomous-aws-guard.test.js
```

reader 최초7건 중4실패·3통과를 확인했다. artifact 실제 credential 회귀1건, provider 비용 admission/volume 연결2건, 최초 관측·지연 영수증2건, cache/JSON 순서/원문 메시지3건의 실패를 확인한 뒤 수정했다. 최종3파일84통과·0실패, 집중 TypeScript emit과 직접 `.ts` import가 통과했다. 네트워크·실제 청구·모델·배포·commit·전체 검사·runtime stamp는 수행하지 않았다. 테스트 fixture의 숫자는 현재 AWS 요금이 아니다.

```sh
./node_modules/.bin/tsc --target ES2023 --module NodeNext --moduleResolution NodeNext --rewriteRelativeImportExtensions --types node --strict --noUncheckedIndexedAccess --noUnusedLocals --noUnusedParameters --skipLibCheck --rootDir . --outDir dist tests/autonomous-external-cost.test.ts tests/autonomous-external.test.ts tests/autonomous-external-providers.test.ts
node --test dist/tests/autonomous-external-cost.test.js dist/tests/autonomous-external.test.js dist/tests/autonomous-external-providers.test.js
node --input-type=module -e "await import('./packages/adapters/src/autonomous-external.ts'); await import('./packages/adapters/src/autonomous-external-cost.ts'); console.log('direct TS imports passed')"
```


### R11 소유 orphan EBS 정리

cleanup은 aws.spot.start만 허용한다. 보존된 ownedResource가 있으면 instance/action/owner/idempotency가 요청과 일치해야 한다. instance가 조회되지 않으면 이 보존 참조가 필수다. 조회된 instance의 owner/client-token/workload/parameters와 원래 guard/timer/expiry 결속을 검사한 뒤에만 TerminateInstances를 요청한다. 같은 호출에서 종료 ACK를 실제 종료로 간주하지 않는다.

종료 또는 실제 부재를 확인하면 DescribeVolumes를 owner/request/workload로 조회한다. guard/timer/parameters로 query를 더 좁혀 잘못된 태그의 자원을 숨기지 않는다. 반환된 모든 volume의7개 원래 태그를 검증하며 timer는 같은 account/region의 hm-<original bindingHash 앞48자>여야 한다. 이 규칙은 concrete guard의 arm timer와 같다. 잘못된 태그·중복 ID·불완전 응답·페이지 미완료는 pending이다.

volume은 available이고 attachmentSet이 명시적으로 비어 있을 때만 DeleteVolume을 호출한다. 삭제 직전 재조회하며 한 cleanup batch는 최대2개다. in-use/attached/creating/deleting/error는 삭제하지 않고 detach도 하지 않는다. DeleteVolume ACK는 부재 증거가 아니며 실제 DescribeVolumes의 absent/deleted read-back 뒤에만 confirmAbsent=true다. 늦은 자원과 미확정 청구의 예약은 유지한다. 실제 AWS DeleteVolume 권한과 guard Lambda fallback은 Erdos 범위이며 여기서 원격 검증하지 않았다.

R11 신규 회귀 최초4건 중3실패·1통과를 재현했고 수정 뒤4통과했다. 기존 fake timer도 실제 guard의 binding 기반 이름을 쓰도록 맞췄다. 집중 emit 성공, provider45·broker40·cost11·guard18 합계114통과·0실패다. 실행 명령은 앞 단계의4개 focused test emit 및 node --test와 같다. 실제 AWS·네트워크·배포·commit·전체 검사·stamp는 수행하지 않았다.

### R8 운영자 invoice 정산

trusted broker의 `serverAttestBilling(actionId,actualCostMicros,evidenceRef,reason):ExternalAction`을 제공한다. 인증된 운영자 bridge 전용이며 worker/model 호출로 공개하지 않는다. succeeded/failed의 확정된 결과만 허용하고 자원이 있으면 기존 cleanupStatus=cleaned가 필수다. 이 메서드는 자원 부재·삭제·실행 성공을 새로 확정하지 않는다. intent/dispatching/ambiguous/cancelled, live/pending/deleting 자원과 이미 provider final인 비용은409로 거절한다.

`operatorBilling:{actualCostMicros,evidenceRef,reason,at}`, `billingSource:'operator_attested'`와 원래 `providerReceipt`를 별도로 보존한다. 기존 집계 필드 verifiedCostMicros에는 명시적으로 확인한 invoice 금액을 반영하지만 operator_attested는 provider_verified가 아니다. provider의 원래 null/partial/nonfinal 금액·evidenceId를 덮어쓰지 않는다. legacy known-outcome row는 이미 보존한 마지막 승인 receipt projection을 archive한다. 새 provider final은 provider_verified로 표시하며 사람의 검토로 덮어쓸 수 없다.

같은 amount/reference/reason 재전송은 원래 at을 그대로 반환한다. 다른 검토는409다. invoice reference는128자 이하 ID이며 URL/query·인증 토큰 형식은 거절한다. reason은2000자 이하의 제어문자 없는 설명이며 인식 가능한 비밀을 거절한다. 0은 사람이 명시적으로 검증한 경우에만 이 메서드로 기록할 수 있고 무료를 자동 추정하지 않는다. nonfinal provider partial과 invoice 차이는 두 출처를 보존한 운영자 대사로 처리한다.

명시적 검토 금액이 action quote 또는 현재 task 예산을 넘으면 실제 금액을 보존하고 승인 중단·다른 live 자원의 cleanup을 요청한다. 예약은 이미 확인된 자원 정리와 이 청구 검토가 함께 충족된 경우에만 해제한다. 검토 뒤 reconcile은 새 provider query로 이 검토를 바꾸지 않는다. C1의 operator-only `/billing`과 Volta의 private core settlement는 이 operatorBilling 마커로 human intervention +1을 한 번만 원자적으로 반영해야 한다. API·human count 소비자 연결은 해당 소유자 범위다.

새 회귀4건 모두 실패를 확인한 뒤 수정했다. live/unknown 비용 waiver 차단, provider final 보존, HF/GH 명시적 invoice 정산과 출처 구분, 재전송/409, 초과 금액 정리, SQL 복원을 검사했다. 마지막4개 집중 파일 emit 성공·119통과·0실패다. 앞 단계와 같은4파일 emit/node --test 명령을 사용했다. 실제 invoice 조회·청구 API·네트워크 호출은0이며 source를 동결한다.
