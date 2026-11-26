#!/usr/bin/env bash
# 서울 Hub 스택(HivemindAwsRuntimeStack)을 배포한다. Control Plane 서비스는 desiredCount 0으로 유지한다.
# 사용법: AWS_PROFILE=<profile> scripts/aws-deploy-hub.sh [diff|deploy]
#
# 배포된 Spoke 스택의 출력에서 다음 설정을 만든다.
#   HIVEMIND_SPOKE_REGIONS            Control Plane 역할에 ECS·PassRole 권한을 줄 Spoke 리전
#   HIVEMIND_MF_REGION_NETWORKS_JSON  Model Factory의 리전별 기본 서브넷·보안 그룹·AMI 조회 파라미터
# HIVEMIND_MF_STORAGE(기본 aurora-dsql)는 Model Factory 원장의 저장소를,
# HIVEMIND_DELIVERY_STORAGE(기본 aurora-dsql)는 SW 전달 작업의 저장소를 정한다.
# HIVEMIND_AWS_SPOKES_JSON은 넣지 않는다. Spoke의 Fargate 워커가 Control Plane에 접속하려면 VPC Peering이
# 필요한데 아직 없기 때문이다. Peering을 배포한 뒤 HIVEMIND_DEPLOY_SPOKES_JSON=1 로 켠다.
# 이 스크립트는 비밀 값을 읽지 않는다.
set -euo pipefail

MODE="${1:-diff}"
PRIMARY_REGION="${HIVEMIND_AWS_REGION:-ap-northeast-2}"
SPOKE_REGIONS="${HIVEMIND_SPOKE_REGIONS:-us-east-2,us-east-1,us-west-2,ap-northeast-1}"
# "none" 은 Spoke 없이 Hub 만 배포한다(부트스트랩의 첫 Hub 배포, 또는 Spoke 를 쓰지 않는 구성).
if [[ "$SPOKE_REGIONS" == "none" ]]; then SPOKE_REGIONS=""; fi
AMI_PARAM="${HIVEMIND_MF_AMI_SSM_PARAMETER:-/aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-amazon-linux-2023/latest/ami-id}"
OUTPUTS_DIR="${HIVEMIND_SPOKE_OUTPUTS_DIR:-/tmp}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

ENV_JSON="$(PRIMARY_REGION="$PRIMARY_REGION" SPOKE_REGIONS="$SPOKE_REGIONS" AMI_PARAM="$AMI_PARAM" python3 - <<'PY'
import json, os, subprocess
ami = os.environ["AMI_PARAM"]
networks = {os.environ["PRIMARY_REGION"]: {"amiSsmParameter": ami}}
spokes = []
for region in [r for r in os.environ["SPOKE_REGIONS"].split(",") if r]:
    suffix = "".join(p.capitalize() for p in region.split("-"))
    outputs = json.loads(subprocess.check_output([
        "aws", "cloudformation", "describe-stacks", "--region", region,
        "--stack-name", f"HivemindAwsSpoke{suffix}Stack", "--query", "Stacks[0].Outputs", "--output", "json"]))
    out = {o["OutputKey"]: o["OutputValue"] for o in outputs}
    subnets = out["SpokePublicSubnetIds"].split(",")
    groups = [out["SpokeWorkerSecurityGroupId"]]
    networks[region] = {"subnetIds": subnets, "securityGroupIds": groups, "amiSsmParameter": ami}
    spokes.append({"region": region, "clusterArn": out["SpokeClusterArn"],
                   "workerTaskDefinition": out["SpokeAiWorkerTaskDefArn"],
                   "verifierTaskDefinition": out["SpokeVerifierTaskDefArn"],
                   "subnets": subnets, "securityGroups": groups})
print(json.dumps({"networks": networks, "spokes": spokes}, separators=(",", ":")))
PY
)"

export HIVEMIND_AWS_ACCOUNT_ID="$ACCOUNT_ID"
export HIVEMIND_AWS_REGION="$PRIMARY_REGION"
export HIVEMIND_CONTROL_PLANE_DESIRED_COUNT=0
if [[ -n "$SPOKE_REGIONS" ]]; then export HIVEMIND_SPOKE_REGIONS="$SPOKE_REGIONS"; else unset HIVEMIND_SPOKE_REGIONS; fi
export HIVEMIND_MF_STORAGE="${HIVEMIND_MF_STORAGE:-aurora-dsql}"
export HIVEMIND_DELIVERY_STORAGE="${HIVEMIND_DELIVERY_STORAGE:-aurora-dsql}"
# 기본값 1: Control Plane과 TTL Guard가 제한된 DB 역할로 DSQL에 접속한다. 이 계정에는 2026-11-27에
# scripts/aws-dsql-apply-roles.ts 를 적용했다. 새 계정이나 새 클러스터에서는 그 스크립트를 먼저 실행해야 하며,
# 실행 전에는 HIVEMIND_RESTRICTED_DSQL_ROLES=0 으로 배포한다. 0으로 배포하면 서비스가 admin 으로 접속한다.
export HIVEMIND_RESTRICTED_DSQL_ROLES="${HIVEMIND_RESTRICTED_DSQL_ROLES:-1}"
HIVEMIND_MF_REGION_NETWORKS_JSON="$(python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1])["networks"], separators=(",", ":")))' "$ENV_JSON")"
export HIVEMIND_MF_REGION_NETWORKS_JSON
if [[ "${HIVEMIND_DEPLOY_SPOKES_JSON:-0}" == "1" ]]; then
  HIVEMIND_AWS_SPOKES_JSON="$(python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1])["spokes"], separators=(",", ":")))' "$ENV_JSON")"
  export HIVEMIND_AWS_SPOKES_JSON
else
  unset HIVEMIND_AWS_SPOKES_JSON
fi

cd "$(dirname "$0")/../infrastructure/aws-runtime"
case "$MODE" in
  diff)
    cdk diff HivemindAwsRuntimeStack --app 'node --import tsx bin/app.ts'
    ;;
  deploy)
    cdk deploy HivemindAwsRuntimeStack --app 'node --import tsx bin/app.ts' --require-approval never \
      --outputs-file "${OUTPUTS_DIR}/hivemind-aws-runtime-outputs.json"
    ;;
  *)
    echo "usage: $0 [diff|deploy]" >&2
    exit 1
    ;;
esac
