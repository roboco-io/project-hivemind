import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import { registerComputeRoutes } from '../apps/control-plane/src/compute-api.js';
import { ComputeOrchestrator, type TrustedHfReleasePublisherPort } from '../apps/control-plane/src/compute-orchestrator.js';
import type { Ec2SpotTrainerPort } from '../packages/adapters/src/aws-ec2-spot-trainer.js';
import type { S3ObjectPort } from '../packages/adapters/src/aws-s3-artifacts.js';
import { createTrustedHfReleasePublisher } from '../packages/adapters/src/compute-hf-publisher.js';
import type { CreateComputeJob, ComputeJob } from '../packages/contracts/src/compute.js';
import { ComputeStore, autoPublishAllowed, computeArtifactManifestDigest } from '../packages/core/src/compute.js';
import { ProjectStore } from '../packages/core/src/projects.js';

const OP = 'o'.repeat(32);
const WK = 'w'.repeat(32);
const PREFIX = 'models/smf-tiny-v1/runs/run-01';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function jobInput(release: Partial<CreateComputeJob['releasePolicy']> = {}): CreateComputeJob {
  return {
    title: 'Auto publish',
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
    releasePolicy: { mode: 'hf_release', hfRepository: 'roboco-io/smf-tiny-v1', visibility: 'public', releaseCheckCommand: ['node', 'check.mjs'], autoPublish: true, ...release },
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

function harness(prefixes: string[] = ['roboco-io/']) {
  const store = new ComputeStore(':memory:', { globalBudgetCapMicros: 1_000_000, autoPublishRepoPrefixes: prefixes });
  const objects = new Map<string, Uint8Array>();
  const s3: S3ObjectPort = {
    async putObject(key, body) { objects.set(key, body); return { sha256: '' }; },
    async getObject(key) { const v = objects.get(key); if (!v) throw new Error(`NoSuchKey: ${key}`); return v; },
  };
  const calls: string[] = [];
  const notes: string[] = [];
  const publisher: TrustedHfReleasePublisherPort = {
    async ensureRepository(repository, visibility) { calls.push(`ensure:${repository}:${visibility}`); return 'created'; },
    async publish({ job, receipt }) {
      calls.push(`publish:${job.releasePolicy.hfRepository}`);
      return { mode: 'hf_release', repository: job.releasePolicy.hfRepository!, revision: 'main', commitSha: 'f'.repeat(40), url: 'https://huggingface.co/x', manifestDigest: receipt.manifestDigest, publishedAt: '2026-11-28T00:00:00Z', verifiedFiles: receipt.files.length };
    },
  };
  const orchestrator = new ComputeOrchestrator({ store, ec2, s3, hfPublisher: publisher, notify: async (kind) => { notes.push(kind); } });
  const projects = new ProjectStore(':memory:');
  const app = Fastify();
  registerComputeRoutes(app, { auth: { operatorToken: OP, workerToken: WK, projects }, store, projects, orchestrator });
  return { store, orchestrator, objects, calls, notes, app };
}

/** Trains a job to `evaluating` with a receipt in S3. */
async function evaluating(h: ReturnType<typeof harness>, input = jobInput()): Promise<{ job: ComputeJob; manifestDigest: string }> {
  const created = await h.store.create(input);
  await h.orchestrator.approveAndLaunch(created.id, created.approvalFingerprint, 'ok');
  const files = [{ path: 'model.safetensors', sha256: sha('w'), sizeBytes: 1 }];
  const manifestDigest = computeArtifactManifestDigest(files);
  h.objects.set(`${PREFIX}/receipt.json`, new TextEncoder().encode(JSON.stringify({ version: 1, jobId: created.id, s3Bucket: 'b', s3Prefix: PREFIX, manifestDigest, files, recordedAt: '2026-11-28T00:00:00Z' })));
  const job = await h.orchestrator.wakeJob(created.id);
  assert.equal(job.status, 'evaluating');
  return { job, manifestDigest };
}

async function settled(store: ComputeStore, id: string, check: (job: ComputeJob) => boolean): Promise<ComputeJob> {
  for (let i = 0; i < 100; i += 1) {
    const job = await store.get(id);
    if (check(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return store.get(id);
}

const attestation = (manifestDigest: string, passed = true) => ({ manifestDigest, releaseCheckPassed: passed, metrics: {}, summary: 'release-check', verifiedAt: '2026-11-28T00:00:00Z' });

test('auto-publish is refused at registration outside the operator prefixes', async () => {
  await assert.rejects(new ComputeStore(':memory:').create(jobInput()), (e: { statusCode?: number }) => e.statusCode === 403);
  await assert.rejects(new ComputeStore(':memory:', { autoPublishRepoPrefixes: ['other-org/'] }).create(jobInput()), (e: { statusCode?: number }) => e.statusCode === 403);
  const ok = await new ComputeStore(':memory:', { autoPublishRepoPrefixes: ['roboco-io/'] }).create(jobInput());
  assert.equal(ok.releasePolicy.autoPublish, true);
  // Without autoPublish the fingerprint is the same as before the feature existed.
  const plain = await new ComputeStore(':memory:').create(jobInput({ autoPublish: undefined }));
  assert.equal('autoPublish' in plain.releasePolicy, false);
  assert.notEqual(ok.approvalFingerprint, plain.approvalFingerprint);
  assert.equal(autoPublishAllowed({ mode: 's3_artifact_only', visibility: 'private', releaseCheckCommand: ['x'], autoPublish: true }, []), true);
  assert.equal(autoPublishAllowed({ mode: 'hf_release', hfRepository: 'roboco-io/x', visibility: 'public', releaseCheckCommand: ['x'], autoPublish: true }, ['roboco-io']), false, 'a prefix must end with /');
});

test('an independent verifier pass publishes without an operator, after creating the repository', async (t) => {
  const h = harness();
  t.after(() => h.app.close());
  const { job, manifestDigest } = await evaluating(h);
  const res = await h.app.inject({ method: 'POST', url: `/api/compute/jobs/${job.id}/verifier-attestation`, headers: { authorization: `Bearer ${WK}` }, payload: attestation(manifestDigest) });
  assert.equal(res.statusCode, 200);
  const released = await settled(h.store, job.id, (j) => j.status === 'released');
  assert.equal(released.status, 'released');
  assert.deepEqual(h.calls, ['ensure:roboco-io/smf-tiny-v1:public', 'publish:roboco-io/smf-tiny-v1']);
  assert.equal(released.publication?.approvedBy, 'auto_publish_policy');
  assert.equal(released.publication?.verifiedFiles, 1);
  assert.match(String(released.releaseDecision?.reason), /Auto-publish policy/);
  assert.ok((await h.store.events(job.id)).some((e) => e.type === 'compute.release_auto_approved'));
  assert.deepEqual(h.notes, ['release_published']);
});

test('a failed check, an operator self-report, or a plain job is never published automatically', async (t) => {
  for (const variant of ['failed', 'self-reported', 'plain'] as const) {
    const h = harness();
    t.after(() => h.app.close());
    const { job, manifestDigest } = await evaluating(h, variant === 'plain' ? jobInput({ autoPublish: undefined }) : jobInput());
    const url = variant === 'self-reported' ? `/api/compute/jobs/${job.id}/verify-release` : `/api/compute/jobs/${job.id}/verifier-attestation`;
    const token = variant === 'self-reported' ? OP : WK;
    await h.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload: attestation(manifestDigest, variant !== 'failed') });
    await h.orchestrator.wakeDueJobs();
    const after = await settled(h.store, job.id, () => false);
    assert.notEqual(after.status, 'released', variant);
    assert.equal(after.publication, null, variant);
    assert.deepEqual(h.calls, [], variant);
  }
});

test('a verifier pass recorded while nothing published it is picked up by the periodic wake', async () => {
  const h = harness();
  const { job, manifestDigest } = await evaluating(h);
  await h.store.recordReleaseAttestation(job.id, attestation(manifestDigest), 'independent_verifier');
  await h.orchestrator.wakeDueJobs();
  const released = await settled(h.store, job.id, (j) => j.status === 'released');
  assert.equal(released.status, 'released');
  await h.app.close();
});

test('narrowing the prefixes after registration stops an auto-publish', async () => {
  const strict = new ComputeStore(':memory:', { autoPublishRepoPrefixes: [] });
  const loose = harness();
  const { job, manifestDigest } = await evaluating(loose);
  await loose.store.recordReleaseAttestation(job.id, attestation(manifestDigest), 'independent_verifier');
  const snapshot = await loose.store.get(job.id);
  assert.equal(loose.store.isAutoPublishEligible(snapshot), true);
  assert.equal(strict.isAutoPublishEligible(snapshot), false);
  await loose.app.close();
});

test('ensureRepository creates a missing repository with the requested visibility and leaves an existing one', async () => {
  const requests: { url: string; method: string; body?: string }[] = [];
  let exists = false;
  const publisher = createTrustedHfReleasePublisher({
    s3: { async putObject() { return { sha256: '' }; }, async getObject() { return new Uint8Array(); } },
    resolveHfToken: async () => 'hf_test_token',
    fetchImpl: (async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method ?? 'GET', ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
      if (String(url).includes('/api/models/')) return new Response('{}', { status: exists ? 200 : 404 });
      return new Response('{"url":"x"}', { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(await publisher.ensureRepository('roboco-io/rtl-repair-7b', 'public'), 'created');
  assert.deepEqual(JSON.parse(requests[1]!.body!), { type: 'model', name: 'rtl-repair-7b', organization: 'roboco-io', private: false });
  exists = true;
  assert.equal(await publisher.ensureRepository('roboco-io/rtl-repair-7b', 'public'), 'exists');
  assert.equal(requests.length, 3);
  await assert.rejects(publisher.ensureRepository('roboco-io/../x', 'public'));
});
