import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildApp } from '../apps/control-plane/src/app.js';
import { ComputeOrchestrator } from '../apps/control-plane/src/compute-orchestrator.js';
import { decodeComputeReleaseVerificationSpec, runComputeReleaseVerification } from '../apps/worker/src/aws-compute-verifier-runtime.js';
import { AwsEcsFargateSpotDriver } from '../packages/adapters/src/aws-ecs-driver.js';
import type { Ec2SpotTrainerPort } from '../packages/adapters/src/aws-ec2-spot-trainer.js';
import type { S3ObjectPort } from '../packages/adapters/src/aws-s3-artifacts.js';
import type { CreateComputeJob, ComputeArtifactReceipt } from '../packages/contracts/src/compute.js';
import { computeArtifactManifestDigest, computeInputsDigest, ComputeStore } from '../packages/core/src/compute.js';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const JOB_ID = 'mf-11111111-2222-4333-8444-555555555555';
const PREFIX = 'models/smf-tiny-v1/runs/run-1';
const INPUT_PREFIX = 'models/smf-tiny-v1/inputs/bundle-1';
const CHECK_SCRIPT = [
  "const fs = require('node:fs'), path = require('node:path');",
  "const result = JSON.parse(fs.readFileSync(path.join(process.env.HIVEMIND_ARTIFACT_DIR, 'eval/result.json'), 'utf8'));",
  "const threshold = JSON.parse(fs.readFileSync('threshold.json', 'utf8')).minScore;",
  "console.log('checking score');",
  "console.log(JSON.stringify({ score: result.score, threshold, leakedCreds: Boolean(process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || process.env.HIVEMIND_WORKER_TOKEN) }));",
  'process.exit(result.score >= threshold ? 0 : 1);',
].join('\n');

function makeS3(score: number) {
  const objects = new Map<string, Buffer>();
  const put = (key: string, body: string) => objects.set(key, Buffer.from(body, 'utf8'));
  const resultJson = JSON.stringify({ score });
  const files = [
    { path: 'eval/result.json', sha256: sha(resultJson), sizeBytes: Buffer.byteLength(resultJson) },
    { path: 'model.bin', sha256: sha('weights'), sizeBytes: 7 },
  ];
  put(`${PREFIX}/eval/result.json`, resultJson);
  put(`${PREFIX}/model.bin`, 'weights');
  const receipt: ComputeArtifactReceipt = {
    version: 1,
    jobId: JOB_ID,
    s3Bucket: 'bucket',
    s3Prefix: PREFIX,
    manifestDigest: computeArtifactManifestDigest(files),
    files,
    recordedAt: '2026-11-27T02:00:00.000Z',
  };
  put(`${PREFIX}/receipt.json`, JSON.stringify(receipt));
  const threshold = JSON.stringify({ minScore: 0.8 });
  const inputFiles = [
    { path: 'check.cjs', sha256: sha(CHECK_SCRIPT), sizeBytes: Buffer.byteLength(CHECK_SCRIPT) },
    { path: 'threshold.json', sha256: sha(threshold), sizeBytes: Buffer.byteLength(threshold) },
  ];
  put(`${INPUT_PREFIX}/check.cjs`, CHECK_SCRIPT);
  put(`${INPUT_PREFIX}/threshold.json`, threshold);
  const s3: S3ObjectPort = {
    async putObject(key, body) {
      objects.set(key, Buffer.from(body));
      return { sha256: createHash('sha256').update(Buffer.from(body)).digest('hex') };
    },
    async getObject(key) {
      const found = objects.get(key);
      if (!found) throw new Error(`NoSuchKey: ${key}`);
      return new Uint8Array(found);
    },
  };
  return { s3, objects, receipt, inputs: { s3Prefix: INPUT_PREFIX, files: inputFiles } };
}

test('independent verifier checks receipt, artifact and input hashes, then runs the approved command without task credentials', async (t) => {
  const workRoot = mkdtempSync(join(tmpdir(), 'hivemind-mf-verifier-test-'));
  t.after(() => rmSync(workRoot, { recursive: true, force: true }));
  process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/must-not-reach-the-check';
  process.env.HIVEMIND_WORKER_TOKEN = 'worker-token-must-not-reach-the-check';
  t.after(() => {
    delete process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
    delete process.env.HIVEMIND_WORKER_TOKEN;
  });
  const base = (score: number) => {
    const fixture = makeS3(score);
    return {
      fixture,
      input: {
        jobId: JOB_ID,
        artifactPrefix: PREFIX,
        expectedManifestDigest: fixture.receipt.manifestDigest,
        releaseCheckCommand: [process.execPath, 'check.cjs'],
        inputs: fixture.inputs,
        s3: fixture.s3,
        workRoot,
        now: () => Date.parse('2026-11-27T03:00:00.000Z'),
      },
    };
  };

  const pass = await runComputeReleaseVerification(base(0.91).input);
  assert.equal(pass.releaseCheckPassed, true);
  assert.equal(pass.manifestDigest, base(0.91).fixture.receipt.manifestDigest);
  assert.equal(pass.verifiedAt, '2026-11-27T03:00:00.000Z');
  assert.equal(pass.metrics.score, 0.91);
  assert.equal(pass.metrics.threshold, 0.8);
  assert.equal(pass.metrics.leakedCreds, false, 'the check command must not see task credentials or the worker token');
  assert.equal(pass.metrics.verifierExitCode, 0);
  assert.equal(pass.metrics.artifactFileCount, 2);
  assert.equal(pass.metrics.pinnedInputFileCount, 2);
  assert.match(pass.summary, /Independent verifier ran .*: passed \(exit 0\)/);
  assert.deepEqual(readdirSync(workRoot), [], 'the workspace is removed afterwards');

  // A real failing check produces a failing attestation, not an exception.
  const fail = await runComputeReleaseVerification(base(0.5).input);
  assert.equal(fail.releaseCheckPassed, false);
  assert.equal(fail.metrics.verifierExitCode, 1);

  // Tampering is an exception: no attestation is produced.
  const tamperedArtifact = base(0.91);
  tamperedArtifact.fixture.objects.set(`${PREFIX}/model.bin`, Buffer.from('WEIGHTS'));
  await assert.rejects(() => runComputeReleaseVerification(tamperedArtifact.input), /Artifact model\.bin does not match its receipt entry/);

  const tamperedInput = base(0.91);
  tamperedInput.fixture.objects.set(`${INPUT_PREFIX}/threshold.json`, Buffer.from('{"minScore":0}'));
  await assert.rejects(() => runComputeReleaseVerification(tamperedInput.input), /Pinned input threshold\.json does not match/);

  const otherDigest = base(0.91);
  await assert.rejects(
    () => runComputeReleaseVerification({ ...otherDigest.input, expectedManifestDigest: 'f'.repeat(64) }),
    /does not match the digest recorded by the Control Plane/,
  );

  const forgedReceipt = base(0.91);
  forgedReceipt.fixture.objects.set(
    `${PREFIX}/receipt.json`,
    Buffer.from(JSON.stringify({ ...forgedReceipt.fixture.receipt, files: [forgedReceipt.fixture.receipt.files[0]] })),
  );
  await assert.rejects(() => runComputeReleaseVerification(forgedReceipt.input), /file list does not hash to its manifestDigest/);

  const wrongJob = base(0.91);
  await assert.rejects(() => runComputeReleaseVerification({ ...wrongJob.input, jobId: 'mf-other' }), /belongs to a different job/);

  const tooLarge = base(0.91);
  await assert.rejects(() => runComputeReleaseVerification({ ...tooLarge.input, maxArtifactBytes: 5 }), /above the 5-byte limit/);

  // A receipt path that escapes the artifact directory cannot even be hashed into a manifest.
  assert.throws(() => computeArtifactManifestDigest([{ path: '../escape.txt', sha256: sha('x'), sizeBytes: 1 }]));
});

test('decodeComputeReleaseVerificationSpec accepts the Control Plane spec and rejects malformed ones', () => {
  const spec = { jobId: JOB_ID, artifactPrefix: PREFIX, expectedManifestDigest: 'a'.repeat(64), releaseCheckCommand: ['node', 'check.cjs'] };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
  assert.deepEqual(decodeComputeReleaseVerificationSpec(encode(spec)), spec);
  for (const bad of [{ ...spec, releaseCheckCommand: [] }, { ...spec, expectedManifestDigest: 'short' }, { ...spec, releaseCheckCommand: 'node check' }, { ...spec, inputs: { files: [] } }]) {
    assert.throws(() => decodeComputeReleaseVerificationSpec(encode(bad)), /Malformed/);
  }
});

function jobInput(inputs: CreateComputeJob['compute']['inputs']): CreateComputeJob {
  return {
    title: 'Independent verification',
    workloadId: 'smf-tiny-v1',
    repository: 'roboco-io/silicon-model-factory',
    baseCommit: 'a'.repeat(40),
    compute: {
      region: 'us-east-2',
      instanceType: 't4g.nano',
      amiId: 'ami-0123456789abcdef0',
      maxLifetimeMs: 300_000,
      maxHourlyPriceUsd: 0.01,
      maxTotalCostMicros: 50_000,
      s3ArtifactPrefix: PREFIX,
      ...(inputs ? { inputs } : {}),
    },
    releasePolicy: { mode: 's3_artifact_only', visibility: 'private', releaseCheckCommand: ['node', 'check.cjs'] },
  };
}

test('dispatch-verifier starts the verifier with the approved command and pinned inputs; its report is recorded as independent_verifier', async () => {
  const OP = 'op-verifier-token-999999999999';
  const WK = 'wk-verifier-token-111111111111';
  const fixture = makeS3(0.91);
  const launches: { jobId: string; specBase64: string }[] = [];
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
  const app = buildApp({
    operatorToken: OP,
    workerToken: WK,
    computeOrchestratorFactory: (store: ComputeStore) =>
      new ComputeOrchestrator({
        store,
        ec2,
        s3: fixture.s3,
        verifierLauncher: {
          async launchModelReleaseVerifier(input) {
            launches.push(input);
            return { taskArn: `arn:aws:ecs:ap-northeast-2:123456789012:task/c/verifier-${launches.length}` };
          },
        },
      }),
  });
  const call = async (method: 'GET' | 'POST', url: string, token: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  try {
    const inputs = { s3Prefix: INPUT_PREFIX, files: fixture.inputs.files, digest: computeInputsDigest(INPUT_PREFIX, fixture.inputs.files) };
    const created = (await call('POST', '/api/compute/jobs', OP, jobInput(inputs))).json();
    // Not yet evaluating: dispatch is refused and nothing is launched.
    assert.equal((await call('POST', `/api/compute/jobs/${created.id}/dispatch-verifier`, OP, {})).statusCode, 409);
    assert.equal(launches.length, 0);

    await call('POST', `/api/compute/jobs/${created.id}/approve`, OP, { approvalFingerprint: created.approvalFingerprint, reason: 'ok' });
    // The fixture receipt carries a fixed job id; rewrite it for the job the API created.
    fixture.objects.set(`${PREFIX}/receipt.json`, Buffer.from(JSON.stringify({ ...fixture.receipt, jobId: created.id })));
    const woken = (await call('POST', `/api/compute/jobs/${created.id}/wake`, OP, {})).json();
    assert.equal(woken.status, 'evaluating');

    // Only the operator may dispatch; the worker token may not.
    assert.equal((await call('POST', `/api/compute/jobs/${created.id}/dispatch-verifier`, WK, {})).statusCode, 401);
    const dispatched = await call('POST', `/api/compute/jobs/${created.id}/dispatch-verifier`, OP, {});
    assert.equal(dispatched.statusCode, 200, dispatched.body);
    assert.match(dispatched.json().releaseVerifier.ecsTaskArn, /verifier-1$/);
    assert.equal(dispatched.json().status, 'evaluating', 'dispatching does not change the job state');

    const spec = decodeComputeReleaseVerificationSpec(launches[0]!.specBase64);
    assert.deepEqual(spec.releaseCheckCommand, ['node', 'check.cjs']);
    assert.equal(spec.expectedManifestDigest, fixture.receipt.manifestDigest);
    assert.equal(spec.artifactPrefix, PREFIX);
    assert.deepEqual(spec.inputs?.files, fixture.inputs.files);

    // The verifier runs with that spec and reports with the worker token.
    const workRoot = mkdtempSync(join(tmpdir(), 'hivemind-mf-verifier-api-'));
    try {
      const attestation = await runComputeReleaseVerification({ ...spec, releaseCheckCommand: [process.execPath, 'check.cjs'], s3: fixture.s3, workRoot });
      // The operator token cannot use the verifier endpoint.
      assert.equal((await call('POST', `/api/compute/jobs/${created.id}/verifier-attestation`, OP, attestation)).statusCode, 401);
      const reported = await call('POST', `/api/compute/jobs/${created.id}/verifier-attestation`, WK, attestation);
      assert.equal(reported.statusCode, 200, reported.body);
      const job = reported.json();
      assert.equal(job.status, 'awaiting_release_approval');
      assert.equal(job.releaseAttestation.attestationSource, 'independent_verifier');
      assert.equal(job.releaseAttestation.verificationDisclaimer, null);
      assert.equal(job.releaseAttestation.metrics.score, 0.91);
    } finally {
      rmSync(workRoot, { recursive: true, force: true });
    }
    // After the attestation the job is no longer evaluating, so another dispatch is refused.
    assert.equal((await call('POST', `/api/compute/jobs/${created.id}/dispatch-verifier`, OP, {})).statusCode, 409);
    assert.equal(launches.length, 1);
  } finally {
    await app.close();
  }
});

test('AwsEcsFargateSpotDriver.launchModelReleaseVerifier runs the verifier task definition with only non-secret overrides', async () => {
  const bodies: Record<string, any>[] = [];
  const driver = new AwsEcsFargateSpotDriver({
    region: 'ap-northeast-2',
    allowedRegions: ['ap-northeast-2'],
    clusterArn: 'arn:aws:ecs:ap-northeast-2:123456789012:cluster/c',
    workerTaskDefinition: 'worker:1',
    verifierTaskDefinition: 'verifier:7',
    subnets: ['subnet-a'],
    securityGroups: ['sg-a'],
    controlApiUrl: 'http://10.0.0.10:4310',
    allowVpcInternalHttp: true,
    artifactsBucket: 'bucket',
    credentials: () => ({ accessKeyId: 'AKIAEXAMPLE123456', secretAccessKey: 'secret' }),
    fetchImpl: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ tasks: [{ taskArn: 'arn:aws:ecs:ap-northeast-2:123456789012:task/c/v1' }] }), { status: 200 });
    },
  });
  const specBase64 = Buffer.from(JSON.stringify({ jobId: JOB_ID }), 'utf8').toString('base64');
  assert.deepEqual(await driver.launchModelReleaseVerifier({ jobId: JOB_ID, specBase64 }), { taskArn: 'arn:aws:ecs:ap-northeast-2:123456789012:task/c/v1' });
  const body = bodies[0]!;
  assert.equal(body.taskDefinition, 'verifier:7');
  assert.deepEqual(body.capacityProviderStrategy, [{ capacityProvider: 'FARGATE_SPOT', weight: 1, base: 0 }]);
  const override = body.overrides.containerOverrides[0];
  assert.equal(override.name, 'verifier');
  assert.deepEqual(override.environment.map((e: { name: string }) => e.name), ['HIVEMIND_CONTROL_API_URL', 'HIVEMIND_ARTIFACTS_BUCKET', 'HIVEMIND_MF_VERIFY_SPEC_B64']);
  assert.ok(!JSON.stringify(body).includes('TOKEN'));
  await assert.rejects(() => driver.launchModelReleaseVerifier({ jobId: JOB_ID, specBase64: 'not base64!' }), /not base64/);
  await assert.rejects(() => driver.launchModelReleaseVerifier({ jobId: JOB_ID, specBase64: 'A'.repeat(7001) }), /size budget/);
});
