import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { CreateModelFactoryJob, ModelFactoryEvent, ModelFactoryJob } from '../packages/contracts/src/model-factory.js';
import { ModelFactoryStore } from '../packages/core/src/model-factory.js';
import {
  newModelFactoryTxState,
  type ModelFactoryRepository,
  type ModelFactoryTxState,
} from '../packages/core/src/model-factory-repository.js';

function jobInput(prefix: string, maxTotalCostMicros = 400_000): CreateModelFactoryJob {
  return {
    title: 'Repository port test',
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

/**
 * In-memory repository that behaves like a backend with optimistic concurrency control: it runs every
 * transaction body `attempts` times and keeps only the last run, as a retry after a conflict would.
 */
class RetryingMemoryRepository implements ModelFactoryRepository {
  readonly storageBackend = 'aurora-dsql' as const;
  jobs = new Map<string, ModelFactoryJob>();
  events: ModelFactoryEvent[] = [];
  bodyRuns = 0;
  constructor(private readonly attempts: number) {}

  async transaction<T>(fn: (state: ModelFactoryTxState) => T): Promise<T> {
    let state!: ModelFactoryTxState;
    let result!: T;
    for (let i = 0; i < this.attempts; i += 1) {
      state = newModelFactoryTxState([...this.jobs.values()].map((job) => structuredClone(job)));
      this.bodyRuns += 1;
      result = fn(state);
    }
    for (const id of state.dirtyJobIds) this.jobs.set(id, structuredClone(state.jobs.get(id)!));
    for (const event of state.newEvents) this.events.push({ sequence: this.events.length + 1, ...event });
    return result;
  }
  async listJobs() {
    return [...this.jobs.values()].reverse().map((job) => structuredClone(job));
  }
  async getJob(id: string) {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : null;
  }
  async listEvents(limit: number) {
    return [...this.events].reverse().slice(0, limit);
  }
  async close() {}
}

test('ModelFactoryStore runs unchanged on a non-SQLite repository and stays correct when a transaction body is re-run', async () => {
  const repository = new RetryingMemoryRepository(3);
  const store = new ModelFactoryStore(repository, { globalBudgetCapMicros: 500_000 });
  assert.equal(store.storageBackend, 'aurora-dsql');

  const job = await store.create(jobInput('run-a'));
  assert.equal(repository.jobs.size, 1);
  assert.equal(repository.events.length, 1, 'a re-run body must not duplicate events');

  const approved = await store.approveTraining(job.id, job.approvalFingerprint, 'ok');
  assert.equal(approved.status, 'training_queued');
  assert.equal((await store.ledger()).totalReservedMicros, 400_000);

  // The cost cap is evaluated against every job on each run of the body.
  const second = await store.create(jobInput('run-b'));
  await assert.rejects(() => store.approveTraining(second.id, second.approvalFingerprint, 'ok'), /Central cost cap exceeded/);
  const rejected = await store.get(second.id);
  assert.equal(rejected.status, 'awaiting_training_approval');
  assert.equal(rejected.diagnostics.length, 1, 'the rejection diagnostic is stored once, not once per run');
  assert.equal((await store.events(second.id)).filter((e) => e.type === 'model_factory.cost_cap_rejected').length, 1);

  // A body that throws writes nothing.
  const before = repository.events.length;
  await assert.rejects(() => store.approveTraining(job.id, '0'.repeat(64), 'ok'), /Cannot approve training/);
  await assert.rejects(() => store.get('mf-00000000-0000-4000-8000-000000000000'), /not found/);
  assert.equal(repository.events.length, before);
  assert.ok(repository.bodyRuns >= 12);
});

test('SQLite repository persists across reopen, rolls back a throwing transaction, and reads the pre-port table layout', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hivemind-mf-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'nested', 'mf.sqlite');

  const first = new ModelFactoryStore(path);
  assert.equal(first.storageBackend, 'sqlite');
  const job = await first.create(jobInput('run-persist'));
  await assert.rejects(() => first.approveTraining(job.id, 'f'.repeat(64), 'wrong fingerprint'), /does not match/);
  assert.equal((await first.events(job.id)).length, 1);
  await first.approveTraining(job.id, job.approvalFingerprint, 'ok');
  await first.close();

  const reopened = new ModelFactoryStore(path);
  const loaded = await reopened.get(job.id);
  assert.equal(loaded.status, 'training_queued');
  assert.deepEqual(
    (await reopened.events(job.id)).map((e) => e.type),
    ['model_factory.training_approved', 'model_factory.created'],
  );
  assert.equal((await reopened.list()).length, 1);
  await reopened.close();

  // A database written by the store before the repository port existed has exactly these two tables.
  const legacyPath = join(dir, 'legacy.sqlite');
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`CREATE TABLE model_factory_jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE model_factory_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);`);
  legacy.prepare('INSERT INTO model_factory_jobs (id, data) VALUES (?, ?)').run(loaded.id, JSON.stringify(loaded));
  legacy
    .prepare('INSERT INTO model_factory_events (data) VALUES (?)')
    .run(JSON.stringify({ jobId: loaded.id, type: 'model_factory.created', at: loaded.createdAt, data: {} }));
  legacy.close();
  const fromLegacy = new ModelFactoryStore(legacyPath);
  assert.equal((await fromLegacy.get(loaded.id)).cost.reservedMicros, 400_000);
  assert.equal((await fromLegacy.ledger()).activeReservations, 1);
  assert.equal((await fromLegacy.events()).length, 1);
  await fromLegacy.close();
});

test('buildApp serves the Model Factory API from an injected repository and reports its backend', async () => {
  const { buildApp } = await import('../apps/control-plane/src/app.js');
  const repository = new RetryingMemoryRepository(1);
  const app = buildApp({ operatorToken: 'op-repo-token', workerToken: 'wk-repo-token', modelFactoryRepository: repository });
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/model-factory/jobs',
      headers: { authorization: 'Bearer op-repo-token' },
      payload: jobInput('run-api'),
    });
    assert.equal(created.statusCode, 201);
    assert.equal(repository.jobs.size, 1, 'the job is written to the injected repository, not to SQLite');
    const listed = await app.inject({ method: 'GET', url: '/api/model-factory/jobs', headers: { authorization: 'Bearer op-repo-token' } });
    assert.equal(listed.json().storageBackend, 'aurora-dsql');
    assert.equal(listed.json().jobs[0].id, created.json().id);
  } finally {
    await app.close();
  }
});
