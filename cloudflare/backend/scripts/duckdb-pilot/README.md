# DuckDB P0 로컬 실행기

이 도구는 사전 실행과 자원 한계 탐색용이다. 기존 결과 디렉터리는 덮어쓰지 않고 새 실행 ID를 사용한다. 실제 compile·query 실행은 다른 자원 측정과 겹치지 않게 조율한다.

## 메모리 예산 탐색

`memory`와 `memory-batch`의 P0 `MEM_GIB` 허용값은 **3·6·9**다. 3GiB는 로컬 최선 설정을 찾기 위해 추가한 낮은 메모리 튜닝 후보다. 본실험 설계의 기존 6·9GiB 조건과 이미 실행한 결과의 성공·실패 판정은 변경하지 않는다.

예시:

```sh
node cloudflare/backend/scripts/duckdb-pilot/pilot.ts memory-batch ROOT NEW_RUN_ID BUILD_ID 30 3 4 4
```

이 호출은 동일 SF30 데이터·고정 22쿼리·4샤드·워커당 threads=4를 유지하고 메모리 예산만 3GiB로 낮춘다. 각 워커의 spill 상한은 계속 4GiB다. `memory_limit`은 프로세스 전체 RSS의 확정 상한이 아니다. 메모리 감소에 따라 늘어나는 spill·I/O·완료 시간도 관측해야 한다.

`compare-memory.py`는 같은 SF·query·threads·**memory_limit**의 concurrency-1 참조를 요구한다. m3 결과를 m6 참조와 같은 설정으로 취급하지 않는다. m3 con1을 별도로 실행하거나 `--allow-memory-tuning`을 명시해 다른 메모리 예산의 결과 동치를 검토한다. 이 옵션은 동일 binary·source·데이터·query·threads를 요구하며 두 메모리 값을 별도로 기록한다. 결과 kind는 `cross-memory-tuning-query-equivalence`이고 성능 조건이 같다는 증거가 아니다. 튜닝 결과를 기존 6GiB 원격 비교의 성공 표본으로 대체하지 않는다.

빈 CLI 출력은 무조건 빈 배열로 취급하지 않는다. `query_output.py`가 성공한 shard 종료, 유효 schema, 0행 profile, 고정 query hash 일치를 확인한 경우만 해석하며 원본과 정규화 근거를 함께 보존한다.

## Interface

아래 절은 현재 코드가 정의한 계약을 기록한다. `ROOT`는 실험 산출물을 두는 폴더다.

### 하위 폴더

- [remote](./remote/README.md) - 원격 compute 컨테이너 안에서 실행하는 빌드 runner와 보조 모듈.

### 로컬 실행기

- `pilot.ts` CLI - 첫 인자가 하위 명령이다. `prepare ROOT`, `prepare-local-ccache ROOT`, `baseline ROOT [ID] [SECONDS]`, `build ROOT ID C1|C2|C3|C4 JOBS`, `build-batch ROOT ID CONFIGS CONCURRENCY JOBS`, `build-ccache-batch ROOT ID cold|seed|reuse`, `memory ROOT ID BUILD_ID SF MEM_GIB THREADS QUERY_IDS CONCURRENCY`, `memory-batch ROOT ID BUILD_ID SF MEM_GIB THREADS CONCURRENCY`.
- `[pilot.ts:COMMIT]` - 고정한 DuckDB commit.
- `[pilot.ts:main]` - 위 CLI 하위 명령을 분기하는 공개 진입점.
- `pilot.ts`가 읽는 환경 변수 - `DUCKDB_PILOT_OSX_SYSROOT`(SDK 선택), `DUCKDB_SKIP_JEMALLOC`(ccache 실행에 필수).
- `[batch.ts:validateBuildBatch]`, `[batch.ts:executeBatch]`, `[batch.ts:BatchRecord]` - 빌드 batch 설정을 검증하고 제한된 worker pool로 실행한다.
- `[memory-batch.ts:validateMemoryBatch]`, `[memory-batch.ts:shardScript]`, `[memory-batch.ts:MEMORY_SHARDS]`, `[memory-batch.ts:FLOAT_COMPARISON]` - 22개 query의 고정 4샤드 분할, 샤드 SQL, float 허용 오차.
- `[metrics.ts:Guard]`, `[metrics.ts:parseVm]`, `[metrics.ts:profile]`, `[metrics.ts:validateMemoryOptions]` - 자원 한계 감시, `vm_stat` 해석, profile과 메모리 옵션 검증.
- `[local-ccache.ts:prepareLocalCcache]`, `[local-ccache.ts:verifyLocalCcache]`, `[local-ccache.ts:localCcachePaths]`, `[local-ccache.ts:parseCcacheStats]`, `[local-ccache.ts:LOCAL_CCACHE_VERSION]` - 고정 버전 ccache의 설치·검증과 통계 해석.
- `[sdk.ts:selectMacSdk]`, `[sdk.ts:MacSdk]` - 명시한 macOS SDK 경로를 검증한다.
- `supervise.py` CLI - 인자는 `SPEC_JSON RECEIPT_JSON`이다. 명령 하나를 시간·로그 크기 제한 아래 실행하고 receipt를 쓴다.
- `inventory.py` CLI - 인자는 `BINARY FILTER SOURCE NEW_TEMP_DIR`이다. 테스트 이름 목록을 검증해 출력한다.
- `normalize-source.py` CLI - 인자는 `SOURCE_TGZ OUTPUT_TGZ MANIFEST_JSON`이다.
- `pressure.swift` - macOS 메모리 압력 상태를 JSON 줄로 출력한다.

### 원격 제출과 캠페인

- `[remote.ts:remotePilot]` - 인자는 `PHASE OUTPUT_ROOT SOURCE_REF_JSON DATA_REF_JSON_OR_- ORIGIN PRIVATE_CONTROL_JSON [CONCURRENCY]`다. `PHASE`는 `boundary`, `build`, `boundary-then-build`, `matrix`, `jemalloc-off`, `ccache-seed`, `ccache-cold`, `ccache-warm` 중 하나다.
- `remote.ts`가 읽는 환경 변수 - `DUCKDB_MATRIX_RUNTIME`, `DUCKDB_CACHE_CAMPAIGN`.
- `main-matrix.py` CLI - 인자는 `PILOT_ROOT ORIGIN CONTROL_JSON`이다. 3블록 x 5조건의 빌드 matrix를 순서대로 실행한다.
- `ccache-campaign.py` CLI - 인자는 `PILOT_ROOT ORIGIN SECRET_FILE`이다. 원격 ccache 묶음 6개를 실행한다.

### 비교와 보고

- `compare-memory.py` CLI - `--baseline DIR --actual DIR [--allow-memory-tuning]`. `[compare-memory.py:compare_runs]`
- `oracle.py` CLI - `--source DIR --actual FILE --sf --query N`. 종료 코드는 통과 0, 실패 1, 판정 불가 2다.
- `query_output.py` CLI - `--run DIR --queries Q1,Q2,..`. `[query_output.py:load_query_output]`
- `compare-build.mjs` CLI - 인자는 `LOCAL_RUN_DIR CLOUD_RESULT_JSON OUTPUT_DIR`이다. `[compare-build.mjs:expand]`, `[compare-build.mjs:summarize]`
- `report-ccache.mjs`, `report-matrix.py`, `summarize.py` - 결과 폴더를 읽어 요약 JSON과 Markdown을 쓴다.

## Invariants

- 실행 ID는 `/^[a-z0-9][a-z0-9-]{0,80}$/`와 일치해야 한다. 실행 폴더가 이미 있으면 실패한다. `pilot.ts`
- 측정 실행은 한 번에 하나다. `pilot.lock`을 배타적으로 만든다. `pilot.ts`
- `MEM_GIB`는 3·6·9, `SF`는 1·3·10·30, threads는 1-10이다. `[metrics.ts:validateMemoryOptions]`
- `memory-batch`의 동시 실행 수는 1·2·4다. query 샤드 분할은 고정이다. `[memory-batch.ts:validateMemoryBatch]`, `[memory-batch.ts:MEMORY_SHARDS]`
- 빌드 batch는 config 1-4개(중복 없음), jobs 1-10이다. 한 작업이 실패하면 나머지를 취소한다. `[batch.ts:validateBuildBatch]`, `[batch.ts:executeBatch]`
- source는 고정 commit과 고정 SHA-256의 archive만 받는다. 해제 상한은 2GiB, 100,000파일이다. `pilot.ts`, `normalize-source.py`
- 데이터셋 파일의 SHA-256은 실행 전후가 같아야 한다. `pilot.ts`
- 감시는 디스크 여유 3GiB 미만, 지속되는 critical 메모리 압력, 응답 지연, swap-out 속도 초과에서 실행을 중단한다. `[metrics.ts:Guard]`
- `supervise.py`의 시간 제한은 3,600초 이하다. 로그가 128MiB를 넘으면 프로세스 그룹을 종료한다. `supervise.py`
- 비교의 기준 실행은 concurrency 1이어야 한다. source commit, SF, threads, 데이터셋 해시, query 해시, 샤드, float 정책이 같아야 한다. `[compare-memory.py:compare_runs]`
- 메모리 값이 다른 비교는 `--allow-memory-tuning`과 같은 binary SHA-256이 있을 때만 허용한다. `[compare-memory.py:compare_runs]`
- 빈 query 출력은 샤드가 종료 코드 0으로 끝나고 profile의 반환 행이 0이며 query 해시가 실행 폴더의 `memory-batch-settings.json`에 기록된 `querySourceSha256`과 같을 때만 `[]`로 해석한다. `[query_output.py:load_query_output]`
- `oracle.py`는 SF1의 query 3, 9, 18, 21만 판정한다. 그 밖은 판정 불가로 반환한다. `oracle.py`
- `remote.ts`의 동시 실행 수는 `matrix`와 `jemalloc-off`에서만 `[CONCURRENCY]` 인자로 정하며 1·2·4다. ccache phase는 2이고 `boundary`, `build`, `boundary-then-build`는 인자를 무시하고 1이다. phase 폴더마다 `operator.lock`은 하나다. `[remote.ts:remotePilot]`
- `main-matrix.py`는 비용 상한 추정과 운영자 예비액의 합이 예산 이상이면 중단한다. manifest가 바뀌어도 중단한다. `main-matrix.py`
- ccache 캠페인은 `remote/`의 파일 바이트까지 `campaign.json`에 고정한다. 기존 캠페인 도중에는 `remote/README.md`를 포함한 입력을 바꾸지 않는다. `[ccache-campaign.py:plan]`

## Side Effects

- `pilot.ts prepare`는 DuckDB source와 pip wheel을 내려받고 venv에 `ninja`와 `cmake`를 설치한다. `prepare-local-ccache`는 ccache 릴리스를 내려받는다. `pilot.ts`, `[local-ccache.ts:prepareLocalCcache]`
- `pilot.ts`는 `ROOT` 아래에 source, 도구, 빌드, 데이터셋, 실행 결과를 쓴다. `cmake`, `ninja`, 테스트 바이너리, `duckdb`, `tar`, `ccache`, `swiftc`를 실행한다. `pilot.ts`
- `remote.ts`는 원격 origin의 `/health`, `/v1/snapshots`, `/v1/compute-groups` 경로를 호출하고 승인한다. 승인하면 `standard-4` Cloudflare 컨테이너가 실행되어 비용이 발생한다. `[remote.ts:remotePilot]`
- `main-matrix.py`와 `ccache-campaign.py`는 `pilot.ts`와 `remote.ts`를 자식 프로세스로 실행한다. 따라서 원격 비용이 발생한다. `main-matrix.py`, `ccache-campaign.py`
- `summarize.py`와 `compare-build.mjs`는 지정한 출력 폴더에 요약 파일을 쓴다. `report-matrix.py`와 `report-ccache.mjs`는 `ROOT` 아래 `main-matrix/`와 `ccache/` 폴더에 요약 파일을 쓰고, `REPORT` 인자가 있으면 그 경로에도 쓴다. `summarize.py`, `report-matrix.py`, `report-ccache.mjs`, `compare-build.mjs`

## Verification

- Run: `npm test` (`cloudflare/backend/`에서 실행. `node --test test/*.test.ts`)
- `remote.ts`, `main-matrix.py`, `ccache-campaign.py`와 실제 compile·query 실행은 테스트 명령에 포함하지 않는다. 운영자가 명시적으로 실행한다.
