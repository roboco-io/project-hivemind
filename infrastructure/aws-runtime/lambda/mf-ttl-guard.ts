import { DsqlComputeRepository } from '../../../packages/adapters/src/aws-dsql-compute.ts';
import { AwsEc2SpotTrainer } from '../../../packages/adapters/src/aws-ec2-spot-trainer.ts';
import type { AwsEcsCredentials } from '../../../packages/adapters/src/aws-ecs-driver.ts';
import { runComputeTtlGuard } from '../../../packages/adapters/src/compute-ttl-guard.ts';
import { ComputeStore } from '../../../packages/core/src/compute.ts';

/**
 * Multi-Region Compute TTL Guard Lambda (EventBridge, every 5 minutes).
 * Terminates managed EC2 Spot instances past their `hivemind:expires-at` tag in every guarded region
 * and settles their cost in the Aurora DSQL compute ledger when configured.
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

let cachedStore: ComputeStore | null | undefined;

function ledgerStore(): ComputeStore | null {
  if (cachedStore !== undefined) return cachedStore;
  const endpoint = process.env.HIVEMIND_DSQL_ENDPOINT?.trim();
  const region = process.env.HIVEMIND_DSQL_REGION?.trim();
  const dsqlUser = process.env.HIVEMIND_DSQL_USER?.trim() || undefined;
  if (dsqlUser !== undefined && !/^[a-z][a-z0-9_]{1,62}$/.test(dsqlUser)) throw new Error('Invalid HIVEMIND_DSQL_USER');
  const storage = (process.env.HIVEMIND_COMPUTE_STORAGE ?? process.env.HIVEMIND_MF_STORAGE)?.trim();
  if (storage !== 'aurora-dsql' || !endpoint || !region) {
    cachedStore = null;
    return cachedStore;
  }
  cachedStore = new ComputeStore(
    new DsqlComputeRepository({
      endpoint,
      region,
      allowedRegions: [region],
      credentials: lambdaCredentials,
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
  const summary = await runComputeTtlGuard({
    regions,
    ec2: new AwsEc2SpotTrainer({ allowedRegions: regions, credentials: lambdaCredentials }),
    ...(store ? { store } : {}),
  });
  const ok = summary.every((s) => s.errors.length === 0);
  console.log(JSON.stringify({ event: 'hivemind.compute_ttl_guard.sweep', ledger: store ? 'aurora-dsql' : 'none', ok, summary }));
  if (!ok) throw new Error('TTL Guard finished with errors; see the hivemind.compute_ttl_guard.sweep log event');
  return { ok, summary };
}
