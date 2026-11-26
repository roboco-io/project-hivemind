import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelFactoryOrchestrator } from '../apps/control-plane/src/model-factory-orchestrator.js';
import type { Ec2SpotTrainerPort, ExpiredSpotSweepResult } from '../packages/adapters/src/aws-ec2-spot-trainer.js';
import type { S3ObjectPort } from '../packages/adapters/src/aws-s3-artifacts.js';
import { runModelFactoryTtlGuard } from '../packages/adapters/src/model-factory-ttl-guard.js';
import type { CreateModelFactoryJob, ModelFactoryJob } from '../packages/contracts/src/model-factory.js';
import { calculateActualCostMicros, settleGuardTermination } from '../packages/core/src/model-factory-guard-settlement.js';
import { ModelFactoryStore } from '../packages/core/src/model-factory.js';
import type { ModelFactoryRepository } from '../packages/core/src/model-factory-repository.js';

const T0 = Date.parse('2026-11-26T10:00:00.000Z');

function jobInput(prefix: string): CreateModelFactoryJob {
  return {
    title: 'TTL guard settlement',
    modelId: 'smf-tiny-v1',
    repository: 'roboco-io/silicon-model-factory',
    baseCommit: 'a'.repeat(40),
    compute: {
      region: 'us-east-2',
      instanceType: 'g5.xlarge',
      amiId: 'ami-0123456789abcdef0',
      maxLifetimeMs: 600_000,
      maxHourlyPriceUsd: 0.36,
      maxTotalCostMicros: 500_000,
      s3ArtifactPrefix: `models/smf-tiny-v1/${prefix}`,
    },
    releasePolicy: { mode: 's3_artifact_only', visibility: 'private', releaseCheckCommand: ['node', 'tools/release-check.mjs'] },
  };
}

async function runningJob(store: ModelFactoryStore, prefix: string, instanceId: string): Promise<ModelFactoryJob> {
  const job = await store.create(jobInput(prefix));
  await store.approveTraining(job.id, job.approvalFingerprint, 'ok');
  return store.recordInstanceLaunched(job.id, {
    region: 'us-east-2',
    availabilityZone: 'us-east-2a',
    instanceId,
    instanceType: 'g5.xlarge',
    amiId: 'ami-0123456789abcdef0',
    expiresAt: new Date(T0 + 600_000).toISOString(),
    nextWakeAt: new Date(T0 + 300_000).toISOString(),
  });
}

function sweeper(byRegion: Record<string, ExpiredSpotSweepResult['terminated'] | Error>) {
  const swept: string[] = [];
  const ec2: Pick<Ec2SpotTrainerPort, 'sweepExpiredSpotInstances'> = {
    async sweepExpiredSpotInstances(region) {
      swept.push(region);
      const result = byRegion[region];
      if (result instanceof Error) throw result;
      return { region, checkedCount: result?.length ?? 0, terminated: result ?? [] };
    },
  };
  return { ec2, swept };
}

test('TTL Guard settles a terminated job in the ledger, is idempotent, and ignores unknown jobs and mismatched instances', async () => {
  let clock = T0;
  const store = new ModelFactoryStore(':memory:', { now: () => clock, globalBudgetCapMicros: 2_000_000 });
  try {
    const job = await runningJob(store, 'run-a', 'i-0aaaaaaaaaaaaaaa1');
    const other = await runningJob(store, 'run-b', 'i-0bbbbbbbbbbbbbbb2');
    clock = T0 + 700_000; // 700 s after launch, past the 600 s lifetime

    const { ec2 } = sweeper({
      'us-east-2': [
        { instanceId: 'i-0aaaaaaaaaaaaaaa1', jobId: job.id, expiresAt: job.instance!.expiresAt, reason: 'TTL Guard expired' },
        // An instance whose tag names another job: must not settle that job.
        { instanceId: 'i-0ccccccccccccccc3', jobId: other.id, expiresAt: null, reason: 'forged tag' },
        { instanceId: 'i-0ddddddddddddddd4', jobId: 'mf-00000000-0000-4000-8000-000000000000', expiresAt: null, reason: 'unknown job' },
        { instanceId: 'i-0eeeeeeeeeeeeeee5', jobId: null, expiresAt: null, reason: 'no job tag' },
      ],
    });
    const [summary] = await runModelFactoryTtlGuard({ regions: ['us-east-2'], ec2, store, now: () => clock });
    assert.deepEqual(summary!.errors, []);
    assert.equal(summary!.terminated.length, 4);
    assert.deepEqual(summary!.settlements.map((s) => s.outcome), ['settled', 'instance_mismatch', 'job_not_found']);

    // 700 s at $0.36/h = 70,000 micros.
    const settled = await store.get(job.id);
    assert.equal(settled.cost.settledMicros, 70_000);
    assert.equal(settled.cost.instanceSeconds, 700);
    assert.equal(settled.instance!.state, 'shutting-down');
    assert.match(settled.instance!.forcedTerminationReason ?? '', /^TTL Guard Lambda forced termination/);
    assert.equal(settled.nextWakeAt, null);
    assert.equal(settled.status, 'training_running', 'the guard leaves receipt loading and failing to the Control Plane');
    assert.equal((await store.get(other.id)).cost.settledMicros, null);
    const ledger = await store.ledger();
    assert.equal(ledger.totalSettledMicros, 70_000);
    assert.equal(ledger.totalReservedMicros, 500_000, 'only the other job is still reserved');

    // A second run for the same instance changes nothing.
    const eventsBefore = (await store.events(job.id)).length;
    const again = await settleGuardTermination(store, { jobId: job.id, instanceId: 'i-0aaaaaaaaaaaaaaa1', endedMs: clock + 60_000, reason: 'again' });
    assert.deepEqual(again, { jobId: job.id, instanceId: 'i-0aaaaaaaaaaaaaaa1', outcome: 'already_settled', settledMicros: 70_000 });
    assert.equal((await store.events(job.id)).length, eventsBefore);

    // When the Control Plane starts again, its wake finishes the job: no receipt, so the job fails.
    const emptyS3: S3ObjectPort = {
      async putObject() {
        throw new Error('not used');
      },
      async getObject(key) {
        throw new Error(`NoSuchKey: ${key}`);
      },
    };
    const orchestrator = new ModelFactoryOrchestrator({
      store,
      s3: emptyS3,
      now: () => clock,
      ec2: {
        async launchSpotInstance() {
          throw new Error('not used');
        },
        async describeInstance(region, instanceId) {
          return { region, instanceId, state: 'terminated', availabilityZone: 'us-east-2a', launchTime: null, stateReason: null, tags: {} };
        },
        async terminateInstance(_region, instanceId) {
          return { instanceId, state: 'terminated' };
        },
        async sweepExpiredSpotInstances(region) {
          return { region, checkedCount: 0, terminated: [] };
        },
      },
    });
    assert.ok((await store.listDueWakeJobs(clock)).some((j) => j.id === job.id));
    const woken = await orchestrator.wakeJob(job.id);
    assert.equal(woken.status, 'failed');
    assert.equal(woken.cost.settledMicros, 70_000, 'the Control Plane does not settle a second time');
  } finally {
    await store.close();
  }
});

test('TTL Guard keeps terminating when one region or the ledger fails, and works without a ledger', async () => {
  const store = new ModelFactoryStore(':memory:', { now: () => T0 });
  const job = await runningJob(store, 'run-c', 'i-0fffffffffffffff6');
  const terminated = [{ instanceId: 'i-0fffffffffffffff6', jobId: job.id, expiresAt: null, reason: 'expired' }];

  // Region 1 fails to sweep; region 2 is still swept and settled.
  const partial = sweeper({ 'us-east-1': new Error('EC2 us-east-1 DescribeInstances HTTP 503'), 'us-east-2': terminated });
  const summaries = await runModelFactoryTtlGuard({ regions: ['us-east-1', 'us-east-2'], ec2: partial.ec2, store, now: () => T0 + 120_000 });
  assert.deepEqual(partial.swept, ['us-east-1', 'us-east-2']);
  assert.match(summaries[0]!.errors[0]!, /^sweep: EC2 us-east-1/);
  assert.deepEqual(summaries[1]!.settlements.map((s) => s.outcome), ['settled']);
  await store.close();

  // Ledger unreachable: the instance is still reported as terminated and the error is recorded.
  const brokenRepository: ModelFactoryRepository = {
    storageBackend: 'aurora-dsql',
    transaction: async () => {
      throw new Error('connect ETIMEDOUT');
    },
    listJobs: async () => {
      throw new Error('connect ETIMEDOUT');
    },
    getJob: async () => {
      throw new Error('connect ETIMEDOUT');
    },
    listEvents: async () => [],
    close: async () => undefined,
  };
  const down = sweeper({ 'us-east-2': terminated });
  const [degraded] = await runModelFactoryTtlGuard({ regions: ['us-east-2'], ec2: down.ec2, store: new ModelFactoryStore(brokenRepository) });
  assert.equal(degraded!.terminated.length, 1);
  assert.deepEqual(degraded!.settlements, []);
  assert.match(degraded!.errors[0]!, /^settle mf-.*connect ETIMEDOUT/);

  // No ledger configured: terminate only.
  const plain = sweeper({ 'us-east-2': terminated });
  const [noLedger] = await runModelFactoryTtlGuard({ regions: ['us-east-2'], ec2: plain.ec2 });
  assert.equal(noLedger!.terminated.length, 1);
  assert.deepEqual(noLedger!.settlements, []);
  assert.deepEqual(noLedger!.errors, []);
});

test('calculateActualCostMicros applies the 60-second minimum and never exceeds the reservation', () => {
  const base = {
    compute: { maxHourlyPriceUsd: 3.6 },
    instance: { launchedAt: new Date(T0).toISOString() },
    cost: { reservedMicros: 100_000 },
  } as unknown as ModelFactoryJob;
  assert.deepEqual(calculateActualCostMicros(base, T0 + 5_000), { actualCostMicros: 60_000, instanceSeconds: 60 });
  assert.deepEqual(calculateActualCostMicros(base, T0 + 90_000), { actualCostMicros: 90_000, instanceSeconds: 90 });
  assert.deepEqual(calculateActualCostMicros(base, T0 + 3_600_000), { actualCostMicros: 100_000, instanceSeconds: 3600 });
});
