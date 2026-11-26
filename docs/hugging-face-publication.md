# Hugging Face 모델 게시

## 조사 결과

2026-11-21 공식 문서와 공개 모델 metadata를 확인했다. 모델 가중치는 요청 JSON에 base64로 넣는 작은 파일과 별도로 전송해야 한다. 일반적인 모델 저장소는 가중치, 설정, 토크나이저, 모델 카드로 구성된다. 큰 모델은 shard와 index를 함께 보존한다.

| 공개 모델 | 확인한 가중치 | 함께 있는 파일 |
|---|---|---|
| [SmolLM2-135M](https://huggingface.co/HuggingFaceTB/SmolLM2-135M/tree/main) | model.safetensors, 269,060,552 bytes | config.json, tokenizer_config.json, README.md |
| [Qwen2.5-0.5B](https://huggingface.co/Qwen/Qwen2.5-0.5B/tree/main) | model.safetensors, 988,097,824 bytes | config.json, tokenizer_config.json, README.md |
| [Llama-3.1-8B](https://huggingface.co/meta-llama/Llama-3.1-8B/tree/main) | safetensors shard 4개, 각각 약1.17–5.00 GB | model.safetensors.index.json, config.json, tokenizer_config.json, README.md |

표는 공개 metadata 조회이며 가중치 다운로드나 모델 실행을 하지 않았다. 조회한 commit SHA는 로컬 조사 기록 `.superlite/hf-research/model-examples.json`에 보존했다. GB는10진 단위다. 가중치 파일이 작아도 tokenizer.json 같은 다른 필수 파일은 별도로 포함해야 한다.

## 공식 방식과 HIVEMIND 적용

HF 공식 Python 클라이언트는 `upload_folder`·`hf upload`에 Xet 기반 스트리밍·중복 제거·재개를 제공한다. Xet 미사용 클라이언트용 LFS 호환 경로도 남아 있으며 업로드 후 서버가 Xet 저장으로 이전할 수 있다. 따라서 Xet 저장소라는 이유만으로 LFS 호환 클라이언트를 막지는 않는다. [업로드 안내](https://huggingface.co/docs/huggingface_hub/main/en/guides/upload), [LFS 호환 설명](https://huggingface.co/docs/hub/xet/legacy-git-lfs).

HIVEMIND는 Cloudflare의 중앙 HTTP broker를 유지한다. 모델 프로세스에 HF 토큰을 주거나 임의 CLI로 승인을 우회하지 않는다. Python/Rust Xet 네이티브 실행기를 새로 배포하지 않고, 공식 LFS 호환 프로토콜을 현재 TypeScript 전송기에 적용한다. 실제 Xet SDK와 같은 처리량·chunk dedup·자동 재개를 구현했다고 주장하지 않는다.

공식 클라이언트 v2.4.0 소스와 대조한 항목은 전송 협상, multipart 조각·완료 메시지, OID 중복 제거, 검증 응답 처리다. batch의 revision은 입력 revision을 그대로 사용한다. verify 단계는 성공 HTTP 상태를 확인하며 빈 응답을 JSON으로 파싱하지 않는다. 작은 일반 파일과 LFS 가중치를 구분하는 preupload·commit 규약도 대조한다. [LFS 규약 구현](https://github.com/huggingface/huggingface_hub/blob/v2.4.0/src/huggingface_hub/lfs.py), [commit 규약 구현](https://github.com/huggingface/huggingface_hub/blob/v2.4.0/src/huggingface_hub/_commit_api.py).

## 모델 산출물 준비

Transformers 모델은 학습 환경에서 다음과 같이 산출물을 저장할 수 있다. 이것은 학습 코드의 예시이며 HIVEMIND가 PyTorch를 설치하거나 모델을 실행한다는 뜻이 아니다.

```python
output_dir = "/workspace/dist/checkpoint"
model.save_pretrained(output_dir, safe_serialization=True, max_shard_size="5GB")
tokenizer.save_pretrained(output_dir)
```

설치한 Transformers 버전의 인자를 확인한다. 현재 공식 기본 shard 크기는 HIVEMIND 파일 한도보다 클 수 있으므로 명시한다. 하나의 tensor가 크면 설정값보다 큰 shard가 생길 수 있으므로 실제 파일 크기도 확인한다. custom 모델은 해당 프레임워크의 직렬화 형식을 사용한다. HIVEMIND는 tensor를 바이트 단위로 임의 분할하거나 shard index를 만들어 학습 산출물을 변조하지 않는다. [Transformers 저장 API](https://huggingface.co/docs/transformers/main_classes/model#transformers.PreTrainedModel.save_pretrained), [HF 직렬화 안내](https://huggingface.co/docs/huggingface_hub/package_reference/serialization).

README.md에는 모델 설명·사용법·라이선스·평가 결과를 기록한다. Transformers 모델을 게시할 때는 생성된 config·토크나이저·가중치 전체와 shard index가 있으면 그 파일을 함께 선택한다.

## 승인과 호출

서버 HF profile은 repository·revision·visibility·허용 operation·자격 reference·크기·금액 정책을 고정한다. `hf.model.commit`의 inline1MiB 한도는 작은 파일 전용이다. 가중치는 `hf.model.lfs_commit`을 사용한다. 기존 large store의8MiB multipart 업로드와 task/revision/profile에 결속된 manifest grant를 거친다.

예시 model tool 입력은 다음과 같다. profile ID는 실제 서버에 설정하고 승인한 값을 사용해야 한다.

```json
{
  "profileId": "approved-hf-profile",
  "requestId": "publish-checkpoint-001",
  "operation": "hf.model.lfs_commit",
  "largeArtifact": {"paths": ["README.md", "dist/checkpoint/config.json", "dist/checkpoint/model.safetensors", "dist/checkpoint/tokenizer.json", "dist/checkpoint/tokenizer_config.json"]},
  "parameters": {"message": "Publish the verified checkpoint"}
}
```

shard를 썼다면 예시의 model.safetensors를 같은 디렉터리의 실제 shard 목록과 model.safetensors.index.json으로 바꾼다. paths는 `/workspace` 기준이며 비밀 파일·symlink·다른 작업의 storageRef를 사용할 수 없다. 생성한 큰 파일은 source snapshot에서 제외되는 `dist/`에 두어 작은 코드 snapshot 한도와 분리한다. 경로는 HF에서도 그대로 보존되므로 위 예시는 `subfolder="dist/checkpoint"`로 모델과 토크나이저를 읽는다. 저장소 루트에 게시하려면 별도 신뢰 게시 작업이나 게시 완료 후 산출물 정리 절차를 사용하고, 큰 파일을 코드 snapshot에 남기지 않는다. `dist/`는 반복 사이에 자동 복원되는 학습 체크포인트 저장소가 아니다. 이미 업로드한 manifest가 있으면 largeArtifact 대신 승인된 manifestDigest를 전달한다. 두 방식을 동시에 사용하지 않는다.

private가 기본이다. 공개 대형 게시에는 서버 target의 `visibility:"public"`, `allowPublicLarge:true`, 허용 operation이 모두 필요하며 변경된 profile hash를 승인해야 한다. 단순히 visibility를 바꿔 기존 승인을 재사용할 수 없다. 대시보드와 MCP 검토에 공개 효과와 명시적 대형 허용을 표시한다. 새 저장소 생성이나 private→public 전환을 자동 수행하지 않는다.

## 한계와 검증 구분

- 플랫폼 hard limit은 파일당5GiB·합계64GiB·32파일이며, 실제 profile은 더 작은 한도를 지정할 수 있다. 일반 파일은 합계16MiB, commit wire는24MiB로 제한한다. HF 자체의 저장 정책과 HIVEMIND 정책은 별개다.
- 보호된 값의 사전 stream 검사와 크기/SHA256 검사를 수행한다. 이 검사는 모든 은닉 정보·개인정보·라이선스 문제를 찾아내는 완전한 DLP가 아니다.
- HF 토큰은 고정된 HF API에만 사용한다. 저장소가 반환한 업로드 URL도 운영자가 허용한 host만 사용하고 redirect를 거부한다. multipart 완료의 서명 쿼리는 보존하되 인증 토큰을 붙이지 않는다.
- Cloudflare Worker의 PUT에는 `FixedLengthStream`을 사용해 실제 Content-Length를 유지한다. 일반 ReadableStream에 헤더만 붙이면 chunked 전송이 되기 때문이다. Workers가 지원하지 않는 redirect:error 대신 manual 모드에서 모든3xx를 거절한다. [Cloudflare 요청 문서](https://developers.cloudflare.com/workers/runtime-apis/request/#set-the-content-length-header).
- 큰 파일 검사는 추가 읽기를 요구한다. 실제 Worker의 CPU·시간·처리량은 실증 전이며, 파일 한도와 시간 내 완료를 동일시하지 않는다.
- 공개/비공개 상태는 commit 직전과 이후에도 확인한다. HF가 visibility를 commit과 원자적으로 결속하지 않으므로 원격 관리자의 동시 privacy 변경까지 완전히 막는 보장은 하지 않는다.
- R2 업로드 재개와 HF 게시의 불확실한 결과 복구는 다르다. HF commit 응답이 유실되면 기존 broker의 근거 조회를 우선하며 새 requestId로 무조건 재게시하지 않는다. Xet SDK 수준의 자동 재개를 보장하지 않는다.
- 이번 적용은 로컬·모의 HTTP 회귀 검증이다. 실제 HF 업로드·공개 전환·배포는 별도 명시적 실행 범위가 필요하다.
