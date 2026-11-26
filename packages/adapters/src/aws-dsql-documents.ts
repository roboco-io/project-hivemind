import { Pool } from 'pg';
import {
  newDocumentTxState,
  type DocumentRepository,
  type DocumentTxState,
} from '../../core/src/document-repository.js';
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

export interface DsqlDocumentRepositoryOptions extends AwsDsqlStorageOptions {
  /** Injected pool for tests. When set, no network connection or IAM token is created. */
  pool?: DsqlPoolLike;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Table name prefix. A live proof uses its own prefix so that its test documents never mix with the
   * real ones.
   */
  tablePrefix?: string;
}

/** Fixed per-store settings of a DSQL document repository. */
export interface DsqlDocumentTables<TEventDraft> {
  /** Default table prefix of the store, for example `hm_mf`. `dropTables` refuses this prefix. */
  defaultPrefix: string;
  /** Name of the events-table column that holds the owning document id. */
  eventOwnerColumn: string;
  eventOwnerId: (event: TEventDraft) => string;
}

// Aurora DSQL has no FOREIGN KEY, SERIAL or trigger, and needs one DDL statement per transaction.
/** DDL of one document store's three tables. One statement per transaction on Aurora DSQL. */
export function documentSchemaStatements(prefix: string, eventOwnerColumn: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${prefix}_jobs (
    id VARCHAR(128) PRIMARY KEY,
    data TEXT NOT NULL,
    write_seq BIGINT NOT NULL
  )`,
    `CREATE TABLE IF NOT EXISTS ${prefix}_events (
    sequence BIGINT PRIMARY KEY,
    ${eventOwnerColumn} VARCHAR(128) NOT NULL,
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
 * Amazon Aurora DSQL repository for a document store (documents plus an append-only event log).
 *
 * Every mutating transaction updates the single `<prefix>_meta` sequence row. DSQL detects conflicts only
 * on rows a transaction WRITES. Without the shared row, two concurrent transactions could each read the same
 * state, write different document rows, and both commit, even when a rule over all documents (the Model
 * Factory central cost cap) allows only one of them. With it, one of them fails with an optimistic
 * concurrency conflict, and its body is re-run on the new state.
 */
export class DsqlDocumentRepository<TDoc extends { id: string }, TEventDraft> implements DocumentRepository<TDoc, TEventDraft> {
  readonly storageBackend = 'aurora-dsql' as const;
  private readonly pool: DsqlPoolLike;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly t: string;
  private readonly manageSchema: boolean;
  private schemaReady: Promise<void> | null = null;

  constructor(
    options: DsqlDocumentRepositoryOptions,
    private readonly tables: DsqlDocumentTables<TEventDraft>,
  ) {
    assertAwsRegion(options.region, options.allowedRegions);
    this.t = options.tablePrefix ?? tables.defaultPrefix;
    if (!/^[a-z][a-z0-9_]{1,24}$/.test(tables.eventOwnerColumn)) throw new Error('Invalid DSQL event owner column');
    // The prefix is interpolated into SQL identifiers, so it is restricted to a fixed safe alphabet.
    if (!/^[a-z][a-z0-9_]{1,24}$/.test(this.t)) throw new Error('Invalid DSQL table prefix');
    this.maxRetries = options.maxRetries ?? 5;
    this.manageSchema = options.manageSchema ?? true;
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
    if (!this.manageSchema) return;
    if (!this.schemaReady) {
      this.schemaReady = (async () => {
        for (const ddl of documentSchemaStatements(this.t, this.tables.eventOwnerColumn)) {
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

  private async readDocs(client: DsqlClientLike): Promise<TDoc[]> {
    const res = await client.query(`SELECT data FROM ${this.t}_jobs ORDER BY write_seq DESC, id DESC`);
    return res.rows.map((row) => JSON.parse(String(row.data)) as TDoc);
  }

  async transaction<T>(fn: (state: DocumentTxState<TDoc, TEventDraft>) => T): Promise<T> {
    await this.initSchema();
    let attempt = 0;
    while (true) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const seqRes = await client.query(`SELECT value FROM ${this.t}_meta WHERE id = $1`, [SEQUENCE_ROW]);
        let seq = seqRes.rows[0] ? Number(seqRes.rows[0].value) : 0;
        if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('Corrupt DSQL document write sequence');
        const state = newDocumentTxState<TDoc, TEventDraft>(await this.readDocs(client));
        const result = fn(state);

        if (state.dirtyIds.size > 0 || state.newEvents.length > 0) {
          for (const id of state.dirtyIds) {
            const doc = state.docs.get(id);
            if (!doc) continue;
            seq += 1;
            await client.query(
              `INSERT INTO ${this.t}_jobs (id, data, write_seq) VALUES ($1, $2, $3)
               ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, write_seq = EXCLUDED.write_seq`,
              [id, JSON.stringify(doc), seq],
            );
          }
          for (const event of state.newEvents) {
            seq += 1;
            await client.query(`INSERT INTO ${this.t}_events (sequence, ${this.tables.eventOwnerColumn}, data) VALUES ($1, $2, $3)`, [
              seq,
              this.tables.eventOwnerId(event),
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

  listDocs(): Promise<TDoc[]> {
    return this.read((client) => this.readDocs(client));
  }

  getDoc(id: string): Promise<TDoc | null> {
    return this.read(async (client) => {
      const res = await client.query(`SELECT data FROM ${this.t}_jobs WHERE id = $1`, [id]);
      return res.rows[0] ? (JSON.parse(String(res.rows[0].data)) as TDoc) : null;
    });
  }

  listEvents(limit: number): Promise<(TEventDraft & { sequence: number })[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 1000);
    return this.read(async (client) => {
      const res = await client.query(`SELECT sequence, data FROM ${this.t}_events ORDER BY sequence DESC LIMIT $1`, [safeLimit]);
      return res.rows.map((row) => ({
        sequence: Number(row.sequence),
        ...(JSON.parse(String(row.data)) as TEventDraft),
      }));
    });
  }

  /** Drops this repository's three tables. Only a live proof with its own table prefix calls this. */
  async dropTables(): Promise<void> {
    if (this.t === this.tables.defaultPrefix) throw new Error('Refusing to drop the production tables of this store');
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
