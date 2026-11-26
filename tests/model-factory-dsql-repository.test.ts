import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DsqlModelFactoryRepository,
  importModelFactoryHistoryIfEmpty,
  type DsqlClientLike,
  type DsqlPoolLike,
} from '../packages/adapters/src/aws-dsql-model-factory.js';
import type { CreateModelFactoryJob } from '../packages/contracts/src/model-factory.js';
import { ModelFactoryStore } from '../packages/core/src/model-factory.js';
import { SqliteModelFactoryRepository } from '../packages/core/src/model-factory-repository.js';

type Row = { value: Record<string, unknown>; version: number };

/**
 * In-memory stand-in for Aurora DSQL with the two properties the repository depends on:
 * snapshot isolation (a transaction reads the state as of BEGIN) and optimistic concurrency control
 * (COMMIT fails with OC000 when a row this transaction wrote was changed by another commit since BEGIN).
 * Conflicts are detected on WRITTEN rows only, exactly the behavior that allows write skew.
 */
class FakeDsql implements DsqlPoolLike {
  tables: Record<string, Map<string, Row>> = { hm_mf_jobs: new Map(), hm_mf_events: new Map(), hm_mf_meta: new Map() };
  statements: string[] = [];
  conflicts = 0;
  ddlInsideTransactionWithOtherStatements = false;
  failNextCommitWith: string | null = null;
  /** When false, COMMIT never reports a conflict (last writer wins). Used as a control case. */
  detectConflicts = true;

  async connect(): Promise<DsqlClientLike> {
    let snapshot: Record<string, Map<string, Row>> | null = null;
    let writes: [string, string, Record<string, unknown>][] = [];
    let statementsInTx = 0;
    let sawDdl = false;
    const view = (table: string) => {
      const base = new Map(snapshot ? snapshot[table] : this.tables[table]);
      for (const [t, key, value] of writes) if (t === table) base.set(key, { value, version: -1 });
      return base;
    };
    return {
      release: () => undefined,
      query: async (text: string, values: unknown[] = []) => {
        await Promise.resolve(); // let concurrent transactions interleave
        const sql = text.replace(/\s+/g, ' ').trim();
        this.statements.push(sql.slice(0, 40));
        if (sql === 'BEGIN') {
          snapshot = Object.fromEntries(Object.entries(this.tables).map(([k, v]) => [k, new Map(v)]));
          writes = [];
          statementsInTx = 0;
          sawDdl = false;
          return { rows: [] };
        }
        if (sql === 'ROLLBACK') {
          snapshot = null;
          writes = [];
          return { rows: [] };
        }
        if (sql === 'COMMIT') {
          if (sawDdl && statementsInTx > 1) this.ddlInsideTransactionWithOtherStatements = true;
          if (this.failNextCommitWith) {
            const code = this.failNextCommitWith;
            this.failNextCommitWith = null;
            throw Object.assign(new Error('injected commit failure'), { code });
          }
          for (const [table, key] of writes) {
            const committed = this.tables[table]!.get(key)?.version ?? 0;
            const seen = snapshot![table]!.get(key)?.version ?? 0;
            if (this.detectConflicts && committed !== seen) {
              this.conflicts += 1;
              throw Object.assign(new Error('change conflicts with another transaction'), { code: 'OC000' });
            }
          }
          for (const [table, key, value] of writes) {
            const version = (this.tables[table]!.get(key)?.version ?? 0) + 1;
            this.tables[table]!.set(key, { value, version });
          }
          snapshot = null;
          writes = [];
          return { rows: [] };
        }
        statementsInTx += 1;
        if (sql.startsWith('CREATE TABLE IF NOT EXISTS')) {
          sawDdl = true;
          return { rows: [] };
        }
        if (sql.startsWith('SELECT value FROM hm_mf_meta')) {
          const row = view('hm_mf_meta').get(String(values[0]));
          return { rows: row ? [row.value] : [] };
        }
        if (sql.startsWith('SELECT data FROM hm_mf_jobs WHERE id')) {
          const row = view('hm_mf_jobs').get(String(values[0]));
          return { rows: row ? [row.value] : [] };
        }
        if (sql.startsWith('SELECT data FROM hm_mf_jobs ORDER BY write_seq DESC')) {
          return { rows: [...view('hm_mf_jobs').values()].map((r) => r.value).sort((a, b) => Number(b.write_seq) - Number(a.write_seq)) };
        }
        if (sql.startsWith('SELECT sequence, data FROM hm_mf_events')) {
          return {
            rows: [...view('hm_mf_events').values()]
              .map((r) => r.value)
              .sort((a, b) => Number(b.sequence) - Number(a.sequence))
              .slice(0, Number(values[0])),
          };
        }
        if (sql.startsWith('INSERT INTO hm_mf_jobs')) {
          writes.push(['hm_mf_jobs', String(values[0]), { id: values[0], data: values[1], write_seq: values[2] }]);
          return { rows: [] };
        }
        if (sql.startsWith('INSERT INTO hm_mf_events')) {
          writes.push(['hm_mf_events', String(values[0]), { sequence: values[0], job_id: values[1], data: values[2] }]);
          return { rows: [] };
        }
        if (sql.startsWith('INSERT INTO hm_mf_meta')) {
          writes.push(['hm_mf_meta', String(values[0]), { id: values[0], value: values[1] }]);
          return { rows: [] };
        }
        throw new Error(`FakeDsql does not understand: ${sql}`);
      },
    };
  }
  async end(): Promise<void> {}
}

function jobInput(prefix: string, maxTotalCostMicros: number): CreateModelFactoryJob {
  return {
    title: 'DSQL repository test',
    modelId: 'smf-tiny-v1',
    repository: 'roboco-io/silicon-model-factory',
    baseCommit: 'a'.repeat(40),
    compute: {
      region: 'us-east-2',
      instanceType: 'g5.xlarge',
      amiId: 'ami-0123456789abcdef0',
      maxLifetimeMs: 3_600_000,
      maxHourlyPriceUsd: 0.45,
      maxTotalCostMicros,
      s3ArtifactPrefix: `models/smf-tiny-v1/${prefix}`,
    },
    releasePolicy: { mode: 's3_artifact_only', visibility: 'private', releaseCheckCommand: ['node', 'tools/release-check.mjs'] },
  };
}

function makeRepository(db: FakeDsql) {
  return new DsqlModelFactoryRepository({
    endpoint: 'example.dsql.ap-northeast-2.on.aws',
    region: 'ap-northeast-2',
    credentials: () => ({ accessKeyId: 'unused', secretAccessKey: 'unused' }),
    pool: db,
    sleep: async () => undefined,
  });
}

test('DSQL repository stores jobs and events, lists newest write first, and runs each DDL statement in its own transaction', async () => {
  const db = new FakeDsql();
  const store = new ModelFactoryStore(makeRepository(db), { globalBudgetCapMicros: 1_000_000 });
  assert.equal(store.storageBackend, 'aurora-dsql');

  const a = await store.create(jobInput('run-a', 100_000));
  const b = await store.create(jobInput('run-b', 100_000));
  assert.deepEqual((await store.list()).map((j) => j.id), [b.id, a.id]);
  await store.approveTraining(a.id, a.approvalFingerprint, 'ok');
  assert.deepEqual((await store.list()).map((j) => j.id), [a.id, b.id], 'an updated job moves to the front, like SQLite rowid order');
  assert.equal((await store.get(a.id)).cost.reservedMicros, 100_000);
  const events = await store.events();
  assert.deepEqual(events.map((e) => e.type), ['model_factory.training_approved', 'model_factory.created', 'model_factory.created']);
  assert.ok(events[0]!.sequence > events[1]!.sequence && events[1]!.sequence > events[2]!.sequence);
  assert.equal(db.ddlInsideTransactionWithOtherStatements, false);
  assert.equal(db.statements.filter((s) => s.startsWith('CREATE TABLE')).length, 3, 'schema is created once');

  // A throwing body writes nothing and is not retried.
  const jobsBefore = db.tables.hm_mf_jobs!.get(b.id)!.version;
  await assert.rejects(() => store.approveTraining(b.id, '0'.repeat(64), 'bad'), /does not match/);
  assert.equal(db.tables.hm_mf_jobs!.get(b.id)!.version, jobsBefore);
});

test('two concurrent approvals cannot both pass the central cost cap on DSQL (write-skew guard)', async () => {
  const db = new FakeDsql();
  const store = new ModelFactoryStore(makeRepository(db), { globalBudgetCapMicros: 500_000 });
  const a = await store.create(jobInput('run-a', 400_000));
  const b = await store.create(jobInput('run-b', 400_000));

  const results = await Promise.allSettled([
    store.approveTraining(a.id, a.approvalFingerprint, 'ok'),
    store.approveTraining(b.id, b.approvalFingerprint, 'ok'),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.match(String(rejected.reason), /Central cost cap exceeded/);
  assert.ok(db.conflicts >= 1, 'the losing approval must have hit an optimistic concurrency conflict');
  const ledger = await store.ledger();
  assert.equal(ledger.totalReservedMicros, 400_000);
  assert.equal(ledger.activeReservations, 1);

  // Control case: on a database that never reports a conflict, the same two approvals both succeed and
  // the reservations exceed the cap. This shows the result above depends on conflict detection.
  const lossy = new FakeDsql();
  lossy.detectConflicts = false;
  const unguarded = new ModelFactoryStore(makeRepository(lossy), { globalBudgetCapMicros: 500_000 });
  const c = await unguarded.create(jobInput('run-c', 400_000));
  const d = await unguarded.create(jobInput('run-d', 400_000));
  const both = await Promise.allSettled([
    unguarded.approveTraining(c.id, c.approvalFingerprint, 'ok'),
    unguarded.approveTraining(d.id, d.approvalFingerprint, 'ok'),
  ]);
  assert.deepEqual(both.map((r) => r.status), ['fulfilled', 'fulfilled']);
  assert.equal((await unguarded.ledger()).totalReservedMicros, 800_000);
});

test('DSQL repository retries retryable commit errors and surfaces others', async () => {
  const db = new FakeDsql();
  const store = new ModelFactoryStore(makeRepository(db), {});
  await store.create(jobInput('run-warmup', 1_000));
  db.failNextCommitWith = '40001';
  const created = await store.create(jobInput('run-retry', 1_000));
  assert.equal((await store.events(created.id)).length, 1, 'the retried body leaves exactly one event');
  db.failNextCommitWith = '57014';
  await assert.rejects(() => store.create(jobInput('run-fatal', 1_000)), /injected commit failure/);
  assert.equal((await store.list()).length, 2);
});

test('importModelFactoryHistoryIfEmpty copies the SQLite ledger once and never overwrites an existing DSQL ledger', async () => {
  const sqlite = new SqliteModelFactoryRepository(':memory:');
  const local = new ModelFactoryStore(sqlite, { globalBudgetCapMicros: 1_000_000 });
  const a = await local.create(jobInput('run-a', 100_000));
  const b = await local.create(jobInput('run-b', 200_000));
  await local.approveTraining(b.id, b.approvalFingerprint, 'ok');

  const db = new FakeDsql();
  const target = makeRepository(db);
  assert.equal(await importModelFactoryHistoryIfEmpty(sqlite, target), 2);
  const moved = new ModelFactoryStore(target, { globalBudgetCapMicros: 1_000_000 });
  assert.deepEqual((await moved.list()).map((j) => j.id), (await local.list()).map((j) => j.id));
  assert.equal((await moved.ledger()).totalReservedMicros, 200_000);
  assert.deepEqual((await moved.events()).map((e) => e.type), (await local.events()).map((e) => e.type));
  assert.equal((await moved.get(a.id)).status, 'awaiting_training_approval');

  // Second import is a no-op, even when the local file has changed since.
  await local.create(jobInput('run-c', 100_000));
  assert.equal(await importModelFactoryHistoryIfEmpty(sqlite, target), 0);
  assert.equal((await moved.list()).length, 2);
  assert.equal(await importModelFactoryHistoryIfEmpty(new SqliteModelFactoryRepository(':memory:'), makeRepository(new FakeDsql())), 0);
  await local.close();
});
