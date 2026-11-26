import { App } from 'aws-cdk-lib';
import { AwsRuntimeStack } from '../lib/aws-runtime-stack.ts';
import { AwsComputeSpokeStack } from '../lib/aws-spoke-stack.ts';

const app = new App();
const accountId = process.env.HIVEMIND_AWS_ACCOUNT_ID;
const primaryRegion = process.env.HIVEMIND_AWS_REGION ?? 'ap-northeast-2';
const resourcePrefix = process.env.HIVEMIND_AWS_PREFIX ?? 'hivemind-runtime';
const controlPlaneDesiredCount = Number(process.env.HIVEMIND_CONTROL_PLANE_DESIRED_COUNT ?? '1');
if (!accountId) {
  throw new Error('HIVEMIND_AWS_ACCOUNT_ID is required to synthesize HIVEMIND AWS stacks');
}

const spokeRegion = process.env.HIVEMIND_SPOKE_REGION?.trim();
if (spokeRegion) {
  const stackSuffix = spokeRegion
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  const required = (name: string): string => {
    const val = process.env[name]?.trim();
    if (!val) throw new Error(`${name} is required to synthesize AwsComputeSpokeStack`);
    return val;
  };
  const allowedRegions = (process.env.HIVEMIND_ALLOWED_REGIONS ?? `${primaryRegion},${spokeRegion}`)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  new AwsComputeSpokeStack(app, `HivemindAwsSpoke${stackSuffix}Stack`, {
    env: { account: accountId, region: spokeRegion },
    configuration: {
      accountId,
      region: spokeRegion,
      allowedRegions,
      primaryRegion,
      resourcePrefix,
      vpcCidr: required('HIVEMIND_SPOKE_VPC_CIDR'),
      primaryArtifactsBucketArn: required('HIVEMIND_PRIMARY_ARTIFACTS_BUCKET_ARN'),
      primaryArtifactKeyArn: required('HIVEMIND_PRIMARY_ARTIFACT_KEY_ARN'),
      workerImageUri: required('HIVEMIND_WORKER_IMAGE_URI'),
      verifierImageUri: required('HIVEMIND_VERIFIER_IMAGE_URI'),
      workerTokenSecretArn: required('HIVEMIND_SPOKE_WORKER_TOKEN_SECRET_ARN'),
      modelAuthSecretArn: required('HIVEMIND_SPOKE_MODEL_AUTH_SECRET_ARN'),
      primaryHubVpcCidr: process.env.HIVEMIND_PRIMARY_HUB_VPC_CIDR ?? '10.0.0.0/16',
    },
  });
} else {
  new AwsRuntimeStack(app, 'HivemindAwsRuntimeStack', {
    env: { account: accountId, region: primaryRegion },
    configuration: {
      accountId,
      region: primaryRegion,
      allowedRegions: [primaryRegion],
      resourcePrefix,
      controlPlaneDesiredCount,
    },
  });
}
