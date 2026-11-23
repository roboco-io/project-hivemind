# OIDC·GSC·위임 실행 통합

새 기능의 기본값은 비활성이다. 실제 AWS·HF 실행, 배포와 공개 전환은 수행하지 않았다.

실제 계정 검증의 설정 목록·실행 순서·중단·근거 기준은 [수용 검증 준비](plans/2026-11-23-provider-acceptance.md)를 따른다.

## 설정과 승인

- 기존 외부 작업 설정은 유지한다. `AUTONOMOUS_EXTERNAL_OIDC_CONFIG`는 `{version:1,oidc,scoping}`이다. `oidc`는 issuer·audience·profile별 execute/cleanup role을 지정한다. 서명은 비공개 `AUTONOMOUS_OIDC_SIGNER.sign(grant)` service binding만 호출한다.
- `scoping[profileId][execute|inspect|cleanup]`는 `{policy,policyHash,durationSeconds}`다. 정책은 서버가 지정한 2048바이트 이하 JSON 문자열이며 `policyHash`는 그 문자열의 SHA-256이다. 기간은 1~120초다. 승인 fingerprint는 정책·기간·역할·issuer·위임 descriptor를 포함한다. JWT나 자격 증명은 포함하지 않는다.
- 실행은 canonical core 작업·현재 승인·broker action·중앙 예약·실행 권한을 반복 대조한다. ARWI 900초 부모 세션 뒤 GSC 자식 세션만 guard·EC2·비용 조회 callback에 전달한다. 실패 시 부모나 장기 key로 대체하지 않는다.
- 자식 세션의 실행 기간은 작업·action·절대 모델 실행 종료 시각과 서버 상한으로 제한한다. 갱신 가능한 30초 heartbeat 권한이나 JWT 만료를 절대 실행 기간으로 사용하지 않는다. 실제 자식 만료도 각 HTTP 단계 직전에 확인한다.
- inspect/cleanup은 해당 action에 저장된 과거 정책과 별도 정리 역할을 사용한다. 실행 권한 만료나 현재 설정 변경은 과거 소유 자원의 정리 권한을 새 실행 권한으로 바꾸지 않는다.

## OIDC 감사

`GET /v1/autonomous-tasks/:taskId/external-oidc-audit?after=0&limit=50`은 운영자 전용이다. task·revision·profile hash·action·purpose·role·kid·scoped/denied·시각·sequence만 보존한다. 발급 성공 후 callback에서 사용이 거절되면 scoped와 denied가 함께 남을 수 있다. JWT·자격 증명·raw provider 오류는 보존하지 않는다. 태스크별 최신 1024건, 전체 최신 8192건만 유지하며 한 페이지는 최대 100건이다. 재시작 뒤에도 조회한다. 현재 OIDC 설정을 제거했더라도 과거 소유 정책의 정리 감사는 유지한다.

## 위임 입력과 인스턴스

`AUTONOMOUS_DELEGATED_ENABLED=true`와 `AUTONOMOUS_DELEGATED_CONFIG`를 모두 설정해야 한다. 설정은 `{version:1,audience,allowedRegions?,workloads}`이며 각 workload는 `{profileId,descriptor,inputManifest,instanceRole:{roleName,roleId}}`다.

서버는 manifest digest·descriptor hash·AMI·instance profile·AZ ID·GSC 정책과 기간·guard workload 정책 문서를 대조한다. `descriptor.awsDelivery`는 실행 경로에서 필수다. `descriptor.iam.policySha256`은 실제 guard workload inline/boundary 문서의 canonical SHA-256이며, GSC scope 정책 hash와 별개다. guard manifest의 `delegatedUpload` bucket·prefix·최대 기간도 일치해야 한다.

기존 `aws.spot.start` API는 서버 manifest로 위임 저장·요청·전송 예산을 먼저 중앙 예약한다. 예약 key는 task·revision·profile·launch requestId를 포함한다. 같은 requestId 재전송만 재사용하며 새 launch는 별도 예약한다. 입력 변경은 새 승인이 필요하다. 소유 instance가 확인된 뒤 bootstrap challenge 경로가 원장을 등록하고 성공한 경우에만 nonce를 발급한다. 운영자가 먼저 `/register`를 호출할 수도 있다. 등록 실패 시 학습은 시작하지 않으며 기존 broker/TTL 정리 경계를 유지한다. launch는 IMDSv2와 instance metadata tags를 켠다. 기존 owner/guard 태그를 보존하고 `hivemind:task`, `revision`, `profile`, `descriptor`, `input` 태그를 instance·volume에 추가한다. 태그에는 서버 식별자와 승인 hash만 넣는다. trusted AMI는 이 locator와 instance identity를 읽고 중앙 bootstrap을 호출한다. 실제 AMI의 trusted bootstrap이 등록 성공을 기다리고 IMDS·credential 파일 격리를 강제해야 한다.

모델이 WAIT를 반환한 뒤에는 native lease 없이도 승인된 workload가 계속될 수 있다. bootstrap·HF token·publication의 권한은 현재 승인 revision/profile, 중단 여부, 작업·소유 action 기한으로 판단한다. 취소된 인스턴스도 과거 바인딩의 서명된 감사 보고·독립 검증·정리는 가능하다. 새로운 학습·토큰·공개 전환은 허용하지 않는다.

## HTTP 경로

기본 경로는 `/v1/autonomous-tasks/:taskId/delegated`다.

| 경로 | 권한·동작 |
|---|---|
| `POST /admit` | worker + native lease/runtime·launchRequestId. 중앙 예약과 입력 hash 결속 |
| `POST /register` | operator. 실제 소유 instance의 원장 등록 |
| `GET /` | operator. `actionId` 또는 `instanceId`, 선택적 `revision`, `after`, `limit<=100` |
| `POST /verify`, `/cleanup` | operator. `{receiptId}`와 소유 action selector |
| `POST /publish`, `/recover-publication` | operator. 독립 증명·신뢰된 checker 영수증으로만 공개 전환·조회 복구 |
| `GET /instances/:instanceId/challenge/:purpose` | purpose는 bootstrap/report/hf-token. 소유 instance 대조 후 짧은 nonce 발급 |
| `POST /instances/:instanceId/bootstrap`, `/report`, `/hf-token` | `x-hivemind-instance-proof` header에 base64url JSON 서명 증거. 본문보다 먼저 인증 |

서명 증거는 `{challengeId,request,publicKeyJwk?}`다. bootstrap은 서명된 RSA key thumbprint를 비공개 SQL CAS로 먼저 고정한다. HF token은 같은 key의 RSA-OAEP envelope만 반환한다. raw token·AWS key를 모델이나 학습 환경에 전달하지 않는다. 응답은 `Cache-Control: no-store`다.

S3/HF는 인스턴스가 직접 업로드한다. 중앙 proof adapter는 HEAD·ACL·고정 HF metadata API만 사용한다. multipart native composite 검증과 전체 파일 SHA-256의 instance 보고를 구분한다. 보고만으로 성공·청구 0·quality passed를 만들지 않는다. 확인되지 않은 비용은 null이고 중앙 예약을 유지한다.

공개 전환에는 비공개 `AUTONOMOUS_DELEGATED_CHECKER.qualityProof(binding,receipt)`가 필요하다. Worker의 passed:true 보고는 이 binding을 대체하지 않는다. checker가 없으면 전환을 거절한다. 승인·MCP·dashboard에는 역할·subject·정책 hash·descriptor·token 전달 방식만 표시한다.

## 한계

이미 발급된 AWS 세션을 취소 즉시 개별 폐기한다고 보장하지 않는다. 비공개 broker는 중단 뒤 실행 세션을 사용하지 않으며 TTL과 IAM 정책이 노출 기간을 제한한다. 실제 계정·AMI·OS 격리·서비스 binding·배포·대용량 업로드·청구 수용 검증은 별도로 필요하다. 로컬 fake-fetch 검증은 원격 수용 증거가 아니다.
