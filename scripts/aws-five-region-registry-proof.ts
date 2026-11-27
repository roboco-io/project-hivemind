import { readFileSync } from 'node:fs';
import { createSpotPlacementFeedPort } from '../packages/adapters/src/spot-placement-feed.js';
import type { ModelFactoryJob } from '../packages/contracts/src/model-factory.js';
import { selectOptimalSpotPlacement } from '../packages/core/src/multi-region.js';
import { apiJson, aws, awsJson, ControlPlane, PRIMARY_REGION, sleep, waitForNoManagedInstances } from './lib/aws-live.js';

/**
 * Live AWS proof for Issue #16 task 1: a Model Factory job that names several candidate regions and gives
 * NO regionOverrides, subnet or security group is placed by the deployed Seoul Control Plane using only
 *   - the 6-hourly Spot Placement Score ranking,
 *   - the operator registry HIVEMIND_MF_REGION_NETWORKS_JSON (subnets, security groups), and
 *   - the public SSM latest-AMI lookup.
 *
 * The job requests d3en.xlarge, which AWS does not offer in us-east-2 (checked 2026-11-26 with
 * describe-instance-type-offerings). The script picks a second candidate region that the router ranks
 * BELOW us-east-2, so the Control Plane must first try us-east-2, receive a real EC2 error, and fail over
 * to the second region.
 *
 * The script starts ControlPlaneService (desiredCount 1) and ALWAYS returns it to desiredCount 0. It cancels
 * the job, which terminates the Spot instance, and then counts running managed instances in all 5 regions.
 * It never prints the operator token.
 */

const UNSUPPORTED_REGION = 'us-east-2';
const INSTANCE_TYPE = 'd3en.xlarge';
const WORKLOAD_CLASS = 'c.xlarge';
const MAX_HOURLY_PRICE_USD = 0.5;
const AMI_PARAM = '/aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-amazon-linux-2023/latest/ami-id';
const DEFAULT_SPOT_FEED_URL = 'https://d16jdvzof4zpo7.cloudfront.net/data.json';

/** Same ranking loop as ModelFactoryOrchestrator.approveAndLaunchTraining, used only to choose the candidates. */
function rankRegions(snapshot: Parameters<typeof selectOptimalSpotPlacement>[0], candidates: string[]): string[] {
  const ranked: string[] = [];
  const remaining = [...candidates];
  while (remaining.length > 0) {
    try {
      const decision = selectOptimalSpotPlacement(snapshot, {
        primaryRegion: remaining[0]!,
        allowedRegions: remaining,
        workloadClass: WORKLOAD_CLASS,
        maxHourlyPriceUsd: MAX_HOURLY_PRICE_USD,
      });
      ranked.push(decision.selectedRegion);
      const idx = remaining.indexOf(decision.selectedRegion);
      remaining.splice(idx >= 0 ? idx : 0, 1);
    } catch {
      break;
    }
  }
  return ranked;
}

async function main(): Promise<void> {
  const localPort = Number(process.env.HIVEMIND_LOCAL_PORT ?? '14326');
  const runtimeOut = (
    JSON.parse(readFileSync(process.env.HIVEMIND_RUNTIME_OUTPUTS ?? '/tmp/hivemind-aws-runtime-outputs.json', 'utf8')) as Record<
      string,
      Record<string, string>
    >
  ).HivemindAwsRuntimeStack!;
  const cluster = runtimeOut.ClusterName!;
  const service = runtimeOut.ControlPlaneServiceName!;

  // Choose the fallback region: any spoke that the router ranks below the unsupported region.
  const snapshot = await createSpotPlacementFeedPort({
    feedUrl: process.env.HIVEMIND_SPOT_FEED_URL?.trim() || DEFAULT_SPOT_FEED_URL,
  }).getSnapshot();
  let candidateRegions: string[] | null = null;
  let predictedOrder: string[] = [];
  for (const fallbackRegion of ['us-east-1', 'us-west-2', 'ap-northeast-1']) {
    const order = rankRegions(snapshot, [UNSUPPORTED_REGION, fallbackRegion]);
    if (order[0] === UNSUPPORTED_REGION && order[1] === fallbackRegion) {
      candidateRegions = [UNSUPPORTED_REGION, fallbackRegion];
      predictedOrder = order;
      break;
    }
  }
  if (!candidateRegions) {
    throw new Error(`Router does not rank ${UNSUPPORTED_REGION} first for ${WORKLOAD_CLASS}; failover cannot be forced today`);
  }
  const fallbackRegion = candidateRegions[1]!;
  const expectedFallbackAmi = aws(fallbackRegion, ['ssm', 'get-parameter', '--name', AMI_PARAM, '--query', 'Parameter.Value', '--output', 'text']);
  const primaryAmi = aws(UNSUPPORTED_REGION, ['ssm', 'get-parameter', '--name', AMI_PARAM, '--query', 'Parameter.Value', '--output', 'text']);
  console.log(JSON.stringify({ phase: 'plan', feedGenerated: snapshot?.generated ?? null, candidateRegions, predictedOrder }));

  const operatorToken = awsJson<{ SecretString?: string }>(PRIMARY_REGION, [
    'secretsmanager', 'get-secret-value', '--secret-id', runtimeOut.OperatorTokenSecretArn!,
  ]).SecretString?.trim();
  if (!operatorToken) throw new Error('Operator token missing');

  const startedAtMs = Date.now();
  const controlPlane = new ControlPlane(cluster, service, localPort);
  let jobId: string | null = null;
  let summary: Record<string, unknown> = {};
  const baseUrl = `http://127.0.0.1:${localPort}`;

  try {
    await controlPlane.start();

    const created = await apiJson<ModelFactoryJob>(`${baseUrl}/api/model-factory/jobs`, operatorToken, {
      title: 'Issue #16 five-region registry auto-placement and failover proof',
      modelId: 'smf-region-registry-proof',
      repository: 'roboco-io/silicon-model-factory',
      baseCommit: 'a'.repeat(40),
      compute: {
        region: UNSUPPORTED_REGION,
        candidateRegions,
        instanceType: INSTANCE_TYPE,
        workloadClass: WORKLOAD_CLASS,
        amiId: primaryAmi,
        maxLifetimeMs: 300_000,
        maxHourlyPriceUsd: MAX_HOURLY_PRICE_USD,
        maxTotalCostMicros: 50_000,
        s3ArtifactPrefix: `models/smf-region-registry-proof/runs/run-${startedAtMs}`,
      },
      releasePolicy: { mode: 's3_artifact_only', visibility: 'private', releaseCheckCommand: ['node', 'tools/release-check.mjs'] },
    });
    jobId = created.id;
    if (created.compute.regionOverrides || created.compute.subnetId || created.compute.securityGroupIds) {
      throw new Error('Proof job must not carry regionOverrides, subnetId or securityGroupIds');
    }

    const launched = await apiJson<ModelFactoryJob>(
      `${baseUrl}/api/model-factory/jobs/${encodeURIComponent(jobId)}/approve-training`,
      operatorToken,
      { approvalFingerprint: created.approvalFingerprint, reason: 'Issue #16 live five-region registry placement proof' },
    );
    if (launched.status !== 'training_running' || !launched.instance) {
      throw new Error(`Launch failed: status=${launched.status} failureReason=${launched.failureReason ?? ''}`);
    }
    console.log(JSON.stringify({ phase: 'launched', jobId, region: launched.instance.region, instanceId: launched.instance.instanceId }));

    const instance = awsJson<
      { InstanceLifecycle?: string; InstanceType?: string; ImageId?: string; SubnetId?: string; SecurityGroups?: { GroupId?: string }[] }[]
    >(launched.instance.region, [
      'ec2', 'describe-instances', '--instance-ids', launched.instance.instanceId, '--query', 'Reservations[].Instances[]',
    ])[0]!;
    const spokeOutputs = awsJson<{ OutputKey: string; OutputValue: string }[]>(launched.instance.region, [
      'cloudformation', 'describe-stacks',
      '--stack-name', `HivemindAwsSpoke${launched.instance.region.split('-').map((p) => p[0]!.toUpperCase() + p.slice(1)).join('')}Stack`,
      '--query', 'Stacks[0].Outputs',
    ]);
    const out = Object.fromEntries(spokeOutputs.map((o) => [o.OutputKey, o.OutputValue]));
    const registrySubnets = (out.SpokePublicSubnetIds ?? '').split(',');
    const securityGroups = (instance.SecurityGroups ?? []).map((g) => g.GroupId);

    const cancelled = await apiJson<ModelFactoryJob>(`${baseUrl}/api/model-factory/jobs/${encodeURIComponent(jobId)}/cancel`, operatorToken, {
      reason: 'Issue #16 proof complete; terminate Spot instance',
    });

    // Placement attempts logged by the deployed Control Plane (CloudWatch Logs), as independent evidence of failover.
    await sleep(15_000);
    const logEvents = awsJson<{ events?: { message?: string }[] }>(PRIMARY_REGION, [
      'logs', 'filter-log-events', '--log-group-name', `/hivemind/${process.env.HIVEMIND_AWS_PREFIX ?? 'hivemind-runtime'}`,
      '--start-time', String(startedAtMs), '--filter-pattern', '"hivemind.model_factory.placement_attempt"',
    ]);
    const attempts = (logEvents.events ?? [])
      .map((e) => {
        try {
          return JSON.parse(e.message ?? '') as { jobId?: string; region?: string; subnetId?: string; outcome?: string; detail?: string };
        } catch {
          return null;
        }
      })
      .filter((a): a is NonNullable<typeof a> => a !== null && a.jobId === jobId)
      .map((a) => ({ region: a.region, subnetId: a.subnetId, outcome: a.outcome, detail: a.detail?.slice(0, 120) }));

    summary = {
      jobId,
      candidateRegions,
      predictedOrder,
      selectedRegion: launched.instance.region,
      instanceId: launched.instance.instanceId,
      instanceType: instance.InstanceType,
      lifecycle: instance.InstanceLifecycle,
      amiId: instance.ImageId,
      amiMatchesSsmLatest: instance.ImageId === expectedFallbackAmi,
      subnetId: instance.SubnetId,
      subnetFromRegistry: registrySubnets.includes(instance.SubnetId ?? ''),
      securityGroups,
      securityGroupFromRegistry: securityGroups.length === 1 && securityGroups[0] === out.SpokeWorkerSecurityGroupId,
      cancelledStatus: cancelled.status,
      placementAttempts: attempts,
      failoverObserved: attempts.some((a) => a.region === UNSUPPORTED_REGION && a.outcome === 'capacity_failover'),
    };
  } catch (error) {
    if (jobId) {
      await apiJson(`${baseUrl}/api/model-factory/jobs/${encodeURIComponent(jobId)}/cancel`, operatorToken, {
        reason: 'Cleanup after registry proof error',
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    // Leaves the Control Plane as it was found: running all day, or at 0 if the proof raised it.
    await controlPlane.stop();
  }

  // Wait until the cancelled instance leaves pending/running, then count managed instances in all 5 regions.
  const running = await waitForNoManagedInstances();
  const desiredCount = Number(
    aws(PRIMARY_REGION, ['ecs', 'describe-services', '--cluster', cluster, '--services', service, '--query', 'services[0].desiredCount', '--output', 'text']),
  );
  const ok =
    summary.selectedRegion === fallbackRegion &&
    summary.lifecycle === 'spot' &&
    summary.amiMatchesSsmLatest === true &&
    summary.subnetFromRegistry === true &&
    summary.securityGroupFromRegistry === true &&
    summary.failoverObserved === true &&
    desiredCount === (controlPlane.initialDesiredCount ?? 0) &&
    Object.values(running).every((n) => n === 0);
  console.log(JSON.stringify({ phase: 'summary', ok, ...summary, controlPlaneDesiredCount: desiredCount, runningManagedInstances: running }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
