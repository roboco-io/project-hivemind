import assert from 'node:assert/strict';
import test from 'node:test';
import { ComputeOrchestrator } from '../apps/control-plane/src/compute-orchestrator.js';
import { AwsEc2SpotTrainer, parseStateTransitionTime, type Ec2SpotTrainerPort, type LaunchSpotInstanceInput } from '../packages/adapters/src/aws-ec2-spot-trainer.js';
import type { S3ObjectPort } from '../packages/adapters/src/aws-s3-artifacts.js';
import type { CreateComputeJob } from '../packages/contracts/src/compute.js';
import { ComputeStore } from '../packages/core/src/compute.js';

// Findings of the first real GPU trial run (2026-11-27, docs/verification/2026-11-27-smf-gpu-trial-run.md).

function jobInput(compute: Partial<CreateComputeJob['compute']> = {}): CreateComputeJob {
  return {
    title: 'Trial findings',
    workloadId: 'smf-trial',
    repository: 'roboco-io/silicon-model-factory',
    baseCommit: 'a'.repeat(40),
    compute: {
      region: 'us-east-2', instanceType: 'g4dn.xlarge', amiId: 'ami-0123456789abcdef0', maxLifetimeMs: 2_700_000,
      maxHourlyPriceUsd: 0.4, maxTotalCostMicros: 300_000, s3ArtifactPrefix: 'models/smf-trial/runs/r1', ...compute,
    },
    releasePolicy: { mode: 's3_artifact_only', visibility: 'private', releaseCheckCommand: ['node', 'check.mjs'] },
  };
}
const emptyS3 = { async getObject() { throw new Error('NoSuchKey'); } } as unknown as S3ObjectPort;

test('the end time of an instance is read from the EC2 state transition reason', () => {
  assert.equal(parseStateTransitionTime('User initiated (2026-11-27 02:23:56 GMT)'), '2026-11-27T02:23:56.000Z');
  assert.equal(parseStateTransitionTime('Server.SpotInstanceTermination: Spot instance termination (2026-11-27 02:23:56 GMT)'), '2026-11-27T02:23:56.000Z');
  for (const none of [null, '', 'User initiated', 'User initiated (yesterday)', '(2026-13-45 99:99:99 GMT)']) assert.equal(parseStateTransitionTime(none), null);
});

/** Launches one instance, then reports it as ended with the given transition time. */
function endedInstance(transitionOffsetMs: number | null) {
  let launchedAtMs = 0;
  const launches: LaunchSpotInstanceInput[] = [];
  const port: Ec2SpotTrainerPort = {
    async launchSpotInstance(input) {
      launches.push(input);
      launchedAtMs = Date.now();
      return { region: input.region, availabilityZone: 'us-east-2a', instanceId: 'i-0123456789abcdef0', instanceType: input.instanceType, amiId: input.amiId, state: 'pending' };
    },
    async describeInstance(region, instanceId) {
      return {
        region, instanceId, state: 'shutting-down', availabilityZone: 'us-east-2a', launchTime: null,
        stateReason: 'Client.InstanceInitiatedShutdown: Instance initiated shutdown',
        stateTransitionTime: transitionOffsetMs === null ? null : new Date(launchedAtMs + transitionOffsetMs).toISOString(),
        tags: {},
      };
    },
    async terminateInstance(_region, instanceId) { return { instanceId, state: 'terminated' }; },
    async sweepExpiredSpotInstances(region) { return { region, checkedCount: 0, terminated: [] }; },
  };
  return { port, launches, launchedAt: () => launchedAtMs };
}

test('an instance that ended before the check noticed it is settled for its real run time, not up to the check', async () => {
  // Real case: the instance ran about 60 s, the 5-minute check noticed it 328 s after launch and settled 328 s.
  for (const [name, offsetMs, expectedSeconds] of [
    ['EC2 reports the end time', 60_000, 60],
    ['a longer run is counted to its end', 390_000, 390],
    ['no time from EC2: counted up to the check', null, 668],
    ['a time before the launch is ignored', -5_000, 668],
    ['a time after the check is ignored', 9_000_000, 668],
  ] as const) {
    const store = new ComputeStore(':memory:', { globalBudgetCapMicros: 2_000_000 });
    const ec2 = endedInstance(offsetMs);
    let nowMs = Date.now();
    const orchestrator = new ComputeOrchestrator({ store, ec2: ec2.port, s3: emptyS3, now: () => nowMs });
    try {
      const job = await store.create(jobInput());
      const running = await orchestrator.approveAndLaunch(job.id, job.approvalFingerprint, 'ok');
      const launchedMs = Date.parse(running.instance!.launchedAt);
      nowMs = launchedMs + 668_000;
      const woken = await orchestrator.wakeJob(job.id);
      assert.equal(woken.cost.instanceSeconds, expectedSeconds, name);
      assert.equal(woken.cost.settledMicros, Math.ceil((expectedSeconds * 0.4 * 1_000_000) / 3600), name);
      if (expectedSeconds !== 668) {
        const endedMs = Date.parse(woken.instance!.terminatedAt!);
        assert.ok(Math.abs(endedMs - (ec2.launchedAt() + offsetMs!)) < 5, `${name}: the recorded end time is EC2's`);
      }
    } finally {
      await store.close();
    }
  }
});

test('a forced termination is still counted up to the termination, whatever EC2 reported before', async () => {
  const store = new ComputeStore(':memory:', { globalBudgetCapMicros: 2_000_000 });
  let launchedAtMs = 0;
  const port: Ec2SpotTrainerPort = {
    async launchSpotInstance(input) { launchedAtMs = Date.now(); return { region: input.region, availabilityZone: 'us-east-2a', instanceId: 'i-0123456789abcdef0', instanceType: input.instanceType, amiId: input.amiId, state: 'pending' }; },
    async describeInstance(region, instanceId) { return { region, instanceId, state: 'running', availabilityZone: 'us-east-2a', launchTime: null, stateReason: null, stateTransitionTime: new Date(launchedAtMs + 1000).toISOString(), tags: {} }; },
    async terminateInstance(_region, instanceId) { return { instanceId, state: 'shutting-down' }; },
    async sweepExpiredSpotInstances(region) { return { region, checkedCount: 0, terminated: [] }; },
  };
  let nowMs = Date.now();
  const orchestrator = new ComputeOrchestrator({ store, ec2: port, s3: emptyS3, now: () => nowMs });
  try {
    const job = await store.create(jobInput({ maxLifetimeMs: 120_000 }));
    const running = await orchestrator.approveAndLaunch(job.id, job.approvalFingerprint, 'ok');
    nowMs = Date.parse(running.instance!.launchedAt) + 300_000;
    const woken = await orchestrator.wakeJob(job.id);
    assert.match(woken.instance!.forcedTerminationReason!, /TTL Guard forced termination/);
    assert.equal(woken.cost.instanceSeconds, 300, 'the instance ran until it was terminated');
  } finally {
    await store.close();
  }
});

test('rootVolumeGb: validated, part of the approval fingerprint, and sent as a root device mapping that is deleted with the instance', async () => {
  const store = new ComputeStore(':memory:', { globalBudgetCapMicros: 2_000_000 });
  try {
    const plain = await store.create(jobInput());
    const sized = await store.create(jobInput({ rootVolumeGb: 100, s3ArtifactPrefix: 'models/smf-trial/runs/r1' }));
    assert.equal(plain.compute.rootVolumeGb, undefined);
    assert.equal(sized.compute.rootVolumeGb, 100);
    assert.notEqual(sized.approvalFingerprint, plain.approvalFingerprint, 'a different disk is a different approval');
    assert.equal((await store.create(jobInput({ rootVolumeGb: 200 }))).approvalFingerprint === sized.approvalFingerprint, false);
    for (const bad of [7, 2001, 50.5, Number.NaN]) await assert.rejects(() => store.create(jobInput({ rootVolumeGb: bad })), /rootVolumeGb/);

    // The orchestrator passes the size on to the launch.
    const ec2 = endedInstance(null);
    const orchestrator = new ComputeOrchestrator({ store, ec2: ec2.port, s3: emptyS3 });
    await orchestrator.approveAndLaunch(sized.id, sized.approvalFingerprint, 'ok');
    await orchestrator.approveAndLaunch(plain.id, plain.approvalFingerprint, 'ok');
    assert.equal(ec2.launches[0]!.rootVolumeGb, 100);
    assert.equal('rootVolumeGb' in ec2.launches[1]!, false);
  } finally {
    await store.close();
  }

  // The adapter reads the AMI's root device name and maps the root volume.
  const actions: string[] = [];
  let run: URLSearchParams | null = null;
  const trainer = new AwsEc2SpotTrainer({
    allowedRegions: ['us-east-2'],
    credentials: () => ({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret-example' }),
    fetchImpl: async (_url, init) => {
      const params = new URLSearchParams(String(init?.body ?? ''));
      actions.push(params.get('Action')!);
      if (params.get('Action') === 'DescribeImages') {
        assert.equal(params.get('ImageId.1'), 'ami-0123456789abcdef0');
        return new Response('<DescribeImagesResponse><imagesSet><item><imageId>ami-0123456789abcdef0</imageId><rootDeviceName>/dev/xvda</rootDeviceName></item></imagesSet></DescribeImagesResponse>', { status: 200 });
      }
      run = params;
      return new Response('<RunInstancesResponse><instancesSet><item><instanceId>i-0123456789abcdef0</instanceId><instanceState><name>pending</name></instanceState><placement><availabilityZone>us-east-2a</availabilityZone></placement></item></instancesSet></RunInstancesResponse>', { status: 200 });
    },
  });
  const base = { jobId: 'mf-1', workloadId: 'm', region: 'us-east-2', instanceType: 'g4dn.xlarge', amiId: 'ami-0123456789abcdef0', maxHourlyPriceUsd: 0.4, expiresAtIso: '2026-11-27T03:00:00.000Z' };
  await trainer.launchSpotInstance({ ...base, rootVolumeGb: 100 });
  assert.deepEqual(actions, ['DescribeImages', 'RunInstances']);
  assert.equal(run!.get('BlockDeviceMapping.1.DeviceName'), '/dev/xvda');
  assert.equal(run!.get('BlockDeviceMapping.1.Ebs.VolumeSize'), '100');
  assert.equal(run!.get('BlockDeviceMapping.1.Ebs.DeleteOnTermination'), 'true');
  actions.length = 0;
  await trainer.launchSpotInstance(base);
  assert.deepEqual(actions, ['RunInstances'], 'without a size the AMI is not looked up');
  assert.equal(run!.get('BlockDeviceMapping.1.DeviceName'), null);
});
