# 서명 전용 OIDC Worker

별도 배포 템플릿이며 기본 비활성이다. 운영 키나 계정 값은 포함하지 않는다. 공개 HTTP에는 discovery/JWKS GET만 허용한다. 서명은 trusted backend의 `OidcSigner` service binding RPC로만 호출한다.

설정·권한·키 교체·검증 한계는 [운영 안내](../../docs/oidc-issuer.md)를 따른다. 이 패키지는 기존 backend binding을 변경하거나 배포하지 않는다.
