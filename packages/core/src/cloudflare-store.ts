import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CreateTask, HiveEvent, RepositoryPolicy } from '../../contracts/src/index.js';
import type { CloudConnection, CloudControl, CloudEvidence, CloudPoll, CloudPort, CloudPrivateTask, CloudProcess, CloudSubmission, CloudTask } from '../../contracts/src/cloudflare.js';
import { DomainError, money, text } from './store.js';

export interface CloudControlOptions { dbPath: string; policy: RepositoryPolicy; port: CloudPort; pollIntervalMs?: number; executionScope?: string }
interface StoredCloudTask extends CloudPrivateTask { executionScope: string | null }
const terminal = new Set(['completed','rejected','cancelled','failed']);
const allowedInput = new Set(['title','instructions','budgetMicros','provider','runtime','repositoryId','baseCommit','testProfile']);
const stamp = () => new Date().toISOString();
const copy = <T>(value: T): T => structuredClone(value);
function initialEvidence(): CloudEvidence { return {phase:'AWAITING_APPROVAL',jobId:null,inputSnapshotId:null,outputSnapshotId:null,containerStopped:false,authSynced:false,agent:null,checks:[],errorCode:null}; }
function safe(value: string, limit = 16000): string {
  return value.slice(0,limit).replace(/Bearer\s+[^\s"']+/gi,'Bearer [REDACTED]').replace(/((?:access[_-]?token|refresh[_-]?token|api[_-]?key|control[_-]?token|authorization|password|secret)\s*[=:]\s*)[^\s,"'}]+/gi,'$1[REDACTED]');
}
function processEvidence(item: CloudProcess | null): CloudProcess | null {
  if (!item) return null;
  return {status:item.status,exitCode:item.exitCode,durationMs:item.durationMs,stdout:safe(item.stdout),stderr:safe(item.stderr),truncated:item.truncated};
}
function projectEvidence(item: CloudEvidence, jobId: string): CloudEvidence {
  return {phase:safe(item.phase,100),jobId,inputSnapshotId:item.inputSnapshotId,outputSnapshotId:item.outputSnapshotId,containerStopped:item.containerStopped,authSynced:item.authSynced,agent:processEvidence(item.agent),checks:item.checks.map(c=>({id:safe(c.id,100),name:safe(c.name,200),status:safe(c.status,100),command:c.command.map(a=>safe(a,1000)),process:processEvidence(c.process),credentialsAbsent:c.credentialsAbsent,sourceUnchanged:c.sourceUnchanged})),errorCode:item.errorCode && /^[A-Z0-9_]{1,100}$/.test(item.errorCode) ? item.errorCode : null};
}
function verified(poll: CloudPoll): boolean {
  const e=poll.evidence;
  return poll.success && poll.phase === 'SUCCEEDED' && e.phase === 'SUCCEEDED' && e.authSynced && e.containerStopped && e.agent?.status === 'passed' && e.agent.exitCode === 0 && e.checks.length > 0 && e.checks.every(c=>['SUCCEEDED','succeeded','passed'].includes(c.status) && c.process?.status === 'passed' && c.process.exitCode === 0 && c.credentialsAbsent === true && c.sourceUnchanged === true);
}
function assertPrivateSubmission(value: CloudSubmission): void {
  // The port may persist credential IDs, never credential contents or HTTP headers.
  const inspect = (item: unknown): void => {
    if (!item || typeof item !== 'object') return;
    for (const [key,child] of Object.entries(item)) {
      if (/^(?:authorization|headers|controlToken|access_token|refresh_token|apiKey|password|secret|credentials)$/i.test(key)) throw Object.assign(new DomainError('Unsafe Cloudflare submission',502),{retryable:false});
      inspect(child);
    }
  };
  inspect(value);
  if (!value.spec || !value.worktreePath || value.snapshot === undefined) throw Object.assign(new DomainError('Invalid Cloudflare submission',502),{retryable:false});
}

export function createCloudControl(options: CloudControlOptions): CloudControl {
  const {dbPath,port}=options, policy=copy(options.policy), interval=options.pollIntervalMs ?? 2000;
  const executionScope=options.executionScope === undefined ? createHash('sha256').update(JSON.stringify({id:policy.id,name:policy.name,baseCommit:policy.baseCommit,testProfile:policy.testProfile,testCommand:policy.testCommand})).digest('hex') : text(options.executionScope,'Cloudflare execution scope',256);
  if (!Number.isSafeInteger(interval) || interval < 1) throw new DomainError('Invalid Cloudflare poll interval',400);
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath),{recursive:true});
  const db=new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') chmodSync(dbPath,0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS cloud_tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL, submission TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0, execution_scope TEXT);
    CREATE TABLE IF NOT EXISTS cloud_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cloud_metadata (key TEXT PRIMARY KEY, data TEXT NOT NULL);`);
  if (!db.prepare('PRAGMA table_info(cloud_tasks)').all().some(column=>column.name === 'execution_scope')) db.exec('ALTER TABLE cloud_tasks ADD COLUMN execution_scope TEXT');
  let readyVerifiedAt:number|null=null;
  let closed=false, closing=false, inflight: Promise<void> | null=null, timer: ReturnType<typeof setTimeout> | null=null, closePromise: Promise<void> | null=null;
  const tx = <T>(fn:()=>T):T => { db.exec('BEGIN IMMEDIATE'); try { const out=fn(); db.exec('COMMIT'); return out; } catch(error) { db.exec('ROLLBACK'); throw error; } };
  const ensureOpen = () => { if (closed || closing) throw new DomainError('Cloudflare control is closed',503); };
  const connection = ():CloudConnection => {
    const row=db.prepare("SELECT data FROM cloud_metadata WHERE key='connection'").get();
    return row ? JSON.parse(row.data as string) as CloudConnection : {status:'checking',message:null,checkedAt:null};
  };
  const setConnection = (status:CloudConnection['status']) => db.prepare("INSERT INTO cloud_metadata(key,data) VALUES ('connection',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(JSON.stringify({status,message:status === 'unavailable' ? 'Cloudflare connection unavailable' : null,checkedAt:stamp()}));
  const get = (id:string):StoredCloudTask => {
    const row=db.prepare('SELECT data,submission,cancel_requested,execution_scope FROM cloud_tasks WHERE id=?').get(id);
    if (!row) throw new DomainError('Cloudflare task not found',404);
    return {task:JSON.parse(row.data as string) as CloudTask,submission:row.submission === null ? null : JSON.parse(row.submission as string) as CloudSubmission,cancelRequested:row.cancel_requested === 1,executionScope:row.execution_scope as string|null};
  };
  const save = (record:CloudPrivateTask) => {
    record.task.updatedAt=stamp();
    db.prepare('UPDATE cloud_tasks SET data=?,submission=?,cancel_requested=? WHERE id=?').run(JSON.stringify(record.task),record.submission === null ? null : JSON.stringify(record.submission),record.cancelRequested ? 1 : 0,record.task.id);
  };
  const event = (task:CloudTask,type:string,data:Record<string,unknown>) => db.prepare('INSERT INTO cloud_events(data) VALUES (?)').run(JSON.stringify({taskId:task.id,runId:null,type,at:stamp(),data}));
  const ids = ():string[] => db.prepare('SELECT id FROM cloud_tasks ORDER BY rowid DESC').all().map(r=>r.id as string);
  const active = (task:CloudTask) => task.status === 'running' || task.status === 'queued';
  async function dispatch(id:string):Promise<void> {
    let record=get(id);
    if (!active(record.task)) return;
    if (record.executionScope !== executionScope) {
      tx(()=>{
        record=get(id); if (!active(record.task)) return;
        if (!record.submission && !record.task.remote.jobId) {
          record.task.status='failed'; record.task.remote.phase='CONFIGURATION_CHANGED';
          record.task.summary='Cloudflare execution configuration changed';
        }
        if (record.task.remote.errorCode !== 'CONFIGURATION_CHANGED') {
          record.task.remote.errorCode='CONFIGURATION_CHANGED';
          save(record); event(record.task,'remote.configuration_changed',{});
        }
      });
      return;
    }
    if (record.task.remote.errorCode === 'CONFIGURATION_CHANGED') {
      tx(()=>{record=get(id);record.task.remote.errorCode=null;save(record);event(record.task,'remote.configuration_restored',{});});
    }
    if (!record.submission) {
      tx(()=>{ record=get(id); if (!active(record.task)) return; record.task.status='running'; record.task.remote.phase=record.cancelRequested ? 'CANCELLING' : 'PREPARING'; save(record); });
      if (!active(record.task)) return;
      let submission:CloudSubmission;
      try { submission=await port.prepare(copy(record.task)); assertPrivateSubmission(submission); }
      catch (error) {
        if (error && typeof error === 'object' && 'retryable' in error && error.retryable === false) {
          tx(()=>{
            record=get(id); if (!active(record.task) || record.submission) return;
            record.task.status=record.cancelRequested ? 'cancelled' : 'failed';
            record.task.remote.phase=record.cancelRequested ? 'CANCELLED' : 'PREPARATION_FAILED';
            record.task.summary='Cloudflare source preparation failed';
            save(record); event(record.task,'remote.preparation_failed',{status:record.task.status});
          });
          return;
        }
        throw error;
      }
      tx(()=>{
        record=get(id); if (!active(record.task)) return;
        record.submission=copy(submission); record.task.worktreePath=submission.worktreePath;
        if (record.cancelRequested) { record.task.status='cancelled'; record.task.remote.phase='CANCELLED'; event(record.task,'task.cancelled',{}); }
        else record.task.remote.phase='SUBMITTING';
        save(record);
      });
    }
    record=get(id); if (!active(record.task) || !record.submission) return;
    if (!record.task.remote.jobId) {
      // Persisted submission is replayed exactly after uncertain delivery, including its key.
      const jobId=await port.submit(copy(record.submission));
      tx(()=>{ record=get(id); if (!active(record.task)) return; record.task.status='running'; record.task.remote.jobId=text(jobId,'Cloudflare job id',200); record.task.remote.phase=record.cancelRequested ? 'CANCELLING' : 'RUNNING'; save(record); event(record.task,'remote.submitted',{jobId:record.task.remote.jobId}); });
      record=get(id);
      if (record.cancelRequested && record.task.remote.jobId) await port.cancel(record.task.remote.jobId);
      return;
    }
    const jobId=record.task.remote.jobId;
    if (record.cancelRequested) {
      // Lost cancellation responses must not hide authoritative terminal evidence.
      try { await port.cancel(jobId); } catch { setConnection('unavailable'); }
    }
    const poll=await port.poll(jobId,copy(record.submission));
    tx(()=>{
      record=get(id); if (!active(record.task)) return;
      record.task.remote=projectEvidence(poll.evidence,jobId);
      if (poll.diff !== null) { record.task.diff=safe(poll.diff,180000); record.task.diffTruncated=poll.diffTruncated || poll.diff.length>180000; }
      if (poll.summary !== null) record.task.summary=safe(poll.summary,12000);
      if (record.cancelRequested) {
        record.task.remote.phase='CANCELLING';
        if (poll.terminal && poll.evidence.containerStopped) { record.task.status='cancelled'; record.task.remote.phase=poll.phase; event(record.task,'task.cancelled',{}); }
      } else if (poll.terminal) {
        record.task.status=poll.cancelled && poll.evidence.containerStopped ? 'cancelled' : verified(poll) ? 'awaiting_review' : 'failed';
        event(record.task,'remote.finished',{status:record.task.status,phase:record.task.remote.phase});
      }
      save(record);
    });
  }
  async function cycle():Promise<void> {
    // Runtime-only cache: every server start verifies even a persisted READY state.
    const now=Date.now();
    if (readyVerifiedAt === null || connection().status !== 'ready' || now < readyVerifiedAt || now-readyVerifiedAt >= 30000) {
      try {
        const result=await port.connection(); setConnection(result.status);
        if (result.status !== 'ready') return;
        readyVerifiedAt=Date.now();
      } catch { setConnection('unavailable'); return; }
    }
    await Promise.all(ids().map(async id=>{ try { await dispatch(id); } catch { setConnection('unavailable'); } }));
  }
  function tick():Promise<void> {
    if (closed || closing) return Promise.resolve();
    if (inflight) return inflight;
    inflight=cycle().finally(()=>{ inflight=null; }); return inflight;
  }
  function schedule():void {
    if (closed || closing || timer) return;
    timer=setTimeout(()=>{ timer=null; void tick().finally(()=>{ schedule(); }); },interval); timer.unref();
  }
  const control:CloudControl = {
    capabilities() { ensureOpen(); return {providers:['codex','claude'],repository:copy(policy),connection:connection()}; },
    state() {
      ensureOpen(); const events=db.prepare('SELECT sequence,data FROM cloud_events ORDER BY sequence DESC LIMIT 200').all().reverse().map(r=>({...JSON.parse(r.data as string),sequence:r.sequence}) as HiveEvent);
      return {tasks:ids().map(id=>get(id).task),events,connection:connection()};
    },
    create(input:CreateTask) {
      ensureOpen(); if (connection().status !== 'ready') throw new DomainError('Cloudflare connection is not ready',503);
      if (!input || Object.keys(input).some(k=>!allowedInput.has(k))) throw new DomainError('Invalid Cloudflare task fields',400);
      if (!['codex','claude'].includes(input.provider) || input.runtime !== 'cloudflare') throw new DomainError('Unsupported Cloudflare provider or runtime',422);
      if (input.repositoryId !== policy.id || input.baseCommit !== policy.baseCommit || input.testProfile !== policy.testProfile) throw new DomainError('Invalid Cloudflare repository policy',422);
      const at=stamp(); const task:CloudTask={title:text(input.title,'title',160),instructions:text(input.instructions,'instructions',12000),budgetMicros:money(input.budgetMicros,'budget'),provider:input.provider as CloudTask['provider'],runtime:'cloudflare',repositoryId:policy.id,baseCommit:policy.baseCommit,testProfile:policy.testProfile,testCommand:copy(policy.testCommand),id:'cf-'+randomUUID(),status:'awaiting_execution_approval',createdAt:at,updatedAt:at,runId:null,workerId:null,leaseExpiresAt:null,estimatedCostMicros:null,actualCostMicros:null,diff:null,summary:null,execution:null,remote:initialEvidence(),worktreePath:null,diffTruncated:false};
      return tx(()=>{db.prepare('INSERT INTO cloud_tasks(id,data,execution_scope) VALUES (?,?,?)').run(task.id,JSON.stringify(task),executionScope);event(task,'task.created',{provider:task.provider,runtime:'cloudflare'});return copy(task);});
    },
    decision(id,decision,reason) {
      ensureOpen(); reason=text(reason,'reason'); if (!['approve','reject'].includes(decision)) throw new DomainError('Invalid decision',400);
      return tx(()=>{const record=get(id), stage=record.task.status;if (!['awaiting_execution_approval','awaiting_review'].includes(stage)) throw new DomainError('No approval pending in this state');if (decision === 'approve' && stage === 'awaiting_execution_approval' && record.executionScope !== executionScope) throw new DomainError('Cloudflare execution configuration changed');record.task.status=decision === 'reject' ? 'rejected' : stage === 'awaiting_review' ? 'completed' : 'queued';if (record.task.status === 'queued') record.task.remote.phase='QUEUED'; save(record);event(record.task,'approval.decided',{stage,decision,reason:safe(reason),actor:'operator'});return copy(record.task);});
    },
    cancel(id,reason) {
      ensureOpen();reason=text(reason,'reason');return tx(()=>{const record=get(id);if (terminal.has(record.task.status)) throw new DomainError('Cannot cancel a terminal Cloudflare task');record.cancelRequested=true;
        if (record.task.status === 'running' || (record.submission && record.task.status !== 'awaiting_review')) {record.task.status='running';record.task.remote.phase='CANCELLING';}
        else {record.task.status='cancelled';record.task.remote.phase='CANCELLED';}
        save(record);event(record.task,'task.cancel_requested',{reason:safe(reason),actor:'operator'});return copy(record.task);});
    },
    tick,
    start() { ensureOpen(); if (timer) return; void tick().finally(()=>{schedule();}); },
    close() {
      if (closePromise) return closePromise;
      closing=true;if (timer) {clearTimeout(timer);timer=null;}
      closePromise=(async()=>{await inflight;db.close();closed=true;})(); return closePromise;
    }
  };
  return control;
}
