import assert from 'node:assert/strict';
import test from 'node:test';
import { DeliveryOrchestrator } from '../apps/control-plane/src/delivery-orchestrator.js';
import { ModelFactoryOrchestrator } from '../apps/control-plane/src/model-factory-orchestrator.js';
import type { Ec2SpotTrainerPort } from '../packages/adapters/src/aws-ec2-spot-trainer.js';
import type { S3ObjectPort } from '../packages/adapters/src/aws-s3-artifacts.js';
import type { CreateDeliveryTask } from '../packages/contracts/src/delivery.js';
import type { CreateModelFactoryJob } from '../packages/contracts/src/model-factory.js';
import { computeAcceptanceTestDigest, DeliveryStore } from '../packages/core/src/delivery.js';
import { ModelFactoryStore } from '../packages/core/src/model-factory.js';

const T0 = Date.parse('2026-11-27T01:00:00.000Z');
const emptyS3: S3ObjectPort = {
  async putObject() {
    throw new Error('not used');
  },
  async getObject(key) {
    throw new Error(`NoSuchKey: ${key}`);
  },
};

function deliveryInput(title: string): CreateDeliveryTask {
  const baseCommit = 'a'.repeat(40);
  const files = [{ path: 'tests/acceptance.test.ts', sha256: 'd'.repeat(64) }];
  const testCommand = ['npm', 'run', 'check'];
  return {
    title,
    instructions: 'Do the change.',
    provider: 'codex',
    maxIterations: 3,
    budgetMicros: 500_000,
    acceptance: { baseCommit, files, testCommand, digest: computeAcceptanceTestDigest({ baseCommit, files, testCommand }) },
    delivery: { mode: 'draft_pr', repository: 'roboco-io/project-hivemind', baseBranch: 'main', branchPrefix: 'hivemind/', autoMerge: false },
    bundle: { baseCommit, bundleSha256: 'b'.repeat(64), sizeBytes: 1_000, fileCount: 1, s3Key: 'bundles/x.bundle' },
    spot: { maxSpotRetries: 2, checkpointFlushTimeoutMs: 90_000 },
  };
}

type EcsStatus = { lastStatus: string; stopCode: string | null; stoppedReason: string | null; exitCode: number | null } | null;

function makeDelivery(clock: { now: number }) {
  const store = new DeliveryStore(':memory:', () => clock.now);
  const statuses = new Map<string, EcsStatus | Error>();
  const stopped: string[] = [];
  let seq = 0;
  const orchestrator = new DeliveryOrchestrator({
    store,
    s3: emptyS3,
    now: () => clock.now,
    github: { publishDraftPr: async () => { throw new Error('not used'); } } as never,
    ecs: {
      async launchWorkload(input) {
        seq += 1;
        return { taskArn: `arn:aws:ecs:ap-northeast-2:123456789012:task/c/${input.kind}-${seq}` };
      },
      async stop(arn) {
        if (arn.endsWith('-boom')) throw new Error('AWS ECS StopTask failed with HTTP 500');
        stopped.push(arn);
      },
      async describeTask(arn) {
        const status = statuses.get(arn);
        if (status instanceof Error) throw status;
        return status === undefined ? { lastStatus: 'RUNNING', stopCode: null, stoppedReason: null, exitCode: null } : status;
      },
    },
  });
  const start = async (title: string) => {
    const created = await store.create(deliveryInput(title));
    await store.approve(created.id, created.approvalFingerprint, 'ok');
    const dispatched = await orchestrator.dispatchWorker(created.id);
    return { id: created.id, runId: dispatched.runId, arn: dispatched.ecsTaskArn };
  };
  return { store, orchestrator, statuses, stopped, start };
}

test('delivery reconcile fails a running task only when its ECS task is gone past the hand-off grace period', async () => {
  const clock = { now: T0 };
  const { store, orchestrator, statuses, start } = makeDelivery(clock);
  try {
    const alive = await start('alive');
    const stopped = await start('stopped');
    const vanished = await start('vanished');
    const flaky = await start('lookup-error');
    assert.equal((await store.get(alive.id)).activeEcsTaskArn, alive.arn, 'dispatch records the worker ECS task');

    statuses.set(stopped.arn, { lastStatus: 'STOPPED', stopCode: 'SpotInterruption', stoppedReason: 'Your Spot Task was interrupted.', exitCode: null });
    statuses.set(vanished.arn, null);
    statuses.set(flaky.arn, new Error('AWS ECS DescribeTasks failed with HTTP 503'));

    // Right after the ECS task ended, the worker's hand-off may still be in flight: nothing is failed yet.
    clock.now = T0 + 30_000;
    const early = await orchestrator.reconcileRunningTasks();
    assert.equal(early.checked, 4);
    assert.deepEqual(early.failed, []);
    assert.ok(early.untouched.some((u) => u.taskId === stopped.id && /within the hand-off grace period/.test(u.reason)));

    clock.now = T0 + 300_000;
    const late = await orchestrator.reconcileRunningTasks();
    assert.deepEqual(late.failed.map((f) => f.title).sort(), ['stopped', 'vanished']);
    assert.match(late.failed.find((f) => f.title === 'stopped')!.reason, /SpotInterruption; Your Spot Task was interrupted\./);
    const reasons = Object.fromEntries(late.untouched.map((u) => [u.taskId, u.reason]));
    assert.equal(reasons[alive.id], 'ECS task is RUNNING');
    assert.match(reasons[flaky.id]!, /status lookup failed/);

    const failed = await store.get(stopped.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.activeRunId, null);
    assert.match(failed.failureReason ?? '', /stopped without reporting a result/);
    assert.ok((await store.events(stopped.id)).some((e) => e.type === 'delivery.orphaned_run_failed'));
    assert.equal((await store.get(alive.id)).status, 'running');
    assert.equal((await store.get(flaky.id)).status, 'running');

    // Idempotent: a second run fails nothing new.
    assert.deepEqual((await orchestrator.reconcileRunningTasks()).failed, []);
    // failOrphanedRun ignores a stale run id, so it cannot fail a newer run.
    assert.equal((await store.failOrphanedRun(alive.id, 'run-stale', 'stale')).status, 'running');
  } finally {
    await store.close();
  }
});

test('delivery reconcile leaves tasks without a recorded ECS task alone, and cancelTask stops the recorded one', async () => {
  const clock = { now: T0 };
  const { store, orchestrator, stopped, start } = makeDelivery(clock);
  try {
    // A task started before the field existed: running, but no ECS task recorded.
    const legacy = await store.create(deliveryInput('legacy'));
    await store.approve(legacy.id, legacy.approvalFingerprint, 'ok');
    await store.startIteration(legacy.id, 'worker-old', 'run-old');
    clock.now = T0 + 3_600_000;
    const result = await orchestrator.reconcileRunningTasks();
    assert.deepEqual(result.failed, []);
    assert.match(result.untouched[0]!.reason, /no ECS task recorded; cancel the task/);

    const cancelledLegacy = await orchestrator.cancelTask(legacy.id, 'worker is gone');
    assert.equal(cancelledLegacy.task.status, 'cancelled');
    assert.equal(cancelledLegacy.stoppedEcsTask, false);

    const live = await start('live');
    const cancelled = await orchestrator.cancelTask(live.id, 'operator cancel');
    assert.equal(cancelled.task.status, 'cancelled');
    assert.equal(cancelled.stoppedEcsTask, true);
    assert.deepEqual(stopped, [live.arn]);
  } finally {
    await store.close();
  }
});

function mfInput(): CreateModelFactoryJob {
  return {
    title: 'Vanished instance',
    modelId: 'smf-tiny-v1',
    repository: 'roboco-io/silicon-model-factory',
    baseCommit: 'a'.repeat(40),
    compute: {
      region: 'us-east-2',
      instanceType: 't4g.nano',
      amiId: 'ami-0123456789abcdef0',
      maxLifetimeMs: 300_000,
      maxHourlyPriceUsd: 3.6,
      maxTotalCostMicros: 500_000,
      s3ArtifactPrefix: 'models/smf-tiny-v1/run-vanished',
    },
    releasePolicy: { mode: 's3_artifact_only', visibility: 'private', releaseCheckCommand: ['node', 'tools/release-check.mjs'] },
  };
}

test('Model Factory wake settles a job whose instance EC2 no longer lists, bounded by the expiry time, and rethrows other errors', async () => {
  const clock = { now: T0 };
  const store = new ModelFactoryStore(':memory:', { now: () => clock.now });
  let describeError: Error | null = new Error('EC2 instance i-0123456789abcdef0 not found in us-east-2');
  const terminated: string[] = [];
  const ec2: Ec2SpotTrainerPort = {
    async launchSpotInstance(input) {
      return { region: input.region, availabilityZone: 'us-east-2a', instanceId: 'i-0123456789abcdef0', instanceType: input.instanceType, amiId: input.amiId, state: 'pending' };
    },
    async describeInstance() {
      if (describeError) throw describeError;
      throw new Error('unexpected');
    },
    async terminateInstance(_region, instanceId) {
      terminated.push(instanceId);
      return { instanceId, state: 'terminated' };
    },
    async sweepExpiredSpotInstances(region) {
      return { region, checkedCount: 0, terminated: [] };
    },
  };
  const orchestrator = new ModelFactoryOrchestrator({ store, ec2, s3: emptyS3, now: () => clock.now });
  try {
    const job = await store.create(mfInput());
    const launched = await orchestrator.approveAndLaunchTraining(job.id, job.approvalFingerprint, 'ok');
    assert.equal(launched.status, 'training_running');

    // A transient EC2 error is not evidence that the instance ended.
    clock.now = T0 + 60_000;
    describeError = new Error('AWS EC2 DescribeInstances failed with HTTP 503');
    await assert.rejects(() => orchestrator.wakeJob(job.id), /HTTP 503/);
    assert.equal((await store.get(job.id)).cost.settledMicros, null);

    // Days later EC2 no longer lists the instance. The cost is bounded by the 300 s lifetime: 300 s at $3.6/h.
    clock.now = T0 + 3 * 86_400_000;
    describeError = new Error('EC2 instance i-0123456789abcdef0 not found in us-east-2');
    const woken = await orchestrator.wakeJob(job.id);
    assert.equal(woken.cost.settledMicros, 300_000);
    assert.equal(woken.cost.instanceSeconds, 300);
    assert.equal(woken.instance?.state, 'terminated');
    assert.equal(woken.status, 'failed', 'no receipt, so the training job fails');
    assert.ok(woken.diagnostics.some((d) => /EC2 no longer lists/.test(d)));
    assert.deepEqual(terminated, [], 'a vanished instance is not terminated again');
    assert.equal((await store.ledger()).totalReservedMicros, 0);
    assert.deepEqual(await store.listDueWakeJobs(clock.now), [], 'the job no longer wakes forever');
  } finally {
    await store.close();
  }
});
