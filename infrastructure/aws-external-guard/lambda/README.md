# AWS TTL guard Lambda

## Overview

주기 이벤트와 일회성 timer 이벤트를 검증하고, 소유권이 일치하는 만료 EC2의 종료와 미연결 EBS 삭제를 요청한다.

## Interface

- `handler(event, context)`는 환경의 manifest/schema/digest/group ARN을 읽고 서울 리전 boto3 EC2·DynamoDB client를 만든 뒤 `enforce`를 호출한다. 실패는 `ValueError('Guard unavailable')`로 정리한다. [guard.py:`handler`]
- `enforce(event, manifest, group_arn, ec2, now_ms, registry)`는 `periodic` 또는 `timer` 이벤트를 받아 `terminationRequests`, `volumeDeletionRequests`를 반환한다. 만료 전 timer는 두 값 0과 `early: True`를 반환한다. [guard.py:`enforce`]
- `identity`, `request_profile`, `binding`은 manifest, 요청과 DynamoDB 소유권 binding을 검증한다. `resource_tags`, `owned_tags`, `owned_instance_absent`, `deletable_volume`, `sweep_volumes`는 리소스 소유권·삭제 조건을 검사하는 내부 협력 함수다. [guard.py:`identity`, `request_profile`, `binding`, `resource_tags`, `owned_tags`, `owned_instance_absent`, `deletable_volume`, `sweep_volumes`]
- `FIELDS`는 요청의 정확한 필드 집합과 binding hash 입력 순서를 정의한다. `canonical`은 키 정렬 JSON을 만든다. [guard.py:`FIELDS`, `canonical`]

## Invariants

- schema 1, `broker_uuid_registry_v1`, 서울 리전의 동일 계정 ARN, 1~16개 profile과 manifest digest가 일치해야 한다. 이벤트는 종류별 정확한 필드 집합을 요구한다. [guard.py:`identity`, `enforce`]
- request는 UUID v4 소유권, SHA-256 client/parameter hash, 유일한 workload/configuration profile과 고정 quote 금액을 요구한다. binding은 consistent read 결과의 필드, digest, canonical request, binding hash와 timer ARN을 모두 대조한다. [guard.py:`request_profile`, `binding`]
- EC2 종료는 ownership 태그·binding·instance profile·계정·리전·LaunchTime·TTL과 종료 가능한 상태를 검사한 뒤 요청한다. [guard.py:`enforce`]
- EBS는 만료되고 `available`이며 `Attachments == []`인 볼륨만 후보가 된다. 관련 instance가 없거나 종료됐음을 확인하고 삭제 직전 볼륨을 재조회한다. 연결 해제 경로는 없다. [guard.py:`deletable_volume`, `owned_instance_absent`, `sweep_volumes`]
- 목록 조회는 최대 100페이지이며 반복·잘못된 next token을 거절한다. EC2 검사와 볼륨 검사 예산은 각각 10000개다. [guard.py:`enforce`, `owned_instance_absent`, `sweep_volumes`]

## Side Effects

- DynamoDB `get_item`과 EC2 `describe_instances`, `describe_volumes`를 호출한다. 조건에 맞으면 `terminate_instances`, `delete_volume`을 요청한다. 반환 개수는 요청 수이며 실제 부재나 청구 종료를 증명하지 않는다. [guard.py:`binding`, `enforce`, `owned_instance_absent`, `sweep_volumes`]
- 환경 변수와 현재 시각을 읽는다. 코드에 이벤트·자격 증명·소유권 태그를 직접 로그로 출력하는 호출은 없다. [guard.py:`handler`]

## Verification

- `infrastructure/aws-external-guard`에서 `npm test`를 실행한다. Lambda만 검사하려면 같은 위치에서 `python3 -m unittest discover -s lambda -p 'test_*.py'`를 실행한다. [../package.json:`scripts.test`]
- fake boto3 검증은 실제 AWS 종료나 비용 상한을 입증하지 않는다.
