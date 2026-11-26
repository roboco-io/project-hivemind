import assert from 'node:assert/strict';
import test from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsComputeSpokeStack } from '../lib/aws-spoke-stack.ts';

function synthSpoke(region = 'us-east-2') {
  const app = new App();
  const stack = new AwsComputeSpokeStack(app, `TestSpoke-${region}`, {
    env: { account: '111111111111', region },
    fixture: true,
    configuration: {
      accountId: '111111111111',
      region,
      allowedRegions: ['ap-northeast-2', 'us-east-2', 'us-east-1', 'us-west-2', 'ap-northeast-1'],
      primaryRegion: 'ap-northeast-2',
      resourcePrefix: 'hivemind-dev',
      vpcCidr: '10.1.0.0/16',
      primaryArtifactsBucketArn: 'arn:aws:s3:::hivemind-dev-111111111111-ap-northeast-2-artifacts',
      primaryArtifactKeyArn: 'arn:aws:kms:ap-northeast-2:111111111111:key/00000000-0000-0000-0000-000000000000',
      workerImageUri: '111111111111.dkr.ecr.ap-northeast-2.amazonaws.com/hivemind-dev-worker:latest',
      verifierImageUri: '111111111111.dkr.ecr.ap-northeast-2.amazonaws.com/hivemind-dev-verifier:latest',
      workerTokenSecretArn: 'arn:aws:secretsmanager:us-east-2:111111111111:secret:hivemind-dev/worker-token-AAAAAA',
      modelAuthSecretArn: 'arn:aws:secretsmanager:us-east-2:111111111111:secret:hivemind-dev/model-subscription-auth-BBBBBB',
      primaryHubVpcCidr: '10.0.0.0/16',
    },
  });
  return Template.fromStack(stack);
}

test('synthesizes stateless $0-idle multi-region compute spoke with zero NAT/EIP/ALB/inbound rules and strict secret isolation', () => {
  const template = synthSpoke('us-east-2');
  // Zero fixed-cost networking or always-on services in spoke region.
  template.resourceCountIs('AWS::EC2::NatGateway', 0);
  template.resourceCountIs('AWS::EC2::EIP', 0);
  template.resourceCountIs('AWS::ECS::Service', 0);
  template.resourceCountIs('AWS::EFS::FileSystem', 0);

  template.hasResourceProperties('AWS::ECS::ClusterCapacityProviderAssociations', {
    CapacityProviders: ['FARGATE', 'FARGATE_SPOT'],
    DefaultCapacityProviderStrategy: [{ CapacityProvider: 'FARGATE_SPOT', Weight: 1, Base: 0 }],
  });

  // Zero inbound rules on spoke worker SG.
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    SecurityGroupIngress: Match.absent(),
  });

  // Strict secret isolation: NO OperatorTokenSecret or GithubDraftPrSecret anywhere in spoke; Verifier gets zero secrets.
  const rawJson = JSON.stringify(template.toJSON());
  assert.doesNotMatch(rawJson, /operator-token/i);
  assert.doesNotMatch(rawJson, /github-draft-pr/i);

  const policies = template.findResources('AWS::IAM::Policy') as Record<
    string,
    { Properties?: { Roles?: unknown; PolicyDocument?: unknown } }
  >;
  let verifierDoc = '';
  let workerDoc = '';
  for (const policy of Object.values(policies)) {
    const roles = JSON.stringify(policy.Properties?.Roles ?? []);
    const doc = JSON.stringify(policy.Properties?.PolicyDocument ?? {});
    if (roles.includes('SpokeVerifierTaskRole')) verifierDoc += doc;
    if (roles.includes('SpokeAiWorkerTaskRole')) workerDoc += doc;
  }
  assert.match(workerDoc, /model-subscription-auth/);
  assert.doesNotMatch(verifierDoc, /model-subscription-auth/);
  assert.doesNotMatch(verifierDoc, /secretsmanager/);
  assert.match(verifierDoc, /attestations\/\*/);
});

test('rejects deploying a spoke stack into the primaryRegion itself', () => {
  assert.throws(() => synthSpoke('ap-northeast-2'), /spoke region must differ from primaryRegion/);
});
