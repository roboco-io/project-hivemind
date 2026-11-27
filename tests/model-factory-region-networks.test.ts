import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ModelFactoryOrchestrator,
  parseRegionNetworkRegistry,
} from '../apps/control-plane/src/model-factory-orchestrator.js';
import type { Ec2SpotTrainerPort } from '../packages/adapters/src/aws-ec2-spot-trainer.js';
import type { S3ObjectPort } from '../packages/adapters/src/aws-s3-artifacts.js';
import { createAwsPublicAmiResolver } from '../packages/adapters/src/aws-ssm-public-ami.js';
import type { CreateModelFactoryJob } from '../packages/contracts/src/model-factory.js';
import { ModelFactoryStore } from '../packages/core/src/model-factory.js';

const FIVE_REGIONS = ['ap-northeast-2', 'us-east-2', 'us-east-1', 'us-west-2', 'ap-northeast-1'];
const DLAMI_PARAM = '/aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-amazon-linux-2023/latest/ami-id';

type Launch = Parameters<Ec2SpotTrainerPort['launchSpotInstance']>[0];

function jobInput(compute: Partial<CreateModelFactoryJob['compute']>): CreateModelFactoryJob {
  return {
    title: 'Region registry routing',
    modelId: 'smf-tiny-v1',
    repository: 'roboco-io/silicon-model-factory',
    baseCommit: 'a'.repeat(40),
    compute: {
      region: 'us-east-2',
      instanceType: 'g5.xlarge',
      amiId: 'ami-0123456789abcdef0',
      maxLifetimeMs: 3_600_000,
      maxHourlyPriceUsd: 0.45,
      maxTotalCostMicros: 500_000,
      s3ArtifactPrefix: 'models/smf-tiny-v1/run-registry',
      ...compute,
    },
    releasePolicy: { mode: 's3_artifact_only', visibility: 'private', releaseCheckCommand: ['node', 'tools/release-check.mjs'] },
  };
}

function fakeEc2(failRegions: Record<string, string> = {}) {
  const launches: Launch[] = [];
  const port: Ec2SpotTrainerPort = {
    async launchSpotInstance(input) {
      launches.push(input);
      const failure = failRegions[input.region];
      if (failure) throw new Error(failure);
      return {
        region: input.region,
        availabilityZone: `${input.region}a`,
        instanceId: `i-${String(launches.length).padStart(17, '0')}`,
        instanceType: input.instanceType,
        amiId: input.amiId,
        state: 'pending',
      };
    },
    async describeInstance() {
      throw new Error('not used');
    },
    async terminateInstance(_region, instanceId) {
      return { instanceId, state: 'terminated' };
    },
    async sweepExpiredSpotInstances(region) {
      return { region, checkedCount: 0, terminated: [] };
    },
  };
  return { port, launches };
}

const emptyS3: S3ObjectPort = {
  async putObject() {
    throw new Error('not used');
  },
  async getObject(key) {
    throw new Error(`NoSuchKey: ${key}`);
  },
};

test('parseRegionNetworkRegistry accepts valid entries and fails closed on bad regions, fields and IDs', () => {
  assert.equal(parseRegionNetworkRegistry(undefined, FIVE_REGIONS), undefined);
  assert.equal(parseRegionNetworkRegistry('  ', FIVE_REGIONS), undefined);
  const parsed = parseRegionNetworkRegistry(
    JSON.stringify({
      'us-east-1': {
        subnetIds: ['subnet-067ecf91041a44411'],
        securityGroupIds: ['sg-02c88111a9073a681'],
        amiSsmParameter: DLAMI_PARAM,
      },
      'us-west-2': { amiId: 'ami-0aaaaaaaaaaaaaaa1' },
    }),
    FIVE_REGIONS,
  );
  assert.deepEqual(parsed?.['us-east-1'], {
    subnetIds: ['subnet-067ecf91041a44411'],
    securityGroupIds: ['sg-02c88111a9073a681'],
    amiSsmParameter: DLAMI_PARAM,
  });
  assert.deepEqual(parsed?.['us-west-2'], { amiId: 'ami-0aaaaaaaaaaaaaaa1' });

  const bad: [string, RegExp][] = [
    ['not json', /not valid JSON/],
    ['[]', /object keyed by region/],
    [JSON.stringify({ 'eu-west-1': {} }), /outside the allowlist/],
    [JSON.stringify({ 'us-east-1': { subnetIds: ['subnet-XYZ'] } }), /Invalid us-east-1\.subnetIds/],
    [JSON.stringify({ 'us-east-1': { subnetIds: [] } }), /1\.\.8/],
    [JSON.stringify({ 'us-east-1': { securityGroupIds: ['subnet-067ecf91041a44411'] } }), /securityGroupIds/],
    [JSON.stringify({ 'us-east-1': { amiId: 'ami-nope' } }), /amiId/],
    [JSON.stringify({ 'us-east-1': { amiSsmParameter: '/hivemind/private/ami' } }), /amiSsmParameter/],
    [JSON.stringify({ 'us-east-1': { amiSsmParameter: '/aws/service/../x' } }), /amiSsmParameter/],
    [JSON.stringify({ 'us-east-1': { instanceProfileArn: 'x' } }), /unknown field/],
  ];
  for (const [raw, pattern] of bad) {
    assert.throws(() => parseRegionNetworkRegistry(raw, FIVE_REGIONS), pattern, raw);
  }
});

test('registry supplies subnet, SG and SSM-resolved AMI for a non-primary region; capacity failover walks registry subnets', async () => {
  const store = new ModelFactoryStore(':memory:', { globalBudgetCapMicros: 1_000_000 });
  const ec2 = fakeEc2({ 'us-east-2': 'InsufficientInstanceCapacity: no g5 capacity' });
  const resolved: [string, string][] = [];
  const attempts: { region: string; outcome: string; subnetId?: string }[] = [];
  const orchestrator = new ModelFactoryOrchestrator({
    store,
    ec2: ec2.port,
    s3: emptyS3,
    onPlacementAttempt: (a) => {
      attempts.push({ region: a.region, outcome: a.outcome, ...(a.subnetId ? { subnetId: a.subnetId } : {}) });
      if (a.outcome === 'launched') throw new Error('audit sink failure must be ignored');
    },
    regionNetworks: {
      'us-east-2': { subnetIds: ['subnet-0bedc9f4179d6205f'], securityGroupIds: ['sg-0e3ac45935e27429c'] },
      'us-east-1': {
        subnetIds: ['subnet-067ecf91041a44411', 'subnet-0062d4a4b2c083c5f'],
        securityGroupIds: ['sg-02c88111a9073a681'],
        amiSsmParameter: DLAMI_PARAM,
      },
    },
    amiResolver: {
      async resolveAmiId(region, parameterName) {
        resolved.push([region, parameterName]);
        return 'ami-0bbbbbbbbbbbbbbb2';
      },
    },
  });
  try {
    const job = await store.create(jobInput({ candidateRegions: ['us-east-2', 'us-east-1'] }));
    const launched = await orchestrator.approveAndLaunchTraining(job.id, job.approvalFingerprint, 'ok');

    assert.equal(launched.status, 'training_running', launched.failureReason ?? '');
    assert.equal(launched.instance?.region, 'us-east-1');
    assert.equal(launched.instance?.amiId, 'ami-0bbbbbbbbbbbbbbb2');
    // Primary region keeps the job's own AMI and takes only network defaults from the registry.
    assert.equal(ec2.launches[0]!.region, 'us-east-2');
    assert.equal(ec2.launches[0]!.amiId, 'ami-0123456789abcdef0');
    assert.equal(ec2.launches[0]!.subnetId, 'subnet-0bedc9f4179d6205f');
    assert.deepEqual(ec2.launches[0]!.securityGroupIds, ['sg-0e3ac45935e27429c']);
    const last = ec2.launches.at(-1)!;
    assert.equal(last.subnetId, 'subnet-067ecf91041a44411');
    assert.deepEqual(last.securityGroupIds, ['sg-02c88111a9073a681']);
    assert.deepEqual(resolved, [['us-east-1', DLAMI_PARAM]]);
    assert.deepEqual(attempts, [
      { region: 'us-east-2', outcome: 'capacity_failover', subnetId: 'subnet-0bedc9f4179d6205f' },
      { region: 'us-east-1', outcome: 'launched', subnetId: 'subnet-067ecf91041a44411' },
    ]);
  } finally {
    await store.close();
  }
});

test('job regionOverrides win over the registry, and a failed AMI lookup skips that region without launching', async () => {
  const store = new ModelFactoryStore(':memory:', { globalBudgetCapMicros: 2_000_000 });
  const ec2 = fakeEc2({ 'us-east-2': 'InsufficientInstanceCapacity' });
  const orchestrator = new ModelFactoryOrchestrator({
    store,
    ec2: ec2.port,
    s3: emptyS3,
    regionNetworks: {
      'us-east-1': { subnetIds: ['subnet-067ecf91041a44411'], amiSsmParameter: DLAMI_PARAM },
      'us-west-2': { subnetIds: ['subnet-0270e259a3b61b6e3'], securityGroupIds: ['sg-03219f5a356b9f260'], amiId: 'ami-0ccccccccccccccc3' },
    },
    amiResolver: {
      async resolveAmiId() {
        throw new Error('AWS SSM GetParameter failed with HTTP 400');
      },
    },
  });
  try {
    const job = await store.create(
      jobInput({
        candidateRegions: ['us-east-2', 'us-east-1', 'us-west-2'],
        regionOverrides: { 'us-west-2': { amiId: 'ami-0ddddddddddddddd4', subnetIds: ['subnet-0db24b6d58afff2b9'] } },
      }),
    );
    const launched = await orchestrator.approveAndLaunchTraining(job.id, job.approvalFingerprint, 'ok');
    assert.equal(launched.status, 'training_running', launched.failureReason ?? '');
    assert.equal(launched.instance?.region, 'us-west-2');
    assert.deepEqual(ec2.launches.map((l) => l.region), ['us-east-2', 'us-west-2']);
    const last = ec2.launches.at(-1)!;
    assert.equal(last.amiId, 'ami-0ddddddddddddddd4');
    assert.equal(last.subnetId, 'subnet-0db24b6d58afff2b9');
    assert.deepEqual(last.securityGroupIds, ['sg-03219f5a356b9f260']);

    // When every region fails, the AMI lookup failure is reported in the job error.
    const job2 = await store.create(jobInput({ candidateRegions: ['us-east-2', 'us-east-1'], s3ArtifactPrefix: 'models/smf-tiny-v1/run-registry-2' }));
    const failed = await orchestrator.approveAndLaunchTraining(job2.id, job2.approvalFingerprint, 'ok');
    assert.equal(failed.status, 'failed');
    assert.match(failed.failureReason ?? '', /us-east-1: AMI lookup failed/);
  } finally {
    await store.close();
  }
});

test('createAwsPublicAmiResolver signs AmazonSSM.GetParameter per region and rejects non-public names and bad values', async () => {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  let value: unknown = 'ami-0eeeeeeeeeeeeeee5';
  const resolver = createAwsPublicAmiResolver({
    allowedRegions: FIVE_REGIONS,
    credentials: () => ({ accessKeyId: 'AKIAEXAMPLE123456', secretAccessKey: 'never-leak', sessionToken: 'st' }),
    now: () => Date.parse('2026-11-26T03:00:00.000Z'),
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), headers: init?.headers as Record<string, string>, body: String(init?.body ?? '') });
      return new Response(JSON.stringify({ Parameter: { Value: value } }), { status: 200 });
    },
  });

  assert.equal(await resolver.resolveAmiId('us-west-2', DLAMI_PARAM), 'ami-0eeeeeeeeeeeeeee5');
  assert.equal(new URL(calls[0]!.url).hostname, 'ssm.us-west-2.amazonaws.com');
  assert.equal(calls[0]!.headers['x-amz-target'], 'AmazonSSM.GetParameter');
  assert.deepEqual(JSON.parse(calls[0]!.body), { Name: DLAMI_PARAM });
  assert.match(calls[0]!.headers.authorization!, /Credential=AKIAEXAMPLE123456\/20261126\/us-west-2\/ssm\/aws4_request/);

  await assert.rejects(() => resolver.resolveAmiId('eu-west-1', DLAMI_PARAM), /region/i);
  await assert.rejects(() => resolver.resolveAmiId('us-west-2', '/hivemind/private/ami'), /public parameter/);
  value = 'not-an-ami';
  await assert.rejects(() => resolver.resolveAmiId('us-west-2', DLAMI_PARAM), /valid AMI ID/);
  assert.equal(calls.length, 2);
});

test('when every subnet has no Spot capacity the job is recorded as failed and its budget is released, however long the AWS messages are', async () => {
  const store = new ModelFactoryStore(':memory:', { globalBudgetCapMicros: 2_000_000 });
  // The real message of 2026-11-27 (g6.xlarge, us-east-2). Three of them joined were longer than the
  // 1000-character limit of the failure reason; recording the failure then threw, and the job stayed
  // `training_queued` with its budget reserved.
  const awsMessage =
    'AWS EC2 RunInstances failed (InsufficientInstanceCapacity): We currently do not have sufficient g6.xlarge capacity in the Availability Zone you requested (us-east-2a). ' +
    'Our system will be working on provisioning additional capacity. You can currently get g6.xlarge capacity by not specifying an Availability Zone in your request or choosing us-east-2b, us-east-2c.';
  const ec2 = fakeEc2({ 'us-east-2': awsMessage });
  const details: string[] = [];
  const orchestrator = new ModelFactoryOrchestrator({
    store,
    ec2: ec2.port,
    s3: emptyS3,
    onPlacementAttempt: (a) => void details.push(a.detail ?? ''),
    regionNetworks: {
      'us-east-2': { subnetIds: ['subnet-0bedc9f4179d6205f', 'subnet-0c829ce6bf93df89f', 'subnet-051b400e25bc0b9f0', 'subnet-0aaaaaaaaaaaaaaa1'], securityGroupIds: ['sg-0e3ac45935e27429c'] },
    },
  });
  try {
    const job = await store.create(jobInput({}));
    assert.ok(awsMessage.length * 4 > 1000);
    const result = await orchestrator.approveAndLaunchTraining(job.id, job.approvalFingerprint, 'ok');
    assert.equal(ec2.launches.length, 4, 'every subnet was tried');
    assert.equal(result.status, 'failed');
    assert.equal(result.waitReason, null);
    assert.equal(result.cost.settledMicros, 0, 'nothing ran, so nothing is charged');
    assert.equal((await store.ledger()).totalReservedMicros, 0, 'the reservation is released');
    // The stored reason names every attempt by place and AWS error code and fits the field.
    assert.ok(result.failureReason!.length <= 1000);
    assert.match(result.failureReason!, /No Spot capacity for .* in 4 placement attempt\(s\)/);
    assert.equal(result.failureReason!.match(/InsufficientInstanceCapacity/g)!.length, 4);
    assert.match(result.failureReason!, /us-east-2\/subnet-051b400e25bc0b9f0: InsufficientInstanceCapacity/);
    // The full AWS text is still available in the placement log events.
    assert.ok(details.every((d) => d.includes('provisioning additional capacity')));
  } finally {
    await store.close();
  }
});

test('recording a failure never fails on its own length', async () => {
  const store = new ModelFactoryStore(':memory:', { globalBudgetCapMicros: 2_000_000 });
  try {
    const job = await store.create(jobInput({}));
    const failed = await store.fail(job.id, 'x'.repeat(5000), 'd'.repeat(5000));
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureReason!.length, 1000);
    assert.ok(failed.failureReason!.endsWith('…'));
    assert.equal(failed.diagnostics.at(-1)!.length, 1000);
  } finally {
    await store.close();
  }
});
