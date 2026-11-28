import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DsqlComputeRepository } from '../packages/adapters/src/aws-dsql-compute.js';
import type { ComputeJob } from '../packages/contracts/src/compute.js';
import {
  apiJson,
  aws,
  awsJson,
  ControlPlane,
  loadOperatorToken,
  loadProfileCredentials,
  loadRuntimeOutputs,
  PRIMARY_REGION,
  sleep,
  waitForNoManagedInstances,
} from './lib/aws-live.js';

/**
 * Live AWS proof for Issue #16 task 3: the TTL Guard Lambda settles a job's cost in the Aurora DSQL ledger
 * while the Control Plane service is stopped.
 *
 *   1. Start the Control Plane, check that its Model Factory ledger is `aurora-dsql`, register and approve a
 *      job. The Control Plane launches one t4g.nano Spot instance in us-east-2 with a 3-minute lifetime.
 *   2. Stop the Control Plane (desiredCount 0) and wait until no task runs.
 *   3. After the instance's expiry time, wait for the EventBridge 5-minute schedule to run the deployed TTL
 *      Guard Lambda. The script does not call the Lambda. (HIVEMIND_GUARD_TRIGGER=invoke calls it directly.)
 *   4. Read the job straight from DSQL with the operator's IAM identity: the cost must be settled and the
 *      forced termination recorded, with the Control Plane still stopped.
 *   5. Start the Control Plane again and wake the job: it must finish the job (failed, no receipt) without
 *      settling a second time. Stop the Control Plane.
 *
 * The script always returns the Control Plane to desiredCount 0, cancels the job on error, and counts running
 * managed instances in all 5 regions at the end. It never prints the operator token.
 */

const INSTANCE_REGION = 'us-east-2';
const LIFETIME_MS = 180_000;
/** `schedule` (default): wait for the EventBridge rule. `invoke`: call the Lambda directly. */
const TRIGGER = process.env.HIVEMIND_GUARD_TRIGGER === 'invoke' ? 'invoke' : 'schedule';

async function main(): Promise<void> {
  const runtimeOut = loadRuntimeOutputs();
  const controlPlane = ControlPlane.fromOutputs(runtimeOut, Number(process.env.HIVEMIND_LOCAL_PORT ?? '14341'));
  const guardFunction = runtimeOut.ModelFactoryTtlGuardFunctionName!;
  const operatorToken = loadOperatorToken(runtimeOut);
  const amiId = aws(INSTANCE_REGION, ['ssm', 'get-parameter', '--name', '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64', '--query', 'Parameter.Value', '--output', 'text']);

  // Read-only view of the production ledger tables, straight from DSQL (not through the Control Plane).
  const ledger = new DsqlComputeRepository({
    endpoint: runtimeOut.DsqlClusterEndpoint!,
    region: PRIMARY_REGION,
    allowedRegions: [PRIMARY_REGION],
    credentials: loadProfileCredentials,
  });
  const scratch = mkdtempSync(join(tmpdir(), 'hivemind-guard-proof-'));
  const startedAtMs = Date.now();
  let jobId: string | null = null;
  const summary: Record<string, unknown> = {};

  try {
    // 1. Launch through the Control Plane.
    await controlPlane.start();
    const listed = await apiJson<{ storageBackend?: string; jobs: unknown[] }>(`${controlPlane.baseUrl}/api/compute/jobs`, operatorToken);
    summary.controlPlaneLedgerBackend = listed.storageBackend ?? null;
    summary.jobsVisibleAfterMigration = listed.jobs.length;
    if (listed.storageBackend !== 'aurora-dsql') throw new Error(`Control Plane ledger backend is ${String(listed.storageBackend)}, expected aurora-dsql`);

    const created = await apiJson<ComputeJob>(`${controlPlane.baseUrl}/api/compute/jobs`, operatorToken, {
      title: 'Issue #16 TTL Guard DSQL settlement proof',
      workloadId: 'smf-guard-dsql-proof',
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
    const launched = await apiJson<ComputeJob>(`${controlPlane.baseUrl}/api/compute/jobs/${encodeURIComponent(jobId)}/approve`, operatorToken, {
      approvalFingerprint: created.approvalFingerprint,
      reason: 'Issue #16 TTL Guard DSQL settlement proof',
    });
    if (launched.status !== 'running' || !launched.instance) {
      throw new Error(`Launch failed: status=${launched.status} failureReason=${launched.failureReason ?? ''}`);
    }
    const instance = launched.instance;
    console.log(JSON.stringify({ phase: 'launched', jobId, instanceId: instance.instanceId, expiresAt: instance.expiresAt }));

    // 2. Stop the Control Plane before the instance expires.
    await controlPlane.stop();
    summary.controlPlaneStoppedBeforeExpiry = Date.now() < Date.parse(instance.expiresAt);
    const beforeGuard = await ledger.getDoc(jobId);
    summary.settledBeforeGuard = beforeGuard?.cost.settledMicros ?? null;

    // 3. Wait for expiry. Then either let the EventBridge schedule run the guard (default), or invoke it.
    type GuardSummary = { region: string; terminated: { instanceId: string }[]; settlements: { jobId: string; outcome: string; settledMicros: number | null }[]; errors: string[] }[];
    const waitMs = Date.parse(instance.expiresAt) - Date.now() + 5_000;
    if (waitMs > 0) await sleep(waitMs);
    let guardSummary: GuardSummary | undefined;
    if (TRIGGER === 'invoke') {
      const outFile = join(scratch, 'guard-output.json');
      const invoke = awsJson<{ StatusCode?: number; FunctionError?: string }>(PRIMARY_REGION, ['lambda', 'invoke', '--function-name', guardFunction, outFile]);
      const guardOutput = JSON.parse(readFileSync(outFile, 'utf8')) as { ok?: boolean; summary?: GuardSummary };
      guardSummary = guardOutput.summary;
      summary.guardInvoke = { statusCode: invoke.StatusCode ?? null, functionError: invoke.FunctionError ?? null, ok: guardOutput.ok ?? null };
    } else {
      // The script does NOT call the Lambda. The rule runs every 5 minutes, so the settlement must appear
      // in the ledger within one interval plus the Lambda run time.
      const expiredAtMs = Date.parse(instance.expiresAt);
      const deadline = expiredAtMs + 7 * 60_000;
      let settledAtMs: number | null = null;
      while (Date.now() < deadline) {
        const current = await ledger.getDoc(jobId);
        if (current?.cost.settledMicros !== null && current?.cost.settledMicros !== undefined) {
          settledAtMs = Date.now();
          break;
        }
        await sleep(20_000);
      }
      summary.scheduleWait = {
        settled: settledAtMs !== null,
        secondsAfterExpiry: settledAtMs !== null ? Math.round((settledAtMs - expiredAtMs) / 1000) : null,
      };
      // The guard's own log event for this job is the evidence that the scheduled run did the settlement.
      await sleep(10_000);
      const logs = awsJson<{ events?: { timestamp?: number; message?: string }[] }>(PRIMARY_REGION, [
        'logs', 'filter-log-events', '--log-group-name', `/aws/lambda/${guardFunction}`,
        '--start-time', String(expiredAtMs), '--filter-pattern', `"${jobId}"`,
      ]);
      for (const event of logs.events ?? []) {
        const jsonStart = (event.message ?? '').indexOf('{');
        if (jsonStart < 0) continue;
        try {
          const parsed = JSON.parse((event.message ?? '').slice(jsonStart)) as { event?: string; ledger?: string; summary?: GuardSummary };
          if (parsed.event === 'hivemind.mf_ttl_guard.sweep' && parsed.summary) {
            guardSummary = parsed.summary;
            summary.guardLogEvent = { at: event.timestamp ? new Date(event.timestamp).toISOString() : null, ledger: parsed.ledger ?? null };
            break;
          }
        } catch {
          // not the JSON sweep line
        }
      }
      // Which principal invoked the function is recorded by EventBridge, not by the function; the rule's state is read instead.
      summary.scheduleRule = JSON.parse(
        aws(PRIMARY_REGION, ['events', 'list-rule-names-by-target', '--target-arn', aws(PRIMARY_REGION, ['lambda', 'get-function', '--function-name', guardFunction, '--query', 'Configuration.FunctionArn', '--output', 'text']), '--output', 'json']),
      ) as unknown;
    }
    const regionSummary = guardSummary?.find((s) => s.region === INSTANCE_REGION);
    summary.guardTrigger = TRIGGER;
    summary.guardTerminated = regionSummary?.terminated.map((t) => t.instanceId) ?? [];
    summary.guardSettlements = regionSummary?.settlements ?? [];
    summary.guardErrors = guardSummary?.flatMap((s) => s.errors) ?? [];

    // 4. Ledger state read from DSQL while the Control Plane is still stopped.
    const afterGuard = await ledger.getDoc(jobId);
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
    const woken = await apiJson<ComputeJob>(`${controlPlane.baseUrl}/api/compute/jobs/${encodeURIComponent(jobId)}/wake`, operatorToken, {});
    summary.afterControlPlaneWake = { status: woken.status, settledMicros: woken.cost.settledMicros, failureReason: (woken.failureReason ?? '').slice(0, 160) };
    const events = await apiJson<{ events: { type: string }[] }>(`${controlPlane.baseUrl}/api/compute/jobs/${encodeURIComponent(jobId)}`, operatorToken);
    summary.costSettledEvents = events.events.filter((e) => e.type === 'compute.cost_settled').length;
  } catch (error) {
    if (jobId) {
      // Best effort: make sure the instance does not outlive a failed proof. The guard schedule also covers it.
      try {
        if (controlPlane.runningTaskCount() === 0) await controlPlane.start();
        await apiJson(`${controlPlane.baseUrl}/api/compute/jobs/${encodeURIComponent(jobId)}/cancel`, operatorToken, { reason: 'Cleanup after guard proof error' });
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

  const running = await waitForNoManagedInstances();
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
