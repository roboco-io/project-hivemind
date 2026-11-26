# 중개 S3 쓰기·조회 설계 — 2026-11-21

상태: 계약·core 검증기·전송 어댑터 구현 완료. 공용 union 확장과 broker 연결은 통합 작업 I1이 맡는다. 실제 AWS 호출은 하지 않았고 모든 검사는 가짜 fetch를 쓴다.

## 설계

HIVEMIND가 직접 S3에 쓰는 일은 `aws.s3.put` 하나다. 이 작업은 이미 승인된 산출물(artifact)의 정규 JSON을 서버가 정한 bucket과 prefix 아래 한 객체로 저장한다. `aws.s3.inspect`는 같은 승인 안의 put 작업이 쓴 객체를 HEAD로 읽기만 한다. bucket, prefix, 계정, region, KMS 키는 서버 profile의 `target`만 정한다. put의 모델 입력은 `keySuffix`와 `artifactDigest` 두 값뿐이다. inspect의 모델 입력은 `{putActionId}` 하나이며, 대상 키와 digest는 그 put 작업의 값을 쓴다. 모델이 inspect에서 키를 다시 지정할 수 없다. 다른 키(예: `bucket`)는 두 작업 모두 검증에서 거절한다.

객체 키는 `prefix + keySuffix`다. suffix는 `^[A-Za-z0-9_][A-Za-z0-9_./-]{0,239}$`를 만족해야 하고 `..`, `//`, `/./`, 끝 `/`를 포함하면 안 된다. `%`와 `\`는 정규식에서 이미 막힌다. bucket 이름에 점이 있으면 가상 호스트 방식 TLS 주소가 깨지므로 거절한다. prefix는 `/`로 끝나야 한다.

PUT은 다음 헤더를 보낸다. `If-None-Match: *`는 기존 객체를 덮어쓰지 않게 한다. `x-amz-checksum-sha256`은 S3가 본문을 검증하게 한다. `x-amz-expected-bucket-owner`는 계정이 다른 bucket으로의 쓰기를 막는다. `x-amz-meta-hivemind-mark`는 이 작업의 표식이다. 표식은 `JSON.stringify([ownershipToken, idempotencyKey, parametersHash])`의 SHA-256 hex다. `kmsKeyId`가 있으면 SSE-KMS 헤더도 보낸다.

본문은 artifact 게시자가 저장하는 것과 같은 정규 JSON(`JSON.stringify({files})`)이다. `x-amz-checksum-sha256`은 artifact digest 바이트의 base64다. 확인 결과: `externalArtifactDigest`는 이 JSON 문자열의 SHA-256 hex이므로, hex를 바이트로 풀어 base64로 바꾼 값이 S3 checksum과 같다. 테스트가 이 등식을 직접 검사한다.

PUT 응답 처리는 다음과 같다. 200이면 성공이다. 412(이미 객체가 있음)이면 HEAD로 표식과 checksum, 크기, KMS 키를 비교한다. 모두 같으면 성공이고, 표식이 다르면 다른 작업이 쓴 객체이므로 `failed`/`none`이다. 표식이 같은데 내용이 다르면 `unknown`/`unknown`이다. 그 밖의 상태와 예외는 execute가 예외로 던지며, 효과가 없었다는 증거로 쓰지 않는다. 자동 재-PUT은 없다.

inspect는 HEAD만 보낸다. 200이고 일치하면 성공 영수증을 낸다. 404, 403, 네트워크 오류는 `null`(미해결)이다. `null`은 객체가 없다는 증명이 아니다. `aws.s3.inspect` 작업은 자기 표식이 쓴 쪽과 다르므로 표식을 비교하지 않고 내용(checksum, 크기, KMS)만 비교한다. inspect는 실행 권한이 만료된 뒤에도 동작한다.

전송 제한: `redirect:'error'`, 요청당 5초, execute는 `now() < expiresAt`일 때만 실행한다. 크기는 기존 artifact 한도 1 MiB와 `target.maxObjectBytes` 중 작은 값을 넘으면 PUT 전에 거절한다. digest가 맞지 않아도 fetch 전에 거절한다. 서명은 이 파일의 `signExternalS3Request`가 직접 하며, 기존 전송(`http()`)은 고치지 않았다.

## 비용 의미

put의 효과는 `retained`다. HIVEMIND는 객체를 삭제하지 않으므로 정리 대상 resource를 만들지 않는다. 영수증의 비용은 `billing:{verifiedCostMicros:null,final:false}`다. `null`은 0이 아니다. 운영자가 정산 근거를 입력하기 전까지 broker는 예약 비용을 유지해야 한다. `retentionDays`는 보존 정책 선언이며, 만료 삭제는 bucket의 수명 주기 규칙이 하고 HIVEMIND는 삭제하지 않는다.

## IAM 예시

자격 증명은 이 작업 전용 역할 하나에 연결한다. Delete 권한은 주지 않는다.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject"],
     "Resource": "arn:aws:s3:::BUCKET/PREFIX*"},
    {"Effect": "Allow", "Action": ["kms:GenerateDataKey"],
     "Resource": "arn:aws:kms:REGION:ACCOUNT:key/KEY_ID"}
  ]
}
```

HEAD는 `s3:GetObject` 권한으로 동작한다. `kms:GenerateDataKey`는 `kmsKeyId`를 설정했을 때만 필요하다. `s3:ListBucket`을 주지 않으면 없는 객체의 HEAD가 404 대신 403을 받을 수 있다. 두 경우 모두 inspect는 `null`이다.

## 신뢰하는 워크로드 기술서 (문서 정의, 코드 없음)

EC2 고정 워크로드가 S3에 쓰는 경우, 승인 fingerprint는 다음 항목을 함께 묶어야 한다. 하나라도 바뀌면 새 승인이 필요하다.

- AMI ID
- 부팅·입력 manifest의 digest
- IAM 정책 revision
- 계정 ID와 region
- bucket과 prefix
- 바이트 한도, 보존 기간, 비용 한도

## 한계

- HIVEMIND는 인스턴스 안에서 일어나는 개별 쓰기를 중개하거나 보지 못한다. 위 기술서가 묶는 것은 허용 범위이지 실제 쓰기 내역이 아니다.
- 같은 ARN의 IAM 정책 내용은 나중에 바뀔 수 있다. policy revision은 운영자가 기록한 값이며 HIVEMIND가 매번 확인하지 않는다.
- reporter 영수증은 워크로드의 자기 보고이며 독립 증거가 아니다.
- 인스턴스 종료는 저장 비용을 끝내지 않는다. 객체는 삭제 또는 수명 주기 만료 전까지 비용이 계속 생긴다.
- 404와 네트워크 오류는 부재 증명이 아니다.

## I1 요청

1. `ExternalOperation`, `ExternalTarget`, `ExternalProfile`, `ExternalParameters`, `ExternalActionRequest`에 S3 항목을 추가한다. 이후 `ExternalS3Invocation`을 `ExternalInvocation`으로 대체한다.
2. core `validateProfile`/`validateParameters`가 `provider:'s3'`와 두 작업을 `validateExternalS3Target`·`validateExternalS3Parameters`로 검증하게 한다. 작업 수 제한(현재 2)은 충분하다.
3. `externalParametersHash`는 현재 형식(`hash({operation,parameters})`, 키 정렬)을 유지해야 한다. 전송은 같은 값을 자체 계산해 `parametersHash`와 비교한다.
4. `ExternalProviderCredential`은 `provider:'aws'` 형태를 그대로 쓴다. resolver가 s3 profile에 aws 자격 증명을 주게 한다.
5. `createExternalProviderTransport`의 provider 분기에서 `createExternalS3Transport`로 위임하고 `cleanup`/`confirmAbsent`는 s3에서 거절한다(resource가 없음).
6. broker는 put 영수증의 `verifiedCostMicros:null`을 운영자 정산 전까지 예약 유지로 처리해야 한다.
7. 서버 설정에서 `ExternalS3Target`을 주입하고 `loadFiles`는 `createExternalR2ArtifactLoader(...).load(i.parameters.artifactDigest)`의 `files`를 쓴다.

## 검증

`tests/autonomous-external-s3-core.test.ts`(검증기, 키, 표식)와 `tests/autonomous-external-s3-transport.test.ts`(PUT·HEAD·412·만료·크기·서명)를 가짜 fetch로 실행했다. `SUPERLITE_REAL=1`이면 artifact 로더를 실제 R2 로더 구현으로 바꿔 같은 테스트를 다시 실행한다. 서명은 테스트 안의 독립 계산과 같은 값을 내는지 비교했다. 실제 S3와의 서명 호환은 이 계획에서 검증하지 못했다.
