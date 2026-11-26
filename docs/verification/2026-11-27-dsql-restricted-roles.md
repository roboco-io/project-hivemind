# 2026-11-27 검증 보고서 — Aurora DSQL 접속을 제한된 DB 역할로 전환

이 문서는 Control Plane과 TTL Guard Lambda가 Aurora DSQL에 `admin`이 아닌 제한된 DB 역할로 접속하도록 바꾼 내용과 실 AWS 확인 결과를 기록한다. 대상 계정은 `<AWS_ACCOUNT_ID>`, 프로필은 `roboco`, 클러스터는 서울의 `h5uil5myqct7chhnr7qrbtbwiq`다. 아래 값은 2026-11-27에 직접 실행해 얻었다.

## 1. 바꾸기 전의 문제

두 서비스 모두 IAM 권한 `dsql:DbConnectAdmin`으로 DSQL의 `admin` 역할에 접속했다. `admin`은 클러스터의 모든 테이블을 만들고 지울 수 있다. 서비스가 실제로 하는 일은 행을 읽고 쓰는 것뿐이므로, 서비스나 그 IAM 역할이 탈취되면 필요 이상의 권한이 넘어가는 상태였다.

## 2. 바꾼 내용

DB 역할 두 개를 만들고 테이블 단위로 권한을 줬다.

| DB 역할 | 연결된 IAM 역할 | 권한 |
|---|---|---|
| `hm_control_plane` | Control Plane 작업 역할 | 협업 4개, Model Factory 3개, SW 전달 3개 테이블에 `SELECT`, `INSERT`, `UPDATE` |
| `hm_ttl_guard` | TTL Guard Lambda 역할 | `hm_mf_jobs`와 `hm_mf_meta`에 `SELECT`, `INSERT`, `UPDATE`, `hm_mf_events`에 `INSERT` |

두 역할 모두 `DELETE`, 테이블 생성·삭제, 역할 생성 권한이 없다. `hm_ttl_guard`는 협업과 SW 전달 테이블에 접근할 수 없다.

제한된 역할은 테이블을 만들 수 없다. 그래서 테이블 생성, 역할 생성, IAM 연결, 권한 부여를 운영자가 관리자 권한으로 한 번 실행하는 스크립트(`scripts/aws-dsql-apply-roles.ts`)로 옮겼고, 서비스는 `HIVEMIND_DSQL_MANAGE_SCHEMA=false`일 때 DDL을 실행하지 않는다. CDK 설정 `restrictedDsqlRoles`를 켜면 두 서비스의 IAM 권한이 `dsql:DbConnectAdmin`에서 `dsql:DbConnect`로 바뀌고, 접속할 역할 이름이 환경 변수로 들어간다. 이 설정의 기본값은 꺼짐이며, 꺼져 있으면 이전처럼 `admin`으로 접속한다.

## 3. DSQL의 동작을 실험으로 확인한 것

공식 문서에 명시되지 않은 부분이 있어, 같은 클러스터에서 임시 역할과 임시 테이블로 실험한 뒤 모두 지웠다.

| 확인한 것 | 결과 |
|---|---|
| `CREATE ROLE ... IF NOT EXISTS` | 구문 오류. 이미 있는 역할은 SQLSTATE `42710`으로 실패한다. |
| `AWS IAM GRANT`를 두 번 실행 | 두 번 다 성공한다. |
| 한 트랜잭션에 `GRANT` 두 개 | "multiple ddl statements not supported in a transaction"으로 실패한다. |
| `GRANT USAGE ON SCHEMA public` | "feature not supported on system entity"로 실패한다. |
| `public` 테이블에 테이블 단위 권한만 준 역할 | 접속해서 읽고 쓸 수 있다. 스키마 사용 권한은 필요 없다. |
| `INSERT` 권한만으로 upsert | 권한 오류. `UPDATE`도 필요하다. |
| 제한된 역할의 테이블 생성, 역할 생성, 권한 없는 테이블 조회 | 모두 권한 오류로 거절된다. |
| IAM 연결 직후의 접속 | 첫 실험에서 한 번 접속이 거절됐고, 재시도를 넣은 두 번째 실험에서는 첫 시도에 성공했다. 반영 지연인지는 확정하지 못했다. |

## 4. 실 AWS 반영과 확인

반영 순서는 다음과 같았다. 서비스가 접속하지 못하는 구간이 생기지 않도록 역할을 먼저 만들고 그다음 서비스를 전환했다.

1. 역할 ARN을 스택 출력에 추가하는 Hub 배포. 이때 서비스는 아직 `admin`으로 접속한다.
2. `scripts/aws-dsql-apply-roles.ts` 실행. 27개 문장이 모두 적용됐고, 두 DB 역할의 IAM 연결과 위 표의 테이블 권한이 조회됐다.
3. 새 Control Plane 이미지 푸시.
4. `HIVEMIND_RESTRICTED_DSQL_ROLES=1`로 Hub 배포. 배포 전 `cdk diff`에서 바뀌는 것은 두 IAM 정책의 DSQL 권한, Control Plane 작업 정의의 환경 변수 2개, Lambda의 환경 변수 1개였다.

전환 후 확인한 내용은 다음과 같다.

- 배포된 Control Plane 역할의 정책에서 DSQL 관련 권한은 `dsql:DbConnect` 하나다(`iam get-role-policy`로 조회).
- Control Plane 기동 로그에 `dsqlUser: hm_control_plane`, `manageSchema: false`가 기록됐다.
- stdio MCP로 연결해 `hivemind_status`가 세 저장소를 모두 읽었다(전달 5건, Model Factory 5건, 협업 4건).
- 쓰기도 확인했다. 협업 세션을 만들고 하위 작업과 메시지를 추가한 뒤 `cancelled`로 끝냈다. Model Factory 초안을 만들고 취소했다. 두 기록 모두 과금 자원을 만들지 않는 초안이다.
- TTL Guard Lambda를 호출했고 오류 없이 끝났다.
- 확인 후 Control Plane은 `desiredCount 0`이고 5개 리전의 관리 대상 실행 인스턴스는 0대였다.

## 5. 한계와 미검증 항목

- **`hm_ttl_guard` 역할의 실제 DSQL 쓰기는 이 문서의 확인 시점에는 실행되지 않았다.** Lambda는 종료할 인스턴스가 있을 때만 DSQL에 접속한다. 같은 날 뒤이은 스케줄 정산 실증에서 이 역할로 정산이 기록되는 것을 확인했다([기록](2026-11-26-dsql-ledger-ttl-guard-settlement-proof.md)의 4-1절).
- **SW 전달 저장소의 쓰기는 이번에 실행하지 않았다.** 읽기와 정리 도구 호출만 했다. 권한은 Model Factory 저장소와 같은 방식으로 부여했다.
- **`admin` 접속 경로는 운영자에게 남아 있다.** 스키마 변경과 실증 스크립트는 운영자의 IAM 권한으로 `admin`에 접속한다. 줄인 것은 서비스의 권한이다.
- **새 테이블이 필요해지면 운영자가 스크립트를 다시 실행해야 한다.** 서비스가 스스로 테이블을 만들지 않기 때문이다. 스크립트는 여러 번 실행해도 결과가 같다.
