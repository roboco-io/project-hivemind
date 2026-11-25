import assert from 'node:assert/strict';
import test from 'node:test';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AwsRuntimeStack } from '../lib/aws-runtime-stack.ts';

function synth(overrides: Partial<ConstructorParameters<typeof AwsRuntimeStack>[2]['configuration']> = {}) {
  const app = new App();
  const stack = new AwsRuntimeStack(app, 'TestAwsRuntimeStack', {
    env: { account: '111111111111', region: overrides.region ?? 'ap-northeast-2' },
    fixture: true,
    configuration: {
      accountId: '111111111111',
      region: 'ap-northeast-2',
      resourcePrefix: 'hivemind-dev',
      ...overrides,
    },
  });
  return Template.fromStack(stack);
}

test('synthesizes NAT-free, zero-public-ingress SSM-tunneled Control Plane + Spot-first ECS cluster', () => {
  const template = synth();
  template.hasResourceProperties('AWS::ECS::Cluster', {
    ClusterName: 'hivemind-dev-cluster',
  });
  template.hasResourceProperties('AWS::ECS::ClusterCapacityProviderAssociations', {
    CapacityProviders: ['FARGATE', 'FARGATE_SPOT'],
    DefaultCapacityProviderStrategy: [{ CapacityProvider: 'FARGATE_SPOT', Weight: 1, Base: 0 }],
  });
  template.hasResourceProperties('AWS::S3::Bucket', {
    VersioningConfiguration: { Status: 'Enabled' },
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true,
    },
  });
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    Family: 'hivemind-dev-ai-worker',
    RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
    EphemeralStorage: { SizeInGiB: 50 },
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({ Name: 'ai-worker', StopTimeout: 120 }),
    ]),
  });
  template.hasResourceProperties('AWS::ECS::Service', {
    ServiceName: 'hivemind-dev-control-plane',
    DesiredCount: 1,
    EnableExecuteCommand: true,
    NetworkConfiguration: {
      AwsvpcConfiguration: { AssignPublicIp: 'ENABLED' },
    },
    CapacityProviderStrategy: [{ CapacityProvider: 'FARGATE', Weight: 1, Base: 1 }],
  });
  // NAT-free architecture: zero NAT Gateways and zero Elastic IPs.
  template.resourceCountIs('AWS::EC2::NatGateway', 0);
  template.resourceCountIs('AWS::EC2::EIP', 0);
  template.hasResourceProperties('AWS::EFS::AccessPoint', {
    PosixUser: { Uid: '1000', Gid: '1000' },
    RootDirectory: { Path: '/hivemind-data', CreationInfo: { OwnerUid: '1000', OwnerGid: '1000', Permissions: '0750' } },
  });
  // Zero public CIDR ingress rules anywhere in the VPC (SSM tunnel + VPC SG-to-SG only).
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: 'HIVEMIND hivemind-dev Control Plane SG (zero public inbound; SSM tunnel + VPC workers only)',
    SecurityGroupIngress: Match.absent(),
  });
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: 'HIVEMIND hivemind-dev Fargate Spot worker/verifier SG (zero inbound)',
    SecurityGroupIngress: Match.absent(),
  });
  const ingressRules = template.findResources('AWS::EC2::SecurityGroupIngress');
  for (const rule of Object.values(ingressRules) as { Properties?: { CidrIp?: string } }[]) {
    assert.equal(rule.Properties?.CidrIp, undefined, 'No public CidrIp ingress rules permitted under SSM mode');
  }
});

test('enforces strict 3-way secret separation across Control Plane, AI Worker, Verifier, and Execution roles', () => {
  const template = synth();
  const policies = template.findResources('AWS::IAM::Policy') as Record<
    string,
    { Properties?: { Roles?: unknown; PolicyDocument?: unknown } }
  >;
  const byRole = new Map<string, string>();
  for (const policy of Object.values(policies)) {
    const roles = JSON.stringify(policy.Properties?.Roles ?? []);
    const doc = JSON.stringify(policy.Properties?.PolicyDocument ?? {});
    for (const marker of [
      'ControlPlaneTaskRole',
      'AiWorkerTaskRole',
      'VerifierTaskRole',
      'ControlPlaneExecutionRole',
      'WorkerExecutionRole',
    ]) {
      if (roles.includes(marker)) {
        byRole.set(marker, (byRole.get(marker) ?? '') + doc);
      }
    }
  }
  const cpDoc = byRole.get('ControlPlaneTaskRole') ?? '';
  const workerDoc = byRole.get('AiWorkerTaskRole') ?? '';
  const verifierDoc = byRole.get('VerifierTaskRole') ?? '';
  const cpExecDoc = byRole.get('ControlPlaneExecutionRole') ?? '';
  const wkExecDoc = byRole.get('WorkerExecutionRole') ?? '';

  // Control plane can read GitHub Draft PR secret, run/tag ECS tasks, and open SSM Exec channels, never model auth.
  assert.match(cpDoc, /GithubDraftPrSecret/);
  assert.match(cpDoc, /ecs:RunTask/);
  assert.match(cpDoc, /ecs:TagResource/);
  assert.match(cpDoc, /ssmmessages:OpenDataChannel/);
  assert.doesNotMatch(cpDoc, /ModelSubscriptionAuthSecret/);

  // Control Plane execution role reads operator + worker tokens; Worker execution role reads ONLY worker token.
  assert.match(cpExecDoc, /OperatorTokenSecret/);
  assert.match(cpExecDoc, /WorkerTokenSecret/);
  assert.match(wkExecDoc, /WorkerTokenSecret/);
  assert.doesNotMatch(wkExecDoc, /OperatorTokenSecret/);

  // AI worker can read model subscription auth & write patches/sessions, never GitHub secret, operator token, or ECS RunTask.
  assert.match(workerDoc, /ModelSubscriptionAuthSecret/);
  assert.doesNotMatch(workerDoc, /GithubDraftPrSecret/);
  assert.doesNotMatch(workerDoc, /OperatorTokenSecret/);
  assert.doesNotMatch(workerDoc, /ecs:RunTask/);

  // Verifier reads bundles/acceptance/patches & writes only attestations/*, never accesses secrets.
  assert.doesNotMatch(verifierDoc, /ModelSubscriptionAuthSecret/);
  assert.doesNotMatch(verifierDoc, /GithubDraftPrSecret/);
  assert.doesNotMatch(verifierDoc, /OperatorTokenSecret/);
  assert.match(verifierDoc, /attestations\/\*/);
});

test('rejects unapproved region unless explicitly allowlisted and rejects placeholder account without fixture flag', () => {
  assert.throws(() => synth({ region: 'us-east-2' }), /region/i);
  const ohio = synth({ region: 'us-east-2', allowedRegions: ['ap-northeast-2', 'us-east-2'] });
  ohio.hasResourceProperties('AWS::ECS::Cluster', { ClusterName: 'hivemind-dev-cluster' });

  const app = new App();
  assert.throws(
    () =>
      new AwsRuntimeStack(app, 'BadAccount', {
        env: { account: '111111111111', region: 'ap-northeast-2' },
        configuration: {
          accountId: '111111111111',
          region: 'ap-northeast-2',
          resourcePrefix: 'hivemind-prod',
        },
      }),
    /Explicit AWS runtime deployment configuration required/,
  );
});
