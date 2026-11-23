# AWS OIDC 신뢰 역할

`AwsOidcStack`을 별도 CDK app에서 가져와 명시적 `AwsOidcDeploymentConfig`와 고정 계정·리전을 지정한다. 공개 issuer·audience·canonical subject 목록·서로 다른 실행/정리 정책이 필수다. signer 키는 입력하지 않는다. AWS 조회와 배포 app은 포함하지 않는다.

`npm ci --ignore-scripts`, `npm run typecheck`, `npm test`로 로컬 합성 정책을 검사한다. 상세 계약과 실제 AWS 잔여 수용은 [안내](../../docs/aws-web-identity.md)를 따른다.
