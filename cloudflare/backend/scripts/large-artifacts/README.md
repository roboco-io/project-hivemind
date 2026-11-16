# scripts/large-artifacts

## Overview

이 폴더는 4MiB snapshot에 담을 수 없는 큰 입력(large artifact)을 다루는 운영자 도구다.
`upload.ts`는 로컬 파일을 백엔드에 multipart로 올린다. `local-proof.ts`는 네트워크 없이 로컬 파일로 런타임의 준비 절차(다운로드 검증과 해제)를 실행해 receipt를 남긴다.
형식과 상한은 [backend README](../../README.md)의 "대형 compute 입력과 standard-4" 절을 따른다.

## Interface

- `[upload.ts:uploadLargeArtifact]` - 파일을 해시하고 올린 뒤 `{ref, status:'complete', reused, contentHashVerification:'runtime-required'}`를 반환한다.
- `upload.ts` CLI - 인자는 `FILE source|data tar.gz|file EXPANDED_BYTES MAX_FILES ORIGIN PRIVATE_CONTROL_JSON`이다.
- `[local-proof.ts:runLocalProof]` - 준비 절차를 실행하고 `receipt.json`을 쓴다. 통과하지 못하면 오류를 던진다.
- `[local-proof.ts:createFileBackedArtifactFetch]` - 로컬 파일을 스트림으로 돌려주는 가짜 `fetch`와 통계를 반환한다.
- `[local-proof.ts:FileArtifact]` - `{name, path, sha256, sizeBytes}` 타입.
- `local-proof.ts` CLI - 인자는 `SOURCE_TAR_GZ SF30_DATABASE OUTPUT_DIRECTORY`다.

## Invariants

- `ORIGIN`은 경로·쿼리가 없는 HTTPS origin이어야 한다. 비밀 파일은 그룹·기타 권한이 없는 일반 파일이어야 한다. `[upload.ts:uploadLargeArtifact]`
- 파일은 해시와 업로드 동안 크기와 수정 시각이 바뀌지 않아야 한다. `[upload.ts:uploadLargeArtifact]`
- 참조는 `validateLargeArtifactRef`로 검증한다. 업로드를 시작한 뒤 오류가 나면 해당 업로드를 중단한다. `[upload.ts:uploadLargeArtifact]`
- `local-proof.ts`는 코드에 고정한 크기와 SHA-256의 입력만 받는다. `[local-proof.ts:runLocalProof]`
- 출력 폴더의 여유 공간은 data와 source 크기에 4GiB를 더한 값 이상이어야 한다. `[local-proof.ts:runLocalProof]`
- 통과 조건은 파일 수, 해제 크기, data의 SHA-256 일치와 요청 2건이다. `[local-proof.ts:runLocalProof]`
- `receipt.json`은 이미 있으면 쓰지 않는다. 가짜 권한 문자열은 저장하지 않는다. `[local-proof.ts:runLocalProof]`

## Side Effects

- `upload.ts`는 `ORIGIN`의 `/v1/large-artifact-uploads` 경로를 호출해 원격 R2에 객체를 만든다. 운영자 토큰을 bearer로 보낸다. `[upload.ts:uploadLargeArtifact]`
- `upload.ts`는 파일을 두 번 읽는다. stdout에 참조와 상태만 출력한다. 로컬 파일은 쓰지 않는다. `[upload.ts:uploadLargeArtifact]`
- `local-proof.ts`는 네트워크를 호출하지 않는다. 출력 폴더에 임시 작업 폴더와 `receipt.json`을 만든다. `[local-proof.ts:runLocalProof]`
- `local-proof.ts`는 약 8GB의 data를 두 번 읽고 tar.gz를 해제한다. `[local-proof.ts:runLocalProof]`

## Verification

- Run: `npm test` (`cloudflare/backend/`에서 실행. `node --test test/*.test.ts`)
- `upload.ts`의 실제 원격 업로드는 테스트 명령에 포함하지 않는다. 운영자가 명시적으로 실행한다.
