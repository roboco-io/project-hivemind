import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { DsqlModelFactoryRepository } from '../packages/adapters/src/aws-dsql-model-factory.js';
import type { AwsEcsCredentials } from '../packages/adapters/src/aws-ecs-driver.js';
import type { CreateModelFactoryJob } from '../packages/contracts/src/model-factory.js';
import { ModelFactoryStore } from '../packages/core/src/model-factory.js';

/**
 * Live proof that ModelFactoryStore works on the real Amazon Aurora DSQL cluster in Seoul.
 *
 * It connects directly from this machine with the operator's AWS profile (IAM auth token), NOT through the
 * Control Plane, and uses its own tables (`hm_mfproof_*`) that it drops at the end. So it never touches the
 * real ledger or budget. It checks the things a fake database cannot: that the DDL and the upsert SQL are
 * accepted by DSQL, and that two truly concurrent approvals cannot both pass the central cost cap.
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

function jobInput(prefix: string, maxTotalCostMicros: number): CreateModelFactoryJob {
  return {
    title: 'Issue #16 DSQL ledger proof',
    modelId: 'smf-dsql-proof',
    repository: 'roboco-io/silicon-model-factory',
    baseCommit: 'a'.repeat(40),
    compute: {
      region: 'us-east-2',
      instanceType: 't4g.nano',
      amiId: 'ami-0123456789abcdef0',
      maxLifetimeMs: 300_000,
      maxHourlyPriceUsd: 0.01,
      maxTotalCostMicros,
      s3ArtifactPrefix: `models/smf-dsql-proof/${prefix}`,
    },
    releasePolicy: { mode: 's3_artifact_only', visibility: 'private', releaseCheckCommand: ['node', 'tools/release-check.mjs'] },
  };
}

async function main(): Promise<void> {
  const runtimeOut = (
    JSON.parse(readFileSync(process.env.HIVEMIND_RUNTIME_OUTPUTS ?? '/tmp/hivemind-aws-runtime-outputs.json', 'utf8')) as Record<
      string,
      Record<string, string>
    >
  ).HivemindAwsRuntimeStack!;
  const endpoint = process.env.HIVEMIND_DSQL_ENDPOINT ?? runtimeOut.DsqlClusterEndpoint!;
  const repository = new DsqlModelFactoryRepository({
    endpoint,
    region: REGION,
    allowedRegions: [REGION],
    credentials: loadCredentials,
    tablePrefix: 'hm_mfproof',
  });
  const store = new ModelFactoryStore(repository, { globalBudgetCapMicros: 500_000 });
  const stamp = Date.now();
  let summary: Record<string, unknown> = {};
  try {
    await repository.dropTables(); // leftovers of an aborted earlier run
    const a = await store.create(jobInput(`run-${stamp}-a`, 400_000));
    const b = await store.create(jobInput(`run-${stamp}-b`, 400_000));
    const listedAfterCreate = (await store.list()).map((j) => j.id);

    // Two truly concurrent approvals; together they exceed the 500,000 micros cap.
    const settled = await Promise.allSettled([
      store.approveTraining(a.id, a.approvalFingerprint, 'concurrent approval A'),
      store.approveTraining(b.id, b.approvalFingerprint, 'concurrent approval B'),
    ]);
    const fulfilled = settled.filter((r) => r.status === 'fulfilled').length;
    const rejectedReasons = settled
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => String(r.reason instanceof Error ? r.reason.message : r.reason).slice(0, 160));

    const winner = settled[0]!.status === 'fulfilled' ? a : b;
    await store.recordInstanceLaunched(winner.id, {
      region: 'us-east-2',
      availabilityZone: 'us-east-2a',
      instanceId: 'i-0123456789abcdef0',
      instanceType: 't4g.nano',
      amiId: 'ami-0123456789abcdef0',
      expiresAt: new Date(stamp + 300_000).toISOString(),
      nextWakeAt: new Date(stamp + 60_000).toISOString(),
    });
    const settledJob = await store.settleCost(winner.id, { actualCostMicros: 1_234, instanceSeconds: 60 });
    const ledger = await store.ledger();
    const events = await store.events();
    const sequences = events.map((e) => e.sequence);

    summary = {
      endpoint,
      storageBackend: store.storageBackend,
      listedNewestFirst: listedAfterCreate[0] === b.id && listedAfterCreate[1] === a.id,
      concurrentApprovalsFulfilled: fulfilled,
      concurrentApprovalRejections: rejectedReasons,
      settledMicros: settledJob.cost.settledMicros,
      ledger: {
        totalReservedMicros: ledger.totalReservedMicros,
        totalSettledMicros: ledger.totalSettledMicros,
        remainingBudgetMicros: ledger.remainingBudgetMicros,
        settledJobs: ledger.settledJobs,
      },
      eventTypes: events.map((e) => e.type),
      eventSequencesStrictlyDescending: sequences.every((s, i) => i === 0 || s < sequences[i - 1]!),
    };
  } finally {
    await repository.dropTables().catch((error) => {
      summary.cleanupError = error instanceof Error ? error.message : String(error);
    });
    await store.close();
  }
  const ledger = summary.ledger as { totalReservedMicros: number; totalSettledMicros: number } | undefined;
  const ok =
    summary.storageBackend === 'aurora-dsql' &&
    summary.listedNewestFirst === true &&
    summary.concurrentApprovalsFulfilled === 1 &&
    (summary.concurrentApprovalRejections as string[]).some((r) => r.includes('Central cost cap exceeded')) &&
    summary.settledMicros === 1_234 &&
    ledger?.totalReservedMicros === 0 &&
    ledger?.totalSettledMicros === 1_234 &&
    summary.eventSequencesStrictlyDescending === true &&
    summary.cleanupError === undefined;
  console.log(JSON.stringify({ ok, ...summary }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
