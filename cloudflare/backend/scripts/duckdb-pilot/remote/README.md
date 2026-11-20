# scripts/duckdb-pilot/remote

## Overview

이 폴더는 원격 compute 컨테이너 안에서 실행하는 DuckDB 빌드 runner와 그 보조 모듈이다.
상위 폴더의 `remote.ts`가 이 파일들을 snapshot으로 묶어 compute group에 제출한다. `runner.mjs`는 sandbox 경계를 probe하고 DuckDB를 빌드한 뒤 receipt를 JSON 한 줄로 출력한다.

## Interface

- `runner.mjs` CLI - 인자는 `[PROFILE=C1|C2|C3|C4] [CACHE_MODE=seed|cold|warm]`이다. `HIVEMIND_ARTIFACT_SOURCE`(필수), `HIVEMIND_ARTIFACT_DATA`, `HIVEMIND_CCACHE_DIR`와 같은 폴더의 `runner-config.json`을 읽는다.
- `[build-evidence.mjs:packNinja]` - Ninja 로그를 `{encoding, actions, sumActionMs, sha256, data}`로 묶는다.
- `[cache-stats.ts:parseCacheStats]` - ccache의 JSON 통계를 hit, miss, 캐시 크기로 해석한다.
- `[probe-policy.ts:classifyBoundaryError]`, `[probe-policy.ts:validBoundaryCheck]`, `[probe-policy.ts:validDataPostcondition]` - 경계 probe의 오류 코드를 분류하고 결과를 검증한다.
- `[probe-policy.ts:ProbeOperation]` - `'mutation'|'private-read'`.
- `[toolchain.ts:parseToolchainEvidence]` - CMake 파일과 `cmake`·`ninja` 버전 출력을 toolchain 근거로 해석한다.
- `build-cpu.py` CLI - 인자는 `OUTPUT_JSON COMMAND...`다. 자식의 종료 코드로 끝난다.
- `install-build-tools.py` CLI - 인자는 `BUNDLE_ZIP DESTINATION [ccache]`다.

## Invariants

- profile은 `C1`-`C4`여야 한다. 설정의 commit은 고정한 DuckDB commit과 같아야 하고 phase는 `boundary` 또는 `build`여야 한다. `runner.mjs`
- 캐시 모드는 phase가 `build`이고 profile이 `C3` 또는 `C4`일 때만 허용한다. 캐시 폴더는 `warm`일 때만 비어 있지 않아야 한다. `runner.mjs`
- 경계 probe는 source 쓰기·삭제와 런타임 입력 읽기가 차단되어야 통과한다. data가 있으면 data 쓰기·삭제도 차단되어야 한다. `runner.mjs`
- 차단은 `EACCES` 또는 `EPERM`, 변경 시도의 `EROFS`, 비공개 읽기의 `ENOENT`로 판정한다. 다른 코드는 분류하지 않는다. `[probe-policy.ts:classifyBoundaryError]`
- 단계는 0이 아닌 종료, 시그널, 시간 초과, 디스크 여유 3GiB 미만, 출력 128MiB 초과에서 실패한다. `runner.mjs`
- 테스트 목록은 `projection-tests.txt`와 같아야 한다. `runner.mjs`
- 도구 묶음은 고정한 SHA-256과 일치해야 한다. 절대 경로, `..`, 심볼릭 링크 항목을 거부한다. `install-build-tools.py`
- Ninja 행은 종료 시각이 시작 시각 이상이어야 한다. `[build-evidence.mjs:packNinja]`
- ccache 카운터는 음수가 아닌 안전 정수여야 한다. `[cache-stats.ts:parseCacheStats]`

## Side Effects

- `runner.mjs`는 임시 작업 폴더를 만들고 끝날 때 지운다. `python3`, `cmake`, `ninja`, `ccache`, 테스트 바이너리, `duckdb`를 실행한다.
- `runner.mjs`는 경계 확인을 위해 source와 data의 쓰기·삭제, `/runtime/input.json` 읽기를 의도적으로 시도한다. 차단되는 것이 기대 결과다.
- `runner.mjs`는 receipt를 stdout에, Ninja 근거의 나머지를 stderr에 출력한다.
- `install-build-tools.py`는 `DESTINATION`에 `cmake`, `ninja`, 선택적으로 `ccache`를 쓴다. 네트워크에서 내려받지 않는다.
- `build-cpu.py`는 CPU 시간을 지정한 JSON 파일에 쓴다.

## Verification

- Run: `npm test` (`cloudflare/backend/`에서 실행. `node --test test/*.test.ts`)
