import { Pool } from 'pg';
import type { ModelFactoryEvent, ModelFactoryJob } from '../../contracts/src/model-factory.js';
import {
  newModelFactoryTxState,
  type ModelFactoryEventDraft,
  type ModelFactoryRepository,
  type ModelFactoryTxState,
} from '../../core/src/model-factory-repository.js';
import { assertAwsRegion } from './autonomous-aws-region.js';
import { generateDsqlAuthToken, type AwsDsqlStorageOptions } from './aws-dsql.js';

/** The part of a pg client this repository uses. Tests inject a fake; production uses `pg.Pool`. */
export interface DsqlClientLike {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}
export interface DsqlPoolLike {
  connect(): Promise<DsqlClientLike>;
  end(): Promise<void>;
}

export interface DsqlModelFactoryRepositoryOptions extends AwsDsqlStorageOptions {
  /** Injected pool for tests. When set, no network connection or IAM token is created. */
  pool?: DsqlPoolLike;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Table name prefix (default `hm_mf`). A live proof uses its own prefix so that its test jobs never
   * count against the real ledger and budget.
   */
  tablePrefix?: string;
}

// Aurora DSQL has no FOREIGN KEY, SERIAL or trigger, and needs one DDL statement per transaction.
function schemaStatements(prefix: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${prefix}_jobs (
    id VARCHAR(128) PRIMARY KEY,
    data TEXT NOT NULL,
    write_seq BIGINT NOT NULL
  )`,
    `CREATE TABLE IF NOT EXISTS ${prefix}_events (
    sequence BIGINT PRIMARY KEY,
    job_id VARCHAR(128) NOT NULL,
    data TEXT NOT NULL
  )`,
    `CREATE TABLE IF NOT EXISTS ${prefix}_meta (
    id VARCHAR(32) PRIMARY KEY,
    value BIGINT NOT NULL
  )`,
  ];
}
const SEQUENCE_ROW = 'write_seq';

function isRetryable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  // 40001 serialization failure, OC000/OC001 DSQL optimistic concurrency conflicts, 40P01 deadlock,
  // 23505 two first writers inserting the sequence row at the same time.
  return code === '40001' || code === 'OC000' || code === 'OC001' || code === '40P01' || code === '23505';
}

/**
 * Amazon Aurora DSQL repository for ModelFactoryStore.
 *
 * Every mutating transaction updates the single `hm_mf_meta` sequence row. DSQL detects conflicts only on
 * rows a transaction WRITES. Without the shared row, two concurrent training approvals could each read the
 * same remaining budget, write different job rows, and both commit past the central cost cap. With it, one
 * of them fails with an optimistic concurrency conflict, and its body is re-run on the new state.
 */
export class DsqlModelFactoryRepository implements ModelFactoryRepository {
  readonly storageBackend = 'aurora-dsql' as const;
  private readonly pool: DsqlPoolLike;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly t: string;
  private schemaReady: Promise<void> | null = null;

  constructor(options: DsqlModelFactoryRepositoryOptions) {
    assertAwsRegion(options.region, options.allowedRegions);
    this.t = options.tablePrefix ?? 'hm_mf';
    // The prefix is interpolated into SQL identifiers, so it is restricted to a fixed safe alphabet.
    if (!/^[a-z][a-z0-9_]{1,24}$/.test(this.t)) throw new Error('Invalid DSQL table prefix');
    this.maxRetries = options.maxRetries ?? 5;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    if (options.pool) {
      this.pool = options.pool;
      return;
    }
    const host = options.endpoint.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    const user = options.user ?? 'admin';
    this.pool = new Pool({
      host,
      port: 5432,
      database: options.database ?? 'postgres',
      user,
      ssl: { rejectUnauthorized: true },
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
      password: async () =>
        generateDsqlAuthToken({
          endpoint: host,
          region: options.region,
          credentials: await options.credentials(),
          action: user === 'admin' ? 'DbConnectAdmin' : 'DbConnect',
        }),
    }) as unknown as DsqlPoolLike;
  }

  async initSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = (async () => {
        for (const ddl of schemaStatements(this.t)) {
          const client = await this.pool.connect();
          try {
            await client.query('BEGIN');
            await client.query(ddl);
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
          } finally {
            client.release();
          }
        }
      })().catch((error) => {
        this.schemaReady = null;
        throw error;
      });
    }
    return this.schemaReady;
  }

  private async readJobs(client: DsqlClientLike): Promise<ModelFactoryJob[]> {
    const res = await client.query(`SELECT data FROM ${this.t}_jobs ORDER BY write_seq DESC, id DESC`);
    return res.rows.map((row) => JSON.parse(String(row.data)) as ModelFactoryJob);
  }

  async transaction<T>(fn: (state: ModelFactoryTxState) => T): Promise<T> {
    await this.initSchema();
    let attempt = 0;
    while (true) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const seqRes = await client.query(`SELECT value FROM ${this.t}_meta WHERE id = $1`, [SEQUENCE_ROW]);
        let seq = seqRes.rows[0] ? Number(seqRes.rows[0].value) : 0;
        if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('Corrupt Model Factory write sequence');
        const state = newModelFactoryTxState(await this.readJobs(client));
        const result = fn(state);

        if (state.dirtyJobIds.size > 0 || state.newEvents.length > 0) {
          for (const id of state.dirtyJobIds) {
            const job = state.jobs.get(id);
            if (!job) continue;
            seq += 1;
            await client.query(
              `INSERT INTO ${this.t}_jobs (id, data, write_seq) VALUES ($1, $2, $3)
               ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, write_seq = EXCLUDED.write_seq`,
              [id, JSON.stringify(job), seq],
            );
          }
          for (const event of state.newEvents) {
            seq += 1;
            await client.query(`INSERT INTO ${this.t}_events (sequence, job_id, data) VALUES ($1, $2, $3)`, [
              seq,
              event.jobId,
              JSON.stringify(event),
            ]);
          }
          await client.query(
            `INSERT INTO ${this.t}_meta (id, value) VALUES ($1, $2)
             ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value`,
            [SEQUENCE_ROW, seq],
          );
        }
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (isRetryable(error) && attempt < this.maxRetries) {
          attempt += 1;
          await this.sleep(40 * 2 ** (attempt - 1));
          continue;
        }
        throw error;
      } finally {
        client.release();
      }
    }
  }

  private async read<T>(fn: (client: DsqlClientLike) => Promise<T>): Promise<T> {
    await this.initSchema();
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  listJobs(): Promise<ModelFactoryJob[]> {
    return this.read((client) => this.readJobs(client));
  }

  getJob(id: string): Promise<ModelFactoryJob | null> {
    return this.read(async (client) => {
      const res = await client.query(`SELECT data FROM ${this.t}_jobs WHERE id = $1`, [id]);
      return res.rows[0] ? (JSON.parse(String(res.rows[0].data)) as ModelFactoryJob) : null;
    });
  }

  listEvents(limit: number): Promise<ModelFactoryEvent[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 1000);
    return this.read(async (client) => {
      const res = await client.query(`SELECT sequence, data FROM ${this.t}_events ORDER BY sequence DESC LIMIT $1`, [safeLimit]);
      return res.rows.map((row) => ({
        sequence: Number(row.sequence),
        ...(JSON.parse(String(row.data)) as ModelFactoryEventDraft),
      }));
    });
  }

  /** Drops this repository's three tables. Only a live proof with its own table prefix calls this. */
  async dropTables(): Promise<void> {
    if (this.t === 'hm_mf') throw new Error('Refusing to drop the production Model Factory tables');
    for (const table of ['jobs', 'events', 'meta']) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`DROP TABLE IF EXISTS ${this.t}_${table}`);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }
    this.schemaReady = null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Copies every job and event of `source` into `target` in one transaction, but only when `target` holds no
 * job yet. Used once when the Control Plane moves from the EFS SQLite file to Aurora DSQL, so the ledger
 * (reservations and settlements) is not reset by the move. Returns the number of jobs copied.
 */
export async function importModelFactoryHistoryIfEmpty(
  source: ModelFactoryRepository,
  target: ModelFactoryRepository,
): Promise<number> {
  const jobs = (await source.listJobs()).reverse(); // oldest write first, so listing order is kept
  if (jobs.length === 0) return 0;
  const events = (await source.listEvents(1000)).reverse();
  return target.transaction((state) => {
    if (state.jobs.size > 0) return 0;
    for (const job of jobs) {
      state.jobs.set(job.id, job);
      state.dirtyJobIds.add(job.id);
    }
    for (const event of events) {
      state.newEvents.push({ jobId: event.jobId, type: event.type, at: event.at, data: event.data } as ModelFactoryEventDraft);
    }
    return jobs.length;
  });
}
