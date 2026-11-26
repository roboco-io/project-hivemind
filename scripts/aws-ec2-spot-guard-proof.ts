import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { AwsEc2SpotTrainer } from '../packages/adapters/src/aws-ec2-spot-trainer.js';
import type { AwsEcsCredentials } from '../packages/adapters/src/aws-ecs-driver.js';

function loadAwsCliCredentials(profile: string): AwsEcsCredentials {
  const raw = execFileSync(
    'aws',
    ['configure', 'export-credentials', '--profile', profile, '--format', 'process'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const parsed = JSON.parse(raw) as {
    AccessKeyId?: string;
    SecretAccessKey?: string;
    SessionToken?: string;
  };
  if (!parsed.AccessKeyId || !parsed.SecretAccessKey) {
    throw new Error('Failed to export AWS credentials from profile');
  }
  return {
    accessKeyId: parsed.AccessKeyId,
    secretAccessKey: parsed.SecretAccessKey,
    ...(parsed.SessionToken ? { sessionToken: parsed.SessionToken } : {}),
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const profile = process.env.AWS_PROFILE ?? 'roboco';
  const region = process.env.HIVEMIND_MF_PROOF_REGION ?? 'us-east-2';
  const instanceType = process.env.HIVEMIND_MF_PROOF_INSTANCE_TYPE ?? 't4g.nano';
  const ttlSeconds = Number(process.env.HIVEMIND_MF_PROOF_TTL_SECONDS ?? '45');
  const maxHourlyPriceUsd = Number(process.env.HIVEMIND_MF_PROOF_MAX_PRICE ?? '0.01');

  const spokeOutputsPath = process.env.HIVEMIND_SPOKE_OUTPUTS ?? '/tmp/hivemind-aws-spoke-us-east-2-outputs.json';
  const spokeOutputs = JSON.parse(readFileSync(spokeOutputsPath, 'utf8')) as Record<string, Record<string, string>>;
  const stackOut = Object.values(spokeOutputs)[0];
  const rawSubnets = stackOut?.SpokePublicSubnetIds ?? stackOut?.WorkerSubnets;
  const rawSg = stackOut?.SpokeWorkerSecurityGroupId ?? stackOut?.WorkerSecurityGroupId;
  if (!rawSubnets || !rawSg) {
    throw new Error(`Missing SpokePublicSubnetIds/WorkerSubnets or SpokeWorkerSecurityGroupId/WorkerSecurityGroupId in ${spokeOutputsPath}`);
  }
  const subnetId = rawSubnets.split(',')[0]!.trim();
  const securityGroupId = rawSg.trim();

  const amiId = process.env.HIVEMIND_MF_PROOF_AMI_ID?.trim() || lookupAl2023Arm64Ami(profile, region);
  const creds = loadAwsCliCredentials(profile);
  const trainer = new AwsEc2SpotTrainer({
    allowedRegions: [region],
    credentials: () => creds,
  });

  const jobId = `mf-proof-${Date.now()}`;
  const launchedAtMs = Date.now();
  const expiresAtIso = new Date(launchedAtMs + ttlSeconds * 1000).toISOString();

  console.log(
    JSON.stringify({
      phase: 'launching',
      region,
      subnetId,
      securityGroupId,
      amiId,
      instanceType,
      ttlSeconds,
      expiresAtIso,
    }),
  );

  const launched = await trainer.launchSpotInstance({
    jobId,
    modelId: 'hivemind-guard-canary',
    region,
    instanceType,
    amiId,
    maxHourlyPriceUsd,
    expiresAtIso,
    subnetId,
    securityGroupIds: [securityGroupId],
  });

  console.log(JSON.stringify({ phase: 'launched', launched }));

  try {
    // Poll until instance reaches 'running' or expires.
    let reachedRunningAt: string | null = null;
    while (Date.now() < Date.parse(expiresAtIso) + 2000) {
      const desc = await trainer.describeInstance(region, launched.instanceId);
      console.log(
        JSON.stringify({
          phase: 'poll_before_ttl',
          instanceId: desc.instanceId,
          state: desc.state,
          az: desc.availabilityZone,
          expiresAtTag: desc.tags['hivemind:expires-at'] ?? null,
        }),
      );
      if (desc.state === 'running' && !reachedRunningAt) {
        reachedRunningAt = new Date().toISOString();
      }
      if (Date.now() >= Date.parse(expiresAtIso)) break;
      await sleep(5000);
    }

    // Run dynamic TTL Guard sweep (works for ANY dynamic AMI/instanceType without CDK redeploy).
    const sweepResult = await trainer.sweepExpiredSpotInstances(region, Date.now());
    console.log(JSON.stringify({ phase: 'ttl_guard_swept', sweepResult }));

    // Confirm termination cleanly.
    let finalState = 'unknown';
    for (let i = 0; i < 18; i += 1) {
      const desc = await trainer.describeInstance(region, launched.instanceId);
      finalState = desc.state;
      if (desc.state === 'terminated') break;
      await sleep(5000);
    }

    const totalSeconds = Math.ceil((Date.now() - launchedAtMs) / 1000);
    const result = {
      ok: finalState === 'terminated' || finalState === 'shutting-down',
      region,
      availabilityZone: launched.availabilityZone,
      instanceId: launched.instanceId,
      instanceType,
      amiId,
      reachedRunningAt,
      ttlSeconds,
      expiresAtIso,
      sweptTerminatedCount: sweepResult.terminated.length,
      sweptMatchedInstance: sweepResult.terminated.some((t) => t.instanceId === launched.instanceId),
      finalState,
      totalSeconds,
    };
    console.log(JSON.stringify({ phase: 'summary', result }, null, 2));
    if (!result.ok || !result.sweptMatchedInstance) {
      process.exitCode = 1;
    }
  } catch (error) {
    // Safety cleanup: never leave an orphan EC2 instance running!
    await trainer.terminateInstance(region, launched.instanceId).catch(() => undefined);
    throw error;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
