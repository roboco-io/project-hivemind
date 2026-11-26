import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VerificationAttestation } from '../packages/contracts/src/delivery.js';
import { AwsEcsFargateSpotDriver, type AwsEcsCredentials } from '../packages/adapters/src/aws-ecs-driver.js';
import { createAwsS3ArtifactsPort } from '../packages/adapters/src/aws-s3-artifacts.js';
import { captureAcceptanceTestSpec, createPinnedGitBundle } from '../packages/adapters/src/git-bundle.js';

function awsJson(profile: string, region: string, args: string[]): unknown {
  const out = execFileSync('aws', ['--profile', profile, '--region', region, ...args, '--output', 'json'], {
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

function loadAwsProfileCredentials(profile: string, region: string): AwsEcsCredentials {
  const out = awsJson(profile, region, ['configure', 'export-credentials']) as {
    AccessKeyId: string;
    SecretAccessKey: string;
    SessionToken?: string;
  };
  return {
    accessKeyId: out.AccessKeyId,
    secretAccessKey: out.SecretAccessKey,
    ...(out.SessionToken ? { sessionToken: out.SessionToken } : {}),
  };
}

async function main(): Promise<void> {
  const profile = process.env.AWS_PROFILE ?? 'roboco';
  const region = process.env.HIVEMIND_AWS_REGION ?? 'ap-northeast-2';
  const outputsPath = process.env.HIVEMIND_CDK_OUTPUTS ?? '/tmp/hivemind-aws-runtime-outputs.json';
  const rawOutputs = JSON.parse(readFileSync(outputsPath, 'utf8')) as Record<string, Record<string, string>>;
  const outputs = rawOutputs.HivemindAwsRuntimeStack;
  if (!outputs) throw new Error('Missing HivemindAwsRuntimeStack outputs');

  const clusterArn = outputs.ClusterArn!;
  const bucket = outputs.ArtifactsBucketName!;
  const workerTaskDef = outputs.AiWorkerTaskDefArn!;
  const verifierTaskDef = outputs.VerifierTaskDefArn!;
  const securityGroup = outputs.WorkerSecurityGroupId ?? outputs.RuntimeSecurityGroupId!;
  const subnets = (outputs.PublicSubnetIds ?? outputs.PrivateSubnetIds!).split(',').filter(Boolean);
  const assignPublicIp = outputs.PublicSubnetIds ? 'ENABLED' : 'DISABLED';

  const credentials = () => loadAwsProfileCredentials(profile, region);
  const s3 = createAwsS3ArtifactsPort({ region, allowedRegions: [region], bucket, credentials });
  const ecs = new AwsEcsFargateSpotDriver({
    region,
    allowedRegions: [region],
    clusterArn,
    workerTaskDefinition: workerTaskDef,
    verifierTaskDefinition: verifierTaskDef,
    subnets,
    securityGroups: [securityGroup],
    assignPublicIp,
    controlApiUrl: 'https://control-plane.hivemind.internal',
    artifactsBucket: bucket,
    credentials,
  });

  const repoRoot = process.cwd();
  const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const scratch = mkdtempSync(join(tmpdir(), 'hivemind-live-m1-'));
  const signal = new AbortController().signal;

  try {
    // 1. Package THIS real project-hivemind repository (>4MiB, 790+ files) into a pinned git bundle.
    const bundlePath = join(scratch, 'project-hivemind.bundle');
    const manifest = await createPinnedGitBundle(repoRoot, baseCommit, bundlePath, signal);
    const taskId = `dlv-live-${Date.now()}`;
    const runId = `run-live-${Date.now()}`;
    const bundleS3Key = `bundles/${taskId}/${baseCommit}.bundle`;
    const acceptanceS3Key = `acceptance/${taskId}.json`;
    const patchS3Key = `patches/${taskId}/${runId}.patch`;

    // 2. Capture immutable acceptance test spec pinned at baseCommit.
    const acceptance = await captureAcceptanceTestSpec(
      repoRoot,
      baseCommit,
      ['package.json'],
      ['node', '-e', "const p = JSON.parse(require('node:fs').readFileSync('package.json','utf8')); if (p.name !== 'project-hivemind') process.exit(1); console.log('LIVE_HIVEMIND_VERIFIED');"],
      signal,
    );

    // 3. Upload pinned bundle, immutable acceptance spec, and empty clean patch to KMS-encrypted versioned S3.
    const bundleUpload = await s3.putObject(bundleS3Key, readFileSync(bundlePath), 'application/octet-stream', signal);
    await s3.putObject(acceptanceS3Key, Buffer.from(JSON.stringify(acceptance), 'utf8'), 'application/json', signal);
    const patchBytes = Buffer.from('', 'utf8');
    await s3.putObject(patchS3Key, patchBytes, 'text/x-diff', signal);

    console.log(
      JSON.stringify({
        step: 'uploaded_to_s3',
        bucket,
        baseCommit,
        fileCount: manifest.fileCount,
        bundleSizeBytes: manifest.sizeBytes,
        bundleSha256: bundleUpload.sha256,
        acceptanceDigest: acceptance.digest,
      }),
    );

    // 4. Launch REAL AWS ECS FARGATE_SPOT Verifier task on project-hivemind!
    const launched = await ecs.launchWorkload(
      {
        kind: 'verifier',
        taskId,
        runId,
        iteration: 1,
        bundleS3Key,
        bundleSha256: manifest.bundleSha256,
        acceptanceDigest: acceptance.digest,
        patchS3Key,
      },
      signal,
    );
    console.log(JSON.stringify({ step: 'launched_fargate_spot_verifier', taskArn: launched.taskArn }));

    // 5. Wait for the Fargate Spot container to finish and inspect its status & capacity provider.
    const startedAt = Date.now();
    let finalTask: {
      lastStatus?: string;
      capacityProviderName?: string;
      stopCode?: string;
      stoppedReason?: string;
      containers?: { name?: string; exitCode?: number; reason?: string }[];
    } | null = null;

    while (Date.now() - startedAt < 300_000) {
      const desc = awsJson(profile, region, [
        'ecs',
        'describe-tasks',
        '--cluster',
        clusterArn,
        '--tasks',
        launched.taskArn,
      ]) as { tasks?: (typeof finalTask)[] };
      finalTask = desc.tasks?.[0] ?? null;
      if (finalTask?.lastStatus === 'STOPPED') break;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    if (!finalTask || finalTask.lastStatus !== 'STOPPED') {
      throw new Error('Timed out waiting for AWS Fargate Spot verifier task');
    }

    const exitCode = finalTask.containers?.[0]?.exitCode;
    const attestationKey = `attestations/${taskId}/${runId}.json`;
    const attBytes = await s3.getObject(attestationKey, undefined, signal);
    const attestation = JSON.parse(Buffer.from(attBytes).toString('utf8')) as VerificationAttestation;
    const expectedPatchSha = createHash('sha256').update(patchBytes).digest('hex');

    console.log(
      JSON.stringify(
        {
          step: 'live_fargate_spot_verified',
          taskArn: launched.taskArn,
          capacityProviderName: finalTask.capacityProviderName,
          containerExitCode: exitCode,
          elapsedMs: Date.now() - startedAt,
          checksPassed: attestation.checksPassed,
          acceptancePathsUnmodified: attestation.acceptancePathsUnmodified,
          verifiedTreeHash: attestation.verifiedTreeHash,
          patchSha256Matches: attestation.patchSha256 === expectedPatchSha,
          summary: attestation.summary,
        },
        null,
        2,
      ),
    );

    if (exitCode !== 0 || !attestation.checksPassed || !attestation.acceptancePathsUnmodified) {
      throw new Error(`Live Fargate Spot verifier failed: exit=${exitCode}, summary=${attestation.summary}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
