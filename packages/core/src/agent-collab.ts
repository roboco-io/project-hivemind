import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AppendCollabWorkLog,
  CollabMessage,
  CollabMessageKind,
  CollabOrchestratorRun,
  CollabProvider,
  CollabSession,
  CollabSessionSnapshot,
  CollabSubtask,
  CollabWorkLog,
  CollabWorkLogKind,
  CreateCollabSession,
  CreateCollabSubtask,
  PostCollabMessage,
} from '../../contracts/src/agent-collab.js';
import { DomainError, text } from './store.js';

export interface CollaborationStoragePort {
  readonly backend: 'aurora-dsql' | 'sqlite';
  saveSession(session: CollabSession): Promise<void>;
  getSession(id: string): Promise<CollabSession | null>;
  listSessions(): Promise<CollabSession[]>;
  saveSubtask(subtask: CollabSubtask): Promise<void>;
  getSubtask(id: string): Promise<CollabSubtask | null>;
  listSubtasks(sessionId: string): Promise<CollabSubtask[]>;
  claimSubtaskAtomic(
    subtaskId: string,
    agentId: string,
    region: string | null,
    ecsTaskArn: string | null,
    nowIso: string,
  ): Promise<CollabSubtask | null>;
  appendMessage(input: Omit<CollabMessage, 'seq'>): Promise<CollabMessage>;
  listMessages(
    sessionId: string,
    query?: { afterSeq?: number; recipient?: string; threadId?: string; limit?: number },
  ): Promise<CollabMessage[]>;
  appendWorkLog(log: CollabWorkLog): Promise<void>;
  listWorkLogs(sessionId: string, subtaskId?: string): Promise<CollabWorkLog[]>;
  close(): Promise<void> | void;
}

const DEFAULT_FIVE_REGIONS = ['ap-northeast-2', 'us-east-2', 'us-east-1', 'us-west-2', 'ap-northeast-1'];
const MESSAGE_KINDS = new Set<CollabMessageKind>(['chat', 'handoff', 'question', 'blocker', 'decision', 'artifact']);
const WORKLOG_KINDS = new Set<CollabWorkLogKind>(['progress', 'checkpoint', 'artifact', 'error']);
const REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const HEX40 = /^[a-f0-9]{40}$/i;
const HEX64 = /^[a-f0-9]{64}$/i;

export class SqliteCollaborationRepository implements CollaborationStoragePort {
  readonly backend = 'sqlite' as const;
  private readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS hm_collab_sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS hm_collab_subtasks (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS hm_collab_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, sender TEXT NOT NULL, recipient TEXT, thread_id TEXT, data TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS hm_collab_work_logs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, subtask_id TEXT, agent_id TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL);`);
  }

  close(): void {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async saveSession(session: CollabSession): Promise<void> {
    this.db
      .prepare('INSERT OR REPLACE INTO hm_collab_sessions (id, status, data, updated_at) VALUES (?, ?, ?, ?)')
      .run(session.id, session.status, JSON.stringify(session), Date.parse(session.updatedAt));
  }

  async getSession(id: string): Promise<CollabSession | null> {
    const row = this.db.prepare('SELECT data FROM hm_collab_sessions WHERE id = ?').get(id);
    return row ? (JSON.parse(row.data as string) as CollabSession) : null;
  }

  async listSessions(): Promise<CollabSession[]> {
    return this.db
      .prepare('SELECT data FROM hm_collab_sessions ORDER BY updated_at DESC LIMIT 100')
      .all()
      .map((r) => JSON.parse(r.data as string) as CollabSession);
  }

  async saveSubtask(subtask: CollabSubtask): Promise<void> {
    this.db
      .prepare('INSERT OR REPLACE INTO hm_collab_subtasks (id, session_id, status, data, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(subtask.id, subtask.sessionId, subtask.status, JSON.stringify(subtask), Date.parse(subtask.updatedAt));
  }

  async getSubtask(id: string): Promise<CollabSubtask | null> {
    const row = this.db.prepare('SELECT data FROM hm_collab_subtasks WHERE id = ?').get(id);
    return row ? (JSON.parse(row.data as string) as CollabSubtask) : null;
  }

  async listSubtasks(sessionId: string): Promise<CollabSubtask[]> {
    return this.db
      .prepare('SELECT data FROM hm_collab_subtasks WHERE session_id = ? ORDER BY updated_at ASC')
      .all(sessionId)
      .map((r) => JSON.parse(r.data as string) as CollabSubtask);
  }

  async claimSubtaskAtomic(
    subtaskId: string,
    agentId: string,
    region: string | null,
    ecsTaskArn: string | null,
    nowIso: string,
  ): Promise<CollabSubtask | null> {
    return this.tx(() => {
      const row = this.db.prepare('SELECT data FROM hm_collab_subtasks WHERE id = ?').get(subtaskId);
      if (!row) return null;
      const subtask = JSON.parse(row.data as string) as CollabSubtask;
      if (subtask.status !== 'pending' && subtask.status !== 'queued') return null;
      if (subtask.dependsOn.length > 0) {
        const siblings = this.db
          .prepare('SELECT id, status FROM hm_collab_subtasks WHERE session_id = ?')
          .all(subtask.sessionId);
        const byId = new Map(siblings.map((s) => [String(s.id), String(s.status)]));
        for (const depId of subtask.dependsOn) {
          if (byId.get(depId) !== 'completed') return null;
        }
      }
      subtask.status = 'running';
      subtask.assignedAgentId = agentId;
      subtask.region = region;
      subtask.ecsTaskArn = ecsTaskArn;
      subtask.updatedAt = nowIso;
      this.db
        .prepare('UPDATE hm_collab_subtasks SET status = ?, data = ?, updated_at = ? WHERE id = ?')
        .run(subtask.status, JSON.stringify(subtask), Date.parse(nowIso), subtask.id);
      return subtask;
    });
  }

  async appendMessage(input: Omit<CollabMessage, 'seq'>): Promise<CollabMessage> {
    return this.tx(() => {
      const row = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM hm_collab_messages WHERE session_id = ?')
        .get(input.sessionId);
      const seq = Number(row?.max_seq ?? 0) + 1;
      const msg: CollabMessage = { ...input, seq };
      this.db
        .prepare(
          'INSERT INTO hm_collab_messages (id, session_id, seq, sender, recipient, thread_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          msg.id,
          msg.sessionId,
          msg.seq,
          msg.sender,
          msg.recipient,
          msg.threadId,
          JSON.stringify(msg),
          Date.parse(msg.createdAt),
        );
      return msg;
    });
  }

  async listMessages(
    sessionId: string,
    query?: { afterSeq?: number; recipient?: string; threadId?: string; limit?: number },
  ): Promise<CollabMessage[]> {
    const afterSeq = query?.afterSeq ?? 0;
    const limit = Math.min(Math.max(query?.limit ?? 100, 1), 500);
    const clauses = ['session_id = ?', 'seq > ?'];
    const params: (string | number)[] = [sessionId, afterSeq];
    if (query?.recipient) {
      clauses.push('(recipient IS NULL OR recipient = ?)');
      params.push(query.recipient);
    }
    if (query?.threadId) {
      clauses.push('thread_id = ?');
      params.push(query.threadId);
    }
    params.push(limit);
    return this.db
      .prepare(`SELECT data FROM hm_collab_messages WHERE ${clauses.join(' AND ')} ORDER BY seq ASC LIMIT ?`)
      .all(...params)
      .map((r) => JSON.parse(r.data as string) as CollabMessage);
  }

  async appendWorkLog(log: CollabWorkLog): Promise<void> {
    this.db
      .prepare('INSERT INTO hm_collab_work_logs (id, session_id, subtask_id, agent_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(log.id, log.sessionId, log.subtaskId, log.agentId, JSON.stringify(log), Date.parse(log.createdAt));
  }

  async listWorkLogs(sessionId: string, subtaskId?: string): Promise<CollabWorkLog[]> {
    const rows = subtaskId
      ? this.db
          .prepare('SELECT data FROM hm_collab_work_logs WHERE session_id = ? AND subtask_id = ? ORDER BY created_at ASC LIMIT 500')
          .all(sessionId, subtaskId)
      : this.db
          .prepare('SELECT data FROM hm_collab_work_logs WHERE session_id = ? ORDER BY created_at ASC LIMIT 500')
          .all(sessionId);
    return rows.map((r) => JSON.parse(r.data as string) as CollabWorkLog);
  }
}

function validateProvider(value: unknown): CollabProvider {
  if (value !== 'claude' && value !== 'codex') {
    throw new DomainError('Collaboration provider must be claude or codex', 400);
  }
  return value;
}

function scrubText(value: string, secrets: readonly string[]): string {
  let out = value.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]');
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.replaceAll(s, '[REDACTED]');
  }
  return out;
}

export class AgentCollabService {
  private readonly now: () => number;
  private readonly redactSecrets: readonly string[];

  constructor(
    private readonly repo: CollaborationStoragePort,
    options?: { now?: () => number; redactSecrets?: readonly string[] },
  ) {
    this.now = options?.now ?? Date.now;
    this.redactSecrets = options?.redactSecrets ?? [];
  }

  get storageBackend(): 'aurora-dsql' | 'sqlite' {
    return this.repo.backend;
  }

  close(): Promise<void> | void {
    return this.repo.close();
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  async createSession(input: CreateCollabSession): Promise<CollabSession> {
    const title = text(input.title, 'title', 160);
    const goal = text(input.goal, 'goal', 12_000);
    const provider = validateProvider(input.provider);
    const maxParallelWorkers = input.maxParallelWorkers ?? 4;
    if (!Number.isSafeInteger(maxParallelWorkers) || maxParallelWorkers < 1 || maxParallelWorkers > 32) {
      throw new DomainError('maxParallelWorkers must be between 1 and 32', 400);
    }
    const allowedRegions = (input.allowedRegions ?? DEFAULT_FIVE_REGIONS).map((r) => {
      const clean = text(r, 'allowedRegion', 32).toLowerCase();
      if (!REGION_PATTERN.test(clean)) throw new DomainError(`Invalid AWS region: ${r}`, 400);
      return clean;
    });
    if (allowedRegions.length === 0) throw new DomainError('allowedRegions cannot be empty', 400);
    let baseCommit: string | undefined;
    if (input.baseCommit !== undefined) {
      baseCommit = text(input.baseCommit, 'baseCommit', 40).toLowerCase();
      if (!HEX40.test(baseCommit)) throw new DomainError('Invalid baseCommit', 400);
    }
    const repository = input.repository === undefined ? undefined : text(input.repository, 'repository', 200);
    const at = this.timestamp();
    const session: CollabSession = {
      id: `ses-${randomUUID()}`,
      title,
      goal: scrubText(goal, this.redactSecrets),
      provider,
      status: 'active',
      maxParallelWorkers,
      allowedRegions: [...new Set(allowedRegions)],
      ...(repository ? { repository } : {}),
      ...(baseCommit ? { baseCommit } : {}),
      latestOrchestratorRun: null,
      createdAt: at,
      updatedAt: at,
    };
    await this.repo.saveSession(session);
    return structuredClone(session);
  }

  async listSessions(): Promise<CollabSession[]> {
    return this.repo.listSessions();
  }

  async getSession(id: string): Promise<CollabSession> {
    const found = await this.repo.getSession(id);
    if (!found) throw new DomainError('Collaboration session not found', 404);
    return found;
  }

  async getSnapshot(sessionId: string): Promise<CollabSessionSnapshot> {
    const session = await this.getSession(sessionId);
    const [subtasks, messages, workLogs] = await Promise.all([
      this.repo.listSubtasks(sessionId),
      this.repo.listMessages(sessionId, { limit: 200 }),
      this.repo.listWorkLogs(sessionId),
    ]);
    return {
      storageBackend: this.repo.backend,
      session,
      subtasks,
      messages,
      workLogs,
    };
  }

  async updateOrchestratorRun(sessionId: string, run: CollabOrchestratorRun): Promise<CollabSession> {
    const session = await this.getSession(sessionId);
    session.latestOrchestratorRun = {
      ...run,
      summary: run.summary ? scrubText(run.summary, this.redactSecrets).slice(0, 8000) : null,
      error: run.error ? scrubText(run.error, this.redactSecrets).slice(0, 2000) : null,
    };
    session.updatedAt = this.timestamp();
    await this.repo.saveSession(session);
    return session;
  }

  async completeSession(sessionId: string, status: 'completed' | 'failed' | 'cancelled'): Promise<CollabSession> {
    const session = await this.getSession(sessionId);
    session.status = status;
    session.updatedAt = this.timestamp();
    await this.repo.saveSession(session);
    return session;
  }

  async createSubtask(sessionId: string, input: CreateCollabSubtask): Promise<CollabSubtask> {
    const session = await this.getSession(sessionId);
    if (session.status !== 'active') {
      throw new DomainError(`Cannot add subtask to session in state ${session.status}`, 409);
    }
    const existing = await this.repo.listSubtasks(sessionId);
    const existingIds = new Set(existing.map((s) => s.id));
    const dependsOn = (input.dependsOn ?? []).map((depId) => {
      const clean = text(depId, 'dependsOn', 120);
      if (!existingIds.has(clean)) {
        throw new DomainError(`Unknown dependency subtask: ${clean}`, 400);
      }
      return clean;
    });
    const at = this.timestamp();
    const subtask: CollabSubtask = {
      id: `sub-${randomUUID()}`,
      sessionId,
      title: text(input.title, 'subtask title', 160),
      instructions: scrubText(text(input.instructions, 'subtask instructions', 12_000), this.redactSecrets),
      provider: input.provider ? validateProvider(input.provider) : session.provider,
      dependsOn: [...new Set(dependsOn)],
      status: 'pending',
      assignedAgentId: null,
      region: null,
      ecsTaskArn: null,
      artifactS3Prefix: input.artifactS3Prefix ? text(input.artifactS3Prefix, 'artifactS3Prefix', 512) : null,
      resultSummary: null,
      failureReason: null,
      createdAt: at,
      updatedAt: at,
    };
    await this.repo.saveSubtask(subtask);
    return subtask;
  }

  async listSubtasks(sessionId: string): Promise<CollabSubtask[]> {
    await this.getSession(sessionId);
    return this.repo.listSubtasks(sessionId);
  }

  async listReadySubtasks(sessionId: string): Promise<CollabSubtask[]> {
    const subtasks = await this.listSubtasks(sessionId);
    const done = new Set(subtasks.filter((s) => s.status === 'completed').map((s) => s.id));
    return subtasks.filter(
      (s) => (s.status === 'pending' || s.status === 'queued') && s.dependsOn.every((dep) => done.has(dep)),
    );
  }

  async claimSubtask(
    sessionId: string,
    subtaskId: string,
    input: { agentId: string; region?: string | null; ecsTaskArn?: string | null },
  ): Promise<CollabSubtask> {
    await this.getSession(sessionId);
    const agentId = text(input.agentId, 'agentId', 120);
    const claimed = await this.repo.claimSubtaskAtomic(
      subtaskId,
      agentId,
      input.region ?? null,
      input.ecsTaskArn ?? null,
      this.timestamp(),
    );
    if (!claimed || claimed.sessionId !== sessionId) {
      throw new DomainError('Subtask is not ready or already claimed by another agent', 409);
    }
    return claimed;
  }

  async finishSubtask(
    sessionId: string,
    subtaskId: string,
    input: { agentId: string; status: 'completed' | 'failed'; summary?: string; failureReason?: string },
  ): Promise<CollabSubtask> {
    const subtask = await this.repo.getSubtask(subtaskId);
    if (!subtask || subtask.sessionId !== sessionId) {
      throw new DomainError('Subtask not found', 404);
    }
    if (subtask.status !== 'running' || subtask.assignedAgentId !== input.agentId) {
      throw new DomainError('Subtask is not actively owned by this agent', 409);
    }
    subtask.status = input.status;
    subtask.resultSummary = input.summary ? scrubText(text(input.summary, 'summary', 8000), this.redactSecrets) : null;
    subtask.failureReason = input.failureReason
      ? scrubText(text(input.failureReason, 'failureReason', 2000), this.redactSecrets)
      : null;
    subtask.updatedAt = this.timestamp();
    await this.repo.saveSubtask(subtask);
    return subtask;
  }

  async postMessage(sessionId: string, input: PostCollabMessage): Promise<CollabMessage> {
    await this.getSession(sessionId);
    const sender = text(input.sender, 'sender', 120);
    const recipient = input.recipient ? text(input.recipient, 'recipient', 120) : null;
    const threadId = input.threadId ? text(input.threadId, 'threadId', 120) : null;
    const kind: CollabMessageKind = input.kind ?? 'chat';
    if (!MESSAGE_KINDS.has(kind)) throw new DomainError(`Invalid message kind: ${kind}`, 400);
    const body = scrubText(text(input.body, 'body', 8000), this.redactSecrets);
    const artifactRefs = (input.artifactRefs ?? []).slice(0, 32).map((ref) => text(ref, 'artifactRef', 512));
    return this.repo.appendMessage({
      id: `msg-${randomUUID()}`,
      sessionId,
      sender,
      recipient,
      threadId,
      kind,
      body,
      artifactRefs,
      createdAt: this.timestamp(),
    });
  }

  async listMessages(
    sessionId: string,
    query?: { afterSeq?: number; recipient?: string; threadId?: string; limit?: number },
  ): Promise<CollabMessage[]> {
    await this.getSession(sessionId);
    return this.repo.listMessages(sessionId, query);
  }

  async appendWorkLog(sessionId: string, input: AppendCollabWorkLog): Promise<CollabWorkLog> {
    await this.getSession(sessionId);
    if (!WORKLOG_KINDS.has(input.kind)) throw new DomainError(`Invalid workLog kind: ${input.kind}`, 400);
    let sha256: string | null = null;
    if (input.sha256) {
      sha256 = text(input.sha256, 'sha256', 64).toLowerCase();
      if (!HEX64.test(sha256)) throw new DomainError('Invalid workLog sha256', 400);
    }
    const log: CollabWorkLog = {
      id: `log-${randomUUID()}`,
      sessionId,
      subtaskId: input.subtaskId ? text(input.subtaskId, 'subtaskId', 120) : null,
      agentId: text(input.agentId, 'agentId', 120),
      kind: input.kind,
      summary: scrubText(text(input.summary, 'summary', 4000), this.redactSecrets),
      s3Uri: input.s3Uri ? text(input.s3Uri, 's3Uri', 512) : null,
      sha256,
      createdAt: this.timestamp(),
    };
    await this.repo.appendWorkLog(log);
    return log;
  }

  async listWorkLogs(sessionId: string, subtaskId?: string): Promise<CollabWorkLog[]> {
    await this.getSession(sessionId);
    return this.repo.listWorkLogs(sessionId, subtaskId);
  }
}
