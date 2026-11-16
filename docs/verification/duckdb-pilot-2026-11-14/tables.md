# DuckDB P0 계측 요약

단일 preview·준비 포함 실행과 22쿼리 배치는 서로 다른 작업이다. CPU·압박 관측으로 실패 원인을 자동 추정하지 않는다.

## 기준선·회복

| ID | 상태 | 전체초 | stage CPU초 | gen초 | 핵심단계 union초 | tree RSS GiB | wait4 max GiB | normal/warn/critical 근사초 | 새 swap-out GiB | Node p95 ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline-01 | SUCCEEDED | 600.395 | missing | not-run | not-run | 0.000 | missing | 319.720/280.675/0.000 | 0.000 | 62.259 |
| recovery-before-c4 | SUCCEEDED | 120.787 | missing | not-run | not-run | 0.000 | missing | 120.787/0.000/0.000 | 0.000 | 52.306 |
| recovery-before-memory | SUCCEEDED | 120.886 | missing | not-run | not-run | 0.000 | missing | 120.886/0.000/0.000 | 0.000 | 51.234 |
| recovery-after-sf30-c4 | SUCCEEDED | 120.272 | missing | not-run | not-run | 0.000 | missing | 120.272/0.000/0.000 | 0.428 | 47.032 |
| recovery-before-memory-tuning | SUCCEEDED | 61.213 | missing | not-run | not-run | 0.000 | missing | 61.213/0.000/0.000 | 0.000 | 48.324 |

## C++ 단일·batch

| ID | 상태 | 전체초 | stage CPU초 | gen초 | 핵심단계 union초 | tree RSS GiB | wait4 max GiB | normal/warn/critical 근사초 | 새 swap-out GiB | Node p95 ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| c1-j2 | FAILED | 359.712 | 701.403 | not-run | 353.797 | 1.867 | 0.934 | 359.712/0.000/0.000 | 0.000 | 34.264 |
| c1-j2-sdk265 | SUCCEEDED | 504.895 | 983.008 | not-run | 496.908 | 1.832 | 0.944 | 504.895/0.000/0.000 | 0.000 | 41.013 |
| c1-j8-sdk265 | SUCCEEDED | 161.608 | 1112.259 | not-run | 154.195 | 3.692 | 0.860 | 161.608/0.000/0.000 | 0.000 | 90.882 |
| c1-j10-sdk265 | SUCCEEDED | 144.706 | 1171.939 | not-run | 137.410 | 4.317 | 0.866 | 142.053/0.000/0.000 | 0.000 | 121.588 |
| batch-c2-j5-sdk265 | SUCCEEDED | 1003.786 | 8396.692 | not-run | 993.087 | 4.535 | 0.911 | 926.562/64.455/0.000 | 0.924 | 118.084 |
| batch-c4-j4-sdk265 | SUCCEEDED | 1100.737 | 8509.439 | not-run | 1093.583 | 5.169 | 0.690 | 36.728/1060.266/0.000 | 0.000 | 88.646 |

## 메모리 subset preview

| ID | 상태 | 전체초 | stage CPU초 | gen초 | 핵심단계 union초 | tree RSS GiB | wait4 max GiB | normal/warn/critical 근사초 | 새 swap-out GiB | Node p95 ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| sf1-reference | SUCCEEDED | 10.419 | 11.926 | 8.317 | 1.072 | 0.687 | 0.673 | 10.419/0.000/0.000 | 0.000 | 36.858 |
| sf3-single | SUCCEEDED | 25.023 | 35.355 | 20.297 | 1.841 | 1.177 | 1.168 | 25.023/0.000/0.000 | 0.000 | 34.558 |
| sf10-single | SUCCEEDED | 75.098 | 120.410 | 66.436 | 2.999 | 3.148 | 3.142 | 75.098/0.000/0.000 | 0.000 | 42.356 |
| sf30-single | SUCCEEDED | 228.683 | 366.922 | 202.228 | 9.982 | 5.181 | 5.795 | 89.902/138.781/0.000 | 2.237 | 46.023 |

## 고정 22쿼리 batch

| ID | 상태 | 전체초 | stage CPU초 | gen초 | 핵심단계 union초 | tree RSS GiB | wait4 max GiB | normal/warn/critical 근사초 | 새 swap-out GiB | Node p95 ms |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| sf1-batch-c1 | SUCCEEDED | 3.136 | 2.487 | not-run | 1.437 | 0.230 | 0.282 | 3.136/0.000/0.000 | 0.000 | 38.762 |
| sf1-batch-c4 | SUCCEEDED | 2.075 | 2.833 | not-run | 0.591 | 0.000 | 0.284 | 2.075/0.000/0.000 | 0.000 | 28.418 |
| sf10-batch-c1 | STOPPED | 5.225 | 7.906 | not-run | 2.321 | 2.036 | 2.038 | 5.225/0.000/0.000 | 0.000 | 34.311 |
| sf10-batch-c1-v2 | SUCCEEDED | 12.554 | 24.861 | not-run | 7.611 | 1.863 | 1.923 | 12.554/0.000/0.000 | 0.000 | 41.442 |
| sf10-batch-c4-v2 | SUCCEEDED | 9.978 | 30.313 | not-run | 5.145 | 5.216 | 1.986 | 9.978/0.000/0.000 | 0.000 | 229.157 |
| sf30-batch-c1-m6 | SUCCEEDED | 36.786 | 78.879 | not-run | 24.526 | 5.833 | 5.825 | 36.786/0.000/0.000 | 0.000 | 56.856 |
| sf30-batch-c4-m6 | SUCCEEDED | 33.804 | 117.522 | not-run | 23.404 | 7.802 | 4.969 | 14.793/19.011/0.000 | 7.205 | 185.807 |
| sf30-batch-c2-m6 | SUCCEEDED | 29.796 | 84.647 | not-run | 17.138 | 8.188 | 5.974 | 29.796/0.000/0.000 | 0.000 | 89.272 |
| sf30-batch-c1-m3 | SUCCEEDED | 35.525 | 78.281 | not-run | 22.999 | 4.768 | 4.773 | 35.525/0.000/0.000 | 0.000 | 51.933 |
| sf30-batch-c4-m3 | SUCCEEDED | 30.709 | 110.657 | not-run | 19.262 | 6.609 | 3.331 | 17.676/13.033/0.000 | 0.222 | 301.263 |
| sf30-batch-c2-m3 | SUCCEEDED | 27.681 | 85.789 | not-run | 16.630 | 7.095 | 4.451 | 27.681/0.000/0.000 | 0.000 | 99.745 |

## 결과 동치 대조

| 근거 ID | 종류 | SF | memory 기준→실행 | 동시성 기준→실행 | 일치쿼리 | 상태 |
|---|---|---:|---|---|---:|---|
| sf1-batch-compare.json | same-input-query-equivalence-not-independent-oracle | 1.000 | 6.000→6.000 | 1.000→4.000 | 22 | passed |
| sf1-batch.shared-output-policy.json | same-input-query-equivalence-not-independent-oracle | 1.000 | 6.000→6.000 | 1.000→4.000 | 22 | passed |
| sf10-batch-v2-compare.json | same-input-query-equivalence-not-independent-oracle | 10.000 | 6.000→6.000 | 1.000→4.000 | 22 | passed |
| sf30-batch-c2-m3-compare.json | same-input-query-equivalence-not-independent-oracle | 30.000 | 3.000→3.000 | 1.000→2.000 | 22 | passed |
| sf30-batch-c2-m6-compare.json | same-input-query-equivalence-not-independent-oracle | 30.000 | 6.000→6.000 | 1.000→2.000 | 22 | passed |
| sf30-batch-m3-compare.json | same-input-query-equivalence-not-independent-oracle | 30.000 | 3.000→3.000 | 1.000→4.000 | 22 | passed |
| sf30-batch-m6-compare.json | same-input-query-equivalence-not-independent-oracle | 30.000 | 6.000→6.000 | 1.000→4.000 | 22 | passed |
| sf30-memory-tuning-quality.json | cross-memory-tuning-query-equivalence | 30.000 | 6.000→3.000 | 1.000→1.000 | 22 | passed |

## 로컬 아티팩트 경로 검증

| ID | 성공 | 초 | 데이터 bytes | Node RSS peak bytes | Cloudflare/R2 검증 |
|---|---|---:|---:|---:|---|
| local-proof-vHA80I | True | 29.450 | 8158982144.000 | 113475584.000 | false |

## 실패와 계측 누락

- c1-j2: execution-or-harness-failure-not-attributed-to-resources; missing=none
- sf10-batch-c1: execution-or-harness-failure-not-attributed-to-resources; missing=none

## 해석 범위

- Preview memory runs may include dataset generation and four-query previews; do not compare them directly with the 22-query batch.
- Stage CPU uses wait4 for the root and reaped descendants. Hashing and controller validation outside stages are not included; terminated or detached descendants may be omitted.
- Sampled tree RSS can double-count shared pages. wait4 RSS is a maximum process value, not concurrent tree or host memory.
- Pressure durations approximate host sample intervals, clipped to the run; gaps over five seconds are unobserved.
- Swap-out is the new counter delta; old swap use and recovery deltas are separate. Background apps remain present.
- Node/Git probes are proxies, not IDE interaction latency. Parent hashing and validation can influence them.
- Failed SDK builds and output-parser failures are execution/harness evidence, not automatically resource-limit evidence.
- Cross-run SQL equivalence is not an independent upstream oracle. Missing comparisons remain missing; multiple comparison documents may cover the same execution.
- Core phase means compile/link for builds, query process for previews, and persistent shard process for 22-query batches. Absent phases are not-run, not zero.
- Local HTTP artifact proofs do not establish Cloudflare or R2 behavior. Their process-only resource figures are not whole-machine totals.
