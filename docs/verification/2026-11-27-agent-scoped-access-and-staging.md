# 에이전트 최소 권한 자격 증명과 인스턴스별 쓰기 범위 실증 (이슈 #19)

2026-11-27에 실제 AWS(서울 Hub, us-east-2 학습 리전)에서 이슈 #19의 완료 조건 1-4를 확인했다. 배포한 코드는 커밋 `4f1b416`이다. 이 커밋에는 Hugging Face 비공개 게시 수정(`83ce8dc`)도 함께 들어 있다. 계정 ID, 예산 금액, 토큰 위치는 이 문서에 적지 않는다.

## 배포

`npm run bootstrap -- --rebuild-images --skip-client-config`로 이미지 3종을 다시 빌드하고 Hub를 배포했다. 배포 전 `scripts/aws-deploy-hub.sh diff`의 변경은 리소스 7개였다. 부모 역할과 그 정책 추가, 아티팩트 버킷 수명 주기 규칙 추가, Control Plane 역할 정책 변경, 학습 인스턴스 역할 정책 변경, Control Plane 작업 정의 변경, TTL Guard Lambda 코드 갱신이다. 작업 폴더에 다른 세션의 커밋되지 않은 변경이 있어서, 푸시된 커밋으로 만든 별도 worktree에서 배포했다.

## 완료 조건 1: 스팟 배치 조회 자격 증명과 범위 밖 호출

Control Plane API로 `spot-placement-read`(300초) 자격 증명을 받아 AWS CLI로 호출했다. 받은 세션의 주체는 `hivemind-runtime-agent-credentials-parent-role`의 맡은 역할 세션이었다.

| 호출 | 결과 |
|---|---|
| `ec2 get-spot-placement-scores` | 허용 |
| `ec2 describe-spot-price-history` (us-east-2) | 허용 |
| `ec2 describe-spot-price-history` (us-west-1, 허용 리전 밖) | `UnauthorizedOperation` |
| `s3api list-objects-v2` (다른 모델의 `runs/`) | `AccessDenied` |
| `s3api head-object` (다른 모델의 영수증) | 403 |
| `iam list-roles` | `AccessDenied` |
| `ec2 describe-instances` | `UnauthorizedOperation` |

다른 두 목적도 확인했다. `model-inputs-upload`(시험 모델)은 자기 `inputs/`에 쓰기와 목록 조회만 허용됐고, 다른 모델의 `inputs/`, 자기 `runs/`, 스팟 배치 조회는 거절됐다. `model-artifacts-read`는 자기 `runs/` 읽기만 허용됐고, 다른 모델 목록 조회와 자기 `runs/` 쓰기는 거절됐다.

## 완료 조건 2: 만료와 CloudTrail

요청한 수명이 300초, 120초, 60초일 때 STS가 돌려준 만료 시각은 각각 요청 시각에서 약 300초, 120초, 60초 뒤였다. 로컬 시계와 비교했기 때문에 1초 정도의 차이가 있다. CloudTrail(ap-northeast-2)에는 `GetScopedCredentials` 이벤트 4건이 오류 없이 남았다. 각 이벤트의 `requestParameters.scopedSessionDescription`은 `hivemind-agent <목적> <modelId>`였고, `durationSeconds`는 요청한 값과 같았다. Control Plane 로그에는 발급 4건과 거절 5건이 목적, 대상, 정책 해시, 만료 시각과 함께 남았다. 같은 시간대 로그에서 `ASIA`(임시 접근 키 접두사)를 찾은 결과는 0건이었다.

## 완료 조건 3: 거절

| 요청 | 결과 |
|---|---|
| 목록에 없는 목적(`iam-admin`) | 400 |
| `modelId`가 `../verilog-embed-base` 또는 `*` | 400 |
| `modelId` 없이 `model-inputs-upload` | 400 |
| `durationSeconds` 3600 | 400 |
| 운영자 토큰 없음 | 401 |
| 본문에 `Action: "*"` 정책을 넣은 요청 | 200. 넣은 정책은 쓰이지 않았고, 정책 해시는 목적 틀의 해시와 같았다 |

GSC 호출 실패 시 부모 자격 증명을 돌려주지 않는 동작은 단위 테스트(`tests/agent-access.test.ts`)로만 확인했다. 실제 AWS에서 GSC 실패를 일부러 일으키지는 않았다.

## 완료 조건 4: 학습 인스턴스의 쓰기 범위

`t3.micro` 스팟 인스턴스로 시험 학습 작업(`mf-55e0ea3b-…`)을 1개 실행했다. 사용자 데이터는 다섯 위치에 파일을 쓰려고 시도한 결과를 산출물로 올리고 종료한다. 부트스트랩은 `HIVEMIND_ARTIFACT_PREFIX`를 `staging/<역할 ID>:<인스턴스 ID>`로 정했다.

| 쓰기 대상 | 결과 |
|---|---|
| 자기 스테이징 폴더 | 허용 |
| 자기 작업 접두사(`models/hivemind-probe/runs/...`) | `AccessDenied` |
| 다른 작업의 `runs/` | `AccessDenied` |
| `models/hivemind-probe/inputs/` | `AccessDenied` |
| 다른 스테이징 폴더 | `AccessDenied` |

거절된 위치에는 객체가 생기지 않았다. Control Plane의 점검(wake)은 스테이징 영수증을 읽고 산출물을 작업 접두사로 복사했으며, 작업은 `evaluating`으로 넘어갔다. 영수증의 `s3Prefix`는 작업 접두사로 기록됐다. 인스턴스는 약 40초 실행됐다. 비용은 60초분 334 마이크로달러로 정산됐다. 이 값은 시간당 상한가 기준의 추정이며 실제 청구는 확인하지 않았다. 확인 후 시험 작업은 취소했고, 5개 리전의 관리 대상 실행 EC2는 0대였다.

## 함께 확인한 것

시험 작업을 등록할 때 Control Plane이 직접 EC2 현재 배치 점수를 조회해 `placementPlan`(`ranked`)을 만들었다. 피드에 없는 `t3.micro`라서 현재 점수만 사용했다. 2026-11-27 배포한 리전·AZ 시도 순서 기능의 실제 AWS 확인이기도 하다.

공개 승인 후 게시에 실패해 `release_approved`로 남아 있던 `mf-03e58064-…`는 읽기로만 확인했다. 게시 기록이 없고 영수증(파일 20개)이 작업 접두사를 가리키므로 `publish-release`의 조건을 갖췄다. 실제 게시는 사람의 승인에 따라 다른 세션이 실행한다.

## 남은 한계

에이전트는 운영자 토큰으로 발급 API를 호출한다. 그래서 AWS 권한은 목적별로 좁아지지만, Control Plane 안에서는 여전히 모든 운영자 동작을 할 수 있다. 스테이징 복사는 한 파일당 5 GiB까지만 된다.
