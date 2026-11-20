# 이슈 #1 잔여 구현 기록

상태: 로컬 구현과 교차 검토 수정을 마쳤으며 최종 검증 결과를 아래에 기록한다. 운영 수용과 이슈 종료는 아직 아니다. 사용자의 “잔여작업 랄프 루프로 진행해”에 따라 로컬 설계·구현·검증을 반복한다. 이번 단계에서는 실제 모델·외부 제공자·배포·유료 자원을 호출하지 않았다.

## 기존 실제 근거

2026-11-19 Cloudflare version40d25e9f에서 Claude 두 반복·private 세션 복원·cache read·독립 검사·실제 stop·인증23→24→25를 확인했다. 근거는 이전 autonomous-cloud.report.md다. 이번 변경은 아직 그 운영 서버에 배포하지 않았다.

## 구현과 검토 범위

| 요구 | 이번 변경 | 검증 구분 |
|---|---|---|
| R1 | 명시적56일 long profile, 기존pilot보존, 작업별 원자적 chunk/manifest, 요청·credential 색인, bounded due tick, SQLite/DO 이전, summary·history 페이지 | 로컬·합성 시계. 실제8주·최대 메모리 실증 아님 |
| R2 | 승인 revision·정책 불변과 서버 설정 fingerprint, 외부 profile ID와 표시한 target hash 결속 | 로컬 권한/경합 검사 |
| R3/R4 | WebFetch exacthost·실제 DNS/IP/TLS 경계, MCP action 채널·고정 주/자식 모델 | 로컬 transport/CLI seam. 실제 WebFetch·Fable 가용성 미검증 |
| R5 | 기존 세션/receipt/usage 보존, quota 미측정 사용량 구분 | 기존 실제 두 반복+신규 로컬 회귀 |
| R6 | 일일시간대/DST·5분 dispatch grace·예약복원·quota 구조화 reset 대기 | 실제319 스키마 근거, blocked pause는 합성 |
| R7 | 서버전용 scoped credential resolver, operator metadata와 action private 채널 | fake credentials/로컬 HTTP·SDK, 실제자격 미사용 |
| R8/R9 | 동일 task 전체 profile/revision 예산·intent·멱등성·소유권·accepted 예약/미확정 비용·감사 페이지 | 로컬 durable store/provider fakes |
| R10 | 기존 사람 개입 기록과 operator MCP·dashboard 조회/명시적 승인 연결 | 로컬 API·SDK·DOM |
| R11 | 취소 전 admission 차단, lease 독립 정리·실제 부재 proof, AWS 사전 TTL 가드/타이머 및 CDK | 로컬·템플릿 합성. 실제자원 종료 미검증 |

## 검토에서 수정하는 실제 결함

- 기록 포화 시 취소 이후 대사를 기록하지 못하는 경계를 복구 여유로 분리했다.
- DO가 transaction capability를 잃었을 때 legacy 상태로 돌아가 소유 중인 credential을 놓치는 경로를503으로 차단했다.
- 일일 occurrence를 alarm과 claim 두 단계에서 다르게 계산하던 문제를 원래 예약과 실제 startedAt의 구분으로 보강했다.
- DO tick 전체 이력 로딩을 대상·동일 credential owner·bounded due batch로 나눴다. SQLite 전체 serialized memory32MiB 사전 상한을 추가했다.
- 긴 task의 전체 JSON 응답이 operator transport 한도를 넘는 문제에 summary/history 페이지를 추가하고 소비자를 함께 변경했다.
- 실행 수락과 청구 확정을 같은 상태로 취급하지 않는다. accepted는 상한 예약을 유지하면서 계속/대기를 허용하고, 최종 종료는 정리·실제 비용 근거를 기다린다.
- GitHub expected-head 쓰기 경합과 AWS TTL 부재는 별도 provider 안전 검토에서 수정했다.

## 최종 검증

- 루트 `npm run check`: 732개 통과, 실패·건너뜀 0개.
- 백엔드: 타입 검사와 전체 620개 통과, 실패·건너뜀 0개. 취소 검사는 80ms 경쟁 대신 실행기를 미완료로 유지하고 취소 결과 영속화와 늦은 결과 무시를 확인한다.
- AWS guard: 타입 검사, CDK 템플릿 검사 3개, Python 정리 검사 20개 통과. 실제 AWS 호출 없음.
- runtime stamp/check, linux/amd64 이미지 빌드, 모델 호출 없는 인증·부트스트랩 검사, Wrangler 배포 dry-run 통과. 실제 배포 없음.
- 로컬 실제 샌드박스 probe는 QEMU 환경에서 실패했다. UID·capability 제거·no-new-privileges·인증 부재·managed 설정·native endpoint 인증은 통과했다. 원격 Cloudflare 파일/namespace probe를 대체하지 않는다.
- `git diff --check`는 기존 `docs/plans/local-resource-validation/INTENT.md:14`의 빈 EOF 줄 때문에 실패한다. 기준 사본과 같은 사용자 변경이므로 보존했다.

최종 리뷰에서 default/pilot 개입 기록 포화 후 취소·만료 복구, 종료 후 저장 실패의 비공개 복구, 웹 grant 만료 직후 결과 수집, GitHub 100개 이후 커밋의 고정 head·페이지 복구, 빈 파일, 연속 GitHub push를 위한 안전한 결과 SHA 전달을 보완했다. sealed 인증은 종료 전에 비공개로 저장하고 실제 stop 확인 후에만 새 인증 세대에 반영한다. 외부 복구는 모델 작업이나 쓰기 mutation을 재실행하지 않는다.

## 운영 수용 전 남은 작업

1. 실제 Fable CLI ID, 웹 host, AWS account·소유권·Spot launch policy·예산, HF/GitHub private 대상과 자격 참조를 지정한다. 설정 hash와 승인 revision을 확인한다.
2. 새 Cloudflare 후보를 별도 승인 범위에서 배포하고, 인증 주입 전 원격 파일·namespace 격리와 Workers DNS/IP/TLS 경계를 검사한다. 로컬 probe 실패를 무시해 활성화하지 않는다.
3. 승인한 예산·종료 시각으로 실제 24시간 실행, quota 대기·재개, CLI 세션·cache, 자식 모델, 외부 작업·청구·취소·TTL 정리를 실증한다. 8주 운영과 최대 이력 메모리 검증은 별도다.

외부 업로드는 현재 총 1MiB·32파일이며 HF LFS는 지원하지 않는다. 큰 학습 모델 게시를 완료했다고 주장하지 않는다. 세션/transcript도 4MiB 한도가 있다. 정상/복구 저장 상한 30/32MiB는 Workers 128MiB 메모리 안전 보장이 아니다. 대표 로컬 저장 부하에서는 heap+external 약 84.11MiB였으나 process RSS 약 284.17MiB였으며, 8주 최대 부하 실증으로 해석하지 않는다.

기능 flag는 기본 비활성이다. 현재 운영 근거는 앞서 승인받아 수행한 Claude 2회 반복뿐이다. 이번 작업은 신규 실제 모델·제공자·유료 자원·외부 push·배포·커밋을 수행하지 않았다. 이전 코드로 단순 rollback하면 신규 분할 상태를 잃을 수 있으므로 새 reader로 복구·drain하는 절차를 따른다.

## 후보 식별과 최종 리뷰

- runtime digest: `18b2b025f5fb2d0ccbbcac6923bb12cedc8c1adf141c6603d504e277dd0f2c9c`
- 로컬 이미지: `sha256:7f949c698a711618893fac3e06b59b6fe2a197e1b3c0fa771169a9ca38c320a4`
- Worker dry-run bundle SHA-256: `66ab79990963734c61a9812c92fde64fa9eff72776c749f2604eb19cd9f1bb38`

독립 최종 리뷰는 발췌에서 확정된 추가 코드 결함을 발견하지 못했다. 리뷰 당시 남았던 백엔드 전체 재검사는 이후 620개 통과로 해소했다. 기존 사용자 변경의 공백 경고는 기준 상태와 동일함을 확인했다. 실제 환경 미검증과 QEMU probe 실패 때문에 운영 수용 판정은 보류한다. 검증 로그와 소스 hash는 로컬 `.superlite/remaining-release/`에 보존한다.

## 후속 배포 — 2026-11-20

사용자의 후속 “진행시켜”에 따라 기존 Cloudflare 대상으로 후보를 배포했다. 위의 “미배포”와 “이번 작업”은 앞선 로컬 구현 단계의 기록이다.

- Worker version: `51bc6117-abe7-4c53-bf8d-4e806159bd3e`
- 확인 시각: `2026-11-20T06:42:12.374Z`
- 대상: `https://hivemind-cloudflare-backend.roboco.workers.dev`
- runtime digest는 위 검증 후보와 일치한다. registry image manifest는 `sha256:2a896361c8f9036bfa1a9ba9f3095bad07e074071f6b8811796592e7bb21ea63`이다. 로컬 multi-platform index digest와 구분한다.
- 배포 전·후 기존 작업 338개를 확인했다. 모두 종료 상태이며 자격 증명 점유·격리는 없다.
- `AUTONOMOUS_CLOUD_ENABLED=false`를 유지했고 readiness는 false다. 새 모델·제공자 작업과 컨테이너 실증은 시작하지 않았다.
- 완료 전 루트 `npm run check`를 다시 실행해 732개 통과, 실패·건너뜀 0개를 확인했다.
- 배포 로그·사전/사후 안전 요약은 `.superlite/remaining-activation/`에 보존한다. 인증 원본은 포함하지 않는다.

원격 파일·namespace 격리 probe와 실제 모델·24시간 시험은 여전히 미검증이다. 사용자에게 후속 시험 범위를 선택하도록 요청했다. 실제 모델·유료 자원은 프로젝트 실행 경계에 따라 구체적 범위가 확정된 뒤 진행한다.
