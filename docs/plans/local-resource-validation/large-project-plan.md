# 대형 프로젝트 자원 한계 실측 계획

P0 후속(2026-11-14): [로컬 실측·구현·원격 대기 현황](../../verification/2026-11-14-duckdb-pilot.md)을 기록했다. 본실험은 아래 원안에서 C 15묶음의 조건부 제안으로 축소하고 M은 원격 입력 복원·재사용 gate 뒤에 확정한다. 실제 본실험은 미실행이다.

2026-11-14 설계. 이번 작업에서는 실험·모델 호출·클라우드 배포를 실행하지 않았다. README 의도 섹션의 별도 커밋·푸시는 완료했다. 아래 수치·예산·시간 한도는 다음 실행을 위한 제안이다.

## 1. 선택과 검증할 주장

**1차 프로젝트는 DuckDB의 C++ 엔진 빌드와 회귀 검증으로 정한다.** 고정 기준은 `duckdb/duckdb`의 `v1.4.2`, commit `68d7555f68bd25c1a251ccca2e6338949c33986a`다. 태그를 원격 조회해 확인했다. 최신 버전이라는 뜻이 아니라 반복 비교의 고정 기준이다. 실행 시 태그를 다시 해석하지 않고 commit과 소스 archive SHA-256으로 확인한다. archive 해시는 사전 준비에서 확정한다.

이전 RealWorld 실측의 로컬 작업 RSS 피크는 약 1.64 GiB였다. 이번에는 실제 C++ 컴파일·링크와 데이터베이스 회귀 검증으로 작업 규모를 높인다. 다만 **아직 이 프로젝트가 M1 32GB의 메모리 한계를 드러낸다는 실측은 없다.** 사전 측정에서 CPU·메모리 적합성을 각각 판정한 뒤 본실험에 진입한다. 결과가 불리하다고 규모나 성공 기준을 바꾸지 않는다.

| 후보 | 평가 | 이번 선택 |
|---|---|---|
| DuckDB | C++ 빌드, assertion·unity 구성, SQL 수용 검사와 실제 분석 쿼리로 CPU·메모리 원인을 나눌 수 있음 | 주 대상. 먼저 소스 빌드·CI 작업, 메모리는 별도 회귀 부하 |
| LLVM/Clang | 직접적인 대형 개발 빌드 대상. 병렬 compile/link 조절 가능하나 공식 문서의 full debug 빌드 예시는 디스크 15–20GB 수준 | DuckDB가 적합성 기준을 못 채울 때 검토할 예비 후보. Cloudflare 디스크 여유부터 확인 |
| VS Code | 실제 대형 앱이지만 Electron·네이티브 모듈·OS별 빌드 및 GUI 테스트의 영향이 섞임 | 첫 자원 실험에서는 제외 |

DuckDB는 unity를 끄면 include 오류 탐지에 도움이 된다고 설명한다. 아래 네 구성은 동일 빌드를 의미 없이 네 번 복제하는 대신, 서로 다른 컴파일·assertion 검증 범위를 갖게 하려는 실험 설계다. [1.4 빌드 설정](https://duckdb.org/docs/1.4/dev/building/build_configuration) · [고정 CMake 소스](https://github.com/duckdb/duckdb/blob/68d7555f68bd25c1a251ccca2e6338949c33986a/CMakeLists.txt)

## 2. 고정 작업 두 종류

### C: C++ 개발 빌드·검증 묶음

같은 commit에서 아래 네 구성을 각각 빌드하고, 같은 사전 확정 SQL·C++ 회귀 목록을 검사한다. 하나의 완료 단위는 **네 구성 모두 통과 + 결과 목록의 누락·중복 검사 + 공통 SQL smoke 결과 일치**다. 최종 통합을 위해 불필요한 다섯 번째 전체 빌드를 추가하지 않는다.

| 작업 | CMAKE_BUILD_TYPE | DISABLE_UNITY | FORCE_ASSERT |
|---|---|---|---|
| C1 | Release | OFF | OFF |
| C2 | Release | OFF | ON |
| C3 | Release | ON | OFF |
| C4 | Release | ON | ON |

공통으로 `ENABLE_SANITIZER=OFF`, `ENABLE_UBSAN=OFF`를 명시한다. sanitizer 지원 차이는 별도 실험으로 남긴다. `BUILD_UNITTESTS=ON`, `BUILD_SHELL=ON`과 필요한 in-tree extension만 허용한다. tpch 등 extension 목록과 실제 생성된 CMakeCache를 pilot에서 고정한다. 네 구성은 네 개의 독립 build 디렉터리를 사용한다. 소스 archive와 도구 설치는 공유 가능한 한 번의 준비로 처리한다.

후보 명령 형태는 `cmake -S SOURCE -B BUILD -G Ninja ...` → `cmake --build BUILD --parallel J` → 해당 `unittest` 실행이다. 옵션 정의는 고정 source에서 확인했지만 이 문서의 전체 조합을 빌드해 검증한 것은 아니다. 실행 전 configure/build/테스트 목록 검증을 통과해야 한다. [고정 Makefile](https://github.com/duckdb/duckdb/blob/68d7555f68bd25c1a251ccca2e6338949c33986a/Makefile)

### M: 메모리 중심 SQL 회귀 묶음

C가 CPU 한계만 드러낼 수 있으므로 메모리는 별도 계열로 평가한다. 고정 버전의 tpch 생성기로 만든 데이터와 공식 22개 쿼리를 사용한다. 규모 후보는 SF 1 → 3 → 10 → 30이다. 같은 데이터베이스 파일을 양쪽에 제공하고 SHA-256을 대조한다. SF 숫자나 디스크 크기를 RAM 요구량으로 해석하지 않는다.

22개 쿼리를 pilot의 시간·RSS에 따라 네 개의 **서로 겹치지 않는** 묶음으로 고정한다. 각 쿼리는 목표당 한 번만 실행한다. 각 프로세스는 DB를 읽기 전용으로 열고 자신의 spill 디렉터리를 쓴다. 로컬은 DB·검증된 실행 파일을 공유할 수 있다. 원격은 동일한 파일을 워커에 복원한다. 각 쿼리 묶음마다 엔진을 다시 빌드하지 않는다.

쿼리는 JOIN·GROUP BY·ORDER BY 등 실제 회귀 작업을 그대로 사용한다. 메모리 채우기 프로세스나 인위적 Cartesian product를 추가하지 않는다. `memory_limit`은 기본 80% 같은 상대값을 피하고 양쪽에 같은 절대값을 사용한다. pilot 후보는 6GiB, 필요하면 9GiB이며 실제 RSS를 따로 측정한다. 이 설정은 프로세스 전체 RSS의 확정 상한이 아니다. 실제 spill 크기와 I/O도 기록한다. [공식 메모리·스레드 튜닝 설명](https://duckdb.org/docs/1.4/guides/performance/how_to_tune_workloads)

큰 SF의 정답은 소형 SF용 내장 답안을 잘못 재사용하지 않는다. 고정된 기준 release의 단일 실행을 두 번 수행해 참조 결과를 만들고 양쪽 결과와 비교한다. 정수·DECIMAL은 정확히 비교하고 부동소수점은 사전 확정한 절대·상대 오차와 정렬 규칙을 적용한다. 참조도 같은 구현이라는 한계 때문에 원래 회귀 테스트를 함께 유지한다. 공식 TPC 인증 점수로 표현하지 않는다. [TPC-H extension과 답안 범위](https://duckdb.org/docs/2.0/core_extensions/tpch) · [sqllogictest](https://duckdb.org/docs/2.0/dev/sqllogictest/intro)

M은 엔진 회귀·성능 검증의 분산 가능성을 평가한다. M만 빨라졌다고 AI 기능 구현 전체가 빨라졌다고 주장하지 않는다.

## 3. P0: 적합성과 규모를 먼저 확정

1. 로컬 기준 상태를 10분 측정한다. 기존 swap 누적량과 이번 swap-out 증가를 구분한다. 다른 앱을 강제 종료하지 않는다. 사전·사후 짧은 기준 측정으로 배경 부하 변화를 확인한다. 전원 연결·저전력 모드·온도/열 제한 신호를 기록하고, 반복 사이 회복 기준을 고정한다. 시스템 설정은 임의로 변경하지 않는다.
2. 소스·도구·회귀 목록을 동결하고 각 C 구성을 한 번 검사한다. 로컬 단일 작업의 내부 병렬도 J=2·4·8·10을 대표 구성에서 탐색한다. 후보 전체에 대해 고른 설정도 확인한다. 튜닝 시간은 본실험과 분리해 기록한다.
3. C의 로컬 동시성 1→2→4에서 자원과 응답성을 관측한다. 워커 수와 내부 J를 구분한다. J=4 고정 행렬 외에 총 컴파일 동시성을 약 8–10으로 제한한 로컬 후보도 평가해, **응답성 한도 안에서 가장 빠른 로컬 기준**을 선택한다.
4. M은 작은 SF부터 증가시킨다. 한 작업이 원격 12GiB 안에 안전하게 들어가고 네 작업을 함께 수행할 때 로컬 자원 압박이 나타나는 가장 작은 SF·쿼리 분할을 선택한다. 데이터와 temp 파일의 디스크 적합성도 먼저 확인한다.
5. Cloudflare 단일 워커에서 같은 입력의 정답과 파일·프로세스·인증 경계, CPU·메모리·디스크 한도를 확인한다. 단일 작업이 자체적으로 실패하면 병렬 비교로 진행하지 않는다.
6. 선택한 설정·테스트 목록·정답·해시·시드·예산을 잠근 후 본실험을 시작한다. pilot에서 유리한 시간만 골라 본표본에 넣지 않는다.

**CPU 적합성 제안 기준:** 실제 workload 프로세스 트리의 CPU 수요와 호스트 busy가 함께 높고, 60초 이상 호스트 CPU busy 90% 또는 로컬 동시성 증가 시 처리량 포화가 확인되는 경우다. 배경 앱이 원인이면 workload의 CPU초와 구분한다. 처리량 포화만으로 CPU 한계라 부르지 않고 disk I/O·spill·네트워크 대기도 대조한다.

**메모리 한계 증거:** 작업 증가와 함께 macOS memory-pressure warning/critical, 새로운 swap-out·압축 증가, 응답성 악화가 관측되고, 병렬도를 낮추거나 작업을 원격으로 옮겼을 때 완화되는 경우다. 단순 RSS 합계 32GB 초과, 이미 존재하던 swap, `memory_pressure -Q`의 가용률만으로 판정하지 않는다. 경고가 없으면 CPU 결과만 보고하고 메모리 가설은 미검증으로 남긴다.

Cloudflare에 들어가는 최대 자연 작업에서도 메모리 압박을 관측하지 못하면 **DuckDB의 메모리 실험 적합성 탈락**으로 기록한다. 메모리 filler를 넣거나 결과를 본 뒤 기준을 낮추지 않는다. LLVM의 제한된 Release 빌드 적합성을 다음 후보로 점검하며, 이것도 디스크·작업당 메모리 경계를 통과하지 못하면 Cloudflare의 현재 제약으로 분류한다. AWS로 자동 전환하지 않는다.

## 4. 비교 행렬

| 계열 | 기본 조건 | 반복 | 기본 실행 수 |
|---|---|---:|---:|
| C | 로컬 동시 1·2·4, Cloudflare 동시 1·2·4; J=4 공통 | 각 3회 | 18개 묶음 |
| M | 로컬 동시 1·2·4, Cloudflare 동시 1·2·4; threads=4·같은 memory_limit | 각 3회 | 18개 묶음 |

P0에서 찾은 최선의 로컬 설정이 기본 행렬에 없으면 계열당 3회를 추가한다. 따라서 steady-state 본비교는 최대 42개 묶음이다. cold 경로 4회와 pilot·튜닝 실행은 별도 수량으로 예산에 포함한다. M이 적합성 gate를 통과하지 못하면 실행 수를 채우기 위해 M을 강행하지 않는다.

각 3개 블록에서 여섯 조건을 고정 시드 `20261115`로 섞는다. 동시에 다른 비교 조건을 실행하지 않는다. 세 반복이 모두 통과한 조건의 중앙값·범위·처리량·완주율을 제시한다. 실패·중단 비용과 제한 시간 내 완주율을 먼저 공개하고, 실패를 빠른 성공으로 세지 않는다. 차이가 10% 이내이거나 경계에 걸리면 추가 반복 여부를 판단한다.

C의 주 비교는 빈 build 출력·비활성 compiler cache다. 도구 설치·소스 준비는 미리 완료한다. M의 주 비교는 데이터가 로컬 디스크에 준비된 상태이며 프로세스는 새로 시작한다. OS page cache는 통제하지 못한 부분을 표시하고 동일 warm-up 정책을 적용한다. 캐시 재사용·incremental 개발은 별도 후속 조건이다.

**운영 총시간도 별도 보고한다.** 첫 소스·이미지·데이터 업로드/다운로드, 컨테이너 기동, 모든 검증, 결과 회수까지 포함한 cold 경로를 각 환경에서 별도 1회 기록한다. steady-state 결과에 cold 준비비용을 숨기거나 같은 준비비용을 매 작업에 중복 부과하지 않는다. 이미지·dataset 준비비의 손익분기 반복 횟수를 함께 계산한다.

## 5. 자원 설정과 현재 구현의 차이

Cloudflare 목표는 **standard-4: 4 vCPU·12GiB·20GB/워커**다. 4워커면 합계 16 vCPU·48GiB다. M1 10개 논리 CPU·32GiB보다 많은 원격 자원을 사용하는 비용과 효과를 비교하는 것이며, 동일 하드웨어 효율 비교라고 표현하지 않는다. 로컬 arm64/macOS와 원격 amd64/Linux 차이도 남는다. 가능하면 같은 LLVM Clang 정확한 버전을 사용하고, 불가능하면 버전 차이를 confound로 표시한다. CMake·Ninja·소스·옵션을 맞추고 실제 버전·타깃·표준 라이브러리를 기록한다. x86 에뮬레이션을 로컬 주 기준으로 삼지 않는다. [Cloudflare 공식 한도](https://developers.cloudflare.com/containers/platform/limits/)

현재 구현을 그대로 실행할 수 있는 계획은 아니다. 먼저 다음 준비가 필요하다.

- **standard-4 허용:** 현재 compute-group은 standard-1·3만 받는다. 중앙 계약·스케줄러·runtime·검증·문서를 함께 확장한다. 전역 compute 상한 4는 유지한다.
- **대형 소스 경로:** 현재 4MiB·1,000파일 snapshot에 전체 저장소를 억지로 넣지 않는다. commit/archive SHA로 고정한 읽기 전용 소스와 도구 이미지를 제공하고, 작은 snapshot에는 작업 manifest만 담는다. 작업별 쓰기 공간·출력·temp를 분리한다. 압축 해제 경로 탈출·심볼릭 링크·해시·크기 제한을 검사한다.
- **데이터와 출력:** R2 immutable 객체로 데이터와 큰 검사 산출물을 보존한다. 작업에는 읽기 또는 결과 쓰기만 가능한 짧은 권한을 제공하고, 계정 토큰을 컨테이너에 전달하지 않는다. source/image/dataset/input-manifest 해시를 이벤트에 연결한다.
- **디스크:** image+source+build+data+spill+출력의 실제 고수위를 측정한다. 20GB 기준 사용량 14GB 이내를 pilot 목표로 두고 17GB에서 새 작업을 중단한다. 필요하면 C와 M 이미지를 나누되 준비 비용을 기록한다. 기존 image registry의 누적 저장 한도도 확인한다.
- **장시간 제어:** API의 compute timeout 상한은 1시간이지만 현재 실험 runner의 관측 상한도 1시간이다. 네 순차 작업+최종 집계를 수용하도록 관측·서버 deadline을 일치시키며 재조회로 deadline을 연장하지 않는다. 제한 초과 시 중앙 취소·컨테이너 정지를 검증한다.
- **계측:** macOS memory-pressure 이벤트와 종료된 자식까지 포함한 CPU초를 수집한다. Linux cgroup CPU·throttling·peak memory·OOM·I/O를 유지한다. 단계·요청 ID별로 configure/compile/link/test/data transfer/aggregation을 나눈다.
- **기존 모델 경계:** C·M은 모델 호출 없는 compute 실험이다. 이후 큰 저장소의 실제 Codex·Claude 편집은 전체 source snapshot 대신 고정 base+허용 파일 delta/patch를 검증할 경로가 추가되어야 한다. 작은 fixture 성공을 대형 저장소 모델 연동 완료로 표현하지 않는다.

## 6. 계측·판정·중단

| 항목 | 기록 및 판정 |
|---|---|
| 납기 | 승인→네 작업+최종 정답 검사 완료, 결과 회수까지; local-best 대비 30% 이상 단축을 제안 목표로 유지 |
| 실제 병렬도 | compile 프로세스 수, DB threads, 워커 실행 겹침; 요청한 병렬도와 대조 |
| 자원 | 프로세스 트리 CPU초·RSS/footprint·메모리 압박·swap-out·압축·disk I/O·spill, 원격 cgroup 자원 |
| 사용자 응답성 | 10분 기준선 대비 Node·Git p95; 2배와 절대 100ms를 동시에 넘는지 확인. 실제 대화형 IDE 반응을 대신한다고 주장하지 않음 |
| 정확성 | 동일 필수 테스트 목록·결과, 빌드별 skip/실패 목록, canonical SQL 결과와 사전 선언 오차 |
| 비용 | image/prepare/transfer/R2/Worker/컨테이너/실패·재시도 모두 분리. 미수집 금액을 0으로 표기하지 않음 |
| 재현성 | revision·archive·image·dataset·테스트 목록·정답·컴파일 옵션·도구 버전·시드·샤드·캐시 상태 |

로컬 critical 메모리 압박 15초 지속, 새 swap-out 1GiB/분 이상 두 구간 연속, 디스크 3GB 미만, 또는 응답 probe 1초 초과 30초 지속 시 새 작업을 멈추고 해당 실험 자식 프로세스만 정리한다. 기존 사용자 앱을 종료하지 않는다. warning은 먼저 기록하며 의도적인 OS OOM을 목표로 하지 않는다. 원격도 작업 RSS·cgroup·disk 여유를 확인하고 OOM 및 spill 실패를 작업 한계로 보고한다.

사전 한도 제안은 C 작업 60분, M 묶음 작업 15분, 최종 집계 15분이다. 전체 deadline은 승인된 작업 수·동시성과 시작 여유를 포함해 계산한다. 장시간 작업이 자연 한도를 넘으면 실행 규모나 플랫폼 적합성 문제로 보고하며 시간을 무한 연장하지 않는다.

예산은 P0 인프라 $5, 본실험 인프라 $30을 **추정 중단 기준 후보**로 제시한다. 현재 $10 승인을 새 실험에 자동 재사용하지 않는다. standard-4 CPU를 전부 사용하는 상한 환산은 초당 약 $0.0001114이며 포함량·R2·전송·Worker·이미지 비용은 별도다. P0에서 실제 단가와 준비비를 확인하고 본실험 실행 수와 예산을 다시 확정한다. 최종 청구의 확정 상한이 아니다. [요율](https://developers.cloudflare.com/containers/platform/pricing/)

## 7. 결론을 내리는 방법

- C의 납기와 local-best 대비 개선을 확인하면 실제 개발 빌드·검증 분산의 유용성을 주장할 수 있다.
- M에서만 개선되면 메모리 중심 회귀 분석의 유용성으로 범위를 제한한다.
- CPU 포화만 관측되면 CPU 결과만, 메모리 압박까지 관측되면 메모리 결과를 별도로 판정한다.
- 로컬 4개가 압박을 받더라도 튜닝한 로컬 1·2개가 더 빠르면 로컬을 권장한다. 로컬을 불리하게 제한해 만든 승리를 인정하지 않는다.
- Cloudflare 작업당 메모리·디스크 한도가 먼저 걸리면 현재 Cloudflare 적합성 한계다. AWS는 현재 MVP 완료 이후 별도 단계로 남긴다.
- 모델 구현·랄프 수정까지 포함한 대형 개발 납기는 위 compute 실증과 대형 소스 delta 경로를 검증한 뒤 별도 측정한다. 이번 compute 결과로 토큰 절감이나 AI 구현 속도까지 입증하지 않는다.

## 8. 실행 전 동결할 산출물

`pilot.json`에 eligibility, 실제 peak/디스크/압박, 고른 SF/J/memory_limit와 탈락 이유를 기록한다. 이후 `manifest.json`에 네 빌드 구성·22쿼리 분할·공통 테스트 목록·도구/image/data 해시·최선 로컬 설정·무작위 순서·deadline·예산을 고정한다. 결과는 단계별 원자료, 중단·실패 목록, 모든 샤드 정답, 비용, 조건별 중앙값·범위와 선택 기준으로 남긴다.

이번 문서는 실행 설계다. 소스의 빌드 옵션과 버전 commit, 공식 제약을 확인했으며 대형 빌드나 유료 사전 시험은 아직 하지 않았다.

예비 후보 근거: [LLVM Getting Started](https://llvm.org/docs/GettingStarted.html) · [VS Code 기여 안내](https://github.com/microsoft/vscode/wiki/How-to-Contribute)
