import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { generateDsqlAuthToken } from '../packages/adapters/src/aws-dsql.js';
import type { DsqlPoolLike } from '../packages/adapters/src/aws-dsql-documents.js';
import {
  applyDsqlAccessPlan,
  buildDsqlAccessPlan,
  CONTROL_PLANE_DB_ROLE,
  TTL_GUARD_DB_ROLE,
} from '../packages/adapters/src/aws-dsql-roles.js';

/**
 * Creates the HIVEMIND tables and the two restricted database roles in the Seoul Aurora DSQL cluster, maps
 * them to the Control Plane and TTL Guard IAM roles, and grants table privileges. Run it as an operator who
 * may connect as `admin`. It is idempotent. It reads no secret and prints no token.
 *
 *   AWS_PROFILE=roboco npx tsx scripts/aws-dsql-apply-roles.ts
 *
 * After it succeeds, deploy the Hub with HIVEMIND_RESTRICTED_DSQL_ROLES=1 so the services stop using admin.
 */
const REGION = process.env.HIVEMIND_AWS_REGION ?? 'ap-northeast-2';
const profile = process.env.AWS_PROFILE ?? 'roboco';
const STACK = 'HivemindAwsRuntimeStack';

function aws(args: string[]): string {
  return execFileSync('aws', ['--profile', profile, '--region', REGION, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function main(): Promise<void> {
  const outputs = Object.fromEntries(
    (JSON.parse(aws(['cloudformation', 'describe-stacks', '--stack-name', STACK, '--query', 'Stacks[0].Outputs', '--output', 'json'])) as {
      OutputKey: string;
      OutputValue: string;
    }[]).map((o) => [o.OutputKey, o.OutputValue]),
  );
  const host = outputs.DsqlClusterEndpoint;
  const controlPlaneIamRoleArn = outputs.ControlPlaneTaskRoleArn;
  const ttlGuardIamRoleArn = outputs.ModelFactoryTtlGuardRoleArn;
  if (!host || !controlPlaneIamRoleArn || !ttlGuardIamRoleArn) {
    throw new Error(`${STACK} lacks DsqlClusterEndpoint, ControlPlaneTaskRoleArn or ModelFactoryTtlGuardRoleArn outputs; deploy the Hub stack first.`);
  }
  const raw = JSON.parse(aws(['configure', 'export-credentials', '--format', 'process'])) as { AccessKeyId: string; SecretAccessKey: string; SessionToken?: string };
  const credentials = { accessKeyId: raw.AccessKeyId, secretAccessKey: raw.SecretAccessKey, ...(raw.SessionToken ? { sessionToken: raw.SessionToken } : {}) };
  const pool = new Pool({
    host,
    port: 5432,
    database: 'postgres',
    user: 'admin',
    ssl: { rejectUnauthorized: true },
    max: 1,
    password: () => generateDsqlAuthToken({ endpoint: host, region: REGION, credentials, action: 'DbConnectAdmin' }),
  });
  try {
    const plan = buildDsqlAccessPlan({ controlPlaneIamRoleArn, ttlGuardIamRoleArn });
    const result = await applyDsqlAccessPlan(pool as unknown as DsqlPoolLike, plan);
    const mappings = await pool.query(
      'SELECT pg_role_name, arn FROM sys.iam_pg_role_mappings WHERE pg_role_name = ANY($1) ORDER BY pg_role_name',
      [[CONTROL_PLANE_DB_ROLE, TTL_GUARD_DB_ROLE]],
    );
    const grants = await pool.query(
      `SELECT grantee, table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
         FROM information_schema.role_table_grants
        WHERE grantee = ANY($1)
        GROUP BY grantee, table_name
        ORDER BY grantee, table_name`,
      [[CONTROL_PLANE_DB_ROLE, TTL_GUARD_DB_ROLE]],
    );
    console.log(
      JSON.stringify(
        {
          ok: true,
          cluster: host,
          statements: plan.length,
          ...result,
          // Role names only; account id and role path are not secret but are trimmed to keep the output short.
          mappings: mappings.rows.map((r) => ({ dbRole: r.pg_role_name, iamRole: String(r.arn).split('/').pop() })),
          grants: grants.rows,
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
