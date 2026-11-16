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
