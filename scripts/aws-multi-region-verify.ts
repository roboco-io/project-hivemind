import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VerificationAttestation } from '../packages/contracts/src/delivery.js';
import type { AwsEcsCredentials } from '../packages/adapters/src/aws-ecs-driver.js';
import { AwsMultiRegionEcsDriver } from '../packages/adapters/src/aws-multi-region-driver.js';
import { createAwsS3ArtifactsPort } from '../packages/adapters/src/aws-s3-artifacts.js';
import { createSpotPlacementFeedPort, DEFAULT_SPOT_FEED_URL } from '../packages/adapters/src/spot-placement-feed.js';
import { captureAcceptanceTestSpec, createPinnedGitBundle } from '../packages/adapters/src/git-bundle.js';
import { selectOptimalSpotPlacement } from '../packages/core/src/multi-region.js';

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

function mapSubnetsByAzId(profile: string, region: string, subnetIds: string[]): Record<string, string> {
  const desc = awsJson(profile, region, ['ec2', 'describe-subnets', '--subnet-ids', ...subnetIds]) as {
    Subnets?: { SubnetId?: string; AvailabilityZoneId?: string }[];
  };
  const map: Record<string, string> = {};
  for (const s of desc.Subnets ?? []) {
    if (s.SubnetId && s.AvailabilityZoneId) map[s.AvailabilityZoneId] = s.SubnetId;
  }
  return map;
}

async function main(): Promise<void> {
  const profile = process.env.AWS_PROFILE ?? 'roboco';
  const primaryRegion = process.env.HIVEMIND_AWS_REGION ?? 'ap-northeast-2';
  const spokeRegion = process.env.HIVEMIND_SPOKE_REGION ?? 'us-east-2';
  const workloadClass = process.env.HIVEMIND_WORKLOAD_CLASS ?? 'i8g.mixed';

  const hubOutputs = (
    JSON.parse(readFileSync(process.env.HIVEMIND_HUB_OUTPUTS ?? '/tmp/hivemind-aws-runtime-outputs.json', 'utf8')) as Record<
      string,
      Record<string, string>
    >
  ).HivemindAwsRuntimeStack;
  const spokeFile = JSON.parse(
    readFileSync(process.env.HIVEMIND_SPOKE_OUTPUTS ?? `/tmp/hivemind-aws-spoke-${spokeRegion}-outputs.json`, 'utf8'),
  ) as Record<string, Record<string, string>>;
  const spokeOutputs = Object.values(spokeFile)[0];
  if (!hubOutputs || !spokeOutputs) {
    throw new Error('Missing Hub or Spoke CDK outputs');
  }

  const bucket = hubOutputs.ArtifactsBucketName!;
  const hubSubnets = hubOutputs.PublicSubnetIds!.split(',').filter(Boolean);
  const spokeSubnets = spokeOutputs.SpokePublicSubnetIds!.split(',').filter(Boolean);
  const hubSubnetByAz = mapSubnetsByAzId(profile, primaryRegion, hubSubnets);
  const spokeSubnetByAz = mapSubnetsByAzId(profile, spokeRegion, spokeSubnets);

  // 1. Evaluate live Spot Placement Score feed to choose optimal region & physical AZ.
  const feed = createSpotPlacementFeedPort({ feedUrl: process.env.HIVEMIND_SPOT_FEED_URL ?? DEFAULT_SPOT_FEED_URL });
  const snapshot = await feed.getSnapshot(AbortSignal.timeout(15_000));
  const decision = selectOptimalSpotPlacement(snapshot, {
    primaryRegion,
    allowedRegions: [primaryRegion, spokeRegion],
    workloadClass,
    minPlacementScore: 7,
    trendWindowHours: 48,
    primaryRegionBonusPercent: 5,
  });

  console.log(
    JSON.stringify(
      {
        step: 'spot_placement_decision',
        workloadClass,
        selectedRegion: decision.selectedRegion,
        selectedAzId: decision.selectedAzId,
        selectedAzName: decision.selectedAzName,
        latestScore: decision.latestScore,
        selectedPriceUsd: decision.latestPriceUsd,
        primaryPriceUsd: decision.primaryPriceUsd,
        savingsVsPrimaryPercent: decision.savingsVsPrimaryPercent,
        reason: decision.reason,
      },
      null,
      2,
    ),
  );

  // 2. Wire AwsMultiRegionEcsDriver with Seoul Hub + Ohio Spoke and S3 in Seoul Hub.
  const credentials = () => loadAwsProfileCredentials(profile, primaryRegion);
  const s3 = createAwsS3ArtifactsPort({ region: primaryRegion, allowedRegions: [primaryRegion], bucket, credentials });
  const multiDriver = new AwsMultiRegionEcsDriver({
    primaryRegion,
    spokes: [
      {
        region: primaryRegion,
        clusterArn: hubOutputs.ClusterArn!,
        workerTaskDefinition: hubOutputs.AiWorkerTaskDefArn!,
        verifierTaskDefinition: hubOutputs.VerifierTaskDefArn!,
        subnets: hubSubnets,
        subnetByAzId: hubSubnetByAz,
        securityGroups: [hubOutputs.WorkerSecurityGroupId!],
        assignPublicIp: 'ENABLED',
        controlApiUrl: 'https://control-plane.hivemind.internal',
        artifactsBucket: bucket,
      },
      {
        region: spokeRegion,
        clusterArn: spokeOutputs.SpokeClusterArn!,
        workerTaskDefinition: spokeOutputs.SpokeAiWorkerTaskDefArn!,
        verifierTaskDefinition: spokeOutputs.SpokeVerifierTaskDefArn!,
        subnets: spokeSubnets,
        subnetByAzId: spokeSubnetByAz,
        securityGroups: [spokeOutputs.SpokeWorkerSecurityGroupId!],
        assignPublicIp: 'ENABLED',
        controlApiUrl: 'https://control-plane.hivemind.internal',
        artifactsBucket: bucket,
      },
    ],
    credentials,
  });

  // 3. Package real project-hivemind HEAD into pinned git bundle and upload to Seoul KMS S3.
  const repoRoot = process.cwd();
  const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const expectedTree = execFileSync('git', ['rev-parse', `${baseCommit}^{tree}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  const scratch = mkdtempSync(join(tmpdir(), 'hivemind-mr-verify-'));
  const signal = new AbortController().signal;

  try {
    const bundlePath = join(scratch, 'project-hivemind.bundle');
    const manifest = await createPinnedGitBundle(repoRoot, baseCommit, bundlePath, signal);
    const taskId = `dlv-mr-${Date.now()}`;
    const runId = `run-mr-${Date.now()}`;
    const bundleS3Key = `bundles/${taskId}/${baseCommit}.bundle`;
    const acceptanceS3Key = `acceptance/${taskId}.json`;
    const patchS3Key = `patches/${taskId}/${runId}.patch`;

    const acceptance = await captureAcceptanceTestSpec(
      repoRoot,
      baseCommit,
      ['package.json'],
      [
        'node',
        '-e',
        "const p = JSON.parse(require('node:fs').readFileSync('package.json','utf8')); if (p.name !== 'project-hivemind') process.exit(1); console.log('CROSS_REGION_SPOKE_VERIFIED', process.env.HIVEMIND_SPOKE_REGION);",
      ],
      signal,
    );

    await s3.putObject(bundleS3Key, readFileSync(bundlePath), 'application/octet-stream', signal);
    await s3.putObject(acceptanceS3Key, Buffer.from(JSON.stringify(acceptance), 'utf8'), 'application/json', signal);
    const emptyPatch = Buffer.from('', 'utf8');
    await s3.putObject(patchS3Key, emptyPatch, 'text/x-diff', signal);

    // 4. Launch FARGATE_SPOT Verifier in the core-selected region + physical AZ!
    const launched = await multiDriver.launchWorkload(
      {
        kind: 'verifier',
        taskId,
        runId,
        iteration: 1,
        bundleS3Key,
        bundleSha256: manifest.bundleSha256,
        acceptanceDigest: acceptance.digest,
        patchS3Key,
        targetRegion: decision.selectedRegion,
        targetAzId: decision.selectedAzId,
      },
      signal,
    );
    console.log(JSON.stringify({ step: 'launched_cross_region_verifier', ...launched }));

    const targetClusterArn =
      launched.region === spokeRegion ? spokeOutputs.SpokeClusterArn! : hubOutputs.ClusterArn!;
    const startedAt = Date.now();
    // A named type: `typeof finalTask` inside the loop narrows to `null` and made the task type `never`.
    type EcsTaskView = {
      lastStatus?: string;
      capacityProviderName?: string;
      availabilityZone?: string;
      containers?: { exitCode?: number; reason?: string }[];
    };
    let finalTask: EcsTaskView | null = null;

    while (Date.now() - startedAt < 300_000) {
      const desc = awsJson(profile, launched.region, [
        'ecs',
        'describe-tasks',
        '--cluster',
        targetClusterArn,
        '--tasks',
        launched.taskArn,
      ]) as { tasks?: EcsTaskView[] };
      finalTask = desc.tasks?.[0] ?? null;
      if (finalTask?.lastStatus === 'STOPPED') break;
      await new Promise((r) => setTimeout(r, 5000));
    }

    if (!finalTask || finalTask.lastStatus !== 'STOPPED') {
      throw new Error('Timed out waiting for cross-region Fargate Spot verifier task');
    }

    const exitCode = finalTask.containers?.[0]?.exitCode;
    const attBytes = await s3.getObject(`attestations/${taskId}/${runId}.json`, undefined, signal);
    const attestation = JSON.parse(Buffer.from(attBytes).toString('utf8')) as VerificationAttestation;
    const expectedPatchSha = createHash('sha256').update(emptyPatch).digest('hex');

    console.log(
      JSON.stringify(
        {
          step: 'cross_region_spoke_verified',
          hubRegion: primaryRegion,
          executedRegion: launched.region,
          executedAvailabilityZone: finalTask.availabilityZone,
          capacityProviderName: finalTask.capacityProviderName,
          containerExitCode: exitCode,
          elapsedMs: Date.now() - startedAt,
          fileCount: manifest.fileCount,
          bundleSizeBytes: manifest.sizeBytes,
          checksPassed: attestation.checksPassed,
          acceptancePathsUnmodified: attestation.acceptancePathsUnmodified,
          verifiedTreeHash: attestation.verifiedTreeHash,
          treeHashMatchesLocalHead: attestation.verifiedTreeHash === expectedTree,
          patchSha256Matches: attestation.patchSha256 === expectedPatchSha,
        },
        null,
        2,
      ),
    );

    if (!attestation.checksPassed || !attestation.acceptancePathsUnmodified || attestation.verifiedTreeHash !== expectedTree) {
      throw new Error(`Cross-region verification failed (exit=${exitCode})`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
