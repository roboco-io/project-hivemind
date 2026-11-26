import { createHash, createHmac } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type {
  CollabMessage,
  CollabSession,
  CollabSubtask,
  CollabWorkLog,
} from '../../contracts/src/agent-collab.js';
import type { CollaborationStoragePort } from '../../core/src/agent-collab.js';
import { assertAwsRegion } from './autonomous-aws-region.js';
import type { AwsEcsCredentials } from './aws-ecs-driver.js';

export interface GenerateDsqlAuthTokenInput {
  endpoint: string;
  region: string;
  credentials: AwsEcsCredentials;
  action?: 'DbConnectAdmin' | 'DbConnect';
  expiresInSeconds?: number;
  nowMs?: number;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function awsUriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Generates an IAM SigV4 presigned authentication token for Amazon Aurora DSQL
 * matching `aws dsql generate-db-connect-admin-auth-token` with zero AWS SDK dependencies.
 */
export function generateDsqlAuthToken(input: GenerateDsqlAuthTokenInput): string {
  const host = input.endpoint.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!/^[a-z0-9.-]+\.dsql\.[a-z0-9-]+\.on\.aws$/i.test(host)) {
    throw new Error(`Invalid Aurora DSQL endpoint hostname: ${input.endpoint}`);
  }
  assertAwsRegion(input.region);
  const action = input.action ?? 'DbConnectAdmin';
  const expires = input.expiresInSeconds ?? 900;
  if (!Number.isSafeInteger(expires) || expires < 1 || expires > 604_800) {
    throw new Error('Invalid DSQL token expiresInSeconds');
  }
  const nowMs = input.nowMs ?? Date.now();
  const iso = new Date(nowMs).toISOString().replace(/[:-]|\.\d{3}/g, '');
  const amzDate = `${iso.slice(0, 15)}Z`;
  const dateStamp = iso.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/dsql/aws4_request`;

  const queryParams: [string, string][] = [
    ['Action', action],
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${input.credentials.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expires)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  if (input.credentials.sessionToken) {
    queryParams.push(['X-Amz-Security-Token', input.credentials.sessionToken]);
  }
  queryParams.sort(([a], [b]) => a.localeCompare(b));

  const canonicalQuery = queryParams.map(([k, v]) => `${awsUriEncode(k)}=${awsUriEncode(v)}`).join('&');
  const canonicalHeaders = `host:${host}\n`;
  const payloadHash = sha256Hex('');
  const canonicalRequest = ['GET', '/', canonicalQuery, canonicalHeaders, 'host', payloadHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${input.credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, 'dsql');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return `${host}/?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export interface AwsDsqlStorageOptions {
  endpoint: string;
  region: string;
  allowedRegions?: string[];
  database?: string;
  user?: string;
  credentials: () => Promise<AwsEcsCredentials> | AwsEcsCredentials;
  maxRetries?: number;
  /**
   * When false, the repository never issues DDL. A restricted database role cannot create tables, so an
   * operator creates them once with scripts/aws-dsql-apply-roles.ts. Default: true.
   */
  manageSchema?: boolean;
}

/** DDL of the collaboration tables. One statement per transaction on Aurora DSQL. */
export const DSQL_COLLAB_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS hm_collab_sessions (
    id VARCHAR(128) PRIMARY KEY,
    status VARCHAR(32) NOT NULL,
    data TEXT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS hm_collab_subtasks (
    id VARCHAR(128) PRIMARY KEY,
    session_id VARCHAR(128) NOT NULL,
    status VARCHAR(32) NOT NULL,
    data TEXT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS hm_collab_messages (
    id VARCHAR(128) PRIMARY KEY,
    session_id VARCHAR(128) NOT NULL,
    seq BIGINT NOT NULL,
    sender VARCHAR(128) NOT NULL,
    recipient VARCHAR(128),
    thread_id VARCHAR(128),
    data TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS hm_collab_work_logs (
    id VARCHAR(128) PRIMARY KEY,
    session_id VARCHAR(128) NOT NULL,
    subtask_id VARCHAR(128),
    agent_id VARCHAR(128) NOT NULL,
    data TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
];

function isRetryableDsqlError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  // 40001 = serialization_failure (OCC conflict), OC000/OC001 = DSQL optimistic concurrency codes
  return code === '40001' || code === 'OC000' || code === 'OC001' || code === '40P01';
}

export class DsqlCollaborationRepository implements CollaborationStoragePort {
  readonly backend = 'aurora-dsql' as const;
  private readonly pool: Pool;
  private readonly maxRetries: number;
  private readonly manageSchema: boolean;
  private schemaReady: Promise<void> | null = null;

  constructor(options: AwsDsqlStorageOptions) {
    assertAwsRegion(options.region, options.allowedRegions);
    const host = options.endpoint.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    this.maxRetries = options.maxRetries ?? 5;
    this.manageSchema = options.manageSchema ?? true;
    this.pool = new Pool({
      host,
      port: 5432,
      database: options.database ?? 'postgres',
      user: options.user ?? 'admin',
      ssl: { rejectUnauthorized: true },
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
      password: async () => {
        const creds = await options.credentials();
        return generateDsqlAuthToken({
          endpoint: host,
          region: options.region,
          credentials: creds,
          action: (options.user ?? 'admin') === 'admin' ? 'DbConnectAdmin' : 'DbConnect',
        });
      },
    });
  }

  async initSchema(): Promise<void> {
    if (!this.manageSchema) return;
    if (!this.schemaReady) {
      this.schemaReady = (async () => {
        // Aurora DSQL requires each DDL statement in its own transaction.
        for (const ddl of DSQL_COLLAB_SCHEMA_STATEMENTS) {
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
      })().catch((err) => {
        this.schemaReady = null;
        throw err;
      });
    }
    return this.schemaReady;
  }

  private async runTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.initSchema();
    let attempt = 0;
    while (true) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (isRetryableDsqlError(error) && attempt < this.maxRetries) {
          attempt += 1;
          await new Promise((r) => setTimeout(r, 40 * 2 ** (attempt - 1)));
          continue;
        }
        throw error;
      } finally {
        client.release();
      }
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async saveSession(session: CollabSession): Promise<void> {
    await this.runTx(async (client) => {
      await client.query(
        `INSERT INTO hm_collab_sessions (id, status, data, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
        [session.id, session.status, JSON.stringify(session), Date.parse(session.updatedAt)],
      );
    });
  }

  async getSession(id: string): Promise<CollabSession | null> {
    await this.initSchema();
    const res = await this.pool.query('SELECT data FROM hm_collab_sessions WHERE id = $1', [id]);
    if (!res.rows[0]) return null;
    return JSON.parse(String(res.rows[0].data)) as CollabSession;
  }

  async listSessions(): Promise<CollabSession[]> {
    await this.initSchema();
    const res = await this.pool.query('SELECT data FROM hm_collab_sessions ORDER BY updated_at DESC LIMIT 100');
    return res.rows.map((r) => JSON.parse(String(r.data)) as CollabSession);
  }

  async saveSubtask(subtask: CollabSubtask): Promise<void> {
    await this.runTx(async (client) => {
      await client.query(
        `INSERT INTO hm_collab_subtasks (id, session_id, status, data, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
        [subtask.id, subtask.sessionId, subtask.status, JSON.stringify(subtask), Date.parse(subtask.updatedAt)],
      );
    });
  }

  async getSubtask(id: string): Promise<CollabSubtask | null> {
    await this.initSchema();
    const res = await this.pool.query('SELECT data FROM hm_collab_subtasks WHERE id = $1', [id]);
    if (!res.rows[0]) return null;
    return JSON.parse(String(res.rows[0].data)) as CollabSubtask;
  }

  async listSubtasks(sessionId: string): Promise<CollabSubtask[]> {
    await this.initSchema();
    const res = await this.pool.query(
      'SELECT data FROM hm_collab_subtasks WHERE session_id = $1 ORDER BY updated_at ASC',
      [sessionId],
    );
    return res.rows.map((r) => JSON.parse(String(r.data)) as CollabSubtask);
  }

  async claimSubtaskAtomic(
    subtaskId: string,
    agentId: string,
    region: string | null,
    ecsTaskArn: string | null,
    nowIso: string,
  ): Promise<CollabSubtask | null> {
    return this.runTx(async (client) => {
      const currentRes = await client.query('SELECT data FROM hm_collab_subtasks WHERE id = $1', [subtaskId]);
      if (!currentRes.rows[0]) return null;
      const subtask = JSON.parse(String(currentRes.rows[0].data)) as CollabSubtask;
      if (subtask.status !== 'pending' && subtask.status !== 'queued') {
        return null;
      }
      if (subtask.dependsOn.length > 0) {
        const depsRes = await client.query(
          'SELECT id, status FROM hm_collab_subtasks WHERE session_id = $1',
          [subtask.sessionId],
        );
        const statusById = new Map(depsRes.rows.map((r) => [String(r.id), String(r.status)]));
        for (const depId of subtask.dependsOn) {
          if (statusById.get(depId) !== 'completed') {
            return null;
          }
        }
      }
      subtask.status = 'running';
      subtask.assignedAgentId = agentId;
      subtask.region = region;
      subtask.ecsTaskArn = ecsTaskArn;
      subtask.updatedAt = nowIso;
      await client.query(
        'UPDATE hm_collab_subtasks SET status = $2, data = $3, updated_at = $4 WHERE id = $1',
        [subtask.id, subtask.status, JSON.stringify(subtask), Date.parse(nowIso)],
      );
      return subtask;
    });
  }

  async appendMessage(
    input: Omit<CollabMessage, 'seq'>,
  ): Promise<CollabMessage> {
    return this.runTx(async (client) => {
      const maxRes = await client.query(
        'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM hm_collab_messages WHERE session_id = $1',
        [input.sessionId],
      );
      const nextSeq = Number(maxRes.rows[0]?.max_seq ?? 0) + 1;
      const message: CollabMessage = { ...input, seq: nextSeq };
      await client.query(
        `INSERT INTO hm_collab_messages (id, session_id, seq, sender, recipient, thread_id, data, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          message.id,
          message.sessionId,
          message.seq,
          message.sender,
          message.recipient,
          message.threadId,
          JSON.stringify(message),
          Date.parse(message.createdAt),
        ],
      );
      return message;
    });
  }

  async listMessages(
    sessionId: string,
    query?: { afterSeq?: number; recipient?: string; threadId?: string; limit?: number },
  ): Promise<CollabMessage[]> {
    await this.initSchema();
    const afterSeq = query?.afterSeq ?? 0;
    const limit = Math.min(Math.max(query?.limit ?? 100, 1), 500);
    const params: unknown[] = [sessionId, afterSeq];
    const clauses = ['session_id = $1', 'seq > $2'];
    if (query?.recipient) {
      params.push(query.recipient);
      clauses.push(`(recipient IS NULL OR recipient = $${params.length})`);
    }
    if (query?.threadId) {
      params.push(query.threadId);
      clauses.push(`thread_id = $${params.length}`);
    }
    params.push(limit);
    const res = await this.pool.query(
      `SELECT data FROM hm_collab_messages WHERE ${clauses.join(' AND ')} ORDER BY seq ASC LIMIT $${params.length}`,
      params,
    );
    return res.rows.map((r) => JSON.parse(String(r.data)) as CollabMessage);
  }

  async appendWorkLog(log: CollabWorkLog): Promise<void> {
    await this.runTx(async (client) => {
      await client.query(
        `INSERT INTO hm_collab_work_logs (id, session_id, subtask_id, agent_id, data, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [log.id, log.sessionId, log.subtaskId, log.agentId, JSON.stringify(log), Date.parse(log.createdAt)],
      );
    });
  }

  async listWorkLogs(sessionId: string, subtaskId?: string): Promise<CollabWorkLog[]> {
    await this.initSchema();
    const res = subtaskId
      ? await this.pool.query(
          'SELECT data FROM hm_collab_work_logs WHERE session_id = $1 AND subtask_id = $2 ORDER BY created_at ASC LIMIT 500',
          [sessionId, subtaskId],
        )
      : await this.pool.query(
          'SELECT data FROM hm_collab_work_logs WHERE session_id = $1 ORDER BY created_at ASC LIMIT 500',
          [sessionId],
        );
    return res.rows.map((r) => JSON.parse(String(r.data)) as CollabWorkLog);
  }
}
