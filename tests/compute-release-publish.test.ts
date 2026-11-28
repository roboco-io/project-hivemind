import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import { registerComputeRoutes } from '../apps/control-plane/src/compute-api.js';
import { ComputeOrchestrator } from '../apps/control-plane/src/compute-orchestrator.js';
import { ProjectStore } from '../packages/core/src/projects.js';
import type { Ec2SpotTrainerPort } from '../packages/adapters/src/aws-ec2-spot-trainer.js';
import { createAwsS3ArtifactsPort, type S3ObjectPort } from '../packages/adapters/src/aws-s3-artifacts.js';
import { createTrustedHfReleasePublisher } from '../packages/adapters/src/compute-hf-publisher.js';
import type { CreateComputeJob, ComputeArtifactReceipt, ComputeJob, ComputeReleasePublication } from '../packages/contracts/src/compute.js';
import { ComputeStore, computeArtifactManifestDigest } from '../packages/core/src/compute.js';

const PREFIX = 'models/smf-tiny-v1/runs/run-01';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function jobInput(visibility: 'private' | 'public' = 'private'): CreateComputeJob {
  return {
    title: 'Publish',
    workloadId: 'smf-tiny-v1',
    repository: 'roboco-io/silicon-model-factory',
    baseCommit: 'a'.repeat(40),
    compute: {
      region: 'us-east-2',
      instanceType: 'g4dn.xlarge',
      amiId: 'ami-0123456789abcdef0',
      maxLifetimeMs: 3_600_000,
      maxHourlyPriceUsd: 0.4,
      maxTotalCostMicros: 400_000,
      s3ArtifactPrefix: PREFIX,
    },
    releasePolicy: { mode: 'hf_release', hfRepository: 'roboco-io/smf-tiny-v1', hfRevision: 'main', visibility, releaseCheckCommand: ['node', 'check.mjs'] },
  };
}

const ec2: Ec2SpotTrainerPort = {
  async launchSpotInstance(input) {
    return { region: input.region, availabilityZone: 'us-east-2a', instanceId: 'i-0123456789abcdef0', instanceType: input.instanceType, amiId: input.amiId, state: 'pending' };
  },
  async describeInstance(region, instanceId) {
    return { region, instanceId, state: 'terminated', availabilityZone: 'us-east-2a', launchTime: null, stateReason: null, tags: {} };
  },
  async terminateInstance(_r, instanceId) {
    return { instanceId, state: 'terminated' };
  },
  async sweepExpiredSpotInstances(region) {
    return { region, checkedCount: 0, terminated: [] };
  },
};

function memoryS3(objects: Map<string, Uint8Array>): S3ObjectPort {
  return {
    async putObject(key, body) {
      objects.set(key, body);
      return { sha256: '' };
    },
    async getObject(key) {
      const value = objects.get(key);
      if (!value) throw new Error(`NoSuchKey: ${key}`);
      return value;
    },
  };
}

type Publish = (job: ComputeJob) => Promise<ComputeReleasePublication>;

/** Drives a job to awaiting_release_approval with a verified receipt and attestation. */
async function awaitingRelease(publish: { current: Publish }) {
  const store = new ComputeStore(':memory:', { globalBudgetCapMicros: 1_000_000 });
  const objects = new Map<string, Uint8Array>();
  const orchestrator = new ComputeOrchestrator({
    store,
    ec2,
    s3: memoryS3(objects),
    hfPublisher: { publish: ({ job }) => publish.current(job) },
  });
  const created = await store.create(jobInput());
  await orchestrator.approveAndLaunch(created.id, created.approvalFingerprint, 'ok');
  const files = [{ path: 'model.safetensors', sha256: sha('w'), sizeBytes: 1 }];
  const manifestDigest = computeArtifactManifestDigest(files);
  const receipt: ComputeArtifactReceipt = { version: 1, jobId: created.id, s3Bucket: 'b', s3Prefix: PREFIX, manifestDigest, files, recordedAt: '2026-11-27T00:00:00Z' };
  objects.set(`${PREFIX}/receipt.json`, new TextEncoder().encode(JSON.stringify(receipt)));
  await orchestrator.wakeJob(created.id);
  const attested = await store.recordReleaseAttestation(
    created.id,
    { manifestDigest, releaseCheckPassed: true, metrics: {}, summary: 'ok', verifiedAt: '2026-11-27T00:00:00Z' },
    'independent_verifier',
  );
  assert.equal(attested.status, 'awaiting_release_approval');
  const published = (job: ComputeJob): ComputeReleasePublication => ({
    mode: 'hf_release',
    repository: 'roboco-io/smf-tiny-v1',
    revision: 'main',
    commitSha: 'f'.repeat(40),
    url: 'https://huggingface.co/roboco-io/smf-tiny-v1/commit/x',
    manifestDigest: job.receipt!.manifestDigest,
    publishedAt: '2026-11-27T00:01:00Z',
  });
  return { store, orchestrator, job: attested, published };
}

const APPROVE = { decision: 'approve' as const, openedRawArtifacts: false, durationMinutes: 1, reason: 'ok' };

async function settled(store: ComputeStore, id: string, check: (job: ComputeJob) => boolean): Promise<ComputeJob> {
  for (let i = 0; i < 100; i += 1) {
    const job = await store.get(id);
    if (check(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for the background publication');
}

test('a failed publication keeps the job release_approved, records why, and can be published again', async () => {
  const publish = { current: (async () => { throw new Error('HF upload refused'); }) as Publish };
  const { store, orchestrator, job, published } = await awaitingRelease(publish);

  await assert.rejects(orchestrator.approveAndPublishRelease(job.id, APPROVE), (error: unknown) => (error as { statusCode?: number }).statusCode === 502);
  const failed = await store.get(job.id);
  assert.equal(failed.status, 'release_approved');
  assert.equal(failed.publication, null);
  assert.ok(failed.diagnostics.some((d) => d === 'Release publication failed: HF upload refused'));
  const events = (await store.events(job.id)).map((e) => e.type);
  assert.ok(events.includes('compute.release_publish_started'));
  assert.ok(events.includes('compute.release_publish_failed'));

  // Retry through the API: it answers at once and publishes in the background.
  publish.current = async (j) => published(j);
  const app = Fastify();
  const projects = new ProjectStore(':memory:');
  registerComputeRoutes(app, { auth: { operatorToken: 'o'.repeat(32), workerToken: 'w'.repeat(32), projects }, store, projects, orchestrator });
  try {
    const res = await app.inject({ method: 'POST', url: `/api/compute/jobs/${job.id}/publish-release`, headers: { authorization: `Bearer ${'o'.repeat(32)}` }, payload: {} });
    assert.equal(res.statusCode, 200);
    const released = await settled(store, job.id, (j) => j.status === 'released');
    assert.equal(released.publication?.commitSha, 'f'.repeat(40));
    // Nothing is left to publish again.
    const again = await app.inject({ method: 'POST', url: `/api/compute/jobs/${job.id}/publish-release`, headers: { authorization: `Bearer ${'o'.repeat(32)}` }, payload: {} });
    assert.equal(again.statusCode, 409);
  } finally {
    await app.close();
  }
});

test('approve-release over HTTP returns before the upload and refuses a second concurrent publication', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const publish = { current: (async () => { throw new Error('unused'); }) as Publish };
  const { store, orchestrator, job, published } = await awaitingRelease(publish);
  publish.current = async (j) => {
    await gate;
    return published(j);
  };
  const app = Fastify();
  const projects = new ProjectStore(':memory:');
  registerComputeRoutes(app, { auth: { operatorToken: 'o'.repeat(32), workerToken: 'w'.repeat(32), projects }, store, projects, orchestrator });
  try {
    const headers = { authorization: `Bearer ${'o'.repeat(32)}` };
    const res = await app.inject({ method: 'POST', url: `/api/compute/jobs/${job.id}/approve-release`, headers, payload: APPROVE });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'release_approved');
    assert.ok(orchestrator.isPublishing(job.id));
    const second = await app.inject({ method: 'POST', url: `/api/compute/jobs/${job.id}/publish-release`, headers, payload: {} });
    assert.equal(second.statusCode, 409);
    release();
    await settled(store, job.id, (j) => j.status === 'released');
    assert.equal(orchestrator.isPublishing(job.id), false);
  } finally {
    await app.close();
  }
});

test('a private release reaches the upload instead of being refused by the public-large acknowledgement', async () => {
  // Regression: the publisher passed allowPublicLarge=false for private repositories, which the LFS guard
  // refuses before any network call. A private release must get as far as reading the artifacts.
  const store = new ComputeStore(':memory:', { globalBudgetCapMicros: 1_000_000 });
  const job = await store.create(jobInput('private'));
  let reads = 0;
  let fetches = 0;
  const publisher = createTrustedHfReleasePublisher({
    s3: {
      ...memoryS3(new Map()),
      async openObjectStream() {
        reads += 1;
        throw new Error('stop after the visibility check');
      },
    },
    resolveHfToken: async () => 'hf_test_token_value',
    fetchImpl: (async () => {
      fetches += 1;
      throw new Error('stop after the visibility check');
    }) as typeof fetch,
  });
  const files = [{ path: 'model.safetensors', sha256: sha('w'), sizeBytes: 20 * 1024 * 1024 }];
  const manifestDigest = computeArtifactManifestDigest(files);
  await assert.rejects(
    publisher.publish({
      job,
      receipt: { version: 1, jobId: job.id, s3Bucket: 'b', s3Prefix: PREFIX, manifestDigest, files, recordedAt: '2026-11-27T00:00:00Z' },
      attestation: { manifestDigest, releaseCheckPassed: true, metrics: {}, summary: 'ok', verifiedAt: '2026-11-27T00:00:00Z', attestationSource: 'independent_verifier' } as never,
    }),
  );
  assert.ok(reads + fetches > 0, 'the private release was refused before reading or uploading anything');
});

test('S3 object streams check size and SHA-256 at the end', async () => {
  const body = new TextEncoder().encode('hello world');
  const port = createAwsS3ArtifactsPort({
    region: 'ap-northeast-2',
    bucket: 'b-bucket',
    credentials: () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 's'.repeat(40) }),
    fetchImpl: async () => new Response(body, { status: 200 }),
  });
  const read = async (expectedSha: string, size: number) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of await port.openObjectStream!('k/v', expectedSha, size)) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  };
  assert.equal(await read(sha('hello world'), body.byteLength), 'hello world');
  await assert.rejects(read(sha('other'), body.byteLength), /does not match/);
  await assert.rejects(read(sha('hello world'), 5), /larger than expected/);
});
