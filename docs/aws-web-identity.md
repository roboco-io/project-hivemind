# AWS OIDC와 범위 축소 자격 증명

이 경로는 기본 비활성이다. 실제 계정, 공개 issuer, 역할, 정책과 대상은 운영자가 설정한다. 로컬 가짜 HTTP 검사와 CDK 합성은 실제 AWS 수용 근거가 아니다. 키 생성·AWS 조회·배포는 수행하지 않았다.

## 교환 순서와 경계

1. 중앙 runtime은 저장된 task·approval·action·profile과 현재 실행 권한을 읽는다. `deriveOidcGrant`가 승인 revision·프로필 해시·목적에서 `sub`, `aud`, 역할을 계산한다.
2. 비공개 `OidcSignerPort.sign(grant)`가 짧은 JWT를 반환한다. 서명키는 별도 signer에만 둔다. HTTP 공개 경로는 discovery/JWKS뿐이다.
3. `createAwsWebIdentityResolver`는 허용 리전의 `https://sts.<region>.amazonaws.com/`에 서명 없는 `AssumeRoleWithWebIdentity` POST를 보낸다. 요청 세션은 900초다. 세션 이름은 task/revision/action/purpose의 해시다.
4. 부모 임시 자격 증명으로 같은 리전의 `GetScopedCredentials`를 SigV4 서명한다. 승인된 정책과 짧은 수명으로 범위를 줄인다. 부모는 소비자에게 전달하지 않는다.
5. 반환 계정·역할·세션·기한을 검사하고 중앙 권한을 다시 확인한다. 신뢰된 consume callback 안에서만 자식 AWS 자격 증명을 사용한다. 가드·비용 조회 factory도 이 자식 자격 증명을 쓴다.

JWT, 부모·자식 키와 세션 토큰은 저장·로그·이벤트·UI에 넣지 않는다. 실패하면 종료하며 장기 키나 부모로 전환하지 않는다. 캐시는 없다. 감사 callback은 task/revision/profile/action/purpose/role/kid/status만 받는다. 외부 오류 본문과 예외는 일반 오류로 바꾼다.

실행 목적은 현재 승인과 활성 lease가 필요하다. inspect/cleanup은 저장된 소유 action과 과거 승인에 결속된 별도 정리 역할·subject를 사용한다. 취소된 작업의 정리에 실행 역할을 재사용하지 않는다.

## 중앙 runtime 연결 계약

`packages/adapters/src/aws-web-identity.ts`의 factory:

```ts
createAwsWebIdentityResolver({
  region, allowedRegions, signer, fetch, now, audit,
  authority: {
    grant: async scope => /* canonical facts -> deriveOidcGrant */,
    scoping: async scope => ({
      policy, policyHash, targetHash, durationSeconds, expiresAt
    })
  }
}).withCredentials(scope, async credentials => /* trusted AWS transport */);
```

`authority`는 서버 전용 포트다. 요청 본문에서 역할·subject·정책을 가져오지 않는다. `grant`는 서명 전, STS 전후, GSC 뒤, consume 직전에 다시 평가한다. 정책 조회가 비동기로 대기한 뒤에는 grant를 마지막으로 확인한다. action·승인·역할·정책 해시나 대상이 바뀌면 거부한다.

`policyHash`는 정확한 Policy 문자열의 SHA-256이다. `targetHash`는 `awsOidcTargetHash(scope.target)`다. 승인 fingerprint와 저장된 provider policy에 두 해시를 포함한다. 실행은 현재 설정을, inspect/cleanup은 해당 action에 저장한 설정을 사용한다. 프로필·참조 불일치는 runtime에서 거부한다. 기존 runtime 연결은 `cloudflare/backend/src/autonomous-oidc-runtime.ts`가 담당한다.

정책은 유효한 IAM JSON이며 2,048자 이하다. `durationSeconds`는 서버가 정한 1~120초다. 기본 운영값은 60초를 권장한다. `expiresAt`은 밀리초 단위 절대 기한이다. 실행에서는 task 종료·action 종료·실제 run의 `startedAt + maxRunMs` 중 가장 이른 기한을 쓴다. 갱신 가능한 이전 lease의 만료나 JWT 만료를 AWS 세션 기한으로 사용하지 않는다. 현재 lease의 활성 여부는 각 제공자 단계에서 계속 확인한다. 실제 run의 절대 기한이 없으면 짧은 서버 설정을 사용하며 실제 최대 실행 시간을 늘리지 않는다. 정리 기한은 별도의 서버 복구 정책으로 정한다.

## 독립 GSC helper

`createAwsScopedCredentialResolver({region, allowedRegions, fetch, now})`의 `withCredentials(parent, request, consume)`는 이미 신뢰된 임시 부모 세션을 받는다. `parent`에는 키·토큰 외에 `expiresAt`, `arn`, `sessionId`와 선택적인 `sourceIdentity`, `scopedPoliciesCount`가 필요하다. 요청은 `policy`, `policyHash`, `durationSeconds`, `expiresAt`, 안전한 ASCII `description`이다. 호출자는 중앙 권한과 대상 결속을 확인해야 한다.

요청 수명은 부모 잔여 수명과 절대 기한으로 내림하여 제한한다. 자식 만료는 부모·요청 수명·절대 기한을 넘지 못한다. `SessionInfo.Arn`, `ScopedSessionId`, `SourceIdentity`는 부모와 같아야 한다. 정책 계층은 정확히 하나 증가하며 최대 3개다. 이미 3개인 부모는 호출하지 않는다. JWT로 GSC를 직접 호출할 수 없다.

HTTP 응답은 64KiB, 각 STS 요청은 5초로 제한한다. 이는 로컬 처리 한도이며 AWS 세션 토큰의 고정 최대 크기라는 주장이 아니다. 5,000바이트 토큰을 검사한다. XML은 제한된 STS 문법으로 읽으며 DTD·사용자 정의 엔티티·중복 필드·혼합 본문을 거부한다. 중단된 stream은 cancel 완료를 기다리지 않고 취소한다.

## IAM CDK

`infrastructure/aws-oidc`는 별도 CDK 패키지다. 기존 guard 패키지를 수정하지 않는다. 공개 HTTPS issuer와 audience, 정확한 canonical subject 목록, 계정·리전·서로 다른 실행/정리 정책을 필수로 받는다. trust에 `StringEquals`의 `aud`와 `sub`를 모두 넣는다. wildcard subject는 허용하지 않는다. subject는 task 해시·승인 revision·프로필 해시·목적을 포함한다. 각 목록은 최대 8개이며 신규 승인은 명시적으로 목록을 갱신해야 한다.

실행 역할과 정리 역할은 분리한다. 정리 정책은 읽기·소유 자원 종료/버전 정리의 제한된 동작만 받는다. 운영자는 정책 Resource와 소유 조건을 승인 범위에 맞게 지정한다. `ec2:DeleteVolume`은 소유 태그가 결속된 승인 volume ARN으로 제한한다. S3 ACL·속성 검증 읽기는 승인 bucket/object ARN과 해당 버전 조건으로 제한한다. 이 허용 동작 목록에 추가하는 것만으로 배포 정책에 권한을 자동으로 넣지는 않는다. 두 역할에 `sts:GetScopedCredentials`를 추가하되 `sts:DurationSeconds <= 120`과 파라미터 존재를 강제한다. IAM 역할 설정의 최소 최대세션 값은 3,600초지만 실제 ARWI 요청은 900초다. signer 개인키는 CDK 입력·출력에 넣지 않는다.

```sh
npm --prefix infrastructure/aws-oidc ci --ignore-scripts
npm --prefix infrastructure/aws-oidc run typecheck
npm --prefix infrastructure/aws-oidc test
node --import /tmp/hivemind-source-loader.mjs --test tests/aws-web-identity.test.ts tests/aws-scoped-credentials.test.ts tests/aws-sts-protocol.test.ts
```

마지막 명령은 개발용 `.js`→`.ts` source loader가 있을 때만 쓴다. 일반 통합 검사는 coordinator가 수행한다. 실제 AWS에서 issuer 신뢰, 잘못된 subject 거부, 취소 후 정리, 키 교체, 가드·비용 조회까지 검증해야 #3의 원격 수용이 끝난다. 이미 발급한 AWS 세션은 중앙 취소만으로 즉시 폐기되지 않으므로 짧은 자식 수명과 매 단계 권한 검사, 기존 독립 종료 가드를 함께 유지한다.

공식 근거: [AssumeRoleWithWebIdentity](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRoleWithWebIdentity.html), [GetScopedCredentials](https://docs.aws.amazon.com/STS/latest/APIReference/API_GetScopedCredentials.html), [GSC 권한·수명·신원 보존](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp_control-access_getscopedcredentials.html), [ScopedSession](https://docs.aws.amazon.com/STS/latest/APIReference/API_ScopedSession.html).
