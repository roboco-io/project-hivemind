import { createAwsS3ArtifactsPort } from '../../../packages/adapters/src/aws-s3-artifacts.js';
import { createEcsTaskCredentialsProvider } from '../../../packages/adapters/src/aws-ecs-metadata-creds.js';
import { runAwsVerifierOnce } from './aws-verifier-runtime.js';
import { decodeModelReleaseVerificationSpec, runModelReleaseVerification } from './aws-mf-verifier-runtime.js';

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/** Model Factory release verification: selected when the Control Plane passes a verification spec. */
async function runModelReleaseVerifierMode(specBase64: string): Promise<void> {
  const region = process.env.HIVEMIND_AWS_REGION ?? 'ap-northeast-2';
  const bucket = requiredEnv('HIVEMIND_ARTIFACTS_BUCKET');
  const controlApiUrl = requiredEnv('HIVEMIND_CONTROL_API_URL');
  const workerToken = requiredEnv('HIVEMIND_WORKER_TOKEN');
  const spec = decodeModelReleaseVerificationSpec(specBase64);
  const s3 = createAwsS3ArtifactsPort({ region, allowedRegions: [region], bucket, credentials: createEcsTaskCredentialsProvider() });
  const attestation = await runModelReleaseVerification({
    ...spec,
    s3,
    workRoot: process.env.HIVEMIND_WORK_ROOT?.trim() || undefined,
    timeoutMs: Number(process.env.HIVEMIND_TEST_TIMEOUT_MS ?? '900000'),
  });
  // The S3 copy is the verifier's own record; the Control Plane decides from the API call below.
  await s3.putObject(`attestations/model-factory/${spec.jobId}.json`, Buffer.from(JSON.stringify(attestation), 'utf8'), 'application/json');
  const res = await fetch(new URL(`/api/model-factory/jobs/${encodeURIComponent(spec.jobId)}/verifier-attestation`, controlApiUrl), {
    method: 'POST',
    redirect: 'error',
    headers: { authorization: `Bearer ${workerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(attestation),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Control plane verifier-attestation submission failed with HTTP ${res.status}`);
  console.log(
    JSON.stringify({
      event: 'hivemind.aws_mf_verifier.completed',
      jobId: spec.jobId,
      releaseCheckPassed: attestation.releaseCheckPassed,
      manifestDigest: attestation.manifestDigest,
    }),
  );
}

async function main(): Promise<void> {
  const mfSpec = process.env.HIVEMIND_MF_VERIFY_SPEC_B64?.trim();
  if (mfSpec) {
    await runModelReleaseVerifierMode(mfSpec);
    return;
  }
  const region = process.env.HIVEMIND_AWS_REGION ?? 'ap-northeast-2';
  const bucket = requiredEnv('HIVEMIND_ARTIFACTS_BUCKET');
  const controlApiUrl = process.env.HIVEMIND_CONTROL_API_URL?.trim() || undefined;
  const workerToken = process.env.HIVEMIND_WORKER_TOKEN?.trim() || undefined;
  const taskId = requiredEnv('HIVEMIND_TASK_ID');
  const runId = requiredEnv('HIVEMIND_RUN_ID');
  const iteration = Number(requiredEnv('HIVEMIND_ITERATION'));
  const bundleS3Key = requiredEnv('HIVEMIND_BUNDLE_S3_KEY');
  const bundleSha256 = requiredEnv('HIVEMIND_BUNDLE_SHA256');
  const expectedAcceptanceDigest = requiredEnv('HIVEMIND_ACCEPTANCE_DIGEST');
  const patchS3Key = requiredEnv('HIVEMIND_PATCH_S3_KEY');
  const acceptanceS3Key = process.env.HIVEMIND_ACCEPTANCE_S3_KEY ?? `acceptance/${taskId}.json`;
  const workRoot = process.env.HIVEMIND_WORK_ROOT?.trim() || undefined;
  const testTimeoutMs = Number(process.env.HIVEMIND_TEST_TIMEOUT_MS ?? '180000');

  if (!Number.isSafeInteger(iteration) || iteration < 1) {
    throw new Error('Invalid HIVEMIND_ITERATION');
  }

  const s3 = createAwsS3ArtifactsPort({
    region,
    allowedRegions: [region],
    bucket,
    credentials: createEcsTaskCredentialsProvider(),
  });

  const attestation = await runAwsVerifierOnce({
    taskId,
    runId,
    iteration,
    bundleS3Key,
    bundleSha256,
    acceptanceS3Key,
    expectedAcceptanceDigest,
    patchS3Key,
    s3,
    workRoot,
    testTimeoutMs,
    control: {
      async submitVerification(id, result) {
        const receiptKey = `attestations/${id}/${runId}.json`;
        await s3.putObject(receiptKey, Buffer.from(JSON.stringify(result), 'utf8'), 'application/json');
        if (controlApiUrl && workerToken) {
          const res = await fetch(new URL(`/api/delivery/tasks/${encodeURIComponent(id)}/verify`, controlApiUrl), {
            method: 'POST',
            redirect: 'error',
            headers: {
              authorization: `Bearer ${workerToken}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify(result),
            signal: AbortSignal.timeout(120_000),
          });
          if (!res.ok) throw new Error(`Control plane verify submission failed with HTTP ${res.status}`);
        }
      },
    },
  });

  console.log(
    JSON.stringify({
      event: 'hivemind.aws_verifier.completed',
      taskId,
      runId,
      iteration,
      checksPassed: attestation.checksPassed,
      acceptancePathsUnmodified: attestation.acceptancePathsUnmodified,
      verifiedTreeHash: attestation.verifiedTreeHash,
    }),
  );
  process.exitCode = attestation.checksPassed ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
