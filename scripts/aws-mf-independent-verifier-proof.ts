import { createHash } from 'node:crypto';
import { createAwsS3ArtifactsPort } from '../packages/adapters/src/aws-s3-artifacts.js';
import type { ModelFactoryJob } from '../packages/contracts/src/model-factory.js';
import { computeTrainingInputsDigest } from '../packages/core/src/model-factory.js';
import {
  apiJson,
  aws,
  ControlPlane,
  loadOperatorToken,
  loadProfileCredentials,
  loadRuntimeOutputs,
  PRIMARY_REGION,
  sleep,
  waitForNoManagedInstances,
} from './lib/aws-live.js';

/**
 * Live AWS proof of the independent Model Factory release verifier.
 *
 *   1. Upload pinned inputs to S3: an evaluation script, sample data, and the release check script.
 *   2. The Control Plane launches one t4g.nano Spot instance in us-east-2. The instance downloads the
 *      inputs, runs the evaluation, uploads `eval-result.json` and `receipt.json`, and shuts itself down.
 *   3. Control Plane wake verifies the receipt: the job becomes `evaluating`.
 *   4. `dispatch-verifier` starts the verifier Fargate Spot task. It re-checks every hash, runs the release
 *      check, and reports with the worker token.
 *   5. The job must become `awaiting_release_approval` with `attestationSource: independent_verifier`.
 *
 * The job uses `s3_artifact_only`, so nothing is published. The script cancels nothing that succeeded,
 * always returns the Control Plane to desiredCount 0, and never prints the operator token.
 */
const INSTANCE_REGION = 'us-east-2';
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const RELEASE_CHECK = [
  "const fs = require('node:fs'), path = require('node:path');",
  "const result = JSON.parse(fs.readFileSync(path.join(process.env.HIVEMIND_ARTIFACT_DIR, 'eval-result.json'), 'utf8'));",
  "const threshold = JSON.parse(fs.readFileSync('threshold.json', 'utf8')).minAvgScore;",
  "const ok = result.executedOnInstance === true && result.avgScore >= threshold;",
  "console.log(JSON.stringify({ avgScore: result.avgScore, threshold, sampleCount: result.count }));",
  'process.exit(ok ? 0 : 1);',
  '',
].join('\n');

async function main(): Promise<void> {
  const outputs = loadRuntimeOutputs();
  const controlPlane = ControlPlane.fromOutputs(outputs, Number(process.env.HIVEMIND_LOCAL_PORT ?? '14381'));
  const operatorToken = loadOperatorToken(outputs);
  const bucket = outputs.ArtifactsBucketName!;
  const amiId = aws(INSTANCE_REGION, ['ssm', 'get-parameter', '--name', '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64', '--query', 'Parameter.Value', '--output', 'text']);
  const s3 = createAwsS3ArtifactsPort({ region: PRIMARY_REGION, allowedRegions: [PRIMARY_REGION], bucket, credentials: loadProfileCredentials });

  const stamp = Date.now();
  const modelId = 'smf-verifier-proof';
  const inputsPrefix = `models/${modelId}/inputs/bundle-${stamp}`;
  const artifactPrefix = `models/${modelId}/runs/run-${stamp}`;
  const inputContents: Record<string, string> = {
    'eval_canary.py': [
      'import json, sys',
      'data = json.load(open(sys.argv[1]))',
      'score = sum(item["score"] for item in data["samples"]) / len(data["samples"])',
      'json.dump({"model": data["model"], "count": len(data["samples"]), "avgScore": round(score, 4)}, open(sys.argv[2], "w"), indent=2)',
      '',
    ].join('\n'),
    'samples.json': JSON.stringify({ model: 'verilog-embed-canary', samples: [{ id: 'v1', score: 0.81 }, { id: 'v2', score: 0.77 }, { id: 'v3', score: 0.85 }] }),
    'release-check.cjs': RELEASE_CHECK,
    'threshold.json': JSON.stringify({ minAvgScore: 0.8 }),
  };
  const inputFiles = [];
  for (const [path, content] of Object.entries(inputContents)) {
    const bytes = Buffer.from(content, 'utf8');
    await s3.putObject(`${inputsPrefix}/${path}`, bytes, 'application/octet-stream');
    inputFiles.push({ path, sha256: sha256(bytes), sizeBytes: bytes.byteLength });
  }
  const inputsDigest = computeTrainingInputsDigest(inputsPrefix, inputFiles);

  const userDataScript = `#!/bin/bash
set -euo pipefail
trap 'shutdown -h now' EXIT
WORKDIR=/tmp/mf-work
mkdir -p "$WORKDIR/inputs" "$WORKDIR/out"
python3 - <<'PY'
import base64, datetime, hashlib, json, os, subprocess, sys

bucket = os.environ['HIVEMIND_ARTIFACTS_BUCKET']
region = os.environ['HIVEMIND_ARTIFACTS_REGION']
job_id = os.environ['HIVEMIND_JOB_ID']
out_prefix = os.environ['HIVEMIND_ARTIFACT_PREFIX']
manifest = json.loads(base64.b64decode(os.environ['HIVEMIND_INPUTS_MANIFEST_B64']).decode('utf-8'))
in_prefix = manifest['s3Prefix']

for f in manifest['files']:
    local_path = os.path.join('/tmp/mf-work/inputs', f['path'])
    os.makedirs(os.path.dirname(local_path), exist_ok=True)
    subprocess.run(
        ['aws', 's3', 'cp', f"s3://{bucket}/{in_prefix}/{f['path']}", local_path, '--region', region],
        check=True,
    )
    actual = hashlib.sha256(open(local_path, 'rb').read()).hexdigest()
    assert actual == f['sha256'], f"Input SHA-256 mismatch for {f['path']}"

# Verify IAM Deny prevents mutating immutable inputs/*
tamper = subprocess.run(
    ['aws', 's3', 'cp', '/tmp/mf-work/inputs/samples.json', f"s3://{bucket}/{in_prefix}/tamper.json", '--region', region],
    capture_output=True,
)
input_write_denied = tamper.returncode != 0

subprocess.run(
    ['python3', '/tmp/mf-work/inputs/eval_canary.py', '/tmp/mf-work/inputs/samples.json', '/tmp/mf-work/out/eval-result.json'],
    check=True,
)
result = json.load(open('/tmp/mf-work/out/eval-result.json'))
result['inputWriteDenied'] = input_write_denied
result['executedOnInstance'] = True
json.dump(result, open('/tmp/mf-work/out/eval-result.json', 'w'), indent=2)

out_bytes = open('/tmp/mf-work/out/eval-result.json', 'rb').read()
out_sha = hashlib.sha256(out_bytes).hexdigest()
files_meta = [{'path': 'eval-result.json', 'sha256': out_sha, 'sizeBytes': len(out_bytes)}]
canonical = json.dumps({'version': 1, 'files': files_meta}, separators=(',', ':'))
manifest_digest = hashlib.sha256(canonical.encode('utf-8')).hexdigest()

receipt = {
    'version': 1,
    'jobId': job_id,
    's3Bucket': bucket,
    's3Prefix': out_prefix,
    'manifestDigest': manifest_digest,
    'files': files_meta,
    'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z'),
}
open('/tmp/mf-work/out/receipt.json', 'w').write(json.dumps(receipt, indent=2))

subprocess.run(
    ['aws', 's3', 'cp', '/tmp/mf-work/out/eval-result.json', f"s3://{bucket}/{out_prefix}/eval-result.json", '--region', region],
    check=True,
)
subprocess.run(
    ['aws', 's3', 'cp', '/tmp/mf-work/out/receipt.json', f"s3://{bucket}/{out_prefix}/receipt.json", '--region', region],
    check=True,
)
PY
`;

  const startedAtMs = Date.now();
  const summary: Record<string, unknown> = {};
  let jobId: string | null = null;
  try {
    await controlPlane.start();
    const api = <T>(path: string, body?: unknown) => apiJson<T>(`${controlPlane.baseUrl}${path}`, operatorToken, body);

    const created = await api<ModelFactoryJob>('/api/model-factory/jobs', {
      title: 'Independent release verifier live proof',
      modelId,
      repository: 'roboco-io/silicon-model-factory',
      baseCommit: 'a'.repeat(40),
      compute: {
        region: INSTANCE_REGION,
        instanceType: 't4g.nano',
        amiId,
        maxLifetimeMs: 300_000,
        maxHourlyPriceUsd: 0.01,
        maxTotalCostMicros: 50_000,
        userDataScript,
        s3ArtifactPrefix: artifactPrefix,
        inputs: { s3Prefix: inputsPrefix, digest: inputsDigest, files: inputFiles },
      },
      releasePolicy: { mode: 's3_artifact_only', visibility: 'private', releaseCheckCommand: ['node', 'release-check.cjs'] },
    });
    jobId = created.id;
    const launched = await api<ModelFactoryJob>(`/api/model-factory/jobs/${jobId}/approve-training`, {
      approvalFingerprint: created.approvalFingerprint,
      reason: 'Independent release verifier live proof',
    });
    if (launched.status !== 'training_running' || !launched.instance) {
      throw new Error(`Launch failed: status=${launched.status} failureReason=${launched.failureReason ?? ''}`);
    }
    console.log(JSON.stringify({ phase: 'launched', jobId, instanceId: launched.instance.instanceId }));

    // Wait for the instance to upload its receipt and shut down.
    let job: ModelFactoryJob = launched;
    for (const deadline = Date.now() + 290_000; Date.now() < deadline; ) {
      await sleep(15_000);
      job = await api<ModelFactoryJob>(`/api/model-factory/jobs/${jobId}/wake`, {});
      console.log(JSON.stringify({ phase: 'wake', status: job.status, instanceState: job.instance?.state ?? null, hasReceipt: Boolean(job.receipt) }));
      if ((job.status === 'evaluating' && job.cost.settledMicros !== null) || job.status === 'failed') break;
    }
    if (job.status !== 'evaluating' || !job.receipt) {
      throw new Error(`Expected evaluating with a receipt, got status=${job.status} failureReason=${job.failureReason ?? ''}`);
    }
    summary.receipt = { manifestDigest: job.receipt.manifestDigest, files: job.receipt.files.map((f) => f.path) };
    summary.attestationBeforeVerifier = job.releaseAttestation;

    const dispatched = await api<ModelFactoryJob>(`/api/model-factory/jobs/${jobId}/dispatch-verifier`, {});
    const verifierTaskArn = dispatched.releaseVerifier?.ecsTaskArn ?? null;
    summary.verifierTask = verifierTaskArn ? verifierTaskArn.split('/').pop() : null;
    console.log(JSON.stringify({ phase: 'verifier_dispatched', statusAfterDispatch: dispatched.status }));

    for (const deadline = Date.now() + 420_000; Date.now() < deadline; ) {
      await sleep(15_000);
      job = (await api<{ job: ModelFactoryJob }>(`/api/model-factory/jobs/${jobId}`)).job;
      console.log(JSON.stringify({ phase: 'poll', status: job.status, attested: Boolean(job.releaseAttestation) }));
      if (job.status !== 'evaluating') break;
    }
    if (verifierTaskArn) {
      const task = JSON.parse(
        aws(PRIMARY_REGION, ['ecs', 'describe-tasks', '--cluster', controlPlane.cluster, '--tasks', verifierTaskArn, '--query', 'tasks[0].{capacity:capacityProviderName,taskRole:overrides.taskRoleArn,definition:taskDefinitionArn,exit:containers[0].exitCode,last:lastStatus}', '--output', 'json']),
      ) as { capacity?: string; definition?: string; exit?: number | null; last?: string };
      summary.verifierEcs = { capacityProvider: task.capacity ?? null, taskDefinition: task.definition?.split('/').pop() ?? null, lastStatus: task.last ?? null, exitCode: task.exit ?? null };
    }
    summary.finalStatus = job.status;
    summary.attestation = job.releaseAttestation
      ? {
          attestationSource: job.releaseAttestation.attestationSource,
          verificationDisclaimer: job.releaseAttestation.verificationDisclaimer,
          releaseCheckPassed: job.releaseAttestation.releaseCheckPassed,
          manifestDigestMatchesReceipt: job.releaseAttestation.manifestDigest === job.receipt?.manifestDigest,
          metrics: job.releaseAttestation.metrics,
        }
      : null;
    summary.settledMicros = job.cost.settledMicros;
    // The verifier also keeps its own copy of the attestation in S3.
    try {
      const copy = JSON.parse(Buffer.from(await s3.getObject(`attestations/model-factory/${jobId}.json`)).toString('utf8')) as { releaseCheckPassed?: boolean };
      summary.verifierS3Copy = { releaseCheckPassed: copy.releaseCheckPassed ?? null };
    } catch {
      summary.verifierS3Copy = null;
    }
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error);
    if (jobId) {
      await apiJson(`${controlPlane.baseUrl}/api/model-factory/jobs/${jobId}/cancel`, operatorToken, { reason: 'Cleanup after verifier proof error' }).catch(() => undefined);
    }
  } finally {
    await controlPlane.stop().catch((error) => {
      summary.stopError = error instanceof Error ? error.message : String(error);
    });
  }

  const running = await waitForNoManagedInstances();
  const attestation = summary.attestation as { attestationSource?: string; verificationDisclaimer?: string | null; releaseCheckPassed?: boolean; manifestDigestMatchesReceipt?: boolean } | null;
  const ok =
    summary.error === undefined &&
    summary.attestationBeforeVerifier === null &&
    summary.finalStatus === 'awaiting_release_approval' &&
    attestation?.attestationSource === 'independent_verifier' &&
    attestation.verificationDisclaimer === null &&
    attestation.releaseCheckPassed === true &&
    attestation.manifestDigestMatchesReceipt === true &&
    controlPlane.desiredCount() === 0 &&
    Object.values(running).every((n) => n === 0);
  console.log(JSON.stringify({ phase: 'summary', ok, jobId, elapsedMs: Date.now() - startedAtMs, ...summary, controlPlaneDesiredCount: controlPlane.desiredCount(), runningManagedInstances: running }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
