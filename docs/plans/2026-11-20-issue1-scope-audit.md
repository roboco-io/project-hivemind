# 이슈 #1 범위 감사 — 2026-11-20

## 판정과 검증 범위

소스와 `.superlite/remaining-activation/issue-1.json`을 대조했다. 사용자 최신 지시에 따라 실제 24시간 실행, 외부 제공자, Fable 검증은 실제 프로젝트로 이관한다. 이는 원문의 수용 기준 5개에 대한 이번 단계의 실제 검증 유예이며, 통과 증거나 원문 요구 삭제가 아니다. 정확한 모델 ID와 외부 대상 설정 추가 조사는 중단했다. 비밀 원본, 클라우드, 모델 호출은 사용하지 않았다. CLI version/help만 조회했다.

**현재 전체 이슈의 구현 완료를 단정할 수 없다.** 특히 HF/GitHub용 작업 산출물 생성 경로는 실제 검증 문제가 아닌 확인된 구현 공백이다. A4가 publisher를 수정 중이라는 조정자 최신 전달을 받았으며 이 감사에서는 수정 완료를 검증하지 않았다. 이 공백 수정 후 제한된 외부 제공자 기능의 구현 완료와 실제 프로젝트 수용을 분리해 판정해야 한다.

## 요구 해석과 확인된 차이

| 항목 | 원문의 강도 | 코드와 판정 |
|---|---|---|
| R7 자격 범위 | AWS/HF/GitHub의 작업별 전달, 외부 IAM 권한 제한과 승인 화면 표시를 명시. 특정 S3 버킷은 권한 제한의 예시 | 서버 profile/credentialRef와 중앙 broker 경로가 있다. 범용 S3 작업 API 자체는 명시 요구가 아니다. 실제 IAM·자격 전달은 이번에 실증하지 않았다. |
| S3 산출물 | 배경/문제 설명에서 HF·S3 외부 산출물을 명시. 별도 S3 연산·크기 기준은 R1–R11에 없음 | S3 operation/target 계약이 없다. 프로젝트 적합성의 공백이지만 S3 API 부재만으로 R7 구현 실패라고 단정하지 않는다. |
| 대형 HF 모델 | 소형 오픈 모델 학습·배포라는 프로젝트 목표. 바이트/LFS 기준은 명시하지 않음 | 현재 총 raw 1MiB, 32파일, 파일당 256KiB, inline commit만 지원. 큰 체크포인트는 처리할 수 없다. 범위를 작은 산출물로 한정한 구현은 가능하지만 실제 모델 배포 지원 완료라는 표현은 부정확하다. |
| 공개 게시 | 배경에 오픈 모델과 HF 배포, R9에 모델 공개를 외부 행동 예시로 명시. privacy 전환 API는 별도 요구하지 않음 | HF는 사전·사후 private=true를 강제한다. 공개 저장소 commit과 private→public 전환 모두 미지원. R9가 공개 기능 자체를 반드시 구현하라는 뜻은 아니지만 프로젝트의 공개 배포를 충족하지 못한다. |
| R9 기록 | 외부 시스템 행동을 도구 호출 단위로 저장·조회 | `counts.toolCalls=actions.length`는 예약 action 수다. 전체 Bash/Agent 호출 수나 성공한 외부 효과 수가 아니다. private transcript는 operator audit와 다르다. 전체 transcript 공개 부재만으로 R9 위반은 아니다. EC2 내부 S3/HF 효과가 기록되지 않는다면 그 효과에 대한 별도 R9 공백이다. |

## 최우선 확인: artifact materializer

근거: `packages/adapters/src/autonomous-external.ts`의 loader는 `external-artifacts/<digest>`만 읽는다. `cloudflare/backend/src/autonomous-external.ts`는 게시를 future 기능으로 명시한다. `runtime/autonomous-action-mcp.ts`는 HF/GitHub action에 digest만 받으며, external API에는 파일 등록 경로가 없다. 검색한 production 코드에서 작업 공간→해당 namespace의 writer는 확인되지 않았다. 주입 loader/사전 구성 fixture의 테스트 성공은 이 경로의 근거가 아니다.

`large-artifact-store.ts`의 multipart R2 기능은 LargeArtifactRef, source snapshot은 SourceSnapshot이다. 둘 다 ExternalArtifact의 JSON canonical digest/namespace와 호환되지 않는다. 따라서 기존 대형 업로드가 이 공백을 자동으로 해결하지 않는다.

A4 인계 최소 계약(제안이며 이 감사에서는 수정 완료 미검증):

- sidecar `artifact_publish({profileId,requestId,paths})`: `/workspace` 아래 명시 파일만 안전하게 열고 symlink·경로 탈출·변경 중 읽기를 거절한다. 모델에 bucket, URL, credential, 임의 digest 입력을 주지 않는다.
- worker 전용 `POST /v1/autonomous-tasks/:id/external-artifacts`: `{lease,runtimeId,revision,profileId,requestId,files:[{path,contentBase64}]}`. 기존 64KiB action parser와 분리하고 base64를 포함한 bounded body 상한을 정한다(예: 2MiB). 총 raw 1MiB/32파일/256KiB와 기존 경로·비밀 차단을 서버에서도 검사한다. 비밀 탐지가 완전하다고 주장하지 않는다.
- 중앙 core가 활성 lease/runtime, revision, 승인 profile/hash, 기간, 취소 상태, 저장 quota를 검사한다. 새 도구는 명시적으로 승인 범위에 포함한다. 외부 HF/GitHub mutation 승인을 대신하지 않는다.
- 서버가 기존 `externalArtifactDigest` 규칙으로 canonical JSON과 digest를 계산한다. R2 conditional create로 불변 저장하고 requestId 재시도는 같은 내용만 허용한다. 저장 후 응답 유실도 중복 게시 없이 복구한다.
- `{taskId,revision,profileId,digest}` 소유권 binding을 보존하고 broker가 digest 소비 때 확인한다. digest를 안다는 이유로 다른 작업의 파일을 게시할 수 없어야 한다. 응답은 `{artifactDigest,fileCount,totalBytes}`; 감사에는 metadata/hash만 기록한다. quota·보존·orphan 정리 정책도 고정한다.
- 필수 검사: workspace→R2→loader→fake HF/GitHub의 실제 연결, 미승인/취소/만료/다른 revision 차단, 크기·비밀·경로 차단, 재시도·응답 유실, 타 작업 digest 거절. 실제 provider 호출은 하지 않는다.

## EC2 고정 워크로드와 S3 경계

고정 AMI가 부팅 시 학습 서비스를 실행하고 고정 입력을 읽도록 준비되어 있다면, 승인한 AMI와 instanceProfile만으로 UserData 없이 학습을 시작할 수 있다. 현재 RunInstances는 AMI/type/subnet/profile을 고정하며 작업 입력은 lifetimeMs뿐이다. 따라서 일반적인 작업별 학습 지시·데이터 선택 기능은 아니다. 부팅 서비스나 S3 권한이 실제 설정되어 있다는 근거는 이번 조사에 없다.

EC2 내부 프로세스는 IAM이 허용하면 instance profile의 임시 자격으로 S3에 쓸 수 있다. 이는 HIVEMIND worker의 모델 프로세스로 AWS 자격을 넘기는 것과 다른 신뢰 경계다. 중앙 action 검사는 내부의 각 S3 요청을 중개하지 않는다. 현재 launch hash는 profile ARN을 포함하지만 같은 ARN의 IAM 정책 변경이나 AMI가 읽는 가변 설정까지 고정하지 않는다. AMI·부팅 프로그램·IAM 정책·입력 manifest를 신뢰하는 위임 실행임을 문서에 밝혀야 한다.

최소 확장은 trusted workload descriptor에 AMI, bootstrap/입력 manifest digest, IAM 정책 revision/hash, account/region, S3 bucket/prefix, bytes·보존·비용 한도를 선언하고 승인 fingerprint에 결속하는 것이다. `roboco`/`ap-northeast-2`는 사용자 지정 운영 기본값이며 account/bucket을 뜻하지 않는다. 입력 manifest를 쓰는 경우 이를 위한 별도 승인된 중앙 경로가 필요하다. 모델의 임의 UserData·shell은 받지 않는다.

S3 권한은 bucket/prefix와 필요한 KMS 키로 외부 IAM에서 제한한다. 모델 작업별 쓰기 감사가 필요하면 workload reporter의 서명/권한 제한 receipt와 객체 version·checksum·크기를 중앙에서 검증한다. CloudTrail 등 독립 근거는 별도 수집 경로가 있어야 한다. reporter만 신뢰하면 그 한계를 표시한다. 인스턴스 종료는 S3 저장·요청·전송 비용을 끝내지 않으므로 비용 예약과 보존/정리 범위를 추가해야 한다. 현재 Spot/EBS 정리로 S3 정리까지 보장하지 않는다.

## 후속 확장 순서

1. A4 publisher의 위 연결·권한 검사를 확인한다. 이 수정 전에는 작은 HF/GitHub 산출물 경로도 end-to-end 구현 완료로 표시하지 않는다.
2. 공개 저장소에 작은 파일을 commit하는 최소 slice: 서버 소유 `visibility:'private'|'public'`(기본 private)를 HF target/profile 계약·설정 fingerprint·승인 hash·표시 정보에 포함한다. 사전/사후 repository visibility를 그 값과 비교한다. 임의 repository/visibility를 모델 입력으로 받지 않는다. 기존 public repo commit도 공개 효과이므로 승인 화면에 명시한다. 이 slice는 repo 생성·privacy 변경을 하지 않는다. private→public 전환이 필요하면 별도 비가역 공개 action과 승인을 설계한다.
3. 대형 산출물: immutable manifest `{path,size,sha256,storageRef}`와 작업 소유권, streaming/multipart 업로드·재개·중단, provider별 HF LFS 등 대형 전송, commit 검증/reconciliation을 추가한다. 현재 inline 상한을 단순히 올리거나 LargeArtifactRef를 그대로 받아 해결했다고 표시하지 않는다.
4. S3는 고정 workload 위임 경로와 중앙 broker S3 action 중 필요한 범위를 명시한다. 전자는 교육된 AMI/IAM을 신뢰하고 결과를 검증하는 방식, 후자는 bucket/prefix별 승인·호출 감사 방식이다. 두 방식 모두 아직 구현·실증된 것으로 간주하지 않는다.

위 확장은 제안이다. 전체 프로젝트 코드 완료, 공개 모델 게시 지원, 원문 실제 수용 기준 통과는 서로 다른 판정이다. 이번 사용자 지시는 실제 수용을 이관했으며 구현 공백을 해소한 것은 아니다.

## 최종 범위 판정과 원문 근거

- **실제 수용 검증 — 이번 단계에서 유예:** 원문의 완료 기준에는 “24시간 이상 사람의 승인 없이 반복 실행”, 재시작 뒤 세션·캐시, 대기·예약 재개, 비용 상한·정리, 개입·도구 기록 조회가 있다. 사용자가 실제 프로젝트로 이관했다. 미검증을 구현 결함이나 통과로 바꾸지 않는다.
- **구현 결함 — A4 수정 확인 필요:** 승인된 작은 HF/GitHub 파일조차 workspace에서 소비 가능한 artifactDigest로 만드는 경로가 없다는 점은 bounded contract 내부의 연결 공백이다. publisher가 연결·권한·복구 검사를 통과하면 이 차단 요인은 해소할 수 있다. 이 보고서는 병행 수정의 합격 판정이 아니다.
- **명시적 제품 한계 — 그 자체로 bounded 플랫폼 구현 차단은 아님:** HF private commit은 private 모델의 배포를 지원한다. 공개 배포를 지원한다고는 말할 수 없다. 1MiB inline 계약에서 대형 LFS 미지원은 명시할 한계이며, 모든 과학 프로젝트의 체크포인트 처리를 구현해야만 플랫폼 코드를 완료할 수 있다는 요구로 확대하지 않는다. 공개 visibility·LFS·범용 S3 action은 후속 확장이다. 단, 해당 프로젝트가 이를 실제로 필요로 하면 그 프로젝트의 수용 차단 요인이 된다.

R7 원문: “작업 단위로 AWS, Hugging Face, GitHub 자격 증명을 워커에 전달할 수 있어야 한다.” 이어서 “자격 증명의 권한 범위(예: 특정 리전의 스팟 인스턴스 실행, 특정 S3 버킷, 특정 Hugging Face 조직)는 HIVEMIND 밖에서 제한”한다고 적는다. 이는 작업별 자격·권한 경계 요구이며 S3 upload API나 LFS 구현을 직접 명시하지 않는다. EC2 role 위임만으로 R7 전체를 충족했다고도 단정하지 않는다.

R9 원문: “Git diff 외에, 에이전트가 외부 시스템에 한 행동(학습 작업 실행, 모델 공개, 저장소 푸시)을 도구 호출 단위로 저장하고 조회할 수 있어야 한다.” 이는 실행한 외부 행동의 기록 의무다. 모델 공개 기능을 별도 구현하라는 독립 요구나 모든 Bash/Agent transcript의 operator 공개 요구로 읽지는 않는다. 실제로 EC2 내부에서 S3 쓰기나 공개 게시를 수행한다면 그 외부 효과를 기록하는 경계가 필요하다.

따라서 **A4 publisher와 기존 bounded 계약의 검사가 통과한 뒤에는 그 계약 범위의 코드 완료를 판정할 수 있다.** S3·대형 LFS·public 미지원만으로 그 판정을 자동 부정하지 않는다. 전체 이슈의 원문 실제 수용 통과와 Silicon Model Factory 전체 지원은 별도이며, 이번 감사는 어느 쪽도 완료로 주장하지 않는다.


최종 전체 검사는 병행 소스 편집이 끝난 뒤 조정자 gate에서 수행한다. 이 읽기 전용 감사는 코드 합격 판정을 포함하지 않는다.
