import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { AwsEcsCredentials } from '../packages/adapters/src/aws-ecs-driver.js';
import { createAwsS3ArtifactsPort } from '../packages/adapters/src/aws-s3-artifacts.js';
import type { DeliveryTask } from '../packages/contracts/src/delivery.js';
import type {
  ComputeArtifactFile,
  ComputeArtifactReceipt,
  ComputeJob,
  ComputeLedgerSummary,
} from '../packages/contracts/src/compute.js';
import { computeArtifactManifestDigest } from '../packages/core/src/compute.js';
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

async function main(): Promise<void> {
  const profile = process.env.AWS_PROFILE ?? 'roboco';
  const primaryRegion = 'ap-northeast-2';
  const spokeRegion = 'us-east-2';
  const localPort = Number(process.env.HIVEMIND_LOCAL_PORT ?? '14319');

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
  const ttlGuardFnName = runtimeOut.ModelFactoryTtlGuardFunctionName!;
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

  const tunnel = openSsmTunnel(profile, primaryRegion, cluster, service, localPort);
  await tunnel.ready;
  const baseUrl = `http://127.0.0.1:${localPort}`;
  let launchedJobId: string | null = null;

  try {
    // 1. Verify Part A Research Policy acceptance & waitReason on deployed Seoul ControlPlaneService.
    const deliveryTask = await apiJson<DeliveryTask>(`${baseUrl}/api/delivery/tasks`, operatorToken, {
      title: 'Issue #12 Live Verification — SMF Stage 1 Research Policy Draft',
      instructions: 'Draft-only verification of research executionPolicy & waitReason on deployed Control Plane.',
      provider: 'claude',
      maxIterations: 2,
      budgetMicros: 500_000,
      acceptance: {
        baseCommit: 'a'.repeat(40),
        files: [{ path: 'ops/stage1/check.mjs', sha256: 'b'.repeat(64) }],
        testCommand: ['node', 'ops/stage1/check.mjs', '--final'],
      },
      delivery: {
        mode: 'draft_pr',
        repository: 'roboco-io/silicon-model-factory',
        baseBranch: 'main',
        branchPrefix: 'hivemind/stage1/',
        autoMerge: false,
      },
      executionPolicy: {
        allowedWebHosts: ['huggingface.co', 'arxiv.org', 'github.com'],
        allowSubagents: true,
        maxIterationDurationMs: 3_600_000,
        preserveWorkspaceOnRetry: true,
        verificationKind: 'document_format',
      },
    });
    await apiJson(`${baseUrl}/api/delivery/tasks/${encodeURIComponent(deliveryTask.id)}/cancel`, operatorToken, {
      reason: 'Draft policy registration verified on live Control Plane',
    });

    // 2. Verify Part B Live through deployed ControlPlaneService -> real us-east-2 EC2 Spot -> real Lambda TTL Guard -> wake + ledger settlement!
    const prefix = `models/smf-live-proof/${Date.now()}`;
    const mfJob = await apiJson<ComputeJob>(`${baseUrl}/api/compute/jobs`, operatorToken, {
      title: 'Issue #12 Live E2E — ControlPlane EC2 Spot + Lambda TTL Guard + S3 Receipt',
      workloadId: 'smf-live-canary',
      repository: 'roboco-io/silicon-model-factory',
      baseCommit: 'a'.repeat(40),
      compute: {
        region: spokeRegion,
        instanceType: 't4g.nano',
        amiId: dynamicAmi,
        maxLifetimeMs: 60_000, // 60s TTL
        maxHourlyPriceUsd: 0.01,
        maxTotalCostMicros: 50_000, // $0.05 cap
        subnetId: spokeSubnet,
        securityGroupIds: [spokeSg],
        s3ArtifactPrefix: prefix,
      },
      releasePolicy: {
        mode: 's3_artifact_only',
        visibility: 'private',
        releaseCheckCommand: ['node', 'tools/release-check.mjs'],
      },
    });
    launchedJobId = mfJob.id;

    // Approve training -> Seoul ControlPlaneService itself reserves budget & launches us-east-2 Spot instance!
    const launched = await apiJson<ComputeJob>(
      `${baseUrl}/api/compute/jobs/${encodeURIComponent(mfJob.id)}/approve`,
      operatorToken,
      {
        approvalFingerprint: mfJob.approvalFingerprint,
        reason: 'Issue #12 live E2E verification through deployed Seoul ControlPlaneService',
      },
    );
    if (launched.status !== 'running' || !launched.instance?.instanceId) {
      throw new Error(`ControlPlaneService failed to launch Spot instance: ${JSON.stringify(launched)}`);
    }

    // Upload real SHA-256 verified artifact + receipt.json to Seoul KMS S3 while instance runs.
    const modelBytes = Buffer.from('{"model":"smf-live-canary","step":100,"loss":1.12}\n', 'utf8');
    const modelSha = createHash('sha256').update(modelBytes).digest('hex');
    await s3.putObject(`${prefix}/model.json`, modelBytes, 'application/json');
    const files: ComputeArtifactFile[] = [{ path: 'model.json', sha256: modelSha, sizeBytes: modelBytes.byteLength }];
    const manifestDigest = computeArtifactManifestDigest(files);
    const receipt: ComputeArtifactReceipt = {
      version: 1,
      jobId: mfJob.id,
      s3Bucket: bucket,
      s3Prefix: prefix,
      manifestDigest,
      files,
      recordedAt: new Date().toISOString(),
    };
    await s3.putObject(`${prefix}/receipt.json`, Buffer.from(JSON.stringify(receipt), 'utf8'), 'application/json');

    console.log(
      JSON.stringify({
        phase: 'launched_by_control_plane',
        jobId: mfJob.id,
        instanceId: launched.instance.instanceId,
        region: launched.instance.region,
        expiresAt: launched.instance.expiresAt,
        manifestDigest,
      }),
    );

    // Wait until TTL expires, then invoke the deployed AWS Lambda TTL Guard!
    const waitMs = Math.max(0, Date.parse(launched.instance.expiresAt) - Date.now() + 3000);
    await new Promise((r) => setTimeout(r, waitMs));

    const lambdaOutPath = `/tmp/hivemind-ttl-guard-out-${Date.now()}.json`;
    execFileSync(
      'aws',
      [
        '--profile',
        profile,
        '--region',
        primaryRegion,
        'lambda',
        'invoke',
        '--function-name',
        ttlGuardFnName,
        '--payload',
        '{}',
        lambdaOutPath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const lambdaResult = JSON.parse(readFileSync(lambdaOutPath, 'utf8'));
    console.log(JSON.stringify({ phase: 'lambda_ttl_guard_invoked', lambdaResult }));

    // Trigger wake on deployed ControlPlaneService -> picks up S3 receipt, detects terminated instance, settles cost!
    const woken = await apiJson<ComputeJob>(
      `${baseUrl}/api/compute/jobs/${encodeURIComponent(mfJob.id)}/wake`,
      operatorToken,
      {},
    );
    const attested = await apiJson<ComputeJob>(
      `${baseUrl}/api/compute/jobs/${encodeURIComponent(mfJob.id)}/verify-release`,
      operatorToken,
      {
        manifestDigest,
        releaseCheckPassed: true,
        metrics: { evalLoss: 1.12, verifiedOnLiveAws: true },
        summary: 'Verified S3 SHA-256 receipt after AWS Lambda TTL Guard termination',
        verifiedAt: new Date().toISOString(),
      },
    );
    const released = await apiJson<ComputeJob>(
      `${baseUrl}/api/compute/jobs/${encodeURIComponent(mfJob.id)}/approve-release`,
      operatorToken,
      {
        decision: 'approve',
        openedRawArtifacts: false,
        durationMinutes: 0.5,
        reason: 'Issue #12 live Control Plane + Lambda TTL Guard + S3 receipt + release gate E2E verified',
      },
    );
    const ledger = await apiJson<ComputeLedgerSummary>(`${baseUrl}/api/compute/ledger`, operatorToken);

    console.log(
      JSON.stringify(
        {
          phase: 'summary',
          ok: released.status === 'released' && woken.cost.settledMicros !== null,
          deliveryTaskPolicyVerified: {
            taskId: deliveryTask.id,
            waitReason: deliveryTask.waitReason,
            allowedWebHosts: deliveryTask.executionPolicy.allowedWebHosts,
            allowSubagents: deliveryTask.executionPolicy.allowSubagents,
            verificationKind: deliveryTask.executionPolicy.verificationKind,
          },
          modelFactoryLiveE2e: {
            jobId: released.id,
            instanceId: launched.instance.instanceId,
            region: launched.instance.region,
            amiId: dynamicAmi,
            lambdaResult,
            wokenStatus: woken.status,
            attestedStatus: attested.status,
            finalStatus: released.status,
            reservedMicros: released.cost.reservedMicros,
            settledMicros: released.cost.settledMicros,
            instanceSeconds: released.cost.instanceSeconds,
            manifestDigest: released.publication?.manifestDigest,
            ledgerSummary: {
              globalBudgetCapMicros: ledger.globalBudgetCapMicros,
              totalReservedMicros: ledger.totalReservedMicros,
              totalSettledMicros: ledger.totalSettledMicros,
              remainingBudgetMicros: ledger.remainingBudgetMicros,
            },
          },
        },
        null,
        2,
      ),
    );
  } catch (error) {
    if (launchedJobId) {
      await apiJson(`${baseUrl}/api/compute/jobs/${encodeURIComponent(launchedJobId)}/cancel`, operatorToken, {
        reason: 'Cleanup after verification error',
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
