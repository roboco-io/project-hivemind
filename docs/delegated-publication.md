# 위임 업로드·검증·공개 전환

학습 인스턴스는 승인된 고정 프로그램으로 S3와 HF에 직접 업로드한다. 중앙은 메타데이터만 받는다. 모델 파일 본문은 중앙과 Cloudflare를 통과하지 않는다. AMI·부팅 프로그램·IAM 정책을 신뢰하는 위임 실행이며, 중앙이 인스턴스 안의 모든 요청을 중개하거나 증명하지는 않는다.

## 승인과 입력

`WorkloadDescriptorSchema`는 AMI, bootstrap SHA-256, 승인된 manifest digest 목록, IAM 정책 revision·SHA-256, 계정·리전·AZ ID, S3 버킷·접두사·객체 수·용량·보존·비용 예약, HF 저장소·공개 범위·토큰 참조·전달 조건, 품질 검사와 공개 정책을 고정한다. 선택적 `awsDelivery`는 `instance_role_scoped` 방식의 역할·purpose·정책 해시·기간을 추가로 결속한다. HF 토큰은 별도 인스턴스 전용 envelope로 전달한다. 승인 화면에는 이 서버 설정과 descriptor fingerprint를 표시해야 한다.

`workloadFingerprint`는 엄격한 스키마로 검증한 기술서를 키 정렬 JSON으로 만들고 SHA-256을 계산한다. 기술서의 값이 바뀌면 새 승인이 필요하다. `InputManifestSchema`는 code/data의 승인 참조 ID·해시와 정형 인자만 받는다. UserData, 셸, 임의 URL 필드는 받지 않는다. 인스턴스 helper는 manifest digest를 승인 목록과 대조하고 서버가 지정한 entrypoint만 실행해야 한다.

## 중앙 계약

`createDelegatedController`는 durable store, 현재 core 권한 조회, 인스턴스 인증, 중앙 비용 예약·조회·정산, 독립 provider 조회, 신뢰한 품질 검사 포트를 모두 요구한다. 포트가 빠지면 생성 자체를 거절한다. 작업·승인 revision·workload·기술서 해시·인스턴스·계정·리전이 같은 binding이어야 한다. HTTP 요청의 식별자나 `passed:true`는 권한 또는 품질 근거가 아니다.

등록은 비용 예약 **전에** 고정 key와 보존 종료 시각을 가진 `registration.intent`를 저장한다. 중앙 예산 포트는 key별 예약을 멱등 처리하고 `reconcile(key)`로 이미 커밋된 예약을 돌려줘야 한다. 응답이 유실되면 `unknown`을 남기고, 재조회로 같은 예약을 복구한다. 취소 후에는 기존 예약만 복구할 수 있으며 새 예약을 만들지 않는다. S3 저장·요청·전송 예약은 합산한다. 실제 청구 근거가 없으므로 `actualBillingMicros`는 `null`이다. 정리는 예약 비용을 실제 비용 0으로 바꾸지 않는다.

컨트롤러는 binding별로 조립한다. core 조회 포트는 과거 revision·인스턴스의 소유 사실도 반환할 수 있어야 한다. 취소·만료 후에도 그 인스턴스의 인증된 최종 메타데이터 보고, 독립 조회, 보존 종료 후 정리는 허용한다. 활성 권한은 모델 native lease가 아니라 승인된 workload의 현재 revision·취소 여부·작업과 인스턴스 TTL을 뜻한다. 모델이 WAIT로 lease를 반납해도 승인된 학습 인스턴스의 권한이 자동으로 끝나지는 않는다. 새 실행·bootstrap·HF 토큰 전달·공개 전환은 현재 활성 권한을 따로 요구한다. D의 인증 포트도 report 목적과 실행 목적을 구분해야 한다.

## 영수증과 독립 조회

영수증은 `reported → unverified → verified | mismatch | unknown`을 구분한다. 보고만으로 실행 성공이나 실제 청구를 확정하지 않는다. 영수증 ID의 내용은 바꿀 수 없다. 작업별 개수·바이트 한도를 검사하고 같은 S3 버전을 중복 등록하지 않는다.

S3는 정확한 version ID, 크기, provider-native 체크섬을 HEAD로 확인한다. 서명한 `x-amz-expected-bucket-owner`와 해당 버전의 GetObjectAcl 소유자 ID를 함께 검사한다. 서버 기술서의 `ownerCanonicalId`가 없거나 ACL 근거를 읽을 수 없으면 `unknown`이다. `null` 버전은 영수증 스키마와 직접 정리 어댑터 모두에서 거절한다. HEAD의 버전이 다르거나 `null`이면 검증·삭제를 진행하지 않는다. ACL은 객체 소유 계정의 근거이며 업로더 신원을 증명하지 않는다. 원장의 binding은 보고자 인증과 신뢰한 bootstrap에 결속되고, provider 조회는 보고된 데이터·버전·승인 범위의 일치만 검증한다. FULL_OBJECT SHA-256만 전체 파일 SHA-256과 대조할 수 있다.

대형 multipart는 `checksum:{algorithm:'SHA256',type:'COMPOSITE',value:'base64-N'}`으로 보고할 수 있다. 실제 HEAD의 같은 native 값·타입, 버전·크기·소유자가 일치하면 `checksumEvidence:'native-composite'`로 검증한다. 별도 `sha256` 값은 인스턴스가 보고한 전체 파일 해시이며 `wholeSha256Status:'instance_report'`를 유지한다. COMPOSITE를 전체 파일 SHA-256으로 표시하지 않는다. ETag, 객체 사용자 메타데이터와 모델 파일 프록시를 해시 근거로 사용하지 않는다. [AWS 공식 체크섬 규약](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html), [HeadObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html), [GetObjectAcl](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObjectAcl.html)을 따른다.

HF는 고정 `huggingface.co/api/models` API로 현재 SHA·공개 범위와 해당 commit의 `blobs=true` 파일 크기·blob OID·LFS SHA-256을 대조한다. 마지막에 현재 SHA·공개 범위를 다시 읽는다. 필요한 메타데이터가 없으면 `unknown`, 값이 다르면 `mismatch`다. `/resolve/`로 가중치를 읽거나 새 저장소를 만들지 않는다.

## 공개 전환과 정리

커밋 보고와 공개 전환은 별도 행동이다. 공개 전환은 검증된 비공개 HF 영수증, 사전 승인 공개 정책, 같은 binding·commit·영수증·검사 ID·정책 revision의 유효한 trusted quality proof를 요구한다. 요청 본문에서 품질 통과 값을 받지 않는다. 비공개 publication guard는 어댑터의 마지막 토큰 조회 뒤 현재 workload 권한을 비동기로 다시 읽고, 품질 증명과 권한의 만료 시각을 동기로 확인한 직후 PUT을 호출한다. 메타데이터·토큰 조회 중 만료되거나 취소되면 PUT을 보내지 않는다. 모델 품질은 파일 메타데이터로 증명하지 않는다.

쓰기 전에 공개 intent와 operation fence를 저장한다. HF 공식 클라이언트의 [update_repo_settings 구현](https://github.com/huggingface/huggingface_hub/blob/main/src/huggingface_hub/hf_api.py)에 따라 `PUT /api/models/{repo}/settings`에 `{"visibility":"public"}`을 보낸 뒤 정확한 SHA와 공개 상태를 조회한다. 요청 결과가 불명확하면 `unknown`으로 남긴다. `recoverPublication`은 조회만 수행하며 PUT을 재전송하지 않는다. 쓰기가 진행 중일 수 있으므로 아직 비공개라는 조회만으로 실패를 확정하지 않는다. HF는 이 설정 쓰기에 commit CAS를 제공하지 않으므로 조회 사이에 다른 관리자가 바꾸는 동시성까지 원자적으로 차단하지는 못한다.

정리는 보존 종료 후 검증된 소유 객체의 **정확한 버전**만 삭제하고 HEAD로 부재를 확인한다. 결과가 불명확하면 정리 상태를 `unknown`으로 보존하고 예약을 해제하지 않는다. 인스턴스 종료는 S3 비용 종료의 근거가 아니다.

기존 cleanup 호출은 저장된 정리 intent·unknown·미정산 deleted 상태를 만나면 `recoverCleanup`으로 연결된다. 복구 포트 `cleanupState`는 정확한 버전의 HEAD와 필요한 소유·체크섬 조회만 수행하며 DELETE를 재전송하지 않는다. 부재가 확인되면 deleted로 기록한다. 같은 소유 버전이 여전히 일치하면 retained로 복구해 fence를 해제하며, 이후 별도 cleanup 요청이 새 intent와 사전 검사를 시작할 수 있다. 근거가 불명확하면 unknown과 fence를 유지한다. 정리 시도 ID와 정산 intent·unknown·settled 상태를 원장에 보존한다. 재시작과 정산 응답 유실 뒤에도 reservation ID별 멱등 정산을 재개하며 청구액은 null이다.

## 저장과 검증 범위

`delegated-store.ts`는 Worker용 `createDelegatedSqlStore({exec,transactionSync})`, `MemoryDelegatedStore`, 공개 validator를 제공한다. SQL은 manifest와 64KiB 이진 데이터의 base64 청크를 한 트랜잭션으로 저장한다. 각 청크는 96KiB 이하다. 전체 해시·길이·순서·binding·generation을 검증한다. 기본 한도는 원장 128개, 원장당 512KiB, 합계 32MiB다. 비동기 mutation, stale generation, identity 변경과 한도 초과를 거절한다. 중단된 읽기 전용 verify는 같은 영수증에 새 fence로 다시 조회할 수 있으며, 이전 조회는 새 결과를 덮어쓰지 못한다. `delegated-node-store.ts`의 Node 전용 SQLite wrapper는 같은 SQL 포트를 사용한다. Worker 모듈에는 `node:sqlite`가 없다.

이 구현의 증거는 가짜 provider HTTP, 실제 로컬 SQLite, 응답 유실·취소·경합·부분 쓰기 회귀 테스트다. 실제 AWS/HF 업로드·청구·모델 품질·공개 전환·배포는 확인하지 않았다. 이 문서와 로컬 검사만으로 이슈 #4의 실제 계정 수용 완료를 주장하지 않는다.
