# HF 모델 게시 조사와 적용

## 목적과 범위

사용자는 HF의 다른 모델 게시 방식을 조사해 적용하도록 요청했다. 기존 코드에는 inline commit 외에 verified large manifest·R2 multipart·HF LFS·public inline 대상이 이미 추가돼 있다. 이 코드를 공식 규약과 대조해 고친다. 실제 업로드·저장소 생성·공개 전환·배포·커밋·push는 하지 않는다. 기존 dirty runtime session·manifest·문서는 보존한다.

Superlite inventing/drafting/testing/swarm 절차를 적용한다. 기존의 AI 조율·병렬 에이전트 승인을 유지한다. 현 작업 트리에서 소유 파일을 분리하고, 체크포인트 커밋과 worktree 이동은 생략한다.

## 조사 근거

- HF upload guide: https://huggingface.co/docs/huggingface_hub/main/en/guides/upload
- Xet/LFS 호환: https://huggingface.co/docs/hub/xet/legacy-git-lfs
- pinned official protocol source: https://github.com/huggingface/huggingface_hub/blob/v2.4.0/src/huggingface_hub/lfs.py
- commit payload: https://github.com/huggingface/huggingface_hub/blob/v2.4.0/src/huggingface_hub/_commit_api.py
- 모델 예시: https://huggingface.co/HuggingFaceTB/SmolLM2-135M/tree/main , https://huggingface.co/Qwen/Qwen2.5-0.5B/tree/main , https://huggingface.co/meta-llama/Llama-3.1-8B/tree/main

현재 HF 권장 경로는 공식 huggingface_hub/hf_xet의 스트리밍·중복 제거·재개다. Hub는 LFS 호환 경로도 지원한다. Cloudflare Worker에는 Python/Rust SDK 실행 환경이 없으므로 기존 HTTP broker의 LFS 호환 경로를 보완한다. Xet 네이티브 업로드를 구현했다고 표시하지 않는다. weights를 모델 토큰/base64 JSON에 실어 보내지 않고 verified large store의 stream을 쓴다. config/tokenizer/README/model card와 shard index도 모델 산출물이다. 임의 shard 생성이나 학습 결과 변환은 하지 않는다.

## 적용 계약

H1 protocol: packages/adapters/src/autonomous-external-hf-lfs.ts 및 관련 테스트 소유. official batch ref는 원래 revision, transfers basic/multipart; chunk_size·숫자 part URL·ETag 완료 payload; dedup OID; verify 성공의 빈 body 허용. upload·completion·verify URL/headers는 고정 원본·명시 host 정책과 redirect 거부. HF token은 오직 HF API에만 보낸다. SHA/size 실제 stream 검사, 취소·deadline 보존. 커밋 전 사전 검사를 H3 helper로 재사용한다. 증거 없는 mutation 재실행 금지·기존 broker ambiguous 정책 유지. HfLfsOptions에 allowPublicLarge?:boolean 및 forbiddenValues?:readonly string[] 추가.

H2 policy: contracts autonomous-external.ts HF target에 allowPublicLarge?:true; core validator·adapter visibility helper·provider composition·backend config·해당 테스트 소유. 기존 public/private/defaultprivate/hash 의미 보존. public LFS는 target.visibility='public' AND target.allowPublicLarge===true AND 승인된 lfs operation·서버 limits가 모두 있을 때만 허용한다. target field는 승인 hash/화면 safe metadata에 포함된다. provider.visibility와 target은 같아야 한다. H1에 전달하는 allowPublicLarge는 검증된 target에서만 가져온다. repository privacy를 변경하거나 새 repository를 만들지 않는다.

H3 preflight: NEW packages/adapters/src/autonomous-external-hf-preflight.ts + tests. exported async preflightHfFiles(files, {open,forbiddenValues,signal?,assertActive?}):Promise<void>. 모든 파일을 bounded stream으로 읽고 manifest size/SHA256 및 알려진 비밀·credential pattern을 검사한다. 청크 경계를 보존하며 전체 파일을 Buffer로 모으지 않는다. raw/base64/url/json-escaped 알려진 값도 bounded variant 검사한다. 오류 메시지에 값/경로/URL을 넣지 않는다. 임의 모든 은닉 정보를 찾아낸다고 주장하지 않는다. H1이 업로드 전 호출한다. H1은 실제 upload stream에도 size/hash boundary를 유지한다.

H4 coordinator: 공개 모델 metadata만 읽는 조사, 문서·사용 예시, 범위별 교차 리뷰와 전체 npm run check, backend typecheck/test, 새 독립 final review. 승인 화면·model sidecar의 기존 target 표시를 대조한다. 실제 provider 실증은 사용자 지시에 따라 후속 실제 프로젝트에서 수행한다. false production-success 금지.

## 완료 조건

규약 차이를 failing regression으로 확인하고 수정한다. multipart·중복 SHA·빈 verify·malformed href/ETag·secret·취소·public opt-in·private 호환·proof를 검사한다. 전체 검사가 통과해야 완료로 보고한다. 기존 사용자의 4개 dirty 파일은 임의 복원하지 않는다. 테스트 로그와 baseline hash는 .superlite/hf-research에 남긴다.
