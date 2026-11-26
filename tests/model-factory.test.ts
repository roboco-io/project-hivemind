import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildApp } from '../apps/control-plane/src/app.js';
import { ModelFactoryOrchestrator } from '../apps/control-plane/src/model-factory-orchestrator.js';
import {
  AwsEc2SpotTrainer,
  type DescribedSpotInstance,
  type Ec2SpotTrainerPort,
} from '../packages/adapters/src/aws-ec2-spot-trainer.js';
import { createTrustedHfReleasePublisher } from '../packages/adapters/src/model-factory-hf-publisher.js';
import type { S3ObjectPort } from '../packages/adapters/src/aws-s3-artifacts.js';
import type {
  CreateModelFactoryJob,
  ModelArtifactFile,
  ModelArtifactReceipt,
} from '../packages/contracts/src/model-factory.js';
import { computeModelManifestDigest, ModelFactoryStore } from '../packages/core/src/model-factory.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sampleJobInput(overrides?: Partial<CreateModelFactoryJob>): CreateModelFactoryJob {
  return {
    title: 'Train smf-tiny-v1 on Ohio GPU Spot',
    modelId: 'smf-tiny-v1',
    repository: 'roboco-io/silicon-model-factory',
    baseCommit: 'a'.repeat(40),
    compute: {
      region: 'us-east-2',
      instanceType: 'g5.xlarge',
      amiId: 'ami-0123456789abcdef0',
      maxLifetimeMs: 3_600_000, // 1 hour
      maxHourlyPriceUsd: 0.45,
      maxTotalCostMicros: 500_000, // $0.50
      s3ArtifactPrefix: 'models/smf-tiny-v1/run-01',
    },
    releasePolicy: {
      mode: 'hf_release',
      hfRepository: 'roboco-io/smf-tiny-v1',
      hfRevision: 'main',
      visibility: 'private',
      releaseCheckCommand: ['node', 'tools/release-check.mjs'],
    },
    ...overrides,
  };
}

function makeFakeEc2Port() {
  let seq = 1;
  const instances = new Map<
    string,
    DescribedSpotInstance & { instanceType: string; amiId: string; terminatedReasons: string[] }
  >();

  const port: Ec2SpotTrainerPort = {
    async launchSpotInstance(input) {
      const instanceId = `i-${String(seq++).padStart(17, '0')}`;
      const record = {
        region: input.region,
        instanceId,
        instanceType: input.instanceType,
        amiId: input.amiId,
        state: 'running' as const,
        availabilityZone: `${input.region}a`,
        launchTime: new Date().toISOString(),
        stateReason: null,
        tags: {
          'hivemind:managed-by': 'hivemind-model-factory',
          'hivemind:job-id': input.jobId,
          'hivemind:expires-at': input.expiresAtIso,
        },
        terminatedReasons: [],
      };
      instances.set(instanceId, record);
      return {
        region: input.region,
        availabilityZone: record.availabilityZone,
        instanceId,
        instanceType: input.instanceType,
        amiId: input.amiId,
        state: 'pending',
      };
    },
    async describeInstance(_region, instanceId) {
      const found = instances.get(instanceId);
      if (!found) throw new Error(`Missing instance ${instanceId}`);
      return {
        region: found.region,
        instanceId: found.instanceId,
        state: found.state,
        availabilityZone: found.availabilityZone,
        launchTime: found.launchTime,
        stateReason: found.stateReason,
        tags: { ...found.tags },
      };
    },
    async terminateInstance(_region, instanceId) {
      const found = instances.get(instanceId);
      if (!found) throw new Error(`Missing instance ${instanceId}`);
      found.state = 'terminated';
      return { instanceId, state: 'terminated' };
    },
    async sweepExpiredSpotInstances(region, nowMs = Date.now()) {
      const terminated: { instanceId: string; jobId: string | null; expiresAt: string | null; reason: string }[] = [];
      let checkedCount = 0;
      for (const inst of instances.values()) {
        if (inst.region !== region || inst.state === 'terminated') continue;
        checkedCount += 1;
        const expiresAt = inst.tags['hivemind:expires-at'] ?? null;
        if (!expiresAt || Date.parse(expiresAt) <= nowMs) {
          inst.state = 'terminated';
          terminated.push({
            instanceId: inst.instanceId,
            jobId: inst.tags['hivemind:job-id'] ?? null,
            expiresAt,
            reason: `TTL Guard expired at ${expiresAt}`,
          });
        }
      }
      return { region, checkedCount, terminated };
    },
  };

  return { port, instances };
}

function makeMemoryS3(): { port: S3ObjectPort; store: Map<string, Buffer> } {
  const store = new Map<string, Buffer>();
  const port: S3ObjectPort = {
    async putObject(key, body) {
      const buf = Buffer.from(body);
      store.set(key, buf);
      return { key, sha256: createHash('sha256').update(buf).digest('hex'), sizeBytes: buf.byteLength };
    },
    async getObject(key) {
      const buf = store.get(key);
      if (!buf) throw new Error(`NoSuchKey: ${key}`);
      return new Uint8Array(buf);
    },
  };
  return { port, store };
}

test('B1-B7 end-to-end: dynamic EC2 Spot launch -> long-running wake -> S3 receipt -> cost settlement -> human release approval -> trusted HF release', async () => {
  let clock = Date.parse('2026-11-26T00:00:00.000Z');
  const now = () => clock;
  const store = new ModelFactoryStore(':memory:', { now, globalBudgetCapMicros: 1_000_000 });
  const ec2 = makeFakeEc2Port();
  const s3 = makeMemoryS3();
  const publishedCalls: { repo: string; manifestDigest: string }[] = [];

  const orchestrator = new ModelFactoryOrchestrator({
    store,
    ec2: ec2.port,
    s3: s3.port,
    wakeIntervalMs: 600_000,
    now,
    hfPublisher: {
      async publish({ job, receipt }) {
        publishedCalls.push({
          repo: job.releasePolicy.hfRepository!,
          manifestDigest: receipt.manifestDigest,
        });
        return {
          mode: 'hf_release',
          repository: job.releasePolicy.hfRepository!,
          revision: job.releasePolicy.hfRevision ?? 'main',
          commitSha: 'f'.repeat(40),
          url: `https://huggingface.co/${job.releasePolicy.hfRepository!}`,
          manifestDigest: receipt.manifestDigest,
          publishedAt: new Date(clock).toISOString(),
        };
      },
    },
  });

  try {
    // 1. Create job with dynamic AMI & instanceType (no CDK stack redeploy needed).
    const created = store.create(sampleJobInput());
    assert.equal(created.status, 'awaiting_training_approval');
    assert.equal(created.waitReason, 'awaiting_training_approval');
    assert.equal(created.compute.amiId, 'ami-0123456789abcdef0');
    assert.equal(created.compute.region, 'us-east-2');

    // 2. Approve training -> reserves budget and launches Spot instance in us-east-2.
    const launched = await orchestrator.approveAndLaunchTraining(
      created.id,
      created.approvalFingerprint,
      'Approve Ohio g5.xlarge training run',
    );
    assert.equal(launched.status, 'training_running');
    assert.equal(launched.waitReason, 'training_in_progress');
    assert.ok(launched.instance?.instanceId.startsWith('i-'));
    assert.equal(launched.cost.reservedMicros, 500_000);

    // 3. Central budget cap enforcement: a second job requesting $0.60 exceeds remaining $0.50 -> explicit 409!
    const overBudget = store.create(
      sampleJobInput({
        modelId: 'smf-oversized',
        compute: {
          ...sampleJobInput().compute,
          maxTotalCostMicros: 600_000,
        },
      }),
    );
    await assert.rejects(
      () => orchestrator.approveAndLaunchTraining(overBudget.id, overBudget.approvalFingerprint, 'Should reject'),
      /Central cost cap exceeded/,
    );
    assert.ok(store.get(overBudget.id).diagnostics.some((d) => d.includes('Central cost cap exceeded')));

    // 4. First wake-up at +10 min: still running -> reschedules nextWakeAt without keeping worker alive.
    clock += 600_000;
    const midWake = await orchestrator.wakeJob(created.id);
    assert.equal(midWake.status, 'training_running');
    assert.equal(midWake.waitReason, 'training_in_progress');
    assert.ok(midWake.nextWakeAt);

    // 5. Training finishes at +30 min: uploads S3 receipt & terminates cleanly.
    clock += 1_200_000; // total 30m = 1800s
    const files: ModelArtifactFile[] = [
      { path: 'model.safetensors', sha256: sha256('weights-v1'), sizeBytes: 120_000_000 },
      { path: 'config.json', sha256: sha256('{"arch":"tiny"}'), sizeBytes: 512 },
    ];
    const manifestDigest = computeModelManifestDigest(files);
    const receipt: ModelArtifactReceipt = {
      version: 1,
      jobId: created.id,
      s3Bucket: 'hivemind-runtime-artifacts',
      s3Prefix: 'models/smf-tiny-v1/run-01',
      manifestDigest,
      files,
      recordedAt: new Date(clock).toISOString(),
    };
    await s3.port.putObject(
      'models/smf-tiny-v1/run-01/receipt.json',
      Buffer.from(JSON.stringify(receipt), 'utf8'),
      'application/json',
    );
    ec2.instances.get(launched.instance!.instanceId)!.state = 'terminated';

    const doneWake = await orchestrator.wakeJob(created.id);
    assert.equal(doneWake.status, 'evaluating');
    assert.equal(doneWake.receipt?.manifestDigest, manifestDigest);
    // Settled cost for 30 min at $0.45/hr = $0.225 = 225,000 micros (releases unused $0.275 back to ledger!).
    assert.equal(doneWake.cost.settledMicros, 225_000);
    assert.equal(doneWake.cost.instanceSeconds, 1800);
    assert.equal(store.ledger().remainingBudgetMicros, 775_000);

    // 6. Release verification attestation (must match manifestDigest!).
    assert.throws(
      () =>
        store.recordReleaseAttestation(created.id, {
          manifestDigest: '0'.repeat(64),
          releaseCheckPassed: true,
          metrics: { evalLoss: 1.42 },
          summary: 'Tampered digest',
          verifiedAt: new Date(clock).toISOString(),
        }),
      /does not match S3 artifact receipt/,
    );

    const attested = store.recordReleaseAttestation(created.id, {
      manifestDigest,
      releaseCheckPassed: true,
      metrics: { evalLoss: 1.42, gsm8k: 0.61 },
      summary: 'release-check.mjs passed cleanly',
      verifiedAt: new Date(clock).toISOString(),
    });
    assert.equal(attested.status, 'awaiting_release_approval');
    assert.equal(attested.waitReason, 'awaiting_release_approval');

    // 7. Operator approves release -> Control Plane trusted publisher publishes to HF (worker never holds HF token).
    const released = await orchestrator.approveAndPublishRelease(created.id, {
      decision: 'approve',
      openedRawArtifacts: false,
      durationMinutes: 1.2,
      reason: 'Metrics and SHA-256 receipt verified',
    });
    assert.equal(released.status, 'released');
    assert.equal(released.waitReason, null);
    assert.equal(released.publication?.repository, 'roboco-io/smf-tiny-v1');
    assert.equal(released.publication?.manifestDigest, manifestDigest);
    assert.equal(publishedCalls.length, 1);
  } finally {
    store.close();
  }
});

test('B1 TTL Guard: wakeJob force-terminates Spot instance past maxLifetimeMs and settles cost', async () => {
  let clock = Date.parse('2026-11-26T00:00:00.000Z');
  const now = () => clock;
  const store = new ModelFactoryStore(':memory:', { now });
  const ec2 = makeFakeEc2Port();
  const s3 = makeMemoryS3();
  const orchestrator = new ModelFactoryOrchestrator({ store, ec2: ec2.port, s3: s3.port, now });

  try {
    const job = store.create(
      sampleJobInput({
        compute: {
          ...sampleJobInput().compute,
          maxLifetimeMs: 120_000, // 2 min TTL
        },
      }),
    );
    const launched = await orchestrator.approveAndLaunchTraining(job.id, job.approvalFingerprint, 'Launch TTL test');
    const instanceId = launched.instance!.instanceId;
    assert.equal(ec2.instances.get(instanceId)!.state, 'running');

    // Jump past maxLifetimeMs without S3 receipt -> TTL Guard MUST force-terminate!
    clock += 130_000;
    const afterWake = await orchestrator.wakeJob(job.id);
    assert.equal(ec2.instances.get(instanceId)!.state, 'terminated');
    assert.equal(afterWake.status, 'failed');
    assert.match(afterWake.instance?.forcedTerminationReason ?? '', /TTL Guard forced termination/);
    assert.ok(afterWake.cost.settledMicros !== null && afterWake.cost.settledMicros > 0);
  } finally {
    store.close();
  }
});

test('B1 AwsEc2SpotTrainer SigV4 query adapter parses RunInstances, DescribeInstances, and sweeps expired tagged instances', async () => {
  const requests: { url: string; action: string | null; body: URLSearchParams }[] = [];
  const trainer = new AwsEc2SpotTrainer({
    allowedRegions: ['us-east-2'],
    credentials: () => ({
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secret-example',
      sessionToken: 'session-example',
    }),
    now: () => Date.parse('2026-11-26T01:00:00.000Z'),
    fetchImpl: async (url, init) => {
      const params = new URLSearchParams(String(init?.body ?? ''));
      const action = params.get('Action');
      requests.push({ url: String(url), action, body: params });

      if (action === 'RunInstances') {
        assert.equal(params.get('InstanceMarketOptions.MarketType'), 'spot');
        assert.equal(params.get('ImageId'), 'ami-0abc1234567890def');
        assert.equal(params.get('InstanceType'), 't4g.nano');
        return new Response(
          `<RunInstancesResponse><instancesSet><item><instanceId>i-0123456789abcdef0</instanceId><instanceState><name>pending</name></instanceState><placement><availabilityZone>us-east-2c</availabilityZone></placement></item></instancesSet></RunInstancesResponse>`,
          { status: 200 },
        );
      }
      if (action === 'DescribeInstances') {
        return new Response(
          `<DescribeInstancesResponse><reservationSet><item><instancesSet><item><instanceId>i-0123456789abcdef0</instanceId><instanceState><name>running</name></instanceState><placement><availabilityZone>us-east-2c</availabilityZone></placement><tagSet><item><key>hivemind:managed-by</key><value>hivemind-model-factory</value></item><item><key>hivemind:job-id</key><value>mf-1</value></item><item><key>hivemind:expires-at</key><value>2026-11-26T00:59:00.000Z</value></item></tagSet></item></instancesSet></item></reservationSet></DescribeInstancesResponse>`,
          { status: 200 },
        );
      }
      if (action === 'TerminateInstances') {
        return new Response(
          `<TerminateInstancesResponse><instancesSet><item><instanceId>i-0123456789abcdef0</instanceId><currentState><name>shutting-down</name></currentState></item></instancesSet></TerminateInstancesResponse>`,
          { status: 200 },
        );
      }
      return new Response('unexpected', { status: 400 });
    },
  });

  const launched = await trainer.launchSpotInstance({
    jobId: 'mf-1',
    modelId: 'canary',
    region: 'us-east-2',
    instanceType: 't4g.nano',
    amiId: 'ami-0abc1234567890def',
    maxHourlyPriceUsd: 0.01,
    expiresAtIso: '2026-11-26T00:59:00.000Z',
  });
  assert.equal(launched.instanceId, 'i-0123456789abcdef0');
  assert.equal(launched.availabilityZone, 'us-east-2c');

  const swept = await trainer.sweepExpiredSpotInstances('us-east-2', Date.parse('2026-11-26T01:00:00.000Z'));
  assert.equal(swept.checkedCount, 1);
  assert.equal(swept.terminated.length, 1);
  assert.equal(swept.terminated[0]!.instanceId, 'i-0123456789abcdef0');
  assert.equal(requests.map((r) => r.action).join(','), 'RunInstances,DescribeInstances,TerminateInstances');
  assert.equal(new URL(requests[0]!.url).hostname, 'ec2.us-east-2.amazonaws.com');
});

test('Model Factory HTTP API enforces operator-only auth and exposes central ledger for SMF reconciliation', async () => {
  const app = buildApp({
    operatorToken: 'op-secret-token',
    workerToken: 'wk-secret-token',
    modelFactoryBudgetCapMicros: 2_000_000,
  });
  try {
    // Worker token MUST NOT access model factory operator endpoints.
    const unauth = await app.inject({
      method: 'GET',
      url: '/api/model-factory/ledger',
      headers: { authorization: 'Bearer wk-secret-token' },
    });
    assert.equal(unauth.statusCode, 401);

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/model-factory/jobs',
      headers: { authorization: 'Bearer op-secret-token' },
      payload: sampleJobInput(),
    });
    assert.equal(createRes.statusCode, 201);
    const job = createRes.json();

    const approveRes = await app.inject({
      method: 'POST',
      url: `/api/model-factory/jobs/${job.id}/approve-training`,
      headers: { authorization: 'Bearer op-secret-token' },
      payload: { approvalFingerprint: job.approvalFingerprint, reason: 'Operator approved' },
    });
    assert.equal(approveRes.statusCode, 200);

    const ledgerRes = await app.inject({
      method: 'GET',
      url: '/api/model-factory/ledger',
      headers: { authorization: 'Bearer op-secret-token' },
    });
    assert.equal(ledgerRes.statusCode, 200);
    const ledger = ledgerRes.json();
    assert.equal(ledger.globalBudgetCapMicros, 2_000_000);
    assert.equal(ledger.totalReservedMicros, 500_000);
    assert.equal(ledger.remainingBudgetMicros, 1_500_000);
  } finally {
    await app.close();
  }
});

test('B6 createTrustedHfReleasePublisher rejects mismatched digest and missing attestation before any HF API call', async () => {
  const s3 = makeMemoryS3();
  let fetchCalled = false;
  const publisher = createTrustedHfReleasePublisher({
    s3: s3.port,
    resolveHfToken: async () => 'hf_control_plane_only_secret_token',
    fetchImpl: async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    },
  });

  const store = new ModelFactoryStore(':memory:');
  try {
    const job = store.create(sampleJobInput());
    const files: ModelArtifactFile[] = [{ path: 'config.json', sha256: sha256('{}'), sizeBytes: 2 }];
    const digest = computeModelManifestDigest(files);

    await assert.rejects(
      () =>
        publisher.publish({
          job,
          receipt: {
            version: 1,
            jobId: job.id,
            s3Bucket: 'b',
            s3Prefix: job.compute.s3ArtifactPrefix,
            manifestDigest: digest,
            files,
            recordedAt: '2026-11-26T00:00:00.000Z',
          },
          attestation: {
            manifestDigest: '1'.repeat(64),
            releaseCheckPassed: true,
            metrics: {},
            summary: 'mismatch',
            verifiedAt: '2026-11-26T00:00:00.000Z',
          },
        }),
      /does not match release attestation/,
    );
    assert.equal(fetchCalled, false);
  } finally {
    store.close();
  }
});
