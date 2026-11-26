import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ModelFactoryEvent, ModelFactoryJob } from '../../contracts/src/model-factory.js';

export type ModelFactoryEventDraft = Omit<ModelFactoryEvent, 'sequence'>;

/**
 * In-memory view of the whole job set inside one repository transaction.
 * The store's domain logic reads and changes this view synchronously; the repository then writes the
 * dirty jobs and the new events and commits. Loading every job is deliberate: the central cost cap is a
 * sum over all jobs, so every mutating transaction must see all of them.
 */
export interface ModelFactoryTxState {
  /** Jobs keyed by id, in the repository listing order. */
  jobs: Map<string, ModelFactoryJob>;
  dirtyJobIds: Set<string>;
  newEvents: ModelFactoryEventDraft[];
}

/**
 * Storage port of ModelFactoryStore. Implementations: local SQLite (this file) and Amazon Aurora DSQL
 * (packages/adapters). The store never issues SQL itself.
 */
export interface ModelFactoryRepository {
  readonly storageBackend: 'sqlite' | 'aurora-dsql';
  /**
   * Runs `fn` atomically. `fn` is synchronous and must have no side effect outside `state`, because a
   * backend with optimistic concurrency control re-runs it on a serialization conflict. When `fn` throws,
   * nothing is written.
   */
  transaction<T>(fn: (state: ModelFactoryTxState) => T): Promise<T>;
  /** Jobs in listing order (most recently written first). */
  listJobs(): Promise<ModelFactoryJob[]>;
  getJob(id: string): Promise<ModelFactoryJob | null>;
  /** The newest `limit` events, newest first. */
  listEvents(limit: number): Promise<ModelFactoryEvent[]>;
  close(): Promise<void>;
}

export function newModelFactoryTxState(jobs: ModelFactoryJob[]): ModelFactoryTxState {
  return { jobs: new Map(jobs.map((job) => [job.id, job])), dirtyJobIds: new Set(), newEvents: [] };
}

/**
 * Local SQLite repository. The table layout is unchanged from the layout ModelFactoryStore used before the
 * port existed, so an existing database file keeps working.
 */
export class SqliteModelFactoryRepository implements ModelFactoryRepository {
  readonly storageBackend = 'sqlite' as const;
  private readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS model_factory_jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_factory_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);`);
  }

  private readJobs(): ModelFactoryJob[] {
    return this.db
      .prepare('SELECT data FROM model_factory_jobs ORDER BY rowid DESC')
      .all()
      .map((row) => JSON.parse(row.data as string) as ModelFactoryJob);
  }

  // The whole body is synchronous, so no other transaction of this process can interleave with it.
  async transaction<T>(fn: (state: ModelFactoryTxState) => T): Promise<T> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const state = newModelFactoryTxState(this.readJobs());
      const result = fn(state);
      const saveJob = this.db.prepare('INSERT OR REPLACE INTO model_factory_jobs (id, data) VALUES (?, ?)');
      for (const id of state.dirtyJobIds) {
        const job = state.jobs.get(id);
        if (job) saveJob.run(id, JSON.stringify(job));
      }
      const saveEvent = this.db.prepare('INSERT INTO model_factory_events (data) VALUES (?)');
      for (const event of state.newEvents) saveEvent.run(JSON.stringify(event));
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async listJobs(): Promise<ModelFactoryJob[]> {
    return this.readJobs();
  }

  async getJob(id: string): Promise<ModelFactoryJob | null> {
    const row = this.db.prepare('SELECT data FROM model_factory_jobs WHERE id=?').get(id);
    return row ? (JSON.parse(row.data as string) as ModelFactoryJob) : null;
  }

  async listEvents(limit: number): Promise<ModelFactoryEvent[]> {
    return this.db
      .prepare('SELECT sequence, data FROM model_factory_events ORDER BY sequence DESC LIMIT ?')
      .all(limit)
      .map((row) => ({
        sequence: row.sequence as number,
        ...(JSON.parse(row.data as string) as ModelFactoryEventDraft),
      }));
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
