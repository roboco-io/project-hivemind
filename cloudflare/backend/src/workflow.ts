import type {TeamState,TeamObservation} from '../../../packages/contracts/src/team.ts';
import type {CheckSpec, JobSpec, Snapshot, SourceFile} from './contracts.ts';
import {terminal} from './contracts.ts';
import {SchedulerError, validateJobSpec} from './scheduler.ts';
import {canonicalSourcePath, createSnapshot, sha256} from './snapshot.ts';

export interface WorkflowWorker extends Omit<JobSpec, 'snapshotId' | 'idempotencyKey'> {
  writes: string[];
}
export interface WorkflowSpec {
  snapshotId: string;
  contractPath: string;
  contractHash: string;
  idempotencyKey: string;
  workers: [WorkflowWorker, WorkflowWorker];
  integration: CheckSpec;
  concurrency?:1|2;
  instance?:'standard-1'|'standard-3'|'standard-4';
}
export interface WorkflowRecord {
  id: string;
  spec: WorkflowSpec;
  status: 'DRAFT' | 'RUNNING' | 'INTEGRATING' | 'SUCCEEDED' | 'FAILED';
  createdAt: number;
  approvedAt?: number;
  deadline?: number;
  finishedAt?: number;
  workerIds?: [string, string];
  integrationId?: string;
  outputSnapshotId?: string;
  errorCode?: string;
  team?:TeamState;
}
/** Never serialize the private ledger through workflow endpoints. */
export function publicWorkflow(workflow: WorkflowRecord) {
  const {team: _privateTeam, ...safe} = workflow as WorkflowRecord & {team?:unknown};
  return {...structuredClone(safe),...(workflow.team?.spec?{teamSummary:{id:workflow.team.spec.id,workflowId:workflow.team.spec.workflowId,status:workflow.team.status,blocked:workflow.team.status==='blocked',recoveryRequired:workflow.team.tasks.some(t=>t.status==='recovery_required'),taskCounts:Object.fromEntries(['pending','claimed','submitted','verified','failed','recovery_required'].map(status=>[status,workflow.team!.tasks.filter(t=>t.status===status).length])),reviewed:!!workflow.team.review,endsAt:workflow.team.spec.endsAt,...(workflow.team.block?{block:structuredClone(workflow.team.block)}:{})}}:{})};
}
/** Created only by the approved workflow transaction. Job binding is trusted observation. */
export async function createWorkflowTeam(workflow:WorkflowRecord,now:number):Promise<void> {
  const {TeamEngine}=await import('../../../packages/core/src/team.ts');
  const engine=new TeamEngine();
  engine.create({id:workflow.id,workflowId:workflow.id,contractHash:workflow.spec.contractHash,
    endsAt:workflow.deadline!,maxConcurrentClaims:workflow.spec.concurrency??2,
    members:[...workflow.spec.workers.map((w,i)=>({id:`worker-${i}`,role:'worker' as const,writes:w.writes})),{id:'verifier',role:'verifier',writes:[]}],
    tasks:[...workflow.spec.workers.map((w,i)=>({id:`root-${i}`,title:`Worker ${i+1}`,dependencies:[],writes:w.writes,assignee:`worker-${i}`})),{id:'integration',title:'Independent integration',dependencies:['root-0','root-1'],writes:[],assignee:'verifier'}],
  },now);
  workflow.team=engine.snapshot();
}
/** Cancellation uses the existing engine: ownership remains held until actual stop/auth recovery. */
export function enforceWorkflowTeamBlock(workflow:WorkflowRecord,scheduler:import('./scheduler.ts').Scheduler,now:number):boolean {
  if(!workflow.team||workflow.team.status!=='blocked')return false;
  Object.assign(workflow,{status:'FAILED',errorCode:'TEAM_SAFETY_BLOCKED',finishedAt:workflow.finishedAt??now});
  const ids=new Set([...(workflow.workerIds??[]),...(workflow.integrationId?[workflow.integrationId]:[])]);
  for(const id of ids){
    const job=scheduler.get(id);
    for(const child of [...job.childIds,...(job.checkpoint?.checkIds??[]),...(job.checkpointHistory??[]).flatMap(c=>c.checkIds)])ids.add(child);
    for(const child of Object.values(scheduler.state.jobs))if(child.parentId===id)ids.add(child.id);
    scheduler.requestCancel(id,now);
  }
  return true;
}
function trustedCheckProof(job:import('./contracts.ts').JobRecord,scheduler:import('./scheduler.ts').Scheduler):boolean {
  if(job.status!=='SUCCEEDED'||!job.containerStopped||!job.resultKey)return false;
  if(job.kind==='compute')return true;
  const checks=job.childIds.map(id=>scheduler.get(id));
  return job.authSynced&&!!job.outputSnapshotId&&checks.length===job.checks.length&&checks.length>0&&
    checks.every(check=>check.status==='SUCCEEDED'&&check.containerStopped&&!!check.resultKey&&check.snapshotId===job.outputSnapshotId);
}
/** Bind the trusted receipts without exposing private artifact object paths. */
function teamEvidenceRef(job:import('./contracts.ts').JobRecord,scheduler:import('./scheduler.ts').Scheduler):string|undefined {
  if(!job.resultKey)return undefined;
  const receipt=(record:import('./contracts.ts').JobRecord)=>({jobId:record.id,attempt:record.attempt,
    resultKey:record.resultKey,snapshotId:record.snapshotId,outputSnapshotId:record.outputSnapshotId});
  return 'result:'+sha256(JSON.stringify({job:receipt(job),checks:job.childIds.map(id=>receipt(scheduler.get(id))).sort((a,b)=>a.jobId.localeCompare(b.jobId))}));
}
/** Project only gateway state. A worker submission is never an independent success fact. */
export async function observeWorkflowTeam(workflow:WorkflowRecord,scheduler:import('./scheduler.ts').Scheduler,now:number):Promise<void> {
  if(!workflow.team)return;
  const {TeamEngine}=await import('../../../packages/core/src/team.ts');
  const facts:TeamObservation[]=[];
  const entries=[...(workflow.workerIds??[]).map((id,i)=>({id,memberId:`worker-${i}`,taskId:`root-${i}`})),...(workflow.integrationId?[{id:workflow.integrationId,memberId:'verifier',taskId:'integration'}]:[])];
  for(const {id,memberId,taskId} of entries){
    const job=scheduler.get(id);
    if(job.status==='QUEUED')continue;
    const checkProof=trustedCheckProof(job,scheduler);
    const independentlyVerified=checkProof&&(job.kind==='compute'?job.snapshotId===workflow.outputSnapshotId:
      workflow.status==='INTEGRATING'||workflow.status==='SUCCEEDED');
    const member=workflow.team.spec.members.find(m=>m.id===memberId)!;
    const assigned=workflow.team.tasks.filter(t=>t.id===taskId);
    const status=workflow.team.status==='blocked'?(job.containerStopped&&job.authSynced?'stopped':undefined):independentlyVerified?'verified':checkProof?'candidate':terminal(job.status)?'failed':
      job.status==='VERIFYING'?'candidate':'running';
    if(!status)continue;
    const evidenceRef=teamEvidenceRef(job,scheduler);
    const bound=member.jobId===job.id&&member.attempt===job.attempt;
    if(bound&&(status==='running'||status==='stopped'&&member.stopped||
      status==='verified'&&assigned.every(t=>t.status==='verified'&&t.evidenceRef===evidenceRef)||
      status==='candidate'&&assigned.every(t=>t.status==='submitted'||t.status==='verified')||
      status==='failed'&&workflow.team.status==='failed'))continue;
    facts.push({memberId,taskId,jobId:job.id,attempt:job.attempt,status,
      ...(evidenceRef?{evidenceRef}:{}),snapshotId:job.outputSnapshotId??job.snapshotId,
      checksPassed:independentlyVerified,containerStopped:job.containerStopped,authSynced:job.authSynced,requiresAuthSync:job.kind==='agent'});
  }
  const engine=new TeamEngine(workflow.team);engine.observe(workflow.team.spec.id,facts,now);
  if(workflow.status==='FAILED'&&workflow.errorCode!=='TEAM_SAFETY_BLOCKED')engine.fail(workflow.team.spec.id,{reason:workflow.errorCode??'WORKFLOW_FAILED'},now);
  engine.tick(workflow.team.spec.id,now);
  workflow.team=engine.snapshot();
  enforceWorkflowTeamBlock(workflow,scheduler,now);
}
function object(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) {
    throw new SchedulerError('Invalid workflow fields', 400);
  }
  return value as Record<string, unknown>;
}
export function validateWorkflowSpec(value: unknown): WorkflowSpec {
  const raw = object(value, ['snapshotId','contractPath','contractHash','idempotencyKey','workers','integration','concurrency','instance']);
  if (!Array.isArray(raw.workers) || raw.workers.length !== 2 ||
      typeof raw.contractHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.contractHash)) {
    throw new SchedulerError('Expected a contract hash and exactly two workers', 400);
  }
  if(raw.concurrency!==undefined&&raw.concurrency!==1&&raw.concurrency!==2)throw new SchedulerError('Invalid workflow concurrency',400);
  if(raw.instance!==undefined&&raw.instance!=='standard-1'&&raw.instance!=='standard-3'&&raw.instance!=='standard-4')throw new SchedulerError('Invalid workflow instance',400);
  const contractPath = canonicalSourcePath(raw.contractPath);
  const workers = raw.workers.map(value => {
    const {writes, ...worker} = object(value, ['provider','credentialId','instructions','checks','timeoutMs','writes','model','effort']);
    const {snapshotId: _snapshot, idempotencyKey: _key, ...job} =
      validateJobSpec({...worker, snapshotId:raw.snapshotId, idempotencyKey:raw.idempotencyKey});
    if (!Array.isArray(writes) || writes.length < 1 || writes.length > 32) {
      throw new SchedulerError('Expected one to thirty-two write paths', 400);
    }
    return {...job, writes:writes.map(canonicalSourcePath).sort()};
  }) as [WorkflowWorker, WorkflowWorker];
  const paths = [contractPath, ...workers.flatMap(worker => worker.writes)].map(path => path.toLowerCase()).sort();
  if (workers[0].provider === workers[1].provider ||
      workers[0].credentialId === workers[1].credentialId ||
      paths.some((path, i) => paths.slice(i + 1).some(other => other === path || other.startsWith(path + '/')))) {
    throw new SchedulerError('Workers must use distinct providers and disjoint write paths', 400);
  }
  const {writes: _writes, ...integrationJob} = workers[0];
  const integration = validateJobSpec({...integrationJob, checks:[raw.integration],
    snapshotId:raw.snapshotId, idempotencyKey:raw.idempotencyKey,
  }).checks[0]!;
  return {snapshotId:raw.snapshotId as string, contractPath, contractHash:raw.contractHash,
    idempotencyKey:raw.idempotencyKey as string, workers, integration,
    ...(raw.concurrency!==undefined?{concurrency:raw.concurrency as 1|2}:{}),
    ...(raw.instance!==undefined?{instance:raw.instance as 'standard-1'|'standard-3'|'standard-4'}:{})};
}
export function workflowFingerprint(spec: WorkflowSpec): string {
  return sha256(JSON.stringify(spec));
}
function sameFile(a: SourceFile | undefined, b: SourceFile | undefined): boolean {
  return a?.sha256 === b?.sha256 && a?.executable === b?.executable;
}
export function changedPaths(base: Snapshot, output: Snapshot): string[] {
  const before = new Map(base.files.map(file => [file.path, file]));
  const after = new Map(output.files.map(file => [file.path, file]));
  return [...new Set([...before.keys(), ...after.keys()])].filter(path => !sameFile(before.get(path), after.get(path)));
}
export function mergeWorkflowOutputs(base: Snapshot, outputs: Snapshot[], scopes: string[][]): Snapshot {
  const merged = new Map(base.files.map(file => [file.path, file]));
  const claimed = new Set<string>();
  if (outputs.length !== 2 || scopes.length !== outputs.length) throw new Error('Invalid merge input');
  outputs.forEach((output, i) => {
    const allowed = new Set(scopes[i]);
    const after = new Map(output.files.map(file => [file.path, file]));
    const changed = changedPaths(base, output);
    if (!changed.length) throw new Error('Worker produced no changes');
    for (const path of changed) {
      const key = path.toLowerCase();
      if (!allowed.has(path) || claimed.has(key)) throw new Error('Worker changed a path outside its write scope');
      claimed.add(key);
      const file = after.get(path);
      if (file) merged.set(path, file);
      else merged.delete(path);
    }
  });
  return createSnapshot([...merged.values()]);
}

export async function advanceWorkflow(
  workflow: WorkflowRecord,
  scheduler: import('./scheduler.ts').Scheduler,
  artifacts: {read(id: string): Promise<Snapshot>; write(snapshot: Snapshot): Promise<unknown>},
  now: number,
): Promise<void> {
  await observeWorkflowTeam(workflow,scheduler,now);
  try {
  if(enforceWorkflowTeamBlock(workflow,scheduler,now))return;
  if ((workflow.status === 'RUNNING' || workflow.status === 'INTEGRATING') &&
      workflow.deadline !== undefined && now >= workflow.deadline) {
    const ids = [...(workflow.workerIds ?? []), ...(workflow.integrationId ? [workflow.integrationId] : [])];
    for (const id of ids) scheduler.requestCancel(id, now);
    if (ids.every(id => {
      const job = scheduler.get(id);
      return terminal(job.status) && job.containerStopped &&
        (job.checkpoint?.checkIds ?? []).every(checkId => scheduler.get(checkId).containerStopped);
    })) Object.assign(workflow, {status:'FAILED', errorCode:'WORKFLOW_DEADLINE', finishedAt:now});
    return;
  }
  if (workflow.status === 'RUNNING') {
    const workers = workflow.workerIds!.map(id => scheduler.get(id));
    if (workers.some(job => !terminal(job.status) || !job.containerStopped)) return;
    if (workers.some(job => job.status !== 'SUCCEEDED' || !job.outputSnapshotId || !job.authSynced)) {
      Object.assign(workflow, {status:'FAILED', errorCode:'WORKER_FAILED', finishedAt:now});
      return;
    }
    if(workflow.team&&workers.some(job=>!trustedCheckProof(job,scheduler)))return;
    const [base,...outputs] = await Promise.all([workflow.spec.snapshotId,...workers.map(job => job.outputSnapshotId!)].map(id => artifacts.read(id)));
    let merged: Snapshot;
    try {
      merged = mergeWorkflowOutputs(base!, outputs, workflow.spec.workers.map(worker => worker.writes));
    } catch {
      Object.assign(workflow, {status:'FAILED', errorCode:'MERGE_SCOPE_INVALID', finishedAt:now});
      return;
    }
    await artifacts.write(merged);
    const integration = scheduler.enqueueCompute(merged.digest, workflow.spec.integration, now);
    if(workflow.spec.instance)scheduler.state.jobs[integration.id]!.executionGroup={id:workflow.id,concurrency:workflow.spec.concurrency??2,instance:workflow.spec.instance,dependencyNetwork:true};
    Object.assign(workflow, {status:'INTEGRATING', outputSnapshotId:merged.digest, integrationId:integration.id});
    await observeWorkflowTeam(workflow,scheduler,now);
  } else if (workflow.status === 'INTEGRATING') {
    const integration = scheduler.get(workflow.integrationId!);
    if (!terminal(integration.status) || !integration.containerStopped) return;
    if(workflow.team&&workflow.team.tasks.find(t=>t.id==='integration')?.status!=='verified'&&integration.status==='SUCCEEDED')return;
    Object.assign(workflow, integration.status === 'SUCCEEDED' && integration.snapshotId === workflow.outputSnapshotId
      ? {status:'SUCCEEDED', finishedAt:now}
      : {status:'FAILED', errorCode:'INTEGRATION_CHECK_FAILED', finishedAt:now});
  }
  } finally {
    if(workflow.status==='FAILED')await observeWorkflowTeam(workflow,scheduler,now);
  }
}
