import { DSQL_COLLAB_SCHEMA_STATEMENTS } from './aws-dsql.js';
import { documentSchemaStatements, type DsqlPoolLike } from './aws-dsql-documents.js';

/**
 * Least-privilege database roles for Aurora DSQL.
 *
 * The `admin` role can create and drop anything in the cluster. The Control Plane and the TTL Guard Lambda
 * only need to read and write rows, so each gets its own database role with table-level grants. An operator
 * applies this plan once as `admin` (scripts/aws-dsql-apply-roles.ts); afterwards the services connect with
 * `dsql:DbConnect` and never issue DDL.
 *
 * Facts this plan relies on, measured on the Seoul cluster on 2026-11-27:
 * - `CREATE ROLE ... IF NOT EXISTS` is a syntax error; an existing role fails with SQLSTATE 42710.
 * - `AWS IAM GRANT` can be repeated without error.
 * - Every GRANT is DDL: only one per transaction.
 * - `GRANT USAGE ON SCHEMA public` is rejected ("feature not supported on system entity"), and is not
 *   needed: a table-level grant alone lets a custom role use a table in `public`.
 * - An upsert (`INSERT ... ON CONFLICT DO UPDATE`) needs UPDATE as well as INSERT.
 */
export const CONTROL_PLANE_DB_ROLE = 'hm_control_plane';
export const TTL_GUARD_DB_ROLE = 'hm_ttl_guard';

const COLLAB_TABLES = ['hm_collab_sessions', 'hm_collab_subtasks', 'hm_collab_messages', 'hm_collab_work_logs'];
const COMPUTE_TABLES = ['hm_mf_jobs', 'hm_mf_events', 'hm_mf_meta'];
const DELIVERY_TABLES = ['hm_delivery_jobs', 'hm_delivery_events', 'hm_delivery_meta'];
const AUTONOMY_TABLES = ['hm_trig_jobs', 'hm_trig_events', 'hm_trig_meta'];
const PROJECT_TABLES = ['hm_projects_jobs', 'hm_projects_events', 'hm_projects_meta'];

/** Table privileges per role. No role gets DELETE, TRUNCATE or any DDL right. */
export const DSQL_ROLE_GRANTS: Record<string, Record<string, string[]>> = {
  [CONTROL_PLANE_DB_ROLE]: Object.fromEntries(
    [...COLLAB_TABLES, ...COMPUTE_TABLES, ...DELIVERY_TABLES, ...AUTONOMY_TABLES, ...PROJECT_TABLES].map((table) => [
      table,
      ['SELECT', 'INSERT', 'UPDATE'],
    ]),
  ),
  // The guard settles Model Factory jobs only: it reads and upserts jobs and the sequence row, and appends
  // events. It has no access to collaboration or delivery tables.
  [TTL_GUARD_DB_ROLE]: {
    hm_mf_jobs: ['SELECT', 'INSERT', 'UPDATE'],
    hm_mf_meta: ['SELECT', 'INSERT', 'UPDATE'],
    hm_mf_events: ['INSERT'],
  },
};

export interface DsqlAccessStep {
  sql: string;
  /** SQLSTATE codes that mean "already done" for this statement. */
  ignoreCodes?: string[];
}

const IAM_ROLE_ARN = /^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_\/-]{1,512}$/;

/**
 * Ordered, idempotent statements: tables, roles, IAM mappings, table grants.
 * The IAM role ARNs are interpolated into SQL string literals, so they are checked against a strict pattern.
 */
export function buildDsqlAccessPlan(input: { controlPlaneIamRoleArn: string; ttlGuardIamRoleArn: string }): DsqlAccessStep[] {
  for (const arn of [input.controlPlaneIamRoleArn, input.ttlGuardIamRoleArn]) {
    if (!IAM_ROLE_ARN.test(arn)) throw new Error('Invalid IAM role ARN for a DSQL role mapping');
  }
  if (input.controlPlaneIamRoleArn === input.ttlGuardIamRoleArn) {
    throw new Error('The Control Plane and the TTL Guard must use different IAM roles');
  }
  const steps: DsqlAccessStep[] = [
    ...DSQL_COLLAB_SCHEMA_STATEMENTS,
    ...documentSchemaStatements('hm_mf', 'job_id'),
    ...documentSchemaStatements('hm_delivery', 'task_id'),
    ...documentSchemaStatements('hm_trig', 'trigger_id'),
    ...documentSchemaStatements('hm_projects', 'project_id'),
  ].map((sql) => ({ sql }));
  const mappings: [string, string][] = [
    [CONTROL_PLANE_DB_ROLE, input.controlPlaneIamRoleArn],
    [TTL_GUARD_DB_ROLE, input.ttlGuardIamRoleArn],
  ];
  for (const [role, arn] of mappings) {
    steps.push({ sql: `CREATE ROLE ${role} WITH LOGIN`, ignoreCodes: ['42710'] });
    steps.push({ sql: `AWS IAM GRANT ${role} TO '${arn}'` });
    for (const [table, privileges] of Object.entries(DSQL_ROLE_GRANTS[role]!)) {
      steps.push({ sql: `GRANT ${privileges.join(', ')} ON ${table} TO ${role}` });
    }
  }
  return steps;
}

/** Runs each step in its own transaction, as Aurora DSQL requires for DDL. Returns how many were skipped. */
export async function applyDsqlAccessPlan(pool: DsqlPoolLike, steps: DsqlAccessStep[]): Promise<{ applied: number; alreadyDone: number }> {
  let applied = 0;
  let alreadyDone = 0;
  for (const step of steps) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(step.sql);
      await client.query('COMMIT');
      applied += 1;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = (error as { code?: string } | null)?.code;
      if (code && step.ignoreCodes?.includes(code)) {
        alreadyDone += 1;
      } else {
        throw error;
      }
    } finally {
      client.release();
    }
  }
  return { applied, alreadyDone };
}
