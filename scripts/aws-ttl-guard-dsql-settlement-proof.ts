import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DsqlModelFactoryRepository } from '../packages/adapters/src/aws-dsql-model-factory.js';
import type { AwsEcsCredentials } from '../packages/adapters/src/aws-ecs-driver.js';
import type { ModelFactoryJob } from '../packages/contracts/src/model-factory.js';

/**
 * Live AWS proof for Issue #16 task 3: the TTL Guard Lambda settles a job's cost in the Aurora DSQL ledger
 * while the Control Plane service is stopped.
 *
 *   1. Start the Control Plane, check that its Model Factory ledger is `aurora-dsql`, register and approve a
 *      job. The Control Plane launches one t4g.nano Spot instance in us-east-2 with a 3-minute lifetime.
 *   2. Stop the Control Plane (desiredCount 0) and wait until no task runs.
 *   3. After the instance's expiry time, invoke the deployed TTL Guard Lambda directly. (The EventBridge
 *      schedule would run it within 5 minutes; a direct invoke makes the proof deterministic.)
 *   4. Read the job straight from DSQL with the operator's IAM identity: the cost must be settled and the
 *      forced termination recorded, with the Control Plane still stopped.
 *   5. Start the Control Plane again and wake the job: it must finish the job (failed, no receipt) without
 *      settling a second time. Stop the Control Plane.
 *
 * The script always returns the Control Plane to desiredCount 0, cancels the job on error, and counts running
 * managed instances in all 5 regions at the end. It never prints the operator token.
 */

const PRIMARY_REGION = 'ap-northeast-2';
const INSTANCE_REGION = 'us-east-2';
const FIVE_REGIONS = ['ap-northeast-2', 'us-east-2', 'us-east-1', 'us-west-2', 'ap-northeast-1'];
const LIFETIME_MS = 180_000;
const profile = process.env.AWS_PROFILE ?? 'roboco';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function aws(region: string, args: string[]): string {
  return execFileSync('aws', ['--profile', profile, '--region', region, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function awsJson<T>(region: string, args: string[]): T {
  return JSON.parse(aws(region, [...args, '--output', 'json'])) as T;
}
function loadCredentials(): AwsEcsCredentials {
  const raw = awsJson<{ AccessKeyId: string; SecretAccessKey: string; SessionToken?: string }>(PRIMARY_REGION, [
    'configure', 'export-credentials', '--format', 'process',
  ]);
  return {
    accessKeyId: raw.AccessKeyId,
    secretAccessKey: raw.SecretAccessKey,
    ...(raw.SessionToken ? { sessionToken: raw.SessionToken } : {}),
  };
}

async function apiJson<T>(url: string, token: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${new URL(url).pathname}: ${(await res.text()).slice(0, 500)}`);
  return (await res.json()) as T;
}

class ControlPlane {
  private tunnel: { pid?: number } | null = null;
  constructor(
    private readonly cluster: string,
    private readonly service: string,
    private readonly localPort: number,
  ) {}
  get baseUrl(): string {
    return `http://127.0.0.1:${this.localPort}`;
  }
  private setDesired(count: number): void {
    aws(PRIMARY_REGION, ['ecs', 'update-service', '--cluster', this.cluster, '--service', this.service, '--desired-count', String(count), '--query', 'service.desiredCount', '--output', 'text']);
  }
  runningTaskCount(): number {
    return Number(aws(PRIMARY_REGION, ['ecs', 'list-tasks', '--cluster', this.cluster, '--service-name', this.service, '--query', 'length(taskArns)', '--output', 'text']));
  }
  desiredCount(): number {
    return Number(aws(PRIMARY_REGION, ['ecs', 'describe-services', '--cluster', this.cluster, '--services', this.service, '--query', 'services[0].desiredCount', '--output', 'text']));
  }
  async start(): Promise<void> {
    this.setDesired(1);
    const deadline = Date.now() + 300_000;
    let target: string | null = null;
    while (Date.now() < deadline && !target) {
      const taskArn = awsJson<{ taskArns?: string[] }>(PRIMARY_REGION, ['ecs', 'list-tasks', '--cluster', this.cluster, '--service-name', this.service, '--desired-status', 'RUNNING']).taskArns?.[0];
      if (taskArn) {
        const task = awsJson<{ tasks?: { lastStatus?: string; containers?: { name?: string; runtimeId?: string; managedAgents?: { name?: string; lastStatus?: string }[] }[] }[] }>(
          PRIMARY_REGION, ['ecs', 'describe-tasks', '--cluster', this.cluster, '--tasks', taskArn],
        ).tasks?.[0];
        const container = task?.containers?.find((c) => c.name === 'control-plane');
        if (task?.lastStatus === 'RUNNING' && container?.runtimeId && container.managedAgents?.some((a) => a.name === 'ExecuteCommandAgent' && a.lastStatus === 'RUNNING')) {
          target = `ecs:${this.cluster}_${taskArn.split('/').pop()}_${container.runtimeId}`;
        }
      }
      if (!target) await sleep(8_000);
    }
    if (!target) throw new Error('Timed out waiting for a RUNNING ControlPlaneService task');
    // Own process group, so closing also ends the session-manager-plugin child.
    const child = spawn(
      'aws',
      ['--profile', profile, '--region', PRIMARY_REGION, 'ssm', 'start-session', '--target', target, '--document-name', 'AWS-StartPortForwardingSession',
        '--parameters', JSON.stringify({ portNumber: ['4310'], localPortNumber: [String(this.localPort)] })],
      { stdio: 'ignore', detached: true },
    );
    this.tunnel = child;
    const ready = Date.now() + 90_000;
    while (Date.now() < ready) {
      try {
        if ((await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) })).ok) return;
      } catch {
        // tunnel or server still starting
      }
      await sleep(1500);
    }
    throw new Error('Timed out waiting for SSM tunnel to ControlPlaneService');
  }
  async stop(): Promise<void> {
    if (this.tunnel?.pid !== undefined) {
      try {
        process.kill(-this.tunnel.pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
    this.tunnel = null;
    this.setDesired(0);
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline && this.runningTaskCount() > 0) await sleep(8_000);
    if (this.runningTaskCount() > 0) throw new Error('ControlPlaneService tasks did not stop');
  }
}

async function main(): Promise<void> {
  const runtimeOut = (
    JSON.parse(readFileSync(process.env.HIVEMIND_RUNTIME_OUTPUTS ?? '/tmp/hivemind-aws-runtime-outputs.json', 'utf8')) as Record<string, Record<string, string>>
  ).HivemindAwsRuntimeStack!;
  const controlPlane = new ControlPlane(runtimeOut.ClusterName!, runtimeOut.ControlPlaneServiceName!, Number(process.env.HIVEMIND_LOCAL_PORT ?? '14341'));
  const guardFunction = runtimeOut.ModelFactoryTtlGuardFunctionName!;
  const operatorToken = awsJson<{ SecretString?: string }>(PRIMARY_REGION, ['secretsmanager', 'get-secret-value', '--secret-id', runtimeOut.OperatorTokenSecretArn!]).SecretString?.trim();
  if (!operatorToken) throw new Error('Operator token missing');
  const amiId = aws(INSTANCE_REGION, ['ssm', 'get-parameter', '--name', '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64', '--query', 'Parameter.Value', '--output', 'text']);

  // Read-only view of the production ledger tables, straight from DSQL (not through the Control Plane).
  const ledger = new DsqlModelFactoryRepository({
    endpoint: runtimeOut.DsqlClusterEndpoint!,
    region: PRIMARY_REGION,
    allowedRegions: [PRIMARY_REGION],
    credentials: loadCredentials,
  });
  const scratch = mkdtempSync(join(tmpdir(), 'hivemind-guard-proof-'));
  const startedAtMs = Date.now();
  let jobId: string | null = null;
  const summary: Record<string, unknown> = {};

  try {
    // 1. Launch through the Control Plane.
    await controlPlane.start();
    const listed = await apiJson<{ storageBackend?: string; jobs: unknown[] }>(`${controlPlane.baseUrl}/api/model-factory/jobs`, operatorToken);
    summary.controlPlaneLedgerBackend = listed.storageBackend ?? null;
    summary.jobsVisibleAfterMigration = listed.jobs.length;
    if (listed.storageBackend !== 'aurora-dsql') throw new Error(`Control Plane ledger backend is ${String(listed.storageBackend)}, expected aurora-dsql`);

    const created = await apiJson<ModelFactoryJob>(`${controlPlane.baseUrl}/api/model-factory/jobs`, operatorToken, {
      title: 'Issue #16 TTL Guard DSQL settlement proof',
      modelId: 'smf-guard-dsql-proof',
      repository: 'roboco-io/silicon-model-factory',
      baseCommit: 'a'.repeat(40),
      compute: {
        region: INSTANCE_REGION,
        instanceType: 't4g.nano',
        amiId,
        maxLifetimeMs: LIFETIME_MS,
        maxHourlyPriceUsd: 0.01,
        maxTotalCostMicros: 50_000,
        // No userDataScript: the instance idles until the guard terminates it. Network comes from the registry.
        s3ArtifactPrefix: `models/smf-guard-dsql-proof/runs/run-${startedAtMs}`,
      },
      releasePolicy: { mode: 's3_artifact_only', visibility: 'private', releaseCheckCommand: ['node', 'tools/release-check.mjs'] },
    });
    jobId = created.id;
    const launched = await apiJson<ModelFactoryJob>(`${controlPlane.baseUrl}/api/model-factory/jobs/${encodeURIComponent(jobId)}/approve-training`, operatorToken, {
      approvalFingerprint: created.approvalFingerprint,
      reason: 'Issue #16 TTL Guard DSQL settlement proof',
    });
    if (launched.status !== 'training_running' || !launched.instance) {
      throw new Error(`Launch failed: status=${launched.status} failureReason=${launched.failureReason ?? ''}`);
    }
    const instance = launched.instance;
    console.log(JSON.stringify({ phase: 'launched', jobId, instanceId: instance.instanceId, expiresAt: instance.expiresAt }));

    // 2. Stop the Control Plane before the instance expires.
    await controlPlane.stop();
    summary.controlPlaneStoppedBeforeExpiry = Date.now() < Date.parse(instance.expiresAt);
    const beforeGuard = await ledger.getJob(jobId);
    summary.settledBeforeGuard = beforeGuard?.cost.settledMicros ?? null;

    // 3. Wait for expiry, then run the deployed guard Lambda.
    const waitMs = Date.parse(instance.expiresAt) - Date.now() + 5_000;
    if (waitMs > 0) await sleep(waitMs);
    const outFile = join(scratch, 'guard-output.json');
    const invoke = awsJson<{ StatusCode?: number; FunctionError?: string }>(PRIMARY_REGION, ['lambda', 'invoke', '--function-name', guardFunction, outFile]);
    const guardOutput = JSON.parse(readFileSync(outFile, 'utf8')) as {
      ok?: boolean;
      summary?: { region: string; terminated: { instanceId: string }[]; settlements: { jobId: string; outcome: string; settledMicros: number | null }[]; errors: string[] }[];
    };
    const regionSummary = guardOutput.summary?.find((s) => s.region === INSTANCE_REGION);
    summary.guardInvoke = { statusCode: invoke.StatusCode ?? null, functionError: invoke.FunctionError ?? null, ok: guardOutput.ok ?? null };
    summary.guardTerminated = regionSummary?.terminated.map((t) => t.instanceId) ?? [];
    summary.guardSettlements = regionSummary?.settlements ?? [];
    summary.guardErrors = guardOutput.summary?.flatMap((s) => s.errors) ?? [];

    // 4. Ledger state read from DSQL while the Control Plane is still stopped.
    const afterGuard = await ledger.getJob(jobId);
    summary.controlPlaneTasksDuringSettlement = controlPlane.runningTaskCount();
    summary.ledgerAfterGuard = afterGuard
      ? {
          status: afterGuard.status,
          settledMicros: afterGuard.cost.settledMicros,
          instanceSeconds: afterGuard.cost.instanceSeconds,
          instanceState: afterGuard.instance?.state ?? null,
          forcedTerminationReason: afterGuard.instance?.forcedTerminationReason ?? null,
          nextWakeAt: afterGuard.nextWakeAt,
        }
      : null;
    summary.ec2InstanceState = aws(INSTANCE_REGION, ['ec2', 'describe-instances', '--instance-ids', instance.instanceId, '--query', 'Reservations[0].Instances[0].State.Name', '--output', 'text']);

    // 5. The Control Plane finishes the job on its next start, without a second settlement.
    await controlPlane.start();
    const woken = await apiJson<ModelFactoryJob>(`${controlPlane.baseUrl}/api/model-factory/jobs/${encodeURIComponent(jobId)}/wake`, operatorToken, {});
    summary.afterControlPlaneWake = { status: woken.status, settledMicros: woken.cost.settledMicros, failureReason: (woken.failureReason ?? '').slice(0, 160) };
    const events = await apiJson<{ events: { type: string }[] }>(`${controlPlane.baseUrl}/api/model-factory/jobs/${encodeURIComponent(jobId)}`, operatorToken);
    summary.costSettledEvents = events.events.filter((e) => e.type === 'model_factory.cost_settled').length;
  } catch (error) {
    if (jobId) {
      // Best effort: make sure the instance does not outlive a failed proof. The guard schedule also covers it.
      try {
        if (controlPlane.runningTaskCount() === 0) await controlPlane.start();
        await apiJson(`${controlPlane.baseUrl}/api/model-factory/jobs/${encodeURIComponent(jobId)}/cancel`, operatorToken, { reason: 'Cleanup after guard proof error' });
      } catch {
        // reported below through runningManagedInstances
      }
    }
    summary.error = error instanceof Error ? error.message : String(error);
  } finally {
    await controlPlane.stop().catch((error) => {
      summary.stopError = error instanceof Error ? error.message : String(error);
    });
    await ledger.close().catch(() => undefined);
    rmSync(scratch, { recursive: true, force: true });
  }

  const running: Record<string, number> = {};
  for (let attempt = 0; attempt < 12; attempt += 1) {
    for (const region of FIVE_REGIONS) {
      running[region] = Number(
        aws(region, ['ec2', 'describe-instances', '--filters', 'Name=tag:hivemind:managed-by,Values=hivemind-model-factory', 'Name=instance-state-name,Values=pending,running,stopping,stopped', '--query', 'length(Reservations[].Instances[])', '--output', 'text']),
      );
    }
    if (Object.values(running).every((n) => n === 0)) break;
    await sleep(10_000);
  }
  const after = summary.ledgerAfterGuard as { settledMicros: number | null; forcedTerminationReason: string | null } | null | undefined;
  const settlements = (summary.guardSettlements ?? []) as { jobId: string; outcome: string }[];
  const wake = summary.afterControlPlaneWake as { status: string; settledMicros: number | null } | undefined;
  const ok =
    summary.error === undefined &&
    summary.controlPlaneLedgerBackend === 'aurora-dsql' &&
    summary.controlPlaneStoppedBeforeExpiry === true &&
    summary.settledBeforeGuard === null &&
    settlements.some((s) => s.jobId === jobId && s.outcome === 'settled') &&
    summary.controlPlaneTasksDuringSettlement === 0 &&
    typeof after?.settledMicros === 'number' &&
    Boolean(after?.forcedTerminationReason?.startsWith('TTL Guard Lambda forced termination')) &&
    wake?.status === 'failed' &&
    wake.settledMicros === after?.settledMicros &&
    summary.costSettledEvents === 1 &&
    controlPlane.desiredCount() === 0 &&
    Object.values(running).every((n) => n === 0);
  console.log(JSON.stringify({ phase: 'summary', ok, jobId, ...summary, controlPlaneDesiredCount: controlPlane.desiredCount(), runningManagedInstances: running }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
