# DuckDB P0 결과 — 로컬·원격 검증

2026-11-14. standard-4 및 대형 입력 전달 경로를 구현하고 로컬 DuckDB P0를 실행했다. **CPU 포화와 실제 메모리 압박·swap-out을 관측했다. 그러나 로컬 튜닝으로 압박을 크게 줄일 수 있었으므로, HIVEMIND의 우위나 깨끗한 32GiB 머신의 절대 메모리 한계를 입증한 결과는 아니다.**

사용자 승인 후 기존 Cloudflare 백엔드에 배포하고 standard-4 P0를 네 번 실행했다. R2 전달·복원·해시 검증은 확인했고, Linux 격리 검사를 통과해야 시작되는 빌드와 쿼리는 실행되지 않았다. 아래 로컬 P0 본문과 예산 제안은 원격 실행 전 기록이며, 이후 사용자가 재실행을 승인했고, 격리·빌드·테스트·Q9를 완료했다. 최신 결과는 문서 마지막에 있다.

## 구현 범위와 검증 상태

| 구현 | 현재 증거 |
|---|---|
| 일반 compute/workflow의 standard-4, compute group 1–4검사 | 계약·스케줄러·API 테스트 및 이미지 빌드 통과 |
| source/data 별도 입력 | 기존4MiB·1,000파일 snapshot 한도 유지. source archive 최대1GiB/확장2GiB, data 최대8GiB |
| R2 multipart | operator 인증,8MiB part,재개·완료·중단,동일digest 불변 등록. 로컬 service tests 통과; R2 실제 호출은 미검증 |
| 작업별 읽기 | job/attempt/digest/deadline에 한정한 만료 capability. provider·operator 토큰은 child에 전달하지 않음 |
| 런타임 무결성 | 전체 byte 길이·SHA 검증 후 실행, 실패·취소 시 partial 정리, 준비 시간을 작업 deadline에 포함 |
| 압축·파일 경계 | 경로 탈출·링크·장치·중복·PAX/gzip 폭탄 거부. native Codex sandbox의 입력 read/runtime deny 설정. macOS 실제 경계 probe 통과; Linux 원격 probe는 대기 |
| 큰 입력 기능 실증 | 같은 prepareLargeArtifacts 경로로 실제7.60GiB 파일과 source 검증. 로컬 fake-HTTP이므로 R2·Cloudflare 성능 증거와 구분 |

업로드 metadata의 SHA는 선언값이며, runtime 다운로드 검증 전에는 검증 완료로 표시하지 않는다. 잘못 등록된 digest-key 객체의 운영자 복구 도구는 아직 없다. 새 경로는 **compute 입력**을 위한 것이다. 대형 저장소의 AI 편집·delta 병합, 큰 출력 게시, 데이터·빌드 캐시의 지속 재사용은 별도 후속 범위다.

## 고정 입력과 환경

- DuckDB `v1.4.2`, commit `68d7555f68bd25c1a251ccca2e6338949c33986a`.
- 원본 archive98,406,187bytes, SHA `495fe47027a380fc37828dd04be65b2370f68b51872325c78cdeb54d1ec3a2a1`.
- 정규화 archive98,302,940bytes, SHA `2e1a219620dd1ca6bf055600417bdf9a1700e04c5c1ff41e4029752595137785`.
- CSV symlink fixture 두 개만 제외했다. 일반 파일14,010개의 내용·실행 비트는 사후 감사에서도 일치했다. 원본 전체 테스트 커버리지와 같다고 주장하지 않는다.
- 로컬 arm64·10 logical CPU·32GiB, Apple clang21, 격리 CMake3.31.6·Ninja1.13.0, 작업별 SDK26.5.
- Linux 이미지에는 Clang14·CMake3.25.1이 준비돼 있다. 원격 runner는 Clang을 명시하고 실제 toolchain을 기록한다. 아직 실행하지 않았으며 동일 컴파일러·OS·아키텍처의 순수 비교가 아니다.

## C: CPU와 빌드 동시성

성공한 단일 C1 세 번은 같은 구성의 fresh build다. 빌드·테스트 시간을 포함한다.

| 컴파일 동시성 J | 완료 시간 | 작업 트리 RSS 표본 피크 | CPU busy p95 | Node 응답 p95 | 새 swap-out |
|---:|---:|---:|---:|---:|---:|
| 2 | 504.895초 | 1.83GiB | 58.03% | 41.01ms | 0 |
| 8 | 161.608초 | 3.69GiB | 100% | 90.88ms | 0 |
| 10 | 144.706초 | 4.32GiB | 100% | 121.59ms | 0 |

J2→J8은 약3.12배 빨라졌고 J8→J10의 추가 시간 단축은 약10.5%였다. CPU 포화가 관측됐지만 이 단계의 메모리 압박은 정상이다. 각 실행의 projection16 test cases·1,410 assertions가 통과했다.

같은 네 구성(C1–C4)을 처리하는 작업 묶음도 비교했다.

| 동시 워커 × 워커별 J | 완료 시간 | RSS 표본 피크 | 메모리 warning 근사 구간 | 새 swap-out | 결과 |
|---|---:|---:|---:|---:|---|
| 2 × 5 | 1,003.786초 | 4.54GiB | 약64.5초 | 0.924GiB | 네 구성 통과 |
| 4 × 4 | 1,100.737초 | 5.17GiB | 약1,060.3초 | 0 | 네 구성 통과 |

관측 설정에서는 네 워커가 약9.7% 느렸다. 워커 수와 내부 J가 함께 다른 **운영 설정 비교**이며, 워커 수만의 인과 효과로 표현하지 않는다. 현재 로컬 C 후보는2×5다. 표본은 각1회여서 본실험에서 재확인해야 한다.

## M: 실제 데이터·22개 쿼리

SF1·3·10·30 데이터를 생성하고 네 쿼리 subset으로 크기를 확인한 뒤, 고정4샤드에서22쿼리를 각각 한 번 실행했다. 샤드마다 지속 CLI/connection과 private spill을 사용했다. 다음 표는 데이터가 준비된 상태이며, 새 프로세스·입력 해시·검증 비용을 포함한다.

SF30 파일은8,158,982,144bytes(약7.60GiB), SHA `bc49ea1aa6dc112aa79a27e5ca02fa802542cacd00943dc6f1dfc8148ffde8c0`다.

| 동시 워커 | 워커별 memory_limit | 전체 시간 | RSS 표본 피크 | 압박 | 새 swap-out | Node p95 |
|---:|---:|---:|---:|---|---:|---:|
| 1 | 6GiB | 36.786초 | 5.83GiB | normal | 0 | 56.86ms |
| 2 | 6GiB | 29.796초 | 8.19GiB | normal | 0 | 89.27ms |
| 4 | 6GiB | 33.804초 | 7.80GiB | normal/warning | **7.205GiB** | 185.81ms |
| 1 | 3GiB | 35.525초 | 4.77GiB | normal | 0 | 51.93ms |
| 2 | 3GiB | **27.681초** | 7.09GiB | normal | **0** | 99.75ms |
| 4 | 3GiB | 30.709초 | 6.61GiB | normal/warning | 0.222GiB | 301.26ms |

네 워커·6GiB는 순차보다 약8.1% 빨랐지만 큰 swap-out을 동반했다. 워커를2개로 줄이고 메모리를 조절하면 더 빠르고 압박이 적은 설정을 얻었다. 따라서 **무조건 많은 로컬 워커를 띄우는 것은 적절하지 않지만, 이 과제를 로컬에서 처리할 수 없다는 결론도 성립하지 않는다.**

각 조건의22쿼리 결과는 순서·스키마·값을 대조했다. INTEGER/DECIMAL은 정확 비교, FLOAT/DOUBLE은 고정된 상대1e-12·절대1e-8 허용오차를 사용했다. 6→3GiB는 별도 tuning 비교로 표시했다. 이는 같은 입력·binary 간 결과 동치이며 대형 SF의 독립 정답 인증은 아니다. SF1의Q3·9·18·21은 upstream 답안으로도 확인했다.

SF30 생성과 네 쿼리 preview는228.683초였고, 그중 생성202.228초다. 이 준비 구간의 새 swap-out2.237GiB는 위22쿼리 배치와 분리한다. 네 워커·6GiB 이후 회복 구간에도0.428GiB의 swap-out이 더 기록됐다. 커널의 지연된/다른 활동을 해당 쿼리에 모두 귀속하지 않는다.

## 실제 대형 입력 경로의 로컬 검증

source와 SF30 데이터의 정확한 크기·SHA, source14,010파일·260,659,090확장 bytes, 데이터 재읽기 SHA를 확인했다. 64KiB pull/HWM0 스트림으로 실행됐고,29.45초 후 고유 작업 복사본이 정리됐다. 원본은 유지했다. 외부 `time -l` 최대 RSS는114,638,848bytes(약109.3MiB)였으며 Node 자체 표본 최대는약108.2MiB였다.

**파일 기반 fake-HTTP를 사용했다.** 이 결과로 R2 실제 multipart, Cloudflare native sandbox, 원격 다운로드 시간이나 비용을 검증했다고 주장하지 않는다.

## 해석의 경계

최초10분 baseline에도 CPU busy p95 77.5%와 기존 memory warning이 있었고 후반에는 정상으로 회복했다. 첫 baseline 표본의 기존 swap 사용량 약26.35GiB(28.29GB)를 이 실험의 새 사용량으로 계산하지 않았다. 회복 구간과 새 swap-out을 따로 남겼다. 다른 앱·Docker VM·파일 캐시 등 머신 전체 상태가 완전히 통제된 실험은 아니다.

압박 상태는 `kern.memorystatus_vm_pressure_level`의1·2·4 값을 normal·warning·critical로 해석한 폴링 결과다. Apple XNU의 [sysctl 변환 코드](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_memorystatus_notify.c)와 [상태 상수](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/event_private.h)를 대조했다. Swift 로그에는 초기 상태만 있고 추가 callback은 관측되지 않았으므로 이벤트 통지와 폴링 증거를 혼동하지 않는다.

RSS는 공유 페이지를 중복 집계하거나 짧은 피크를 놓칠 수 있다. OS/파일 캐시를 포함한 전체 RAM 요구량과 같지 않다. wait4의 max RSS는 단일 프로세스 최대값이고, stage CPU초는 종료·회수된 자식을 포함한다. memory_limit은 프로세스 RSS의 확정 상한이 아니다. Node p95는 컨트롤러가 관측한 명령 응답이며, 메모리 배치의 동기 결과 검증도 영향을 줄 수 있어 순수 OS/IDE 지연으로 해석하지 않는다.

측정된 압박 상태에 critical이 없었고, 대상 프로세스의 OOM 종료도 관측되지 않았다. **CPU 포화는 확인했고, 현재 사용 환경에서 메모리 압박·페이징도 확인했다.** 다만 튜닝으로 완화됐고 각 설정은1회이므로, 깨끗한 M1 32GiB의 절대 용량 한계나 원격 우위를 주장할 단계는 아니다.

## 수정한 호환성·계측 문제

- SDK27.2의 libc++와 upstream Thrift iterator 충돌: SDK26.5를 작업별로 선택해 해결했다. 소스·전역 SDK 선택은 바꾸지 않았다. 첫359.712초 실패는 자원 실패가 아니다.
- SF1 Q18의 CSV `sum`/CLI `sum(l_quantity)` 별칭만 명시적으로 정규화했다. 값 검증은 유지했다.
- SF10 Q11의 정상0행 출력: 성공 stage·유효 schema·0행 profile·고정query SHA가 확인된 경우만 빈 JSON을0행으로 인정했다. 기존 실패 기록은 보존했다.
- runtime manifest가 Python extractor도 포함하도록 수정했다.
- 최종 검사에서 기존 Ralph 테스트의3초 관측 상한과8초 runtime 예산 불일치를 확인했다. 3.5초 응답 지연으로 재현하고 관측을같은8초 공통deadline에 맞췄다. Production 예산·assertion은 유지했다.

## 다음 본실험 제안과 비용

**우선 C를 조건부15묶음으로 제안한다.** 로컬2×5·4×4, Cloudflare 동시1·2·4(각J4)의 다섯 조건을각3회 실행한다. 작업 범위는 동일한 네 빌드 구성이다. 로컬6묶음의 작업 시간은 현재 P0로 약105분이며 준비·회복·편차는 별도다. 반복으로 로컬 최선 조건을 재확인하고, 원격은 순차 대비 병렬 이득과 로컬 최선 대비 차이를 함께 평가한다.

M은2워커·3/6GiB를 로컬 기준 후보로 유지한다. 작업 전체가 약28–37초라 원격 시작·7.60GiB 입력 복원이 납기 이득을 상쇄할 수 있다. 원격 P0에서 전달/해시/실행 구간을 먼저 분리하고, 준비된 binary·데이터 재사용 경로와 동일 입력 상태를 확보한 뒤 반복 규모를 확정한다. 현재 cold 입력 경로만으로 warm-memory 본실험 준비가 끝났다고 표현하지 않는다.

standard-4의4vCPU·12GiB·20GB를 모두 사용하는 상한 환산은 `4×0.000020 + 12×0.0000025 + 20×0.00000007 = $0.0001114/초`, 시간당약$0.40104다. CPU는 실제 활성 사용량, 메모리·디스크는 할당량으로 과금된다. [Containers 공식 요율](https://developers.cloudflare.com/containers/platform/pricing/)

C의 원격9묶음은36개 빌드와9개 최종 집계 작업이다. 아래는 **실측 예측이 아니라 시간 가정별 사용량 환산**이며 무료 포함량 차감 전이다. 집계는 각각15분의 제안 상한으로 계산했다.

| 원격 빌드당 가정 시간 |36개 빌드+9개 집계의 컨테이너 환산 |
|---|---:|
|10분 | $3.31 |
|20분 | $5.71 |
|40분 | $10.53 |
|60분 작업시간 가정 | $15.34 |

컨테이너 시작·종료 대기나 실패 정리로 추가되는 생존 시간은 위 표에 포함하지 않았다. 작업 timeout을 청구의 확정 상한으로 해석하지 않는다.

source+SF30 약8.26GB를30일 저장하는 R2 Standard 사용량 환산은약$0.124다. 실제 요금은 계정 전체 포함량과 청구 단위 반올림에 달린다. Class A는백만 요청 단위$4.50이므로 단순 요청 비례액을 최종 청구라고 쓰지 않는다. R2 egress는무료지만 Worker·Durable Object·이미지·컨테이너 egress·실패/재시도는 별도로 집계해야 한다. [R2 공식 요율·청구 단위](https://developers.cloudflare.com/r2/pricing/)

기존 제안인 P0 $5·본실험 $30은 추정 중단 기준 후보로 남긴다. R2 포함량과 원격 P0 실측을 확인해 확정해야 하며, 최종 청구 상한이나 승인 완료 금액이 아니다. 이번에는 Cloudflare/R2 유료 실행을 하지 않았으므로 원격 실측 비용은 없다. 로컬 전력·장비 비용은 미계측이다.

## 남은 원격 gate

1. 기존 backend 배포 및 P0 $5 범위 승인 확인.
2. 실제 R2 multipart와 Linux source/data read-only·private runtime/proc alias 경계 확인.
3. standard-4 C1·J4 빌드/16테스트, 실제 toolchain·리소스·입력 준비 시간 확인.
4. 동일 데이터의 query9 결과·해시 대조, 종료·비용 집계 확인.
5. 본실험용 네 구성 runner/공통 검사 목록·skip·image/source/data 해시·예산 동결. 본실험은 별도 승인 후 실행.

AWS와 대형 저장소 AI 편집·랄프 효율 검증은 후속이다. 이번 결과는 compute 빌드·SQL 작업의 P0다.

## 근거

- [정제된 실행·비교·전달 근거](duckdb-pilot-2026-11-14/summary.json)
- [전체 계측 표](duckdb-pilot-2026-11-14/tables.md)
- 원자료: `.hivemind/duckdb-pilot/`의 runs, source/normalization/environment, local-large-proof와 검사 로그.
- 최종검사: `npm run check`149개, backend257개·타입 검사·runtime manifest 검사 통과. source 원래 일반 파일14,010개의 내용·실행 비트가 사후에도 일치했다.

## 승인 후 원격 P0 결과

마지막 배포 Worker 버전은 `737ded8c-6034-4af6-a546-4d5a7ff6ec32`, 런타임 digest는 `f976d9b39179e92f61e34f4e2da871e53a6d0dbc134a59705ed7587746f2e5cb`다. 기존 R2에 정규화 소스 98,302,940바이트와 SF30 데이터 8,158,982,144바이트를 등록했다. 최초 등록부터 전체 업로드 완료까지 28분 52초가 걸렸다. SF30은 973개 조각으로 업로드했다. 재시도는 같은 R2 객체를 사용했다.

| 작업 | 승인→종료 | 다운로드·해시·추출 | 결과 |
|---|---:|---:|---|
| 1 | 495.304초 | 420.220초 | SHA·크기 확인. 차단한 runtime 디렉터리 내부의 작업 홈에서 sandbox 실행 파일 실행 거부 |
| 2 | 448.713초 | 373.472초 | SHA·크기 확인. Codex의 /tmp 아래 helper 생성 제한 확인 |
| 3 | 606.803초 | 미완료 | 컨테이너 일반 홈에 별도 작업 홈을 두고 재배포. 10분 작업 제한에서 입력 준비 시간 초과 |
| 4 | 523.129초 | 513.509초 | SHA·크기 확인. sandbox 안의 검사 스크립트가 시작됐으나 검사 도중 예외로 종료 |

완료된 입력 준비에서 소스 14,010개 파일과 260,659,090바이트의 확장량이 일치했다. Linux capability 제거와 no-new-privileges도 확인했다. 네 번째 작업은 동일 컨테이너에서 경계 검사를 통과하면 빌드하는 방식으로 실행했다. 검사기의 일반화된 오류 때문에 실패한 경로와 errno는 확정할 수 없다. 후속 실행에서 민감한 경로나 값을 출력하지 않고 검사 단계와 제한된 오류 코드만 기록하도록 보완했다. 입력 쓰기·삭제 및 비공개 경로 격리 검증은 미완료다.

동일 C1과 동시성 4의 로컬 빌드는 테스트 포함 274.196초, 컴파일·링크 구간 266.653초였다. 동일 SF30, 4스레드, memory_limit 6GiB의 로컬 Q9 명령은 6.337초였다. 원격에서는 빌드와 Q9를 시작하지 않았으므로 속도와 SQL 결과의 플랫폼 간 대조는 미완료다. 관측된 원격 입력 준비 시간은 373.472–513.509초로, 이번 로컬 빌드 전체 시간보다 길었다.

네 작업 모두 종료되고 컨테이너 정지가 확인됐다. Cloudflare Analytics 4/4 작업의 컨테이너 사용량 환산은 총 **$0.07201**이다. 무료 포함량 차감 전 환산이며 R2·Workers·Durable Objects·이미지 저장은 별도다. 우선 로컬 업로드 전 이번 달 계정 전체 R2 요청량 약 6,469건을 확인했다. 최종 계정 청구액은 확인하지 않았다. [Containers 요율](https://developers.cloudflare.com/containers/platform/pricing/) · [R2 계측](https://developers.cloudflare.com/r2/platform/metrics-analytics/)

승인된 네 작업을 모두 사용했다. 제안한 15묶음의 본실험은 Linux 격리 검사와 원격 빌드·쿼리 검증에 계속 의존한다. 원자료는 `.hivemind/duckdb-pilot/remote-live*` 및 `p0-accounting/observed-usage.json`에 있다.

## Linux 격리 수정과 원격 재검증

수정 런타임은 `11e80d17ddbef0efc287fe3344db8508f59d7d22fbf6a86abdbcb366193f2a3d`이며 Worker 버전은 `0e6a6b9c-ed35-4b8f-860c-5a3d90d942ec`다. 작은 소스로 이전 런타임의 첫 소스 읽기에서 EACCES를 재현했다. Linux sandbox의 상위 /runtime 차단 범위에 입력 디렉터리도 있었기 때문이다. 검증된 입력을 별도 디렉터리에 준비해 읽기 전용으로 열고 작업 종료 후 정리했다. /runtime 차단과 capability 제거 및 no-new-privileges를 유지했다.

작은 입력 경계 검사가 통과했다. 전체 SF30에서도 소스·데이터 쓰기와 삭제는 EROFS, /runtime/input.json 및 /proc/self/root 별칭을 통한 읽기는 EACCES로 차단됐다. 원격 빌드가 통과한 첫 실행에서는 테스트 초기화가 인자 해석 전에 현재 디렉터리에 임시 폴더를 만들면서 목록 수집이 실패했다. 테스트 시작 위치를 쓰기 가능한 scratch로 바꾸고 원래 읽기 전용 소스를 --test-dir에 지정해 재실행했다.

| 항목 | 로컬 M1 | Cloudflare standard-4 |
|---|---:|---:|
| C1 컴파일·링크, 동시성 4 | 266.653초 | 556.385초 |
| Projection 테스트 | 16개 통과, 1.444초 | 16개 통과, 2.454초 |
| SF30 Q9 명령, 4스레드·6GiB | 6.337초 | 7.723초 |
| SF30 Q9 결과 | 175행 | 175행, 로컬과 원문 SHA-256 일치 |

원격 입력 복원·해시 확인은 473.748초, 승인부터 통합 종료까지는 1,081.789초였다. 기존 R2 객체를 재사용했다. 로컬은 Apple Clang 21과 SDK 26.5, 원격은 Debian Clang 14.0.6이다. 원격과 로컬의 테스트 목록 해시는 달랐다. 실행 수와 통과 상태를 대조했으며, 목록 순서 차이인지는 확인할 원문이 없다. 이 비교는 단일 standard-4 작업에 대한 P0다.

이번 재검증의 컨테이너 Analytics는 6개 중 4개에 대해 $0.16211을 보고했다. 두 집계 컨테이너의 사용량은 아직 조회되지 않았다. 두 집계의 생성부터 종료까지 약 14.9초를 4vCPU 전부 사용으로 환산하면 약 $0.00166이다. R2·Worker·Durable Object 및 이미지 비용과 실제 계정 청구액은 별도다. 작업과 집계 컨테이너는 모두 정지했다. [Containers 요율](https://developers.cloudflare.com/containers/platform/pricing/)

성공 작업 ID는 `e89ca2f9-2580-45e1-a34b-ebb99c9298d9`다. 원자료는 `.hivemind/duckdb-pilot/p0-retry-test-cwd/build/result.json`, 비용 자료는 `.hivemind/duckdb-pilot/p0-retry-accounting/observed-usage.json`에 있다.
