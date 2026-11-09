import { DatabaseSync } from 'node:sqlite';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CreateTask, Task, State, Worker, HiveEvent, Lease, RunResult, RepositoryPolicy, Provider, Runtime, ExecutionEvidence, ProcessEvidence, AgentRunEvidence } from '../../contracts/src/index.js';

export class DomainError extends Error {
  constructor(message: string, public statusCode = 409) { super(message); }
}
export const ESTIMATE_MICROS = 1000;
export function text(value: unknown, name: string, max = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new DomainError(`Invalid ${name}`, 400);
  return value.trim();
}
export function money(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) throw new DomainError(`Invalid ${name}`, 400);
  return value;
}
export function equalSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x,y);
}
function object(value: unknown, name: string): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError(`Invalid ${name}`,400);
  return value as Record<string,unknown>;
}
function boundedString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new DomainError(`Invalid ${name}`,400);
  return value;
}
function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new DomainError(`Invalid ${name}`,400);
  return value;
}
function bool(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new DomainError(`Invalid ${name}`,400);
  return value;
}
function exitCode(value: unknown): number | null {
  return value === null ? null : integer(value,'exitCode',-2147483648,2147483647);
}
function processStatus(value: unknown, code: number | null): ProcessEvidence['status'] {
  if (!['passed','failed','timed_out','error','not_run'].includes(String(value))) throw new DomainError('Invalid process status',400);
  if ((value === 'passed' && code !== 0) || (value === 'failed' && (code === null || code === 0)) || (value === 'not_run' && code !== null)) throw new DomainError('Process status conflicts with exitCode',400);
  return value as ProcessEvidence['status'];
}
function validateProcess(value: unknown): ProcessEvidence {
  const item = object(value,'process evidence');
  if (!Array.isArray(item.command) || item.command.length < 1 || item.command.length > 32) throw new DomainError('Invalid test command',400);
  const command = item.command.map(arg=>{
    const value = boundedString(arg,'command argument',1000);
    if (!value.trim() || value.includes('\0')) throw new DomainError('Invalid command argument',400);
    return value;
  });
  const code = exitCode(item.exitCode);
  return {command,status:processStatus(item.status,code),exitCode:code,durationMs:integer(item.durationMs,'durationMs',0,86400000),stdout:boundedString(item.stdout,'stdout',16000),stderr:boundedString(item.stderr,'stderr',16000),truncated:bool(item.truncated,'truncated')};
}
function validateAgent(value: unknown, label: string): AgentRunEvidence {
  const agent = object(value,`${label} evidence`), code = exitCode(agent.exitCode);
  const usage = agent.usage === null ? null : object(agent.usage,'usage');
  return {status:processStatus(agent.status,code),exitCode:code,threadId:agent.threadId === null ? null : text(agent.threadId,'threadId',200),model:agent.model === null ? null : text(agent.model,'model',200),usage:usage === null ? null : {inputTokens:integer(usage.inputTokens,'inputTokens',0,Number.MAX_SAFE_INTEGER),cachedInputTokens:integer(usage.cachedInputTokens,'cachedInputTokens',0,Number.MAX_SAFE_INTEGER),outputTokens:integer(usage.outputTokens,'outputTokens',0,Number.MAX_SAFE_INTEGER)},stderr:boundedString(agent.stderr,`${label} stderr`,16000)};
}
function validateExecution(value: unknown, provider: 'codex' | 'claude'): ExecutionEvidence {
  const item = object(value,'execution evidence');
  const other = provider === 'codex' ? 'claude' : 'codex';
  if (!Object.hasOwn(item,provider) || Object.hasOwn(item,other)) throw new DomainError('Execution provider metadata does not match task',400);
  const agent = validateAgent(item[provider],provider === 'codex' ? 'Codex' : 'Claude');
  const base = text(item.baseCommit,'baseCommit',40), head = text(item.headCommit,'headCommit',40);
  if (!/^[a-f0-9]{40}$/i.test(base) || !/^[a-f0-9]{40}$/i.test(head)) throw new DomainError('Invalid execution commit',400);
  if (!['succeeded','failed'].includes(String(item.status))) throw new DomainError('Invalid execution status',400);
  return {repositoryId:text(item.repositoryId,'repositoryId',120),baseCommit:base,headCommit:head,worktreePath:text(item.worktreePath,'worktreePath',4096),diffTruncated:bool(item.diffTruncated,'diffTruncated'),status:item.status as ExecutionEvidence['status'],
    ...(item.setup === undefined ? {} : {setup:validateProcess(item.setup)}),tests:validateProcess(item.tests),[provider]:agent};
}
export class HiveStore {
  private db: DatabaseSync;
  constructor(path = ':memory:', private now: () => number = Date.now, private repository?: RepositoryPolicy) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL, lease_token TEXT);
      CREATE TABLE IF NOT EXISTS workers (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private timestamp(): string { return new Date(this.now()).toISOString(); }
  private tasks(): Task[] {
    return this.db.prepare('SELECT data FROM tasks ORDER BY rowid DESC').all().map(row => JSON.parse(row.data as string) as Task);
  }
  private get(id: string): Task {
    const row = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id);
    if (!row) throw new DomainError('Task not found',404);
    return JSON.parse(row.data as string) as Task;
  }
  private save(task: Task): Task {
    task.updatedAt = this.timestamp();
    this.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify(task), task.id);
    return task;
  }
  private event(task: Task, type: string, data: Record<string,unknown>): void {
    this.db.prepare('INSERT INTO events(data) VALUES (?)').run(JSON.stringify({taskId:task.id,runId:task.runId,type,at:this.timestamp(),data}));
  }
  private finishLease(task: Task): void {
    task.leaseExpiresAt = null;
    this.db.prepare('UPDATE tasks SET lease_token=NULL WHERE id=?').run(task.id);
  }
  expire(): void {
    this.tx(() => {
      for (const task of this.tasks()) if (task.status === 'running' && task.leaseExpiresAt! <= this.now()) {
        task.status = 'failed'; task.summary = 'Worker lease expired; manual resubmission required';
        this.finishLease(task); this.save(task); this.event(task,'run.expired',{});
      }
    });
  }
  create(input: CreateTask): Task {
    const title = text(input.title,'title',160), instructions = text(input.instructions,'instructions',12000);
    const budget = money(input.budgetMicros,'budget');
    if (!['mock','codex','claude'].includes(input.provider) || input.runtime !== 'local') throw new DomainError('Only mock/local and configured codex/claude local workers are implemented',422);
    const isReal = input.provider !== 'mock';
    if (isReal) {
      if (!this.repository) throw new DomainError('Agent repository is not configured or supported',422);
      if (input.repositoryId !== this.repository.id) throw new DomainError('Invalid repository selection',422);
      if (input.baseCommit !== this.repository.baseCommit) throw new DomainError('Repository base commit does not match the configured snapshot',422);
      if (input.testProfile !== this.repository.testProfile) throw new DomainError('Invalid test profile',422);
    } else {
      if (input.repositoryId !== undefined || input.baseCommit !== undefined || input.testProfile !== undefined) throw new DomainError('Mock tasks cannot select a repository',400);
      if (budget < ESTIMATE_MICROS) throw new DomainError('Task budget is below the mock estimate',422);
    }
    return this.tx(() => {
      const task: Task = {title,instructions,budgetMicros:budget,provider:input.provider,runtime:'local',...(isReal ? {repositoryId:input.repositoryId,baseCommit:input.baseCommit,testProfile:input.testProfile,testCommand:[...this.repository!.testCommand]} : {}),id:randomUUID(),status:'awaiting_execution_approval',createdAt:this.timestamp(),updatedAt:this.timestamp(),runId:null,workerId:null,leaseExpiresAt:null,estimatedCostMicros:isReal ? null : ESTIMATE_MICROS,actualCostMicros:isReal ? null : 0,diff:null,summary:null,execution:null};
      this.db.prepare('INSERT INTO tasks(id,data) VALUES (?,?)').run(task.id,JSON.stringify(task));
      this.event(task,'task.created',{provider:task.provider,runtime:task.runtime,budgetMicros:budget}); return task;
    });
  }
  decision(id: string, decision: string, reason: string): Task {
    reason = text(reason,'reason');
    if (!['approve','reject'].includes(decision)) throw new DomainError('Invalid decision',400);
    return this.tx(() => {
      const task = this.get(id), stage = task.status;
      if (!['awaiting_execution_approval','awaiting_review'].includes(stage)) throw new DomainError('No approval pending in this state');
      task.status = decision === 'reject' ? 'rejected' : stage === 'awaiting_review' ? 'completed' : 'queued';
      this.save(task); this.event(task,'approval.decided',{stage,decision,reason,actor:'operator'}); return task;
    });
  }
  private getWorker(id: string): Worker {
    const row = this.db.prepare('SELECT data FROM workers WHERE id=?').get(id);
    if (!row) throw new DomainError('Worker not registered',400);
    return JSON.parse(row.data as string) as Worker;
  }
  private touchWorker(id: string): Worker {
    const worker = this.getWorker(id); worker.lastSeenAt = this.timestamp();
    this.db.prepare('UPDATE workers SET data=? WHERE id=?').run(JSON.stringify(worker),id);
    return worker;
  }
  register(id: string, provider: Provider = 'mock', runtime: Runtime = 'local', repositoryId?: string): Worker {
    id = text(id,'workerId',120);
    if (!['mock','codex','claude'].includes(provider) || runtime !== 'local') throw new DomainError('Unsupported worker capability',422);
    if (provider !== 'mock' && (!this.repository || repositoryId !== this.repository.id)) throw new DomainError('Invalid agent worker repository',422);
    if (provider === 'mock' && repositoryId !== undefined) throw new DomainError('Mock worker cannot select a repository',400);
    const worker: Worker = {id,provider,runtime,lastSeenAt:this.timestamp(),...(repositoryId ? {repositoryId} : {})};
    const previous = this.db.prepare('SELECT data FROM workers WHERE id=?').get(id);
    if (previous) {
      const old = JSON.parse(previous.data as string) as Worker;
      if ((old.provider !== provider || old.runtime !== runtime || old.repositoryId !== repositoryId) && this.tasks().some(task=>task.status === 'running' && task.workerId === id)) throw new DomainError('Cannot change capability of a busy worker');
    }
    this.db.prepare('INSERT INTO workers(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id,JSON.stringify(worker)); return worker;
  }
  claim(id: string): Lease | null {
    this.expire();
    return this.tx(() => {
      const worker = this.getWorker(id);
      this.touchWorker(id);
      if (this.tasks().some(task => task.status === 'running' && task.workerId === id)) return null;
      const task = this.tasks().reverse().find(task => task.status === 'queued' && task.provider === worker.provider && task.runtime === worker.runtime && (task.provider === 'mock' || task.repositoryId === worker.repositoryId));
      if (!task) return null;
      task.status = 'running'; task.runId = randomUUID(); task.workerId = id; task.leaseExpiresAt = this.now()+30000;
      const leaseToken = randomUUID(); this.db.prepare('UPDATE tasks SET lease_token=? WHERE id=?').run(leaseToken,task.id);
      this.save(task); this.event(task,'run.started',{workerId:id,estimatedCostMicros:task.estimatedCostMicros}); return {task,leaseToken};
    });
  }
  private running(id: string, worker: string, token: string): Task {
    const task = this.get(id), row = this.db.prepare('SELECT lease_token FROM tasks WHERE id=?').get(id)!;
    // Check the deadline after acquiring the accepting transaction's lock.
    if (task.status !== 'running' || task.leaseExpiresAt === null || task.leaseExpiresAt <= this.now() || task.workerId !== worker || typeof token !== 'string' || !equalSecret(token,String(row.lease_token))) throw new DomainError('Invalid or expired lease, or task is not running');
    return task;
  }
  heartbeat(id: string, worker: string, token: string): Task {
    this.expire();
    return this.tx(() => {
      const task = this.running(id,worker,token); task.leaseExpiresAt = this.now()+30000;
      this.touchWorker(worker); return this.save(task);
    });
  }
  result(id: string, worker: string, token: string, result: RunResult): Task {
    const summary = text(result.summary,'summary',12000);
    if (typeof result.diff !== 'string' || result.diff.length > 200000) throw new DomainError('Invalid diff',400);
    this.expire();
    return this.tx(() => {
      const task = this.running(id,worker,token);
      let eventType = 'run.result';
      if (task.provider !== 'mock') {
        if (result.actualCostMicros !== null) throw new DomainError('Agent cost must remain unknown (null)',400);
        const evidence = validateExecution(result.execution,task.provider);
        if (evidence.repositoryId !== task.repositoryId || evidence.baseCommit !== task.baseCommit) throw new DomainError('Execution repository or base commit does not match task',400);
        if (!Array.isArray(task.testCommand) || task.testCommand.length === 0) throw new DomainError('Task is missing its approved command snapshot; resubmit this task',400);
        if (JSON.stringify(evidence.tests.command) !== JSON.stringify(task.testCommand)) throw new DomainError('Execution test command does not match approved profile snapshot',400);
        const agent = evidence[task.provider]!;
        const successful = agent.status === 'passed' && agent.exitCode === 0 && evidence.tests.status === 'passed' && evidence.tests.exitCode === 0 && (!evidence.setup || (evidence.setup.status === 'passed' && evidence.setup.exitCode === 0)) && evidence.headCommit === evidence.baseCommit;
        if (evidence.status === 'succeeded' && !successful) throw new DomainError('Execution success conflicts with process evidence',400);
        task.actualCostMicros = null; task.execution = evidence;
        task.status = evidence.status === 'succeeded' ? 'awaiting_review' : 'failed';
        if (task.status === 'failed') eventType = 'run.failed';
      } else {
        const cost = money(result.actualCostMicros,'actualCostMicros');
        if (!result.diff.trim()) throw new DomainError('Invalid diff',400);
        if (result.execution != null) throw new DomainError('Mock result cannot contain real execution evidence',400);
        task.actualCostMicros = cost; task.execution = null;
        task.status = cost > task.budgetMicros ? 'failed' : 'awaiting_review';
        if (cost > task.budgetMicros) eventType = 'budget.exceeded';
      }
      task.diff = result.diff; task.summary = summary;
      this.finishLease(task); this.save(task);
      this.event(task,eventType,{actualCostMicros:task.actualCostMicros,synthetic:task.provider === 'mock',...(task.execution ? {testStatus:task.execution.tests.status,baseCommit:task.execution.baseCommit} : {})});
      return task;
    });
  }
  fail(id: string, worker: string, token: string, message: string): Task {
    message = text(message,'message',12000); this.expire();
    return this.tx(() => {
      const task = this.running(id,worker,token); task.status = 'failed'; task.summary = message;
      this.finishLease(task); this.save(task); this.event(task,'run.failed',{message}); return task;
    });
  }
  cancel(id: string, reason: string): Task {
    reason = text(reason,'reason');
    return this.tx(() => {
      const task = this.get(id);
      if (['completed','rejected','cancelled','failed'].includes(task.status)) throw new DomainError('Task is already terminal');
      task.status = 'cancelled'; this.finishLease(task); this.save(task);
      this.event(task,'task.cancelled',{reason,actor:'operator'}); return task;
    });
  }
  state(): State {
    this.expire();
    return {tasks:this.tasks(),workers:this.db.prepare('SELECT data FROM workers').all().map(row => JSON.parse(row.data as string) as Worker),events:this.db.prepare('SELECT sequence,data FROM events ORDER BY sequence DESC LIMIT 200').all().reverse().map(row => ({...JSON.parse(row.data as string),sequence:row.sequence}) as HiveEvent)};
  }
  close(): void { this.db.close(); }
}
