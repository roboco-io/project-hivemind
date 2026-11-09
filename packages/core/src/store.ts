import { DatabaseSync } from 'node:sqlite';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CreateTask, Task, State, Worker, HiveEvent, Lease, RunResult } from '../../contracts/src/index.js';

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
export class HiveStore {
  private db: DatabaseSync;
  constructor(path = ':memory:', private now: () => number = Date.now) {
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
    if (input.provider !== 'mock' || input.runtime !== 'local') throw new DomainError('Only mock/local is implemented',422);
    if (budget < ESTIMATE_MICROS) throw new DomainError('Task budget is below the mock estimate',422);
    return this.tx(() => {
      const task: Task = {title,instructions,budgetMicros:budget,provider:'mock',runtime:'local',id:randomUUID(),status:'awaiting_execution_approval',createdAt:this.timestamp(),updatedAt:this.timestamp(),runId:null,workerId:null,leaseExpiresAt:null,estimatedCostMicros:ESTIMATE_MICROS,actualCostMicros:0,diff:null,summary:null};
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
  register(id: string): Worker {
    id = text(id,'workerId',120);
    const worker: Worker = {id,provider:'mock',runtime:'local',lastSeenAt:this.timestamp()};
    this.db.prepare('INSERT INTO workers(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id,JSON.stringify(worker)); return worker;
  }
  claim(id: string): Lease | null {
    this.expire();
    return this.tx(() => {
      if (!this.db.prepare('SELECT id FROM workers WHERE id=?').get(id)) throw new DomainError('Worker not registered',400);
      this.register(id);
      if (this.tasks().some(task => task.status === 'running' && task.workerId === id)) return null;
      const task = this.tasks().reverse().find(task => task.status === 'queued');
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
      this.register(worker); return this.save(task);
    });
  }
  result(id: string, worker: string, token: string, result: RunResult): Task {
    const cost = money(result.actualCostMicros,'actualCostMicros'), summary = text(result.summary,'summary',12000), diff = text(result.diff,'diff',200000);
    this.expire();
    return this.tx(() => {
      const task = this.running(id,worker,token); task.actualCostMicros = cost; task.diff = diff; task.summary = summary;
      task.status = cost > task.budgetMicros ? 'failed' : 'awaiting_review';
      this.finishLease(task); this.save(task);
      this.event(task,cost > task.budgetMicros ? 'budget.exceeded' : 'run.result',{actualCostMicros:cost,synthetic:true}); return task;
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
