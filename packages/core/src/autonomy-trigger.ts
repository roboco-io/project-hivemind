import { SqliteDocumentRepository, type DocumentRepository, type DocumentTxState } from './document-repository.js';
import { DomainError, text } from './store.js';
import { validateDeliveryPolicy, validateWorkerExecutionPolicy } from './delivery.js';

/**
 * Periodic trigger that sends "advance one stage" work for a repository to a cloud worker (issue #20).
 * What a stage does is the repository's own business (for Silicon Model Factory: ops/autonomy/state.json);
 * the trigger only decides when to send the next task and never sends a second one while one is open.
 */
export interface AutonomyTrigger {
  id: string;
  repository: string;
  baseBranch: string;
  /** Agent branches; also how the trigger recognises its own tasks. */
  branchPrefix: string;
  title: string;
  instructions: string;
  provider: 'codex' | 'claude';
  intervalMinutes: number;
  maxIterations: number;
  maxIterationDurationMs: number;
  budgetMicros: number;
  /** Paths a task may not change; also pinned as acceptance files, and an auto-merge touching them stops the trigger. */
  protectedPaths: string[];
  testCommand: string[];
  enabled: boolean;
  /** Why it is disabled, when it is. */
  disabledReason: string | null;
  lastDispatchAt: string | null;
  lastTaskId: string | null;
  lastBaseCommit: string | null;
  /** Last reason a due tick did not send a task (open task, preparation error). */
  lastSkipReason: string | null;
  updatedAt: string;
}

export interface AutonomyTriggerEvent {
  sequence: number;
  triggerId: string;
  type: string;
  at: string;
  data: Record<string, unknown>;
}
export type AutonomyTriggerEventDraft = Omit<AutonomyTriggerEvent, 'sequence'>;
export type AutonomyTriggerRepository = DocumentRepository<AutonomyTrigger, AutonomyTriggerEventDraft>;
type TxState = DocumentTxState<AutonomyTrigger, AutonomyTriggerEventDraft>;

export class SqliteAutonomyTriggerRepository extends SqliteDocumentRepository<AutonomyTrigger, AutonomyTriggerEventDraft> {
  constructor(path = ':memory:') {
    super(path, 'autonomy_trigger_docs', 'autonomy_trigger_events');
  }
}

export type AutonomyTriggerConfig = Pick<
  AutonomyTrigger,
  'repository' | 'baseBranch' | 'branchPrefix' | 'title' | 'instructions' | 'provider' | 'intervalMinutes' | 'maxIterations' | 'maxIterationDurationMs' | 'budgetMicros' | 'protectedPaths' | 'testCommand'
>;

const ID = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function validateAutonomyTriggerConfig(input: unknown): AutonomyTriggerConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DomainError('Invalid trigger configuration', 400);
  const raw = input as Record<string, unknown>;
  const policy = validateDeliveryPolicy({ mode: 'draft_pr', repository: raw.repository, baseBranch: raw.baseBranch, branchPrefix: raw.branchPrefix, autoMerge: true, protectedPaths: raw.protectedPaths });
  const exec = validateWorkerExecutionPolicy({ maxIterationDurationMs: raw.maxIterationDurationMs, hivemindAgentAccess: true });
  if (raw.provider !== 'codex' && raw.provider !== 'claude') throw new DomainError('provider must be codex or claude', 400);
  const intervalMinutes = Number(raw.intervalMinutes);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 10_080) throw new DomainError('intervalMinutes must be 5..10080', 400);
  const maxIterations = Number(raw.maxIterations ?? 2);
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 5) throw new DomainError('maxIterations must be 1..5', 400);
  const budgetMicros = Number(raw.budgetMicros ?? 0);
  if (!Number.isSafeInteger(budgetMicros) || budgetMicros < 0 || budgetMicros > 1_000_000_000) throw new DomainError('Invalid budgetMicros', 400);
  if (!Array.isArray(raw.testCommand) || raw.testCommand.length < 1 || raw.testCommand.length > 16) throw new DomainError('testCommand needs 1..16 arguments', 400);
  return {
    repository: policy.repository,
    baseBranch: policy.baseBranch,
    branchPrefix: policy.branchPrefix,
    title: text(raw.title, 'title', 160),
    instructions: text(raw.instructions, 'instructions', 12_000),
    provider: raw.provider,
    intervalMinutes,
    maxIterations,
    maxIterationDurationMs: exec.maxIterationDurationMs ?? 600_000,
    budgetMicros,
    protectedPaths: policy.protectedPaths!,
    testCommand: raw.testCommand.map((arg) => text(arg, 'testCommand arg', 500)),
  };
}

/** Durable state of the periodic triggers. Only the operator API changes configuration and on/off. */
export class AutonomyTriggerStore {
  private readonly repository: AutonomyTriggerRepository;
  private readonly now: () => number;
  private activeTx: TxState | null = null;

  constructor(storage: string | AutonomyTriggerRepository = ':memory:', options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.repository = typeof storage === 'string' ? new SqliteAutonomyTriggerRepository(storage) : storage;
  }

  get storageBackend(): AutonomyTriggerRepository['storageBackend'] {
    return this.repository.storageBackend;
  }

  close(): Promise<void> {
    return this.repository.close();
  }

  private timestamp(): string {
    return new Date(this.now()).toISOString();
  }

  private tx<T>(fn: () => T): Promise<T> {
    return this.repository.transaction((state) => {
      this.activeTx = state;
      try {
        return fn();
      } finally {
        this.activeTx = null;
      }
    });
  }

  private state(): TxState {
    if (!this.activeTx) throw new Error('AutonomyTriggerStore used outside a transaction');
    return this.activeTx;
  }

  private load(id: string): AutonomyTrigger {
    const doc = this.state().docs.get(id);
    if (!doc) throw new DomainError('Trigger not found', 404);
    return structuredClone(doc);
  }

  private save(doc: AutonomyTrigger): AutonomyTrigger {
    doc.updatedAt = this.timestamp();
    this.state().docs.set(doc.id, structuredClone(doc));
    this.state().dirtyIds.add(doc.id);
    return structuredClone(doc);
  }

  private emit(triggerId: string, type: string, data: Record<string, unknown>): void {
    this.state().newEvents.push({ triggerId, type, at: this.timestamp(), data });
  }

  async list(): Promise<AutonomyTrigger[]> {
    return this.tx(() => [...this.state().docs.values()].map((d) => structuredClone(d)));
  }

  async get(id: string): Promise<AutonomyTrigger> {
    return this.tx(() => this.load(id));
  }

  async events(limit = 100): Promise<AutonomyTriggerEvent[]> {
    return (await this.repository.listEvents(limit)) as AutonomyTriggerEvent[];
  }

  /** Creates or replaces a trigger's configuration. A new trigger starts disabled. */
  async configure(id: string, input: unknown): Promise<AutonomyTrigger> {
    if (!ID.test(id)) throw new DomainError('Trigger id must match ^[a-z0-9][a-z0-9-]{1,62}$', 400);
    const config = validateAutonomyTriggerConfig(input);
    return this.tx(() => {
      const existing = this.state().docs.get(id);
      const doc: AutonomyTrigger = existing
        ? { ...structuredClone(existing), ...config }
        : { id, ...config, enabled: false, disabledReason: 'New trigger', lastDispatchAt: null, lastTaskId: null, lastBaseCommit: null, lastSkipReason: null, updatedAt: this.timestamp() };
      const saved = this.save(doc);
      this.emit(id, 'autonomy_trigger.configured', { repository: config.repository, intervalMinutes: config.intervalMinutes, protectedPaths: config.protectedPaths });
      return saved;
    });
  }

  async setEnabled(id: string, enabled: boolean, reason: string): Promise<AutonomyTrigger> {
    const why = text(reason, 'reason', 1000);
    return this.tx(() => {
      const trigger = this.load(id);
      trigger.enabled = enabled;
      trigger.disabledReason = enabled ? null : why;
      const saved = this.save(trigger);
      this.emit(id, enabled ? 'autonomy_trigger.enabled' : 'autonomy_trigger.disabled', { reason: why });
      return saved;
    });
  }

  /** Enabled triggers whose interval has passed since the last dispatch. */
  async due(nowMs = this.now()): Promise<AutonomyTrigger[]> {
    return (await this.list()).filter((t) => t.enabled && (!t.lastDispatchAt || nowMs - Date.parse(t.lastDispatchAt) >= t.intervalMinutes * 60_000));
  }

  async recordDispatch(id: string, taskId: string, baseCommit: string): Promise<AutonomyTrigger> {
    return this.tx(() => {
      const trigger = this.load(id);
      trigger.lastDispatchAt = this.timestamp();
      trigger.lastTaskId = taskId;
      trigger.lastBaseCommit = baseCommit;
      trigger.lastSkipReason = null;
      const saved = this.save(trigger);
      this.emit(id, 'autonomy_trigger.dispatched', { taskId, baseCommit });
      return saved;
    });
  }

  /** Records why a due tick sent nothing. Events are written only when the reason changes. */
  async recordSkip(id: string, reason: string): Promise<AutonomyTrigger> {
    return this.tx(() => {
      const trigger = this.load(id);
      const clipped = reason.slice(0, 500);
      if (trigger.lastSkipReason === clipped) return trigger;
      trigger.lastSkipReason = clipped;
      const saved = this.save(trigger);
      this.emit(id, 'autonomy_trigger.skipped', { reason: clipped });
      return saved;
    });
  }
}
