# HF 모델 게시 조사·적용 결과

상태: 구현·전체 검사·독립 최종 리뷰 완료. 최종 판정은 로컬 적용 후보에 한정한 APPROVED다. 실제 HF 업로드·공개 전환·배포·commit·push는 하지 않았다.

## 조사

[사용 설명서와 원문 출처](../hugging-face-publication.md)에 공식 HF 문서, v2.4.0 프로토콜 소스, SmolLM2·Qwen·Llama 공개 metadata를 정리했다. 공개 모델의 가중치 다운로드·모델 실행은 하지 않았다. 확인한 가중치는269MB·988MB·약5GB shard 구조였다. 기존1MiB inline 한도는 HF의 모델 크기 한도가 아니라 HIVEMIND 작은 파일 경로의 제한이다. 현재 작업 트리에 이미 추가된 verified large store와 LFS 경로를 보완했다.

## 변경

- preupload로 regular/LFS를 구분하고, 설정·토크나이저·README와 가중치를 한 commit에 포함한다. 일반 파일도 NDJSON/base64를 스트리밍한다.
- 공식 basic/multipart batch·조각 URL·ETag 완료 payload·서명 쿼리·빈 verify 응답·중복 OID를 처리한다.
- Cloudflare 요청은 native FixedLengthStream과 manual redirect 거부를 사용한다. 길이를 헤더로만 지정하거나 지원하지 않는 redirect:error를 사용하지 않는다.
- 모든 파일과 메시지·경로를 먼저 검사한다. SHA256·크기·알려진 비밀 변형과 credential 패턴을 bounded stream으로 검사하고, 실제 전송도 해시·크기를 대조한다.
- 공개 대형 게시는 server target의 public과 allowPublicLarge:true, 허용 operation·LFS limits·갱신된 profile hash 승인이 모두 필요하다. API·core·provider·MCP·대시보드와 감사 target에 이를 보존한다. 기본 private는 유지한다.
- commit 직전 visibility와 기준 head를 다시 확인하고 parent CAS와 commit 후 visibility proof를 사용하며, 만료 후 복구는 실행 권한을 갱신하지 않는 bounded GET 전용 proof를 사용한다. 취소·늦은 소스·정리 거절·동기 fetch 오류·중단된 파이프를 정리한다.

## 검증

- 루트 npm run check: 944 passed,0 failed,0 skipped, 종료0.
- backend npm run typecheck 및 npm test: 719 passed,0 failed,0 skipped, 종료0.
- runtime stamp/check, Wrangler deploy --dry-run: 종료0. 실제 deployment 아님.
- 최종 source23개 hash drift 없음. 기존 사용자 runtime session·해당 test의 바이트 보존을 확인했다. 기존 문서 변경을 보존하고 HF 설명만 갱신했다. generated runtime manifest에는 현재 runtime 입력과 공유 계약을 반영했다.
- git diff --check 통과.

첫 루트 검사는934개 중2개가 실패했다. 새 public opt-in 규칙과 preupload·스트림·manual redirect를 반영하지 않은 기존 통합 fake/assertion을 수정했다. 독립 리뷰의 보호값 중복·혼합 profile 감사 target·늦은 iterator 정리 오류도 회귀와 함께 수정했다. 최종 전체 검사는 이 변경 뒤의 결과다. 로그와 metadata/source hash는 .superlite/hf-research/에 있다.

## 범위와 한계

실제 HF·Cloudflare 대용량 전송, CPU·메모리·처리량, 공개 효과·청구는 실증하지 않았다. Xet 네이티브 실행기나 chunk dedup·자동 재개 전체를 구현했다고 표시하지 않는다. HTTP LFS 호환 경로다. Worker 시간 한도와 실제 프로필 크기 한도가 적용된다. 복구 조회는 최근 commit 페이지에 한정되며 불확실한 commit을 새 requestId로 자동 재게시하지 않는다. 비밀 검사는 완전한 DLP가 아니다. repository privacy 변경과 commit을 원자적으로 묶는 HF API 보장은 없다.

플랫폼은 파일당5GiB·합계64GiB·32파일, regular 합계16MiB·commit wire24MiB다. 실제 profile이 더 작은 한도를 정할 수 있다. 큰 산출물은 작은 코드 snapshot과 분리하고, 실제 프로젝트에서 승인된 자격·대상으로 별도 실증한다. 설치된 사용자의 runtime session 수정과 문서는 되돌리거나 commit하지 않았다.

새 독립 최종 검토자는 현재 HF 연구·적용 패킷을 한 번 읽고 APPROVED로 판정했다. 실제 제공자 수용 승인이 아니다. 최종 제품 source23개 hash는 전체 검사와 리뷰 뒤에도 동일하다. 실제 HF 업로드·배포·커밋은 수행하지 않았다.
