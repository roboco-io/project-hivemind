# experiments

## Overview

이 디렉터리는 Claude Code 세션을 나누는 방식이 작업 시간과 토큰 비용에 주는 영향을 측정하는 실험 스크립트를 담는다. `context_continuity.py`는 임시 Git 저장소를 만들고 `claude -p`를 실제로 호출해 원시 기록을 남긴다. `summarize_context_continuity.py`는 그 원시 기록을 읽어 조건별 통계를 출력한다. 두 스크립트는 HIVEMIND 중앙 core나 HTTP API를 사용하지 않는 독립 실행 도구다. 실험 결과 기록은 [docs/verification/2026-11-11-context-continuity.md](../../docs/verification/2026-11-11-context-continuity.md)에 있다.

실험은 함수 4개를 구현하는 과제 묶음 2개(`shared`, `independent`)를 세 조건으로 실행한다. 조건 `A`는 한 세션이 함수 4개를 모두 구현한다. 조건 `B`는 두 세션이 같은 작업 디렉터리에서 차례로 2개씩 구현한다. 조건 `C`는 네 세션이 각자 분리된 clone에서 1개씩 구현하고, 성공한 세션의 파일만 결과 디렉터리로 복사한다.

## Interface

- `python3 scripts/experiments/context_continuity.py {probe|full} <output_dir>`: 실험 실행 CLI다. `probe`는 `clamp` 함수 하나로 세션 한 번만 실행하고 결과 JSON을 stdout에 출력한다. `full`은 과제 묶음마다 조건 순서의 순열 6개를 고정 시드로 섞어 총 36회 실행한다. [context_continuity.py:`__main__`]
- `python3 scripts/experiments/summarize_context_continuity.py <output_dir>`: `<output_dir>/runs.jsonl`과 실행별 `tests.txt`를 읽어 조건별 성공 수, 소요 시간 중앙값, 추정 API 비용, `B-A`와 `C-A` 짝 비교를 stdout에 출력한다. [summarize_context_continuity.py:`parser`]
- `setup(name, entries)`: `SPEC.md`, 빈 구현 `.mjs` 파일, `verify.mjs`를 가진 기준 저장소 `<name>-base`를 만들고 커밋한다. `(repo, HEAD 커밋)`을 반환한다. [context_continuity.py:`setup`]
- `session(wd, selected, logfile, deadline=None)`: 지정한 함수만 구현하도록 `claude -p` 세션 하나를 실행하고 종료 코드, 사용 모델, `usage`, 변경 파일, diff를 담은 dict를 반환한다. [context_continuity.py:`session`]
- `run(repo, name, condition, names, block, order)`: 조건 하나를 실행하고 `node --test verify.mjs`로 검증한 뒤 결과를 `runs.jsonl`에 한 줄 추가한다. [context_continuity.py:`run`]
- 모듈 상수 `model`, `fields`, `items`, `env`: 실험 모델 ID, 집계할 토큰 필드, 과제 정의, 세션에 넘기는 환경 변수다. [context_continuity.py:`model`, `fields`, `items`, `env`]

## Invariants

- `output_dir`은 존재하지 않는 새 경로여야 한다. `root.mkdir(mode=0o700, parents=True)`는 `exist_ok` 없이 호출되므로 이미 있는 경로에서는 실패한다. 이후 `os.umask(0o077)`로 생성 파일을 소유자 전용으로 만든다. [context_continuity.py:`__main__`]
- 세션에 넘기는 환경에서 `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `CLAUDE_CODE_OAUTH_TOKEN`을 제거한다. [context_continuity.py:`env`]
- 세션은 `Read`, `Edit` 도구만 허용하고 MCP 서버 없이 실행한다(`--tools Read,Edit`, `--strict-mcp-config`, `--max-turns 16`, `--no-session-persistence`). [context_continuity.py:`session`]
- 세션의 `ok`는 종료 코드 0, `is_error`가 `False`, 응답 모델이 `model` 하나뿐, 변경 파일이 할당된 `.mjs` 범위 안이고 추적되지 않은 새 파일이 없음을 모두 만족할 때만 참이다. [context_continuity.py:`session`]
- 실행의 `success`는 `verify.mjs` 종료 코드 0, 통과 테스트 12개, 모든 세션 `ok`를 요구한다. 요약 스크립트는 보존된 `tests.txt`에서 `tests 12 / pass 12 / fail 0`을 다시 확인해 `success`를 새로 계산한다. [context_continuity.py:`run`] [summarize_context_continuity.py:`success`]
- 조건 순서는 `random.Random(20261111)`로 고정하며 기준 커밋의 작성 시각도 고정값이다. [context_continuity.py:`__main__`, `setup`]
- 실행 하나의 제한 시간은 180초이고, 제한 시간을 넘긴 세션은 프로세스 그룹에 신호 15를 보내 종료한다. `deadline`이 없으면 세션 제한 시간은 100초다. [context_continuity.py:`run`, `session`]
- 요약 스크립트는 5분 TTL과 1시간 TTL 캐시 생성 토큰의 합이 `cache_creation_input_tokens`와 다르면 `ValueError`를 낸다. [summarize_context_continuity.py:`ttl5`, `ttl60`]
- `estimated_api_usd`는 스크립트에 고정된 단가(`rates`와 캐시 생성 배수 1.25, 2)로 계산한 추정값이다. CLI가 보고한 비용은 `cli_reported_usd`로 따로 기록한다. [summarize_context_continuity.py:`rates`, `cli_cost`]
- `evidence.json`은 기록이 정확히 36개일 때만 쓴다. [summarize_context_continuity.py:`records`]

## Side Effects

- `context_continuity.py`는 `claude` CLI를 하위 프로세스로 실행하므로 실제 모델 호출과 비용이 발생한다. `probe`는 1개 세션, `full`은 84개 세션(과제 묶음 2개 x 블록 6개 x 조건별 1+2+4 세션)을 실행한다. 프로젝트 규칙상 실제 모델 호출은 명시적으로 요청받은 작업에서만 수행한다. [context_continuity.py:`session`]
- `output_dir` 아래에 기준 저장소, 실행별 clone, 세션 로그(`*.jsonl`, `*.stderr`), `diff.patch`, `tests.txt`를 만들고 `runs.jsonl`에 결과를 추가한다. [context_continuity.py:`setup`, `run`]
- `git init`, `git add`, `git commit`, `git clone`, `git diff`, `git ls-files`와 `node --test verify.mjs`를 하위 프로세스로 실행한다. 이 Git 명령은 `output_dir` 안의 임시 저장소만 대상으로 한다. [context_continuity.py:`git`, `setup`, `run`]
- `summarize_context_continuity.py`는 모듈 최상위에서 바로 실행되며, 기록이 36개일 때 `output_dir/evidence.json`을 쓴다. 그 밖에는 stdout 출력만 한다. [summarize_context_continuity.py:`records`]

## Verification

- 이 디렉터리의 Python 스크립트에는 구성된 테스트 러너가 없다. 저장소 전체 검사인 `npm run check`는 이 스크립트를 실행하거나 검사하지 않는다.
- Run: `<test-command>`
