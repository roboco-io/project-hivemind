import assert from 'node:assert/strict';
import test from 'node:test';
import type { DsqlClientLike, DsqlPoolLike } from '../packages/adapters/src/aws-dsql-documents.js';
import {
  applyDsqlAccessPlan,
  buildDsqlAccessPlan,
  CONTROL_PLANE_DB_ROLE,
  DSQL_ROLE_GRANTS,
  TTL_GUARD_DB_ROLE,
} from '../packages/adapters/src/aws-dsql-roles.js';

const CP_ARN = 'arn:aws:iam::123456789012:role/HivemindAwsRuntimeStack-ControlPlaneTaskRole-AbC123';
const GUARD_ARN = 'arn:aws:iam::123456789012:role/HivemindAwsRuntimeStack-ModelFactoryTtlGuardRole-XyZ789';

test('buildDsqlAccessPlan creates tables first, then roles, IAM mappings and table grants without admin-level rights', () => {
  const plan = buildDsqlAccessPlan({ controlPlaneIamRoleArn: CP_ARN, ttlGuardIamRoleArn: GUARD_ARN });
  const sql = plan.map((s) => s.sql.replace(/\s+/g, ' ').trim());

  // 4 collab + 3 model factory + 3 delivery tables come before any role statement.
  const firstRole = sql.findIndex((s) => s.startsWith('CREATE ROLE'));
  assert.equal(sql.slice(0, firstRole).filter((s) => s.startsWith('CREATE TABLE IF NOT EXISTS')).length, 10);
  assert.equal(firstRole, 10);

  assert.ok(sql.includes(`CREATE ROLE ${CONTROL_PLANE_DB_ROLE} WITH LOGIN`));
  assert.ok(sql.includes(`AWS IAM GRANT ${CONTROL_PLANE_DB_ROLE} TO '${CP_ARN}'`));
  assert.ok(sql.includes(`AWS IAM GRANT ${TTL_GUARD_DB_ROLE} TO '${GUARD_ARN}'`));
  // An existing role is "already done", nothing else is ignored.
  assert.deepEqual(plan.filter((s) => s.ignoreCodes).map((s) => [s.sql, s.ignoreCodes]), [
    [`CREATE ROLE ${CONTROL_PLANE_DB_ROLE} WITH LOGIN`, ['42710']],
    [`CREATE ROLE ${TTL_GUARD_DB_ROLE} WITH LOGIN`, ['42710']],
  ]);

  const grants = sql.filter((s) => s.startsWith('GRANT '));
  assert.equal(grants.filter((s) => s.endsWith(`TO ${CONTROL_PLANE_DB_ROLE}`)).length, 10);
  assert.deepEqual(grants.filter((s) => s.endsWith(`TO ${TTL_GUARD_DB_ROLE}`)).sort(), [
    `GRANT INSERT ON hm_mf_events TO ${TTL_GUARD_DB_ROLE}`,
    `GRANT SELECT, INSERT, UPDATE ON hm_mf_jobs TO ${TTL_GUARD_DB_ROLE}`,
    `GRANT SELECT, INSERT, UPDATE ON hm_mf_meta TO ${TTL_GUARD_DB_ROLE}`,
  ]);
  // No role may delete rows, change schema, or pass its rights on; the guard sees no collab or delivery table.
  for (const statement of sql) {
    assert.doesNotMatch(statement, /\b(DELETE|TRUNCATE|DROP|ALTER|ALL PRIVILEGES|WITH GRANT OPTION|SUPERUSER|CREATEROLE)\b/, statement);
  }
  assert.ok(!Object.keys(DSQL_ROLE_GRANTS[TTL_GUARD_DB_ROLE]!).some((t) => t.startsWith('hm_collab') || t.startsWith('hm_delivery')));
  // Every upserted table has UPDATE next to INSERT (an upsert needs both); the append-only guard event insert does not.
  for (const [role, tables] of Object.entries(DSQL_ROLE_GRANTS)) {
    for (const [table, privileges] of Object.entries(tables)) {
      if (role === TTL_GUARD_DB_ROLE && table === 'hm_mf_events') continue;
      assert.ok(privileges.includes('INSERT') && privileges.includes('UPDATE') && privileges.includes('SELECT'), `${role}.${table}`);
    }
  }
});

test('buildDsqlAccessPlan rejects ARNs that could alter the SQL and identical roles', () => {
  const bad = [
    "arn:aws:iam::123456789012:role/x'; DROP TABLE hm_mf_jobs; --",
    'arn:aws:iam::123456789012:user/someone',
    'arn:aws:iam::12345:role/short-account',
    '',
  ];
  for (const arn of bad) {
    assert.throws(() => buildDsqlAccessPlan({ controlPlaneIamRoleArn: arn, ttlGuardIamRoleArn: GUARD_ARN }), /Invalid IAM role ARN/, arn);
    assert.throws(() => buildDsqlAccessPlan({ controlPlaneIamRoleArn: CP_ARN, ttlGuardIamRoleArn: arn }), /Invalid IAM role ARN/, arn);
  }
  assert.throws(() => buildDsqlAccessPlan({ controlPlaneIamRoleArn: CP_ARN, ttlGuardIamRoleArn: CP_ARN }), /different IAM roles/);
});

test('applyDsqlAccessPlan runs one statement per transaction, skips an existing role, and stops on any other error', async () => {
  const log: string[] = [];
  const failures = new Map<string, string>();
  const pool: DsqlPoolLike = {
    async connect(): Promise<DsqlClientLike> {
      return {
        release: () => void log.push('release'),
        async query(text: string) {
          log.push(text.replace(/\s+/g, ' ').trim().slice(0, 60));
          const code = [...failures.entries()].find(([prefix]) => text.startsWith(prefix))?.[1];
          if (code) throw Object.assign(new Error(`failed ${code}`), { code });
          return { rows: [] };
        },
      };
    },
    async end() {},
  };
  const plan = buildDsqlAccessPlan({ controlPlaneIamRoleArn: CP_ARN, ttlGuardIamRoleArn: GUARD_ARN });

  failures.set('CREATE ROLE', '42710'); // both roles already exist
  const result = await applyDsqlAccessPlan(pool, plan);
  assert.deepEqual(result, { applied: plan.length - 2, alreadyDone: 2 });
  // Each statement sits alone between BEGIN and COMMIT/ROLLBACK.
  const statements = log.filter((l) => l !== 'release');
  for (let i = 0; i < statements.length; i += 3) {
    assert.equal(statements[i], 'BEGIN');
    assert.ok(statements[i + 2] === 'COMMIT' || statements[i + 2] === 'ROLLBACK', statements[i + 2]);
  }
  assert.equal(log.filter((l) => l === 'release').length, plan.length);

  // A permission error on a grant is not "already done": the run stops there.
  failures.clear();
  failures.set('GRANT SELECT, INSERT, UPDATE ON hm_mf_jobs', '42501');
  await assert.rejects(() => applyDsqlAccessPlan(pool, plan), /failed 42501/);
});
