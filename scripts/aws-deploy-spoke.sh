#!/usr/bin/env bash
# 무상태 $0/hr Compute Spoke 스택을 한 리전에 배포한다.
# 사용법: AWS_PROFILE=<profile> scripts/aws-deploy-spoke.sh <spoke-region> <vpc-cidr>
# 예:     AWS_PROFILE=roboco scripts/aws-deploy-spoke.sh us-east-1 10.2.0.0/16
#
# 복제하는 비밀은 worker-token, model-subscription-auth 2종뿐이다.
# operator-token, github-draft-pr, hf-release-token 은 서울 Hub 전용이며 복제하지 않는다.
# 이 스크립트는 비밀 값을 읽거나 출력하지 않는다(메타데이터 조회와 복제 요청만 수행).
set -euo pipefail

SPOKE_REGION="${1:?spoke region required}"
VPC_CIDR="${2:?spoke VPC CIDR required}"
PRIMARY_REGION="${HIVEMIND_AWS_REGION:-ap-northeast-2}"
PREFIX="${HIVEMIND_AWS_PREFIX:-hivemind-runtime}"
ALLOWED_REGIONS="${HIVEMIND_ALLOWED_REGIONS:-ap-northeast-2,us-east-2,us-east-1,us-west-2,ap-northeast-1}"
OUTPUTS_DIR="${HIVEMIND_SPOKE_OUTPUTS_DIR:-/tmp}"

if [[ "$SPOKE_REGION" == "$PRIMARY_REGION" ]]; then
  echo "spoke region must differ from primary region" >&2
  exit 1
fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="${PREFIX}-${ACCOUNT_ID}-${PRIMARY_REGION}-artifacts"
KEY_ID="$(aws s3api get-bucket-encryption --region "$PRIMARY_REGION" --bucket "$BUCKET" \
  --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.KMSMasterKeyID' --output text)"
KEY_ARN="$(aws kms describe-key --region "$PRIMARY_REGION" --key-id "$KEY_ID" --query KeyMetadata.Arn --output text)"

replica_arn() {
  local name="$1"
  local replicated
  replicated="$(aws secretsmanager describe-secret --region "$PRIMARY_REGION" --secret-id "$name" \
    --query "ReplicationStatus[?Region=='${SPOKE_REGION}'].Region | [0]" --output text)"
  if [[ "$replicated" != "$SPOKE_REGION" ]]; then
    aws secretsmanager replicate-secret-to-regions --region "$PRIMARY_REGION" --secret-id "$name" \
      --add-replica-regions "Region=${SPOKE_REGION}" --query 'ReplicationStatus[].[Region,Status]' --output text >&2
  fi
  local status=""
  for _ in $(seq 1 30); do
    status="$(aws secretsmanager describe-secret --region "$PRIMARY_REGION" --secret-id "$name" \
      --query "ReplicationStatus[?Region=='${SPOKE_REGION}'].Status | [0]" --output text)"
    [[ "$status" == "InSync" ]] && break
    sleep 2
  done
  if [[ "$status" != "InSync" ]]; then
    echo "secret ${name} replication to ${SPOKE_REGION} is ${status}" >&2
    exit 1
  fi
  aws secretsmanager describe-secret --region "$SPOKE_REGION" --secret-id "$name" --query ARN --output text
}

for forbidden in operator-token github-draft-pr hf-release-token; do
  leaked="$(aws secretsmanager describe-secret --region "$PRIMARY_REGION" --secret-id "${PREFIX}/${forbidden}" \
    --query "ReplicationStatus[?Region=='${SPOKE_REGION}'].Region | [0]" --output text 2>/dev/null || echo None)"
  if [[ "$leaked" == "$SPOKE_REGION" ]]; then
    echo "${PREFIX}/${forbidden} must never be replicated to ${SPOKE_REGION}" >&2
    exit 1
  fi
done

WORKER_TOKEN_ARN="$(replica_arn "${PREFIX}/worker-token")"
MODEL_AUTH_ARN="$(replica_arn "${PREFIX}/model-subscription-auth")"

STACK_SUFFIX="$(echo "$SPOKE_REGION" | awk -F- '{for(i=1;i<=NF;i++){printf toupper(substr($i,1,1)) substr($i,2)}}')"
STACK_NAME="HivemindAwsSpoke${STACK_SUFFIX}Stack"
ECR="${ACCOUNT_ID}.dkr.ecr.${PRIMARY_REGION}.amazonaws.com"

cd "$(dirname "$0")/../infrastructure/aws-runtime"
HIVEMIND_AWS_ACCOUNT_ID="$ACCOUNT_ID" \
HIVEMIND_AWS_REGION="$PRIMARY_REGION" \
HIVEMIND_AWS_PREFIX="$PREFIX" \
HIVEMIND_SPOKE_REGION="$SPOKE_REGION" \
HIVEMIND_ALLOWED_REGIONS="$ALLOWED_REGIONS" \
HIVEMIND_SPOKE_VPC_CIDR="$VPC_CIDR" \
HIVEMIND_PRIMARY_ARTIFACTS_BUCKET_ARN="arn:aws:s3:::${BUCKET}" \
HIVEMIND_PRIMARY_ARTIFACT_KEY_ARN="$KEY_ARN" \
HIVEMIND_WORKER_IMAGE_URI="${HIVEMIND_WORKER_IMAGE_URI:-${ECR}/${PREFIX}-worker:latest}" \
HIVEMIND_VERIFIER_IMAGE_URI="${HIVEMIND_VERIFIER_IMAGE_URI:-${ECR}/${PREFIX}-verifier:latest}" \
HIVEMIND_SPOKE_WORKER_TOKEN_SECRET_ARN="$WORKER_TOKEN_ARN" \
HIVEMIND_SPOKE_MODEL_AUTH_SECRET_ARN="$MODEL_AUTH_ARN" \
cdk deploy "$STACK_NAME" \
  --app 'node --import tsx bin/app.ts' \
  --output "cdk.out.spoke-${SPOKE_REGION}" \
  --require-approval never \
  --outputs-file "${OUTPUTS_DIR}/hivemind-aws-spoke-${SPOKE_REGION}-outputs.json"

echo "deployed ${STACK_NAME}; outputs: ${OUTPUTS_DIR}/hivemind-aws-spoke-${SPOKE_REGION}-outputs.json"
