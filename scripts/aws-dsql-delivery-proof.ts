import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DsqlDeliveryRepository } from '../packages/adapters/src/aws-dsql-delivery.js';
import type { AwsEcsCredentials } from '../packages/adapters/src/aws-ecs-driver.js';
import type { CreateDeliveryTask } from '../packages/contracts/src/delivery.js';
import { computeAcceptanceTestDigest, DeliveryStore } from '../packages/core/src/delivery.js';

/**
 * Live proof that DeliveryStore works on the real Amazon Aurora DSQL cluster in Seoul.
 * It connects directly with the operator's AWS profile and uses its own tables (`hm_deliveryproof_*`) that
 * it drops at the end, so it never touches real delivery tasks.
 */
const REGION = 'ap-northeast-2';
const profile = process.env.AWS_PROFILE ?? 'roboco';

function loadCredentials(): AwsEcsCredentials {
  const raw = JSON.parse(
    execFileSync('aws', ['--profile', profile, '--region', REGION, 'configure', 'export-credentials', '--format', 'process'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  ) as { AccessKeyId: string; SecretAccessKey: string; SessionToken?: string };
  return {
    accessKeyId: raw.AccessKeyId,
    secretAccessKey: raw.SecretAccessKey,
    ...(raw.SessionToken ? { sessionToken: raw.SessionToken } : {}),
  };
}

function taskInput(): CreateDeliveryTask {
  const baseCommit = 'a'.repeat(40);
  const files = [{ path: 'tests/acceptance.test.ts', sha256: 'd'.repeat(64) }];
  const testCommand = ['npm', 'run', 'check'];
  return {
    title: 'Issue #16 DSQL delivery store proof',
    instructions: 'Proof task. No worker runs it.',
    provider: 'codex',
    maxIterations: 3,
    budgetMicros: 500_000,
    acceptance: { baseCommit, files, testCommand, digest: computeAcceptanceTestDigest({ baseCommit, files, testCommand }) },
    delivery: { mode: 'draft_pr', repository: 'roboco-io/project-hivemind', baseBranch: 'main', branchPrefix: 'hivemind/', autoMerge: false },
    bundle: { baseCommit, bundleSha256: 'b'.repeat(64), sizeBytes: 1_000, fileCount: 1, s3Key: 'bundles/proof.bundle' },
    spot: { maxSpotRetries: 2, checkpointFlushTimeoutMs: 90_000 },
  };
}

async function main(): Promise<void> {
  const runtimeOut = (
    JSON.parse(readFileSync(process.env.HIVEMIND_RUNTIME_OUTPUTS ?? '/tmp/hivemind-aws-runtime-outputs.json', 'utf8')) as Record<string, Record<string, string>>
  ).HivemindAwsRuntimeStack!;
  const endpoint = process.env.HIVEMIND_DSQL_ENDPOINT ?? runtimeOut.DsqlClusterEndpoint!;
  const repository = new DsqlDeliveryRepository({
    endpoint,
    region: REGION,
    allowedRegions: [REGION],
    credentials: loadCredentials,
    tablePrefix: 'hm_deliveryproof',
  });
  const store = new DeliveryStore(repository);
  const summary: Record<string, unknown> = { endpoint };
  try {
    await repository.dropTables(); // leftovers of an aborted earlier run
    const task = await store.create(taskInput());
    const approved = await store.approve(task.id, task.approvalFingerprint, 'proof approval');
    // Two workers try to start the same iteration at the same time.
    const starts = await Promise.allSettled([
      store.startIteration(task.id, 'worker-a', 'run-a'),
      store.startIteration(task.id, 'worker-b', 'run-b'),
    ]);
    const final = await store.get(task.id);
    const events = await store.events(task.id);
    summary.storageBackend = store.storageBackend;
    summary.statusAfterApproval = approved.status;
    summary.concurrentStartsFulfilled = starts.filter((r) => r.status === 'fulfilled').length;
    summary.concurrentStartRejections = starts
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => String(r.reason instanceof Error ? r.reason.message : r.reason).slice(0, 120));
    summary.finalStatus = final.status;
    summary.currentIteration = final.currentIteration;
    summary.activeWorkerId = final.activeWorkerId;
    summary.eventTypes = events.map((e) => e.type);
    summary.cancelledStatus = (await store.cancel(task.id, 'proof complete')).status;
  } finally {
    await repository.dropTables().catch((error) => {
      summary.cleanupError = error instanceof Error ? error.message : String(error);
    });
    await store.close();
  }
  const ok =
    summary.storageBackend === 'aurora-dsql' &&
    summary.concurrentStartsFulfilled === 1 &&
    summary.currentIteration === 1 &&
    summary.finalStatus === 'running' &&
    (summary.eventTypes as string[]).filter((t) => t === 'delivery.iteration_started').length === 1 &&
    summary.cancelledStatus === 'cancelled' &&
    summary.cleanupError === undefined;
  console.log(JSON.stringify({ ok, ...summary }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
