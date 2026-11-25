import { App } from 'aws-cdk-lib';
import { AwsRuntimeStack } from '../lib/aws-runtime-stack.ts';

const app = new App();
const accountId = process.env.HIVEMIND_AWS_ACCOUNT_ID;
const region = process.env.HIVEMIND_AWS_REGION ?? 'ap-northeast-2';
const resourcePrefix = process.env.HIVEMIND_AWS_PREFIX ?? 'hivemind-runtime';
const controlPlaneDesiredCount = Number(process.env.HIVEMIND_CONTROL_PLANE_DESIRED_COUNT ?? '1');
if (!accountId) {
  throw new Error('HIVEMIND_AWS_ACCOUNT_ID is required to synthesize AwsRuntimeStack');
}

new AwsRuntimeStack(app, 'HivemindAwsRuntimeStack', {
  env: { account: accountId, region },
  configuration: {
    accountId,
    region,
    allowedRegions: [region],
    resourcePrefix,
    controlPlaneDesiredCount,
  },
});
