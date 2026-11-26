import { DsqlModelFactoryRepository } from '../../../packages/adapters/src/aws-dsql-model-factory.ts';
import { AwsEc2SpotTrainer } from '../../../packages/adapters/src/aws-ec2-spot-trainer.ts';
import type { AwsEcsCredentials } from '../../../packages/adapters/src/aws-ecs-driver.ts';
import { runModelFactoryTtlGuard } from '../../../packages/adapters/src/model-factory-ttl-guard.ts';
import { ModelFactoryStore } from '../../../packages/core/src/model-factory.ts';

/**
 * Model Factory TTL Guard Lambda (EventBridge, every 5 minutes).
 *
 * It terminates managed EC2 instances that are past their `hivemind:expires-at` tag in every guarded region.
 * When HIVEMIND_MF_STORAGE=aurora-dsql it also settles the terminated job's cost in the Aurora DSQL ledger,
 * so the ledger is correct even while the Control Plane service is stopped (desiredCount 0).
 */
function lambdaCredentials(): AwsEcsCredentials {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error('Lambda execution role credentials are missing');
  return {
    accessKeyId,
    secretAccessKey,
    ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}),
  };
}

// Created once per Lambda execution environment, so warm invocations reuse the DSQL connection pool.
let cachedStore: ModelFactoryStore | null | undefined;

function ledgerStore(): ModelFactoryStore | null {
  if (cachedStore !== undefined) return cachedStore;
  const endpoint = process.env.HIVEMIND_DSQL_ENDPOINT?.trim();
  const region = process.env.HIVEMIND_DSQL_REGION?.trim();
  const dsqlUser = process.env.HIVEMIND_DSQL_USER?.trim() || undefined;
  if (dsqlUser !== undefined && !/^[a-z][a-z0-9_]{1,62}$/.test(dsqlUser)) throw new Error('Invalid HIVEMIND_DSQL_USER');
  if (process.env.HIVEMIND_MF_STORAGE !== 'aurora-dsql' || !endpoint || !region) {
    cachedStore = null;
    return cachedStore;
  }
  cachedStore = new ModelFactoryStore(
    new DsqlModelFactoryRepository({
      endpoint,
      region,
      allowedRegions: [region],
      credentials: lambdaCredentials,
      // A restricted database role cannot create tables; the operator creates them beforehand.
      ...(dsqlUser ? { user: dsqlUser, manageSchema: false } : {}),
    }),
  );
  return cachedStore;
}

export async function handler(): Promise<{ ok: boolean; summary: unknown }> {
  const regions = (process.env.HIVEMIND_GUARD_REGIONS || 'ap-northeast-2,us-east-2')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const store = ledgerStore();
  const summary = await runModelFactoryTtlGuard({
    regions,
    ec2: new AwsEc2SpotTrainer({ allowedRegions: regions, credentials: lambdaCredentials }),
    ...(store ? { store } : {}),
  });
  const ok = summary.every((s) => s.errors.length === 0);
  console.log(JSON.stringify({ event: 'hivemind.mf_ttl_guard.sweep', ledger: store ? 'aurora-dsql' : 'none', ok, summary }));
  // Throwing marks the invocation as failed in Lambda metrics. Instances were already terminated above.
  if (!ok) throw new Error('TTL Guard finished with errors; see the hivemind.mf_ttl_guard.sweep log event');
  return { ok, summary };
}
