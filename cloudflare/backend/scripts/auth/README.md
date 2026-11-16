# scripts/auth

## Overview

이 폴더는 macOS 운영자 머신에서 pi의 OpenAI Codex OAuth 인증을 Keychain에 보관하고 재사용하는 도구다.
`pi-oauth.ts`가 CLI이자 라이브러리다. `keychain.swift`는 `pi-oauth.ts`가 컴파일해 실행하는 Keychain 도우미다.
사용 절차와 배경은 [benchmark README](../../benchmark/README.md)의 "pi 구독 인증 재사용" 절을 따른다.

## Interface

- `[pi-oauth.ts:main]` - 하위 명령은 `status`, `login`, `forget`, `export PATH`다. 환경 변수 `HIVEMIND_PI_PACKAGE_ROOT`로 pi 설치 루트를 지정한다.
- `[pi-oauth.ts:getPiAccess]` - Keychain에서 `{access, accountId, expires}`를 반환한다. 기본 최소 유효 시간은 1,500,000ms다.
- `[pi-oauth.ts:resolveCredential]` - 유효한 인증을 반환한다. 최소 유효 시간 안에 만료되면 갱신한다.
- `[pi-oauth.ts:withKeychain]` - Keychain 도우미를 실행해 `Store`를 넘기고 끝나면 도우미를 정리한다.
- `[pi-oauth.ts:validateCredential]` - `access`, `refresh`, `accountId`, `expires` 네 필드를 검증한다.
- `[pi-oauth.ts:Credential]`, `[pi-oauth.ts:Store]` - 인증과 저장소의 타입.
- `keychain.swift` - stdin으로 `get`, `set`, `delete` 명령의 JSON 줄을 받고 줄마다 JSON 한 줄로 답한다. 시작할 때 `{ready:true}`를 출력한다.

## Invariants

- macOS에서만 동작한다. 다른 플랫폼에서는 오류를 던진다. `[pi-oauth.ts:helperPath]`
- 인증이 없거나 준비 상태가 아니거나 갱신에 실패하면 `HIVEMIND_PI_LOGIN_REQUIRED`를 던진다. `[pi-oauth.ts:resolveCredential]`
- 갱신 전에 저장소에 갱신 중 상태를 먼저 기록한다. 갱신이 중단되면 다시 `login`해야 한다. `[pi-oauth.ts:resolveCredential]`
- 갱신한 토큰의 유효 시간이 최소값보다 짧으면 `HIVEMIND_PI_TOKEN_VALIDITY_TOO_SHORT`를 던진다. `[pi-oauth.ts:resolveCredential]`
- `export`는 대상 파일이 이미 있으면 실패한다. 파일 권한은 0600이다. `[pi-oauth.ts:main]`
- `login`은 `127.0.0.1:1455`가 비어 있어야 하고 240,000ms 후 중단한다. `[pi-oauth.ts:main]`
- 도우미는 잠금 파일을 배타적으로 잡는다. 60초 안에 잡지 못하면 종료 코드 1로 끝난다. `keychain.swift`
- 도우미의 요청 줄은 131,072바이트 미만, `set` 값은 65,536바이트 미만이다. `keychain.swift`

## Side Effects

- Keychain의 generic password 항목 하나를 읽고, 쓰고, 지운다. `keychain.swift`
- `~/Library/Application Support/HIVEMIND`에 잠금 파일과 컴파일한 도우미를 만든다. `/usr/bin/swiftc`를 실행한다. `[pi-oauth.ts:helperPath]`
- `login`은 `/usr/bin/open`으로 브라우저를 열고 포트 1455를 잠시 연다. `[pi-oauth.ts:main]`
- 갱신은 pi 패키지의 OAuth 구현을 통해 제공자에 요청한다. `[pi-oauth.ts:resolveCredential]`
- `export`는 access token, 계정 ID, 만료 시각을 대상 파일에 쓴다. stdout에는 토큰을 출력하지 않는다. `[pi-oauth.ts:main]`
- `status`는 `{stored, ready, accessValid}` 불리언만 출력한다. `[pi-oauth.ts:main]`

## Verification

- Run: `npm test` (`cloudflare/backend/`에서 실행. `node --test test/*.test.ts`)
- `login`과 실제 Keychain 접근은 테스트 명령에 포함하지 않는다. 운영자가 직접 실행한다.
