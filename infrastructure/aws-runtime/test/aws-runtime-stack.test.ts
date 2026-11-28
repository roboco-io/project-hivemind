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
    // The Control Plane runs all day on Fargate Spot.
    CapacityProviderStrategy: [{ CapacityProvider: 'FARGATE_SPOT', Weight: 1, Base: 1 }],
  });
  // It gets the full two-minute Spot warning to close cleanly.
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([Match.objectLike({ Name: 'control-plane', StopTimeout: 120 })]),
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
      'ModelFactoryTrainingInstanceRole',
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
  const trainDoc = byRole.get('ModelFactoryTrainingInstanceRole') ?? '';

  // Control plane can read GitHub Draft PR secret, HF release secret, run/tag ECS tasks,
  // manage scoped Model Factory EC2 Spot instances, pass ONLY ModelFactoryTrainingInstanceRole to ec2.amazonaws.com,
  // and open SSM Exec channels, never model auth.
  assert.match(cpDoc, /GithubDraftPrSecret/);
  assert.match(cpDoc, /HfReleaseTokenSecret/);
  assert.match(cpDoc, /dsql:DbConnectAdmin/);
  assert.match(cpDoc, /ecs:RunTask/);
  assert.match(cpDoc, /ecs:TagResource/);
  assert.match(cpDoc, /ec2:TerminateInstances/);
  // Subnet AZ IDs order the subnets by the planned AZ order at launch.
  assert.match(cpDoc, /ec2:DescribeSubnets/);
  // Live Spot placement scores rank regions for types the score feed does not list.
  assert.match(cpDoc, /ec2:GetSpotPlacementScores/);
  assert.match(cpDoc, /hivemind-model-factory/);
  assert.match(cpDoc, /ec2\.amazonaws\.com/);
  assert.match(cpDoc, /ModelFactoryTrainingInstanceRole/);
  assert.match(cpDoc, /ssmmessages:OpenDataChannel/);
  assert.doesNotMatch(cpDoc, /ModelSubscriptionAuthSecret/);

  // Training instance role: reads models/*/inputs/*, writes only its own staging folder (Deny on models/*), uses KMS ONLY;
  // NEVER touches Secrets Manager, EC2 control, or delivery prefixes.
  assert.match(trainDoc, /models\/\*\/inputs\/\*/);
  assert.match(trainDoc, /"Effect":"Deny"/);
  assert.match(trainDoc, /kms:GenerateDataKey/);
  assert.doesNotMatch(trainDoc, /secretsmanager:/);
  assert.doesNotMatch(trainDoc, /ec2:/);
  assert.doesNotMatch(trainDoc, /bundles\/\*/);
  assert.doesNotMatch(trainDoc, /GithubDraftPrSecret/);
  assert.doesNotMatch(trainDoc, /HfReleaseTokenSecret/);
  template.hasResourceProperties('AWS::IAM::InstanceProfile', {
    InstanceProfileName: 'hivemind-dev-mf-training-instance-profile',
  });

  // Control Plane execution role reads operator + worker tokens; Worker execution role reads ONLY worker token.
  assert.match(cpExecDoc, /OperatorTokenSecret/);
  assert.match(cpExecDoc, /WorkerTokenSecret/);
  assert.match(wkExecDoc, /WorkerTokenSecret/);
  assert.doesNotMatch(wkExecDoc, /OperatorTokenSecret/);
  // The Control Plane and the hub AI worker (for opted-in Model Factory tasks, issue #20) read the agent token.
  assert.match(cpExecDoc, /AgentTokenSecret/);
  assert.match(wkExecDoc, /AgentTokenSecret/);
  assert.doesNotMatch(workerDoc, /AgentTokenSecret/);
  assert.doesNotMatch(verifierDoc, /AgentTokenSecret/);
  template.hasResourceProperties('AWS::SecretsManager::Secret', {
    Name: 'hivemind-dev/agent-token',
    GenerateSecretString: Match.objectLike({ PasswordLength: 40, ExcludePunctuation: true }),
  });

  // AI worker can read model subscription auth & write patches/sessions, never GitHub/HF/DSQL secrets, operator token, or ECS RunTask.
  assert.match(workerDoc, /ModelSubscriptionAuthSecret/);
  assert.doesNotMatch(workerDoc, /GithubDraftPrSecret/);
  assert.doesNotMatch(workerDoc, /HfReleaseTokenSecret/);
  assert.doesNotMatch(workerDoc, /dsql:/);
  assert.doesNotMatch(workerDoc, /OperatorTokenSecret/);
  assert.doesNotMatch(workerDoc, /ecs:RunTask/);

  // Verifier reads bundles/acceptance/patches & writes only attestations/*, never accesses secrets or DSQL.
  assert.doesNotMatch(verifierDoc, /ModelSubscriptionAuthSecret/);
  assert.doesNotMatch(verifierDoc, /GithubDraftPrSecret/);
  assert.doesNotMatch(verifierDoc, /HfReleaseTokenSecret/);
  assert.doesNotMatch(verifierDoc, /dsql:/);
  assert.doesNotMatch(verifierDoc, /OperatorTokenSecret/);
  assert.match(verifierDoc, /attestations\/\*/);

  // Aurora DSQL serverless collaboration cluster synthesized.
  template.resourceCountIs('AWS::DSQL::Cluster', 1);

  // Autonomous $0-idle multi-region TTL Guard Lambda + 5-minute EventBridge rule synthesized.
  template.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'hivemind-dev-mf-ttl-guard',
    Runtime: 'nodejs22.x',
  });
  template.hasResourceProperties('AWS::Events::Rule', {
    Name: 'hivemind-dev-mf-ttl-guard-5m',
    ScheduleExpression: 'rate(5 minutes)',
  });
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

test('passes the Model Factory region network registry to the Control Plane and limits AMI lookup to public SSM parameters', () => {
  const registry = JSON.stringify({ 'us-east-1': { subnetIds: ['subnet-067ecf91041a44411'] } });
  const withRegistry = JSON.stringify(synth({ modelFactoryRegionNetworksJson: registry }).toJSON());
  assert.ok(withRegistry.includes('HIVEMIND_MF_REGION_NETWORKS_JSON'));
  assert.ok(withRegistry.includes('subnet-067ecf91041a44411'));

  const template = synth();
  assert.ok(!JSON.stringify(template.toJSON()).includes('HIVEMIND_MF_REGION_NETWORKS_JSON'));
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 'ssm:GetParameter',
          Resource: 'arn:aws:ssm:*::parameter/aws/service/*',
        }),
      ]),
    },
  });
});

test('grants the Control Plane spoke ECS orchestration and PassRole only for named spoke regions and roles', () => {
  const spokeRegions = ['us-east-2', 'us-east-1'];
  const spokesJson = JSON.stringify([{ region: 'us-east-2' }]);
  const template = synth({ spokeRegions, spokesJson });
  const policies = Object.values(template.findResources('AWS::IAM::Policy'));
  const statements = policies.flatMap(
    (p) => (p as { Properties: { PolicyDocument: { Statement: Record<string, unknown>[] } } }).Properties.PolicyDocument.Statement,
  );

  const runTask = statements.find((s) => Array.isArray(s.Action) && (s.Action as string[]).includes('ecs:RunTask'));
  const clusters = JSON.stringify((runTask!.Condition as { ArnEquals: Record<string, unknown> }).ArnEquals['ecs:cluster']);
  assert.ok(clusters.includes('arn:aws:ecs:us-east-2:111111111111:cluster/hivemind-dev-us-east-2-cluster'));
  assert.ok(clusters.includes('arn:aws:ecs:us-east-1:111111111111:cluster/hivemind-dev-us-east-1-cluster'));
  assert.ok(!clusters.includes('us-west-2'));

  const spokePassRole = statements.find(
    (s) => s.Action === 'iam:PassRole' && JSON.stringify(s.Resource).includes('us-east-1-worker-exec-role'),
  );
  assert.deepEqual(spokePassRole!.Resource, [
    'arn:aws:iam::111111111111:role/hivemind-dev-us-east-2-worker-exec-role',
    'arn:aws:iam::111111111111:role/hivemind-dev-us-east-2-ai-worker-role',
    'arn:aws:iam::111111111111:role/hivemind-dev-us-east-2-verifier-role',
    'arn:aws:iam::111111111111:role/hivemind-dev-us-east-1-worker-exec-role',
    'arn:aws:iam::111111111111:role/hivemind-dev-us-east-1-ai-worker-role',
    'arn:aws:iam::111111111111:role/hivemind-dev-us-east-1-verifier-role',
  ]);
  assert.deepEqual(spokePassRole!.Condition, { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } });
  assert.ok(JSON.stringify(template.toJSON()).includes('HIVEMIND_AWS_SPOKES_JSON'));

  // Without spokeRegions no spoke PassRole statement and no spokes env exist.
  const base = JSON.stringify(synth().toJSON());
  assert.ok(!base.includes('worker-exec-role'));
  assert.ok(!base.includes('HIVEMIND_AWS_SPOKES_JSON'));
  assert.throws(() => synth({ spokeRegions: ['ap-northeast-2'] }), /Invalid spoke region/);
  assert.throws(() => synth({ spokeRegions: ['not-a-region'] }), /Invalid spoke region/);
});

test('sets HIVEMIND_MF_STORAGE only when the Model Factory ledger is configured for Aurora DSQL', () => {
  assert.ok(!JSON.stringify(synth().toJSON()).includes('HIVEMIND_MF_STORAGE'));
  assert.ok(!JSON.stringify(synth({ modelFactoryStorage: 'sqlite' }).toJSON()).includes('HIVEMIND_MF_STORAGE'));
  const dsql = JSON.stringify(synth({ modelFactoryStorage: 'aurora-dsql' }).toJSON());
  assert.ok(dsql.includes('"Name":"HIVEMIND_MF_STORAGE","Value":"aurora-dsql"'));
  assert.ok(!dsql.includes('HIVEMIND_DELIVERY_STORAGE'), 'the two stores switch independently');
  const delivery = JSON.stringify(synth({ deliveryStorage: 'aurora-dsql' }).toJSON());
  assert.ok(delivery.includes('"Name":"HIVEMIND_DELIVERY_STORAGE","Value":"aurora-dsql"'));
  assert.ok(!delivery.includes('HIVEMIND_MF_STORAGE'));
});

test('TTL Guard Lambda is a bundled asset and gets DSQL ledger access only with the Aurora DSQL ledger', async () => {
  const { createRequire } = await import('node:module');
  const { join } = await import('node:path');
  const { bundleLambda } = await import('../lib/bundle-lambda.ts');

  // The bundle loads in plain Node (pg and repository code included) and exports the handler.
  const bundleDir = bundleLambda('mf-ttl-guard.ts');
  const bundle = createRequire(import.meta.url)(join(bundleDir, 'index.js')) as { handler?: unknown };
  assert.equal(typeof bundle.handler, 'function');
  assert.equal(bundleLambda('mf-ttl-guard.ts'), bundleDir, 'bundling is cached per process');

  const guardEnv = (template: Template) => {
    const fn = Object.values(template.findResources('AWS::Lambda::Function')).find(
      (r) => (r as { Properties: { FunctionName?: string } }).Properties.FunctionName === 'hivemind-dev-mf-ttl-guard',
    ) as { Properties: { Code: Record<string, unknown>; Environment: { Variables: Record<string, unknown> } } };
    assert.ok(fn.Properties.Code.S3Key, 'code is an S3 asset, not inline');
    assert.equal(fn.Properties.Code.ZipFile, undefined);
    return fn.Properties.Environment.Variables;
  };

  const sqlite = synth();
  assert.equal(guardEnv(sqlite).HIVEMIND_MF_STORAGE, undefined);
  assert.equal(guardEnv(sqlite).HIVEMIND_DSQL_ENDPOINT, undefined);
  const guardPolicyOf = (template: Template) =>
    JSON.stringify(Object.entries(template.findResources('AWS::IAM::Policy')).find(([id]) => id.startsWith('ModelFactoryTtlGuardRole'))![1]);
  assert.ok(!guardPolicyOf(sqlite).includes('dsql:'));

  const dsqlTemplate = synth({ modelFactoryStorage: 'aurora-dsql' });
  const env = guardEnv(dsqlTemplate);
  assert.equal(env.HIVEMIND_MF_STORAGE, 'aurora-dsql');
  assert.equal(env.HIVEMIND_DSQL_REGION, 'ap-northeast-2');
  assert.ok(env.HIVEMIND_DSQL_ENDPOINT);
  const guardPolicy = guardPolicyOf(dsqlTemplate);
  assert.ok(guardPolicy.includes('"dsql:DbConnectAdmin"'));
  // The guard still cannot launch instances or read any secret.
  assert.ok(!guardPolicy.includes('ec2:RunInstances'));
  assert.ok(!guardPolicy.includes('secretsmanager'));
});

test('restrictedDsqlRoles removes DbConnectAdmin from both services and names their database roles', () => {
  const policyOf = (template: Template, prefix: string) =>
    JSON.stringify(Object.entries(template.findResources('AWS::IAM::Policy')).find(([id]) => id.startsWith(prefix))![1]);

  const admin = synth({ modelFactoryStorage: 'aurora-dsql' });
  assert.ok(policyOf(admin, 'ControlPlaneTaskRole').includes('dsql:DbConnectAdmin'));
  assert.ok(policyOf(admin, 'ModelFactoryTtlGuardRole').includes('dsql:DbConnectAdmin'));
  assert.ok(!JSON.stringify(admin.toJSON()).includes('HIVEMIND_DSQL_USER'));

  const restricted = synth({ modelFactoryStorage: 'aurora-dsql', restrictedDsqlRoles: true });
  for (const prefix of ['ControlPlaneTaskRole', 'ModelFactoryTtlGuardRole']) {
    const policy = policyOf(restricted, prefix);
    assert.ok(policy.includes('"dsql:DbConnect"'), prefix);
    assert.ok(!policy.includes('dsql:DbConnectAdmin'), `${prefix} must not connect as admin`);
  }
  const json = JSON.stringify(restricted.toJSON());
  assert.ok(json.includes('"Name":"HIVEMIND_DSQL_USER","Value":"hm_control_plane"'));
  assert.ok(json.includes('"Name":"HIVEMIND_DSQL_MANAGE_SCHEMA","Value":"false"'));
  assert.ok(json.includes('"HIVEMIND_DSQL_USER":"hm_ttl_guard"'));
  // The role ARNs the operator script needs are stack outputs.
  restricted.hasOutput('ControlPlaneTaskRoleArn', {});
  restricted.hasOutput('ModelFactoryTtlGuardRoleArn', {});
});

test('verifier role can read model artifacts for release verification but still cannot write them or read any secret', () => {
  const template = synth();
  const policy = JSON.stringify(
    Object.entries(template.findResources('AWS::IAM::Policy')).find(([id]) => id.startsWith('VerifierTaskRole'))![1],
  );
  assert.ok(policy.includes('/models/*'), 'verifier reads models/*');
  assert.ok(policy.includes('/attestations/*'));
  assert.ok(!policy.includes('secretsmanager'));
  assert.ok(!policy.includes('dsql:'));
  assert.ok(!policy.includes('ec2:'));
  // Its only write target is attestations/*: every statement that allows s3:PutObject names that prefix alone.
  const statements = (
    Object.entries(template.findResources('AWS::IAM::Policy')).find(([id]) => id.startsWith('VerifierTaskRole'))![1] as {
      Properties: { PolicyDocument: { Statement: { Action: string | string[]; Resource: unknown }[] } };
    }
  ).Properties.PolicyDocument.Statement;
  for (const statement of statements) {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    if (actions.some((a) => a.startsWith('s3:Put') || a.startsWith('s3:Delete') || a === 's3:*')) {
      assert.ok(JSON.stringify(statement.Resource).includes('/attestations/*'));
      assert.ok(!JSON.stringify(statement.Resource).includes('/models/*'));
    }
  }
});

test('training instances write only their own staging folder and the Control Plane promotes from staging', () => {
  const template = synth();
  const policies = Object.values(template.findResources('AWS::IAM::Policy')) as { Properties: { Roles: unknown; PolicyDocument: { Statement: Record<string, unknown>[] } } }[];
  const statementsOf = (marker: string) =>
    policies.filter((p) => JSON.stringify(p.Properties.Roles).includes(marker)).flatMap((p) => p.Properties.PolicyDocument.Statement);
  const train = statementsOf('ModelFactoryTrainingInstanceRole');
  const put = train.find((st) => st.Sid === 'PutOwnInstanceStagingOnly');
  assert.ok(put, 'staging put statement');
  assert.match(JSON.stringify(put.Resource), /\/staging\/\$\{aws:userid\}\/\*/);
  const deny = train.find((st) => st.Sid === 'DenyWritingModelsDirectly');
  assert.equal(deny?.Effect, 'Deny');
  assert.match(JSON.stringify(deny?.Resource), /\/models\/\*"/);
  // No allow statement lets the instance put anywhere else.
  for (const st of train.filter((st) => st.Effect === 'Allow')) {
    if (JSON.stringify(st.Action).includes('s3:PutObject')) assert.equal(st.Sid, 'PutOwnInstanceStagingOnly');
  }
  const cp = JSON.stringify(statementsOf('ControlPlaneTaskRole'));
  assert.match(cp, /\/staging\/\*/);
  const env = JSON.stringify(template.findResources('AWS::ECS::TaskDefinition'));
  assert.match(env, /HIVEMIND_MF_TRAINING_ROLE_ID/);
  template.hasResourceProperties('AWS::S3::Bucket', {
    LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ Id: 'expire-training-staging', Prefix: 'staging/' })]) },
  });
});

test('agent credentials parent role is separate, assumable only by the Control Plane and capped at 900 seconds', () => {
  const template = synth();
  const roles = template.findResources('AWS::IAM::Role') as Record<string, { Properties: { RoleName?: string; AssumeRolePolicyDocument: unknown; MaxSessionDuration?: number } }>;
  const [parentId, parent] = Object.entries(roles).find(([, r]) => r.Properties.RoleName === 'hivemind-dev-agent-credentials-parent-role')!;
  assert.ok(parent);
  assert.equal(parent.Properties.MaxSessionDuration, 3600);
  const trust = JSON.stringify(parent.Properties.AssumeRolePolicyDocument);
  assert.match(trust, /ControlPlaneTaskRole/);
  assert.doesNotMatch(trust, /Service/);

  const policies = Object.values(template.findResources('AWS::IAM::Policy')) as { Properties: { Roles: unknown; PolicyDocument: { Statement: Record<string, unknown>[] } } }[];
  const parentStatements = policies.filter((p) => JSON.stringify(p.Properties.Roles).includes(parentId)).flatMap((p) => p.Properties.PolicyDocument.Statement);
  const gsc = parentStatements.find((st) => st.Sid === 'ScopeDownAtMost900Seconds');
  assert.deepEqual(gsc?.Condition, { NumericLessThanEquals: { 'sts:DurationSeconds': 900 } });
  const actions = new Set(parentStatements.flatMap((st) => [st.Action].flat() as string[]));
  assert.deepEqual([...actions].sort(), [
    'ec2:DescribeInstanceTypeOfferings',
    'ec2:DescribeSpotPriceHistory',
    'ec2:GetSpotPlacementScores',
    'kms:Decrypt',
    'kms:GenerateDataKey',
    's3:GetObject',
    's3:ListBucket',
    's3:PutObject',
    'sts:GetScopedCredentials',
  ]);
  const doc = JSON.stringify(parentStatements);
  assert.doesNotMatch(doc, /iam:|secretsmanager:|ec2:RunInstances|s3:DeleteObject/);

  const cp = JSON.stringify(policies.filter((p) => JSON.stringify(p.Properties.Roles).includes('ControlPlaneTaskRole')).map((p) => p.Properties.PolicyDocument));
  assert.match(cp, /sts:AssumeRole/);
  const env = JSON.stringify(template.findResources('AWS::ECS::TaskDefinition'));
  assert.match(env, /HIVEMIND_AGENT_CREDENTIALS_PARENT_ROLE_ARN/);
  assert.match(env, /spot-placement-read,model-inputs-upload,model-artifacts-read/);
  assert.match(env, /HIVEMIND_ARTIFACTS_KMS_KEY_ARN/);
});

test('the MCP tunnel role can only find the Control Plane task and port-forward to it', () => {
  const template = synth();
  const roles = template.findResources('AWS::IAM::Role') as Record<string, { Properties: { RoleName?: string; AssumeRolePolicyDocument: unknown; MaxSessionDuration?: number } }>;
  const [roleId, role] = Object.entries(roles).find(([, r]) => r.Properties.RoleName === 'hivemind-dev-mcp-tunnel-role')!;
  assert.equal(role.Properties.MaxSessionDuration, 43200);
  assert.match(JSON.stringify(role.Properties.AssumeRolePolicyDocument), /:root/);
  const policies = Object.values(template.findResources('AWS::IAM::Policy')) as { Properties: { Roles: unknown; PolicyDocument: { Statement: Record<string, unknown>[] } } }[];
  const statements = policies.filter((p) => JSON.stringify(p.Properties.Roles).includes(roleId)).flatMap((p) => p.Properties.PolicyDocument.Statement);
  const actions = [...new Set(statements.flatMap((st) => [st.Action].flat() as string[]))].sort();
  assert.deepEqual(actions, ['ecs:DescribeServices', 'ecs:DescribeTasks', 'ecs:ListTasks', 'ssm:ResumeSession', 'ssm:StartSession', 'ssm:TerminateSession']);
  const start = statements.find((st) => st.Sid === 'PortForwardToControlPlaneTasks')!;
  const startResources = JSON.stringify(start.Resource);
  assert.match(startResources, /document\/AWS-StartPortForwardingSession/);
  assert.match(startResources, /:task\//);
  assert.doesNotMatch(startResources, /"\*"/);
  const list = statements.find((st) => st.Sid === 'ListControlPlaneTasks')!;
  assert.ok(JSON.stringify(list.Condition).includes('ecs:cluster'));
  assert.doesNotMatch(JSON.stringify(statements), /UpdateService|ExecuteCommand|iam:|secretsmanager:/);
  template.hasOutput('McpTunnelRoleArn', {});
});

test('the Control Plane may publish only to the configured notification topic', () => {
  const topic = 'arn:aws:sns:us-east-2:123456789012:smf-budget';
  const withTopic = synth({ notifyTopicArn: topic });
  const docs = JSON.stringify(withTopic.findResources('AWS::IAM::Policy'));
  assert.match(docs, /"sns:Publish"/);
  assert.match(docs, /arn:aws:sns:us-east-2:123456789012:smf-budget/);
  assert.match(JSON.stringify(withTopic.findResources('AWS::ECS::TaskDefinition')), /HIVEMIND_NOTIFY_TOPIC_ARN/);
  const without = synth();
  assert.doesNotMatch(JSON.stringify(without.findResources('AWS::IAM::Policy')), /sns:Publish/);
  assert.throws(() => synth({ notifyTopicArn: 'arn:aws:sqs:us-east-2:123456789012:x' }), /SNS topic ARN/);
});

test('workers reach the Control Plane by a Cloud Map name that follows task replacement', () => {
  const template = synth();
  template.resourceCountIs('AWS::ServiceDiscovery::PrivateDnsNamespace', 1);
  const namespaces = template.findResources('AWS::ServiceDiscovery::PrivateDnsNamespace');
  const name = (Object.values(namespaces)[0] as { Properties: { Name: string } }).Properties.Name;
  assert.match(name, /\.internal$/);
  template.hasResourceProperties('AWS::ServiceDiscovery::Service', {
    Name: 'control-plane',
    DnsConfig: Match.objectLike({ DnsRecords: [{ Type: 'A', TTL: 10 }] }),
  });
  template.hasResourceProperties('AWS::ECS::Service', {
    CapacityProviderStrategy: [{ CapacityProvider: 'FARGATE_SPOT', Weight: 1, Base: 1 }],
    ServiceRegistries: Match.anyValue(),
  });
  template.hasResourceProperties('AWS::ECS::TaskDefinition', {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Name: 'control-plane',
        Environment: Match.arrayWith([{ Name: 'HIVEMIND_CONTROL_API_URL', Value: `http://control-plane.${name}:4310` }]),
      }),
    ]),
  });
});
