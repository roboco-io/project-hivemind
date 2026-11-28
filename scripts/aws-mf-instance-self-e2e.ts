import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { AwsEcsCredentials } from '../packages/adapters/src/aws-ecs-driver.js';
import { createAwsS3ArtifactsPort } from '../packages/adapters/src/aws-s3-artifacts.js';
import type { ComputeJob } from '../packages/contracts/src/compute.js';
import { computeInputsDigest } from '../packages/core/src/compute.js';
import { openSsmTunnel } from './lib/aws-live.js';

function awsJson(profile: string, region: string, args: string[]): unknown {
  const out = execFileSync('aws', ['--profile', profile, '--region', region, ...args, '--output', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

function loadAwsCredentials(profile: string): AwsEcsCredentials {
  const raw = awsJson(profile, 'ap-northeast-2', ['configure', 'export-credentials', '--format', 'process']) as {
    AccessKeyId: string;
    SecretAccessKey: string;
    SessionToken?: string;
  };
  return {
    accessKeyId: raw.AccessKeyId,
    secretAccessKey: raw.SecretAccessKey,
    ...(raw.SessionToken ? { sessionToken: raw.SessionToken } : {}),
  };
}

function lookupAl2023Arm64Ami(profile: string, region: string): string {
  return execFileSync(
    'aws',
    [
      '--profile',
      profile,
      '--region',
      region,
      'ssm',
      'get-parameter',
      '--name',
      '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64',
      '--query',
      'Parameter.Value',
      '--output',
      'text',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

function getOperatorToken(profile: string, region: string, secretArn: string): string {
  const res = awsJson(profile, region, ['secretsmanager', 'get-secret-value', '--secret-id', secretArn]) as {
    SecretString?: string;
  };
  if (!res.SecretString) throw new Error('Operator token missing');
  return res.SecretString.trim();
}

async function apiJson<T>(url: string, token: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${url}: ${(await res.text()).slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

/**
 * Live AWS End-to-End Instance Self-Execution Proof (Issue #12 follow-up completion criterion):
 * 1. Operator uploads ONLY pinned training inputs (eval script + data) to Seoul KMS S3 under models/<modelId>/inputs/...
 * 2. Deployed Seoul ControlPlaneService verifies pinned inputs & launches a small us-east-2 Spot instance with
 *    ModelFactoryTrainingInstanceProfile (NO operator proxy upload of outputs/receipt!).
 * 3. The us-east-2 EC2 instance ITSELF downloads inputs from Seoul KMS S3, verifies SHA-256, runs the script,
 *    verifies immutable inputs cannot be overwritten (IAM Deny), uploads eval-result.json + receipt.json to its own
 *    artifact prefix in Seoul KMS S3, and self-terminates via `shutdown -h now`.
 * 4. Deployed Seoul ControlPlaneService `/wake` verifies the instance-uploaded receipt.json & artifact sizes,
 *    settles actual cost, and transitions the job to `evaluating` cleanly.
 */
async function main(): Promise<void> {
  const profile = process.env.AWS_PROFILE ?? 'roboco';
  const primaryRegion = 'ap-northeast-2';
  const spokeRegion = 'us-east-2';
  const localPort = Number(process.env.HIVEMIND_LOCAL_PORT ?? '14321');

  const runtimeOut = (
    JSON.parse(readFileSync('/tmp/hivemind-aws-runtime-outputs.json', 'utf8')) as Record<string, Record<string, string>>
  ).HivemindAwsRuntimeStack!;
  const spokeOut = (
    JSON.parse(readFileSync('/tmp/hivemind-aws-spoke-us-east-2-outputs.json', 'utf8')) as Record<
      string,
      Record<string, string>
    >
  ).HivemindAwsSpokeUsEast2Stack!;

  const cluster = runtimeOut.ClusterName!;
  const service = runtimeOut.ControlPlaneServiceName!;
  const bucket = runtimeOut.ArtifactsBucketName!;
  const operatorToken = getOperatorToken(profile, primaryRegion, runtimeOut.OperatorTokenSecretArn!);
  const spokeSubnets = spokeOut.SpokePublicSubnetIds!.split(',').map((s) => s.trim()).filter(Boolean);
  const spokeSubnet = process.env.HIVEMIND_MF_PROOF_SUBNET_ID?.trim() || spokeSubnets[2] || spokeSubnets[1] || spokeSubnets[0]!;
  const spokeSg = spokeOut.SpokeWorkerSecurityGroupId!.trim();
  const dynamicAmi = lookupAl2023Arm64Ami(profile, spokeRegion);

  const s3 = createAwsS3ArtifactsPort({
    region: primaryRegion,
    allowedRegions: [primaryRegion],
    bucket,
    credentials: () => loadAwsCredentials(profile),
  });

  const runStamp = Date.now();
  const modelId = 'smf-instance-e2e';
  const inputsPrefix = `models/${modelId}/inputs/bundle-${runStamp}`;
  const artifactPrefix = `models/${modelId}/runs/run-${runStamp}`;

  // Step 1: Upload pinned inputs ONLY (code + sample eval data) to Seoul KMS S3.
  const evalScript = [
    'import json, sys',
    'data = json.load(open(sys.argv[1]))',
    'score = sum(item["score"] for item in data["samples"]) / len(data["samples"])',
    'json.dump({"model": data["model"], "count": len(data["samples"]), "avgScore": round(score, 4)}, open(sys.argv[2], "w"), indent=2)',
    '',
  ].join('\n');
  const evalData = JSON.stringify({
    model: 'verilog-embed-canary',
    samples: [
      { id: 'v1', score: 0.81 },
      { id: 'v2', score: 0.77 },
      { id: 'v3', score: 0.85 },
    ],
  });
  const scriptBytes = Buffer.from(evalScript, 'utf8');
  const dataBytes = Buffer.from(evalData, 'utf8');
  await s3.putObject(`${inputsPrefix}/eval_canary.py`, scriptBytes, 'text/x-python');
  await s3.putObject(`${inputsPrefix}/samples.json`, dataBytes, 'application/json');

  const inputFiles = [
    {
      path: 'eval_canary.py',
      sha256: createHash('sha256').update(scriptBytes).digest('hex'),
      sizeBytes: scriptBytes.byteLength,
    },
    {
      path: 'samples.json',
      sha256: createHash('sha256').update(dataBytes).digest('hex'),
      sizeBytes: dataBytes.byteLength,
    },
  ];
  const inputsDigest = computeInputsDigest(inputsPrefix, inputFiles);

  // UserData executed INSIDE the us-east-2 Spot instance:
  // Control Plane injects HIVEMIND_JOB_ID, HIVEMIND_ARTIFACTS_BUCKET, HIVEMIND_ARTIFACTS_REGION,
  // HIVEMIND_ARTIFACT_PREFIX, HIVEMIND_INPUTS_PREFIX, HIVEMIND_INPUTS_MANIFEST_B64 right below shebang.
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

  const tunnel = openSsmTunnel(profile, primaryRegion, cluster, service, localPort);
  await tunnel.ready;
  const baseUrl = `http://127.0.0.1:${localPort}`;
  let jobId: string | null = null;

  try {
    // Step 2: Register & approve job on deployed Seoul ControlPlaneService (NO caller instanceProfileArn — Control Plane injects its approved profile!).
    const created = await apiJson<ComputeJob>(`${baseUrl}/api/compute/jobs`, operatorToken, {
      title: 'Issue #12 Instance Self-S3 E2E Proof (us-east-2 -> Seoul KMS S3)',
      workloadId: modelId,
      repository: 'roboco-io/silicon-model-factory',
      baseCommit: 'a'.repeat(40),
      compute: {
        region: spokeRegion,
        instanceType: 't4g.nano',
        amiId: dynamicAmi,
        maxLifetimeMs: 300_000, // 5m TTL safety cap
        maxHourlyPriceUsd: 0.01,
        maxTotalCostMicros: 50_000,
        subnetId: spokeSubnet,
        securityGroupIds: [spokeSg],
        userDataScript,
        s3ArtifactPrefix: artifactPrefix,
        inputs: { s3Prefix: inputsPrefix, digest: inputsDigest, files: inputFiles },
      },
      releasePolicy: {
        mode: 's3_artifact_only',
        visibility: 'private',
        releaseCheckCommand: ['node', 'tools/release-check.mjs'],
      },
    });
    jobId = created.id;

    const launched = await apiJson<ComputeJob>(
      `${baseUrl}/api/compute/jobs/${encodeURIComponent(jobId)}/approve`,
      operatorToken,
      {
        approvalFingerprint: created.approvalFingerprint,
        reason: 'Issue #12 live instance-self S3 download/upload/shutdown E2E verification',
      },
    );
    if (launched.status !== 'running' || !launched.instance?.instanceId) {
      throw new Error(`Launch failed: ${JSON.stringify(launched)}`);
    }

    console.log(
      JSON.stringify({
        phase: 'launched_by_control_plane',
        jobId,
        instanceId: launched.instance.instanceId,
        region: launched.instance.region,
        inputsPrefix,
        artifactPrefix,
      }),
    );

    // Step 3 & 4: Poll Control Plane `/wake` ONLY (zero operator proxy upload!) until instance self-terminates & Control Plane verifies instance-uploaded receipt!
    const deadline = Date.now() + 270_000;
    let finalJob: ComputeJob = launched;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15_000));
      finalJob = await apiJson<ComputeJob>(
        `${baseUrl}/api/compute/jobs/${encodeURIComponent(jobId)}/wake`,
        operatorToken,
        {},
      );
      console.log(
        JSON.stringify({
          phase: 'wake_poll',
          status: finalJob.status,
          instanceState: finalJob.instance?.state ?? null,
          hasReceipt: Boolean(finalJob.receipt),
          settledMicros: finalJob.cost.settledMicros,
        }),
      );
      if ((finalJob.status === 'evaluating' && finalJob.cost.settledMicros !== null) || finalJob.status === 'failed') {
        break;
      }
    }

    if (finalJob.status !== 'evaluating' || !finalJob.receipt) {
      throw new Error(`Expected status=evaluating with instance-uploaded receipt, got: ${JSON.stringify(finalJob)}`);
    }

    // Read back the eval-result.json uploaded directly by the us-east-2 Spot instance to prove end-to-end execution & IAM Deny!
    const evalBytes = await s3.getObject(`${artifactPrefix}/eval-result.json`);
    const evalJson = JSON.parse(Buffer.from(evalBytes).toString('utf8'));

    console.log(
      JSON.stringify(
        {
          phase: 'summary',
          ok:
            finalJob.status === 'evaluating' &&
            evalJson.executedOnInstance === true &&
            evalJson.inputWriteDenied === true &&
            evalJson.avgScore === 0.81,
          jobId: finalJob.id,
          instanceId: finalJob.instance?.instanceId,
          instanceFinalState: finalJob.instance?.state,
          receiptManifestDigest: finalJob.receipt.manifestDigest,
          settledMicros: finalJob.cost.settledMicros,
          instanceSeconds: finalJob.cost.instanceSeconds,
          instanceUploadedResult: evalJson,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    if (jobId) {
      await apiJson(`${baseUrl}/api/compute/jobs/${encodeURIComponent(jobId)}/cancel`, operatorToken, {
        reason: 'Cleanup after self-e2e error',
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    tunnel.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
