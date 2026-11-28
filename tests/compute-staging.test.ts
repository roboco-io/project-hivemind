import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ComputeOrchestrator,
  composeComputeUserData,
  stagingPrefixBase,
} from '../apps/control-plane/src/compute-orchestrator.js';
import { createAwsS3ArtifactsPort, type S3ObjectPort } from '../packages/adapters/src/aws-s3-artifacts.js';
import type { Ec2SpotTrainerPort } from '../packages/adapters/src/aws-ec2-spot-trainer.js';
import type { CreateComputeJob, ComputeArtifactReceipt } from '../packages/contracts/src/compute.js';
import { ComputeStore, computeArtifactManifestDigest } from '../packages/core/src/compute.js';

const ROLE_ID = 'AROAEXAMPLEROLEID0001';
const PREFIX = 'models/smf-tiny-v1/runs/run-staging';
const INSTANCE = 'i-0123456789abcdef0';
const STAGING = `staging/${ROLE_ID}:${INSTANCE}`;

function jobInput(): CreateComputeJob {
  return {
    title: 'Staging',
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
      userDataScript: '#!/bin/bash\necho train\n',
    },
    releasePolicy: { mode: 's3_artifact_only', visibility: 'private', releaseCheckCommand: ['node', 'tools/release-check.mjs'] },
  };
}

test('with a staging role the bootstrap writes to staging/<role id>:<instance id> and keeps the job prefix aside', async () => {
  const store = new ComputeStore(':memory:', { globalBudgetCapMicros: 1_000_000 });
  const job = await store.create(jobInput());
  const script = composeComputeUserData(job, { artifactsBucket: 'b-bucket', stagingRoleId: ROLE_ID })!;
  assert.match(script, /^#!\/bin\/bash\n# --- HIVEMIND pinned job metadata/);
  assert.match(script, new RegExp(`export HIVEMIND_JOB_ARTIFACT_PREFIX='${PREFIX}'`));
  assert.match(script, /X-aws-ec2-metadata-token-ttl-seconds: 60/);
  assert.match(script, /export HIVEMIND_ARTIFACT_PREFIX="staging\/AROAEXAMPLEROLEID0001:\$HIVEMIND_INSTANCE_ID"/);
  assert.doesNotMatch(script, new RegExp(`export HIVEMIND_ARTIFACT_PREFIX='${PREFIX}'`));
  assert.ok(script.indexOf('unset HIVEMIND_IMDS_TOKEN') < script.indexOf('echo train'));
  assert.throws(() => composeComputeUserData(job, { stagingRoleId: "AROA'; rm -rf /" }), /Invalid compute instance role ID/);
  // Without a staging role the old behaviour stays.
  assert.match(composeComputeUserData(job, {})!, new RegExp(`export HIVEMIND_ARTIFACT_PREFIX='${PREFIX}'`));
  assert.equal(stagingPrefixBase(ROLE_ID), `staging/${ROLE_ID}:`);
});

function memoryS3(objects: Map<string, Uint8Array>) {
  const copies: [string, string][] = [];
  const port: S3ObjectPort = {
    async putObject(key, body) {
      objects.set(key, body);
      return { sha256: '' };
    },
    async getObject(key) {
      const value = objects.get(key);
      if (!value) throw new Error(`NoSuchKey: ${key}`);
      return value;
    },
    async headObject(key) {
      const value = objects.get(key);
      if (!value) throw new Error(`S3 HEAD ${key} failed with HTTP 404`);
      return { contentLength: value.byteLength };
    },
    async copyObject(source, destination) {
      const value = objects.get(source);
      if (!value) throw new Error(`S3 copy ${source} failed`);
      copies.push([source, destination]);
      objects.set(destination, value);
    },
  };
  return { port, copies };
}

function ec2(state: { value: 'running' | 'stopped' }): Ec2SpotTrainerPort {
  return {
    async launchSpotInstance(input) {
      return { region: input.region, availabilityZone: 'us-east-2a', instanceId: INSTANCE, instanceType: input.instanceType, amiId: input.amiId, state: 'pending' };
    },
    async describeInstance(region, instanceId) {
      return { region, instanceId, state: state.value, availabilityZone: 'us-east-2a', launchTime: null, stateReason: null, tags: {} };
    },
    async terminateInstance(_r, instanceId) {
      return { instanceId, state: 'terminated' };
    },
    async sweepExpiredSpotInstances(region) {
      return { region, checkedCount: 0, terminated: [] };
    },
  };
}

function receiptFor(jobId: string, prefix: string, body: Uint8Array): ComputeArtifactReceipt {
  const files = [{ path: 'model/weights.bin', sha256: 'e'.repeat(64), sizeBytes: body.byteLength }];
  return { version: 1, jobId, s3Bucket: 'b-bucket', s3Prefix: prefix, manifestDigest: computeArtifactManifestDigest(files), files, recordedAt: '2026-11-27T10:00:00Z' };
}

async function launched(objects: Map<string, Uint8Array>) {
  const store = new ComputeStore(':memory:', { globalBudgetCapMicros: 1_000_000 });
  const s3 = memoryS3(objects);
  const state = { value: 'running' as 'running' | 'stopped' };
  const orchestrator = new ComputeOrchestrator({ store, ec2: ec2(state), s3: s3.port, trainingRoleId: ROLE_ID, artifactsBucket: 'b-bucket' });
  const job = await store.create(jobInput());
  const running = await orchestrator.approveAndLaunch(job.id, job.approvalFingerprint, 'ok');
  assert.equal(running.status, 'running');
  return { store, orchestrator, job: running, copies: s3.copies, state };
}

test('the Control Plane copies a staged receipt from the instance folder to the job prefix and records it', async () => {
  const objects = new Map<string, Uint8Array>();
  const { orchestrator, job, copies } = await launched(objects);
  const weights = new Uint8Array([1, 2, 3, 4]);
  objects.set(`${STAGING}/model/weights.bin`, weights);
  objects.set(`${STAGING}/receipt.json`, new TextEncoder().encode(JSON.stringify(receiptFor(job.id, STAGING, weights))));

  const woken = await orchestrator.wakeJob(job.id);
  assert.equal(woken.status, 'evaluating');
  assert.equal(woken.receipt?.s3Prefix, PREFIX);
  assert.deepEqual(copies, [[`${STAGING}/model/weights.bin`, `${PREFIX}/model/weights.bin`]]);
  const promoted = JSON.parse(new TextDecoder().decode(objects.get(`${PREFIX}/receipt.json`)!)) as ComputeArtifactReceipt;
  assert.equal(promoted.s3Prefix, PREFIX);
});

test('a receipt in another instance folder, for another job, or naming another prefix is ignored', async () => {
  for (const variant of ['other-instance', 'other-job', 'other-prefix'] as const) {
    const objects = new Map<string, Uint8Array>();
    const { orchestrator, job, copies } = await launched(objects);
    const weights = new Uint8Array([9]);
    const folder = variant === 'other-instance' ? `staging/${ROLE_ID}:i-0fffffffffffffff0` : STAGING;
    const receipt = receiptFor(variant === 'other-job' ? 'mf-00000000-0000-0000-0000-000000000000' : job.id, variant === 'other-prefix' ? 'models/x/runs/y' : folder, weights);
    objects.set(`${folder}/model/weights.bin`, weights);
    objects.set(`${folder}/receipt.json`, new TextEncoder().encode(JSON.stringify(receipt)));
    const woken = await orchestrator.wakeJob(job.id);
    assert.equal(woken.status, 'running', variant);
    assert.equal(woken.receipt, null, variant);
    assert.equal(copies.length, 0, variant);
  }
});

test('a job launched before staging still finds its receipt at the job prefix', async () => {
  const objects = new Map<string, Uint8Array>();
  const { orchestrator, job, copies } = await launched(objects);
  const weights = new Uint8Array([7, 7]);
  objects.set(`${PREFIX}/model/weights.bin`, weights);
  objects.set(`${PREFIX}/receipt.json`, new TextEncoder().encode(JSON.stringify(receiptFor(job.id, PREFIX, weights))));
  const woken = await orchestrator.wakeJob(job.id);
  assert.equal(woken.status, 'evaluating');
  assert.equal(copies.length, 0);
});

test('S3 CopyObject is signed with x-amz-copy-source and fails on an error body even with HTTP 200', async () => {
  const seen: Record<string, string>[] = [];
  let body = '<CopyObjectResult><ETag>"x"</ETag></CopyObjectResult>';
  const port = createAwsS3ArtifactsPort({
    region: 'ap-northeast-2',
    bucket: 'b-bucket',
    credentials: () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 's'.repeat(40) }),
    fetchImpl: async (_url, init) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      seen.push(headers);
      return new Response(body, { status: 200 });
    },
  });
  await port.copyObject!(`${STAGING}/model/weights.bin`, `${PREFIX}/model/weights.bin`);
  assert.equal(seen[0]!['x-amz-copy-source'], `/b-bucket/staging/${ROLE_ID}%3A${INSTANCE}/model/weights.bin`);
  assert.equal(seen[0]!['x-amz-checksum-sha256'], undefined);
  assert.match(seen[0]!.authorization!, /SignedHeaders=[^,]*x-amz-copy-source/);
  body = '<Error><Code>InternalError</Code></Error>';
  await assert.rejects(port.copyObject!('a/b', 'c/d'), /S3 copy a\/b -> c\/d failed/);
});
