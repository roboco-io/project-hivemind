import {createHash} from 'node:crypto';
import {summarizeAutonomousTask,pageAutonomousHistory,type AutonomousTaskSummary,type AutonomousHistoryQuery} from './autonomous-repository.ts';
import {validateAutonomousCapabilities,validateAutonomousModelPin,AUTONOMOUS_EXTERNAL_TOOL,autonomousExternalOperation} from '../../contracts/src/autonomous.ts';
import {nextDailyOccurrence} from './autonomous-schedule.ts';
import type { AutonomousSpec, AutonomousStatus, AutonomousTask, AutonomousState, AutonomousLease, AutonomousRunResult, AutonomousActionRequest, AutonomousAction, AutonomousCheckpoint, AutonomousIntervention, AutonomousNativeAuthorization, AutonomousNativeReceipt, AutonomousWorkerState, AutonomousRun } from '../../contracts/src/autonomous.js';

export class AutonomousError extends Error {
  statusCode: number; status: number; commitState: boolean;
  constructor(message: string, statusCode = 400, commitState = false) {
    super(message); this.name='AutonomousError'; this.statusCode=statusCode; this.status=statusCode; this.commitState=commitState;
  }
}
export class AutonomousPageRequiredError extends AutonomousError {readonly code='AUTONOMOUS_PAGE_REQUIRED';constructor(){super('Task history requires bounded pages',413);}}
const MAX_ITEMS=1000, MAX_TASKS=1000, LONG_ITEMS=65536;
// 복구 기록은 실행별 대사와 마지막 취소를 위해 일반 개입과 별도로 보존한다.
function interventionLimit(s:AutonomousSpec) { return historyLimit(s)*2+2; }
// Keep the legacy recovery envelope and reserve one reconciliation per run/action.
function recoveryLimit(s:AutonomousSpec) { return historyLimit(s)*4+2; }
export interface AutonomousOperatorBillingReview {evidenceRef:string;reason:string}
export interface AutonomousOperatorBillingEvidence extends AutonomousOperatorBillingReview {source:'operator_attested';reasonHash:string;at:number}
type ReviewedAction=AutonomousAction & {operatorBillingEvidence?:AutonomousOperatorBillingEvidence};
const BILLING_NOTE_PREFIX='Operator-attested external billing ';
function billingEvidenceRef(value:unknown):asserts value is string{text(value,200);if(!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)||value.includes('://')||safeNote(value)!==value)fail('Invalid billing evidence reference');}
function billingNote(actionId:string,review:AutonomousOperatorBillingReview){const label=safeNote(actionId)===actionId?actionId:createHash('sha256').update(actionId).digest('hex');return safeNote(BILLING_NOTE_PREFIX+label+' '+review.evidenceRef+': '+review.reason);}
function longRunning(s:AutonomousSpec) { return s.execution?.mode==='long_running'; }
function historyLimit(s:AutonomousSpec) { return longRunning(s)?LONG_ITEMS:MAX_ITEMS; }
function cloudDuration(s:AutonomousSpec) { return longRunning(s)?56*24*60*60*1000:600000; }
function validateCloudDeadline(s:AutonomousSpec,createdAt:number) {
  if(s.execution&&s.endsAt-createdAt>cloudDuration(s)) fail('Cloud profile deadline');
}
/** Approved pending daily occurrences may dispatch up to five minutes late. */
const DAILY_DISPATCH_GRACE_MS=300000;
const terminal = new Set<AutonomousStatus>(['completed','cancelled','budget_exceeded','expired','failed']);
const statuses = new Set<AutonomousStatus>(['awaiting_approval','ready','running','waiting','awaiting_input','stopping',...terminal]);
const clone = <T>(x:T):T => structuredClone(x);
function fail(message:string, code=422):never { throw new AutonomousError(message,code); }
function integer(x:unknown, min=0):asserts x is number { if(typeof x!=='number'||!Number.isSafeInteger(x)||x<min) fail('Invalid safe integer'); }
function text(x:unknown,max=256):asserts x is string { if(typeof x!=='string'||!x.trim()||x.length>max) fail('Invalid text'); }
function object(x:unknown):asserts x is Record<string,unknown> { if(!x||typeof x!=='object'||Array.isArray(x)) fail('Invalid object'); }
function array(x:unknown,max=MAX_ITEMS):asserts x is unknown[] { if(!Array.isArray(x)||x.length>max) fail('Invalid bounded array'); }
function keys(x:object, allowed:string[]) { if(Object.keys(x).some(k=>!allowed.includes(k))) fail('Unknown field'); }
function sum(a:number,b:number) { integer(a); integer(b); const n=a+b; integer(n); return n; }
function safeNote(x:string) { text(x,16000); return x.replace(/Bearer\s+[^\s]+/gi,'Bearer [REDACTED]').replace(/(?:AKIA|ASIA)[A-Z0-9]{16}/g,'[REDACTED]').replace(/hf_[A-Za-z0-9]+/g,'[REDACTED]'); }
function validExecutionPins(s:AutonomousSpec):boolean{if(s.provider!=='claude'||!s.execution)return true;try{validateAutonomousModelPin(s.model);if(s.subagentModel!==undefined)validateAutonomousModelPin(s.subagentModel);return true;}catch{return false;}}
function requireExecutionPins(s:AutonomousSpec){if(!validExecutionPins(s))fail('Concrete Claude model pin required; create a new task');}
function validateSpec(s:AutonomousSpec,executionPins=true) {
  object(s); keys(s,['requestId','goal','provider','model','subagentModel','endsAt','budgetMicros','tools','systems','credentialIds','maxRunMs','maxIterations','billingPolicy','execution','schedule','web','externalProfiles']);
  if(s.schedule!==undefined) { try { nextDailyOccurrence(s.schedule,0); } catch { fail('Invalid daily schedule'); } }
  text(s.requestId); text(s.goal,16000); text(s.model); if(s.subagentModel!==undefined) text(s.subagentModel);
  if(!['mock','claude','codex'].includes(s.provider)) fail('Invalid provider');
  if(executionPins)requireExecutionPins(s);
  if(s.billingPolicy!==undefined) { object(s.billingPolicy); keys(s.billingPolicy,['model','budget']); if(s.provider!=='claude'||s.billingPolicy.model!=='subscription'||s.billingPolicy.budget!=='external_actions') fail('Invalid billing policy'); }
  if(s.execution!==undefined) {
    const e=s.execution; object(e); keys(e,['backend','mode','snapshotId','checks']);
    if(e.mode!==undefined&&e.mode!=='pilot'&&e.mode!=='long_running') fail('Invalid cloud mode');
    if(e.backend!=='cloudflare'||s.provider!=='claude'||!s.billingPolicy||s.credentialIds?.length!==1) fail('Invalid cloud profile');
    if(typeof e.snapshotId!=='string'||!/^[a-f0-9]{64}$/.test(e.snapshotId)) fail('Invalid cloud snapshot digest');
    const cliModel=/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
    if(!cliModel.test(s.model)||(s.subagentModel!==undefined&&!cliModel.test(s.subagentModel))) fail('Invalid cloud model syntax');
    try{validateAutonomousCapabilities(s);}catch{fail('Invalid cloud capabilities');}
    const cloudId=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
    if(typeof s.credentialIds[0]!=='string'||!cloudId.test(s.credentialIds[0])||s.goal.includes('\0')) fail('Invalid cloud scheduler input');
    array(e.checks); if(e.checks.length<1||e.checks.length>4) fail('Invalid cloud checks');
    const ids=new Set<string>();
    for(const c of e.checks) {
      object(c); keys(c,['id','argv','timeoutMs']); text(c.id,128);
      if(!cloudId.test(c.id)||ids.has(c.id)) fail('Invalid or duplicate check id'); ids.add(c.id);
      array(c.argv); if(!c.argv.length||c.argv.length>32) fail('Invalid check argv');
      for(const arg of c.argv) { text(arg,1000); if(arg.includes('\0')) fail('Invalid check argument'); }
      integer(c.timeoutMs,1000); if(c.timeoutMs>10000) fail('Cloud check limit');
    }
    if(s.maxIterations>(longRunning(s)?LONG_ITEMS:4)||s.maxRunMs<1000||s.maxRunMs>120000) fail('Cloud profile limit');
  }
  if(s.web!==undefined||s.externalProfiles!==undefined||s.tools?.some(tool=>tool==='WebFetch'||tool===AUTONOMOUS_EXTERNAL_TOOL)){if(s.provider!=='claude')fail('Invalid capability provider');try{validateAutonomousCapabilities(s);}catch{fail('Invalid autonomous capabilities');}}
  integer(s.endsAt,1); integer(s.budgetMicros); integer(s.maxRunMs,1); integer(s.maxIterations,1);
  if(s.maxIterations>historyLimit(s)||s.maxRunMs>86400000) fail('Execution limit too large');
  for(const a of [s.tools,s.systems,s.credentialIds]) { array(a); if(a.length>100) fail('Scope too large'); a.forEach(v=>text(v)); if(new Set(a).size!==a.length) fail('Duplicate scope'); }
}
function checkpoint(c:AutonomousCheckpoint,model:string) {
  object(c); keys(c,['sessionId','objectKey','model','sequence']); text(c.sessionId); text(c.objectKey,2048); text(c.model); integer(c.sequence);
  if(c.model!==model) fail('Checkpoint model mismatch');
}
function quotaFields(r:Pick<AutonomousRunResult,'quota'|'usageUnavailable'|'usage'|'outcome'|'wakeAt'>,t:AutonomousTask,now:number) {
  if(r.quota!==undefined) {
    const q=r.quota; object(q); keys(q,['kind','resetsAt','evidence']); integer(q.resetsAt,1);
    if(q.kind!=='rejected'||q.evidence!=='claude_rate_limit_event'||q.resetsAt<=now||q.resetsAt>=t.spec.endsAt||r.outcome!=='wait'||r.wakeAt!==q.resetsAt||!subscription(t)||t.spec.provider!=='claude') fail('Invalid quota pause');
  }
  if(Object.hasOwn(r,'usageUnavailable')&&(r.usageUnavailable!==true||!r.quota||Object.values(r.usage).some(v=>v!==0))) fail('Invalid quota usage placeholders');
}
function sameQuota(a:AutonomousRunResult['quota'],b:AutonomousRunResult['quota']) {
  return a===undefined?b===undefined:b!==undefined&&a.kind===b.kind&&a.resetsAt===b.resetsAt&&a.evidence===b.evidence;
}
function result(r:AutonomousRunResult,t:AutonomousTask,now:number,quotaAfter=now) {
  object(r); keys(r,['outcome','checkpoint','usage','costMicros','wakeAt','message','quota','usageUnavailable']);
  if(!['continue','wait','input','complete','failed'].includes(r.outcome)) fail('Invalid outcome');
  object(r.usage); keys(r.usage,['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens']);
  for(const k of ['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens'] as const) integer(r.usage[k]);
  if(r.costMicros!==null) integer(r.costMicros);
  if(r.checkpoint!==undefined) { checkpoint(r.checkpoint,t.spec.model); if(t.checkpoint&&(r.checkpoint.sessionId!==t.checkpoint.sessionId||r.checkpoint.sequence<=t.checkpoint.sequence)) fail('Checkpoint identity or sequence mismatch'); }
  if(r.wakeAt!==undefined) integer(r.wakeAt);
  if(r.outcome==='wait'&&(r.wakeAt===undefined||r.wakeAt<=(r.quota?quotaAfter:now)||r.wakeAt>=t.spec.endsAt)) fail('Wait requires a future wake before deadline');
  quotaFields(r,t,quotaAfter);
  if(r.quota&&(r.costMicros!==null||!r.checkpoint||r.checkpoint.sequence!==sum(t.checkpoint?.sequence??0,1))) fail('Quota requires next checkpoint');
  if(r.message!==undefined) safeNote(r.message);
}

function subscription(t:AutonomousTask) { return t.spec.billingPolicy!==undefined; }
function unknownRun(r:AutonomousRun) { return r.costMicros===null&&r.reconciledCostMicros===undefined&&r.billingEvidence===undefined; }
function recoveryReservations(t:AutonomousTask) {
  return t.runs.filter(unknownRun).length+t.actions.filter(a=>a.status==='reserved'||a.status==='unknown'||a.status==='accepted').length+(t.lease?1:0);
}
function receipt(r:AutonomousNativeReceipt,t:AutonomousTask,runId:string,now=t.activeRunStartedAt!) {
  object(r); keys(r,['runId','runtimeId','sessionId','model','sequence','usage','stopped','outcome','wakeAt','quota','usageUnavailable']);
  for(const v of [r.runId,r.runtimeId,r.sessionId,r.model]) text(v); integer(r.sequence);
  object(r.usage); keys(r.usage,['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens']);
  for(const k of ['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens'] as const) integer(r.usage[k]);
  if(!['continue','wait','input','complete','failed'].includes(r.outcome)) fail('Invalid receipt outcome');
  if(r.wakeAt!==undefined) integer(r.wakeAt);
  if(r.outcome==='wait'&&(r.wakeAt===undefined||r.wakeAt>=t.spec.endsAt)) fail('Invalid receipt wake');
  quotaFields(r,t,now);
  if(!subscription(t)||r.stopped!==true||r.runId!==runId||r.runtimeId!==t.nativeRuntimeId||r.model!==t.spec.model||r.sequence!==sum(t.checkpoint?.sequence??0,1)||
    (t.checkpoint&&r.sessionId!==t.checkpoint.sessionId)) fail('Invalid native receipt');
}
function sameReceipt(a:AutonomousNativeReceipt,b:AutonomousNativeReceipt) {
  return ['runId','runtimeId','sessionId','model','sequence','stopped','outcome','wakeAt','usageUnavailable'].every(k=>a[k as keyof AutonomousNativeReceipt]===b[k as keyof AutonomousNativeReceipt])&&
    sameQuota(a.quota,b.quota)&&(['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens'] as const).every(k=>a.usage[k]===b.usage[k]);
}

type ResourceInput = {id:string; system:string; cleanupOperation:string};

export type AutonomousExternalTaskView=Pick<AutonomousTask,'id'|'spec'|'revision'|'status'|'approvedAt'|'iteration'|'nextRunAt'|'spentMicros'|'reservedMicros'|'actions'|'resources'> & {lease?:Omit<AutonomousLease,'token'>};
export interface AutonomousPersistenceRecord {id:string;json:string;summary:AutonomousTaskSummary;credentialOwner:{credentialIds:string[];blocked:boolean}}
type AtomicFrame={parent?:AtomicFrame;drafts:Map<string,AutonomousTask>};
export class AutonomousEngine {
  private state:AutonomousState;
  private frame?:AtomicFrame;
  constructor(state?:AutonomousState,options:{ownership?:'defensive'|'exclusive'}={}) {
    this.state={version:1,tasks:{}};
    if(state!==undefined) { this.validateState(state); this.state=options.ownership==='exclusive'?state:clone(state); }
  }
  *persistenceRecords():IterableIterator<AutonomousPersistenceRecord>{
    for(const task of Object.values(this.state.tasks))yield {id:task.id,json:JSON.stringify(task),summary:summarizeAutonomousTask(task),credentialOwner:{credentialIds:[...task.spec.credentialIds],blocked:task.spec.provider!=='mock'&&!!(task.lease||task.runs.some(unknownRun))}};
  }
  getExternalTask(id:string):AutonomousExternalTaskView{
    const t=this.task(id),view:AutonomousExternalTaskView={id:t.id,spec:clone(t.spec),revision:t.revision,status:t.status,iteration:t.iteration,spentMicros:t.spentMicros,reservedMicros:t.reservedMicros,actions:clone(t.actions),resources:clone(t.resources)};
    if(t.approvedAt!==undefined)view.approvedAt=t.approvedAt;if(t.nextRunAt!==undefined)view.nextRunAt=t.nextRunAt;
    if(t.lease){const {token:_token,...lease}=t.lease;view.lease=lease;}return view;
  }
  getSummary(id:string):AutonomousTaskSummary{return summarizeAutonomousTask(this.task(id));}
  historyPage(input:Record<string,unknown>,secret?:string){if(secret===undefined)fail('Store history secret required',503);const {id,kind,...query}=input as unknown as AutonomousHistoryQuery;return pageAutonomousHistory(this.task(id),kind,query,secret);}
  snapshot():AutonomousState { return clone(this.state); }
  get(id:string,maxBytes?:number):AutonomousTask {const task=this.task(id);if(maxBytes!==undefined){integer(maxBytes,1);if(Buffer.byteLength(JSON.stringify(task),'utf8')>maxBytes)throw new AutonomousPageRequiredError();}return this.public(task);}
  list(maxBytes?:number):AutonomousTask[] {
    const tasks=Object.values(this.state.tasks);if(maxBytes!==undefined){integer(maxBytes,1);let bytes=2;for(let i=0;i<tasks.length;i++){bytes+=Buffer.byteLength(JSON.stringify(tasks[i]),'utf8')+(i?1:0);if(bytes>maxBytes)throw new AutonomousPageRequiredError();}}
    return tasks.map(t=>this.public(t));
  }
  private public(t:AutonomousTask) { const copy=clone(t); delete copy.nativeRuntimeId; delete copy.nativeReceipt; if(copy.lease) delete copy.lease.token; copy.counts={humanInterventions:copy.interventions.filter(i=>i.kind!=='help').length,helpRequests:copy.interventions.filter(i=>i.kind==='help').length,toolCalls:copy.actions.length}; return copy; }
  private task(id:string) {
    text(id);let t=Object.hasOwn(this.state.tasks,id)?this.state.tasks[id]:undefined;if(!t)fail('Task not found',404);
    if(this.frame&&!this.frame.drafts.has(id)){
      t={...t,runs:[...t.runs],interventions:[...t.interventions],actions:[...t.actions],resources:[...t.resources],...(t.lease?{lease:{...t.lease}}:{})};
      this.state.tasks[id]=t;this.frame.drafts.set(id,t);
    }
    return t;
  }
  private mutableRecord<T extends object>(records:T[],value:T):T{const index=records.indexOf(value);if(index<0)fail('Missing draft record');const copy={...value};records[index]=copy;return copy;}
  private atomic<T>(fn:()=>T):T {
    const before=this.state,parent=this.frame,frame:AtomicFrame={parent,drafts:new Map()};
    this.state={version:1,tasks:{...before.tasks}};this.frame=frame;
    const commit=()=>{
      if(!parent)return;
      for(const [id] of frame.drafts){const current=this.state.tasks[id]!,owned=parent.drafts.get(id);
        if(owned&&owned!==current){for(const key of Object.keys(owned))if(!Object.hasOwn(current,key))delete (owned as unknown as Record<string,unknown>)[key];Object.assign(owned,current);this.state.tasks[id]=owned;}
        else parent.drafts.set(id,current);
      }
    };
    try{const value=fn();commit();return value;}
    catch(e){if(e instanceof AutonomousError&&e.commitState)commit();else this.state=before;throw e;}
    finally{this.frame=parent;}
  }
  private note(t:AutonomousTask,kind:AutonomousIntervention['kind'],message:string,now:number,billing=false) {
    if(message.startsWith(BILLING_NOTE_PREFIX)&&!billing)fail('Reserved billing audit prefix');
    const cancelled=t.interventions.some(i=>i.kind==='cancel');
    if(kind==='cancel'&&cancelled) return;
    const limit=kind==='cancel'?recoveryLimit(t.spec):kind==='reconciliation'?recoveryLimit(t.spec)-(cancelled?0:1):kind==='help'?interventionLimit(t.spec)-1:historyLimit(t.spec);
    if(t.interventions.length>=limit) fail('Intervention limit');
    if(t.interventions.length+1+recoveryReservations(t)-(kind==='reconciliation'?1:0)+(cancelled||kind==='cancel'?0:1)>recoveryLimit(t.spec)) fail('Recovery capacity reserved');
    t.interventions.push({kind,message:safeNote(message),at:now,revision:t.revision});
  }
  create(spec:AutonomousSpec,now:number,id:string):AutonomousTask { return this.atomic(()=>{
    integer(now); text(id); validateSpec(spec); if(spec.endsAt<=now) fail('Deadline has passed'); validateCloudDeadline(spec,now);
    if(Object.hasOwn(this.state.tasks,id)) fail('Task ID conflict',409);
    const prior=Object.values(this.state.tasks).find(t=>t.spec.requestId===spec.requestId);
    if(prior) { if(JSON.stringify(prior.spec)!==JSON.stringify(spec)) fail('Request conflict',409); return this.public(prior); }
    if(Object.keys(this.state.tasks).length>=MAX_TASKS) fail('Task limit');
    const t:AutonomousTask={id,spec:clone(spec),revision:1,status:'awaiting_approval',createdAt:now,iteration:0,runs:[],actions:[],resources:[],interventions:[],spentMicros:0,reservedMicros:0};
    Object.defineProperty(this.state.tasks,id,{value:t,writable:true,enumerable:true,configurable:true}); return this.public(t);
  }); }
  approve(id:string,revision:number,reason:string,now:number):AutonomousTask { return this.atomic(()=>{
    integer(now); integer(revision,1); const t=this.task(id);requireExecutionPins(t.spec);
    if(t.status!=='awaiting_approval'||t.revision!==revision||now>=t.spec.endsAt) fail('Stale approval',409);
    this.note(t,'approval',reason,now); t.approvedAt=now; t.status='ready'; this.scheduleNext(t,now); return this.public(t);
  }); }
  revise(id:string,spec:AutonomousSpec,reason:string,now:number):AutonomousTask { return this.atomic(()=>{
    integer(now); validateSpec(spec); const t=this.task(id);
    if(t.lease||terminal.has(t.status)||t.status==='stopping'||this.unresolved(t)||t.runs.some(unknownRun)) fail('Task cannot be revised',409);
    if(t.iteration>0&&(['web','externalProfiles','systems'] as const).some(key=>JSON.stringify(spec[key])!==JSON.stringify(t.spec[key]))) fail('Capabilities are immutable after claim');
    if(t.iteration>0&&JSON.stringify(spec.schedule)!==JSON.stringify(t.spec.schedule)) fail('Schedule is immutable after claim');
    if(t.iteration>0&&JSON.stringify(spec.execution)!==JSON.stringify(t.spec.execution)) fail('Cloud source and checks are immutable',409);
    validateCloudDeadline(spec,t.createdAt);
    if(t.iteration>0&&(spec.billingPolicy!==undefined)!==subscription(t)) fail('Billing policy cannot change after claim',409);
    if(spec.requestId!==t.spec.requestId||spec.provider!==t.spec.provider||spec.model!==t.spec.model||spec.subagentModel!==t.spec.subagentModel) fail('Immutable identity/model');
    if(spec.endsAt<=now||spec.budgetMicros<t.spentMicros||spec.maxIterations<=t.iteration) fail('Invalid revised limits');
    if(t.actions.some(a=>!spec.tools.includes(a.tool)||!spec.systems.includes(a.system))) fail('Historical action scope must be retained');
    if(t.resources.some(r=>r.status!=='cleaned'&&!spec.systems.includes(r.system))) fail('Resource scope cannot be removed');
    if(t.resources.some(r=>r.status==='cleanup_pending')) fail('Cleanup must finish before revision',409);
    if(t.createdAt>=spec.endsAt||t.runs.some(r=>r.finishedAt>=spec.endsAt||(r.wakeAt!==undefined&&r.wakeAt>=spec.endsAt))) fail('Revised deadline invalidates history');
    t.spec=clone(spec); t.revision=sum(t.revision,1); delete t.approvedAt; delete t.nextRunAt; delete t.stopReason; t.status='awaiting_approval'; this.note(t,'revision',reason,now); return this.public(t);
  }); }
  claim(id:string,workerId:string,token:string,runId:string,now:number):AutonomousLease|null {
    if(this.task(id).spec.execution) return null;
    return this.claimInternal(id,workerId,token,runId,now);
  }
  claimCloud(id:string,workerId:string,token:string,runId:string,now:number):AutonomousLease|null {
    const t=this.task(id); if(!t.spec.execution||t.approvedAt===undefined) return null;
    if(t.lease) { const l=t.lease;if(!(now<l.expiresAt&&t.status==='running'&&l.workerId===workerId&&l.token===token&&l.runId===runId))return null;if(!validExecutionPins(t.spec)){this.atomic(()=>this.stop(this.task(id),'cancelled','Concrete Claude model pin required; create a new task',now));return null;}return clone(l as AutonomousLease); }
    return this.claimInternal(id,workerId,token,runId,now);
  }
  private claimInternal(id:string,workerId:string,token:string,runId:string,now:number):AutonomousLease|null { return this.atomic(()=>{
    integer(now); text(workerId); text(token); text(runId); const t=this.task(id); this.advance(t,now);
    if(t.status!=='ready'||t.lease||this.unresolved(t)||t.runs.some(unknownRun)) return null;
    if(!validExecutionPins(t.spec)){this.stop(t,'cancelled','Concrete Claude model pin required; create a new task',now);return null;}
    if(!this.scheduleNext(t,now)) return null;
    // Credential lanes live in central state, so separate workers cannot bypass them.
    // Even an expired lease remains quarantined until tick and manual reconciliation.
    if(t.spec.provider!=='mock'&&Object.values(this.state.tasks).some(other=>
      other.id!==t.id&&other.spec.provider!=='mock'&&
      other.spec.credentialIds.some(id=>t.spec.credentialIds.includes(id))&&
      (other.lease!==undefined||other.runs.some(unknownRun)))) return null;
    if(t.runs.some(r=>r.runId===runId)) fail('Run ID reused',409);
    if(t.iteration>=t.spec.maxIterations) { this.stop(t,'completed','Iteration limit',now); return null; }
    if(t.spentMicros>=t.spec.budgetMicros) { this.stop(t,'budget_exceeded','Budget exhausted',now); return null; }
    const expiresAt=Math.min(t.spec.endsAt,sum(now,Math.min(30000,t.spec.maxRunMs)));
    if(t.spec.schedule) { t.activeScheduleAt=t.nextRunAt!; t.lastScheduleKey=nextDailyOccurrence(t.spec.schedule,t.activeScheduleAt,t.lastScheduleKey).key; }
    delete t.nextRunAt;
    t.activeRunStartedAt=now; t.lease={taskId:id,workerId,token,runId,expiresAt}; t.iteration=sum(t.iteration,1); t.status='running'; return clone(t.lease as AutonomousLease);
  }); }
  private authorize(lease:AutonomousLease,now:number,allowStopped=false):AutonomousTask {
    integer(now); object(lease); keys(lease,['taskId','workerId','runId','token','expiresAt']); text(lease.taskId); text(lease.runId); text(lease.workerId); text(lease.token); integer(lease.expiresAt);
    const t=this.task(lease.taskId), l=t.lease;
    if(now<t.createdAt||(t.activeRunStartedAt!==undefined&&now<t.activeRunStartedAt)) fail('Timestamp precedes task or run');
    if(!l||l.token!==lease.token||l.runId!==lease.runId||l.workerId!==lease.workerId||l.taskId!==lease.taskId||now>=l.expiresAt||now>=t.spec.endsAt) fail('Stale lease',409);
    if(!allowStopped&&t.status!=='running') fail('Execution suspended',409);
    return t;
  }
  nativeStart(lease:AutonomousLease,runtimeId:string,now:number):AutonomousNativeAuthorization { return this.atomic(()=>{
    text(runtimeId); const t=this.authorize(lease,now);
    if(!validExecutionPins(t.spec)){this.stop(t,'cancelled','Concrete Claude model pin required; create a new task',now);throw new AutonomousError('Concrete Claude model pin required',409,true);}
    if(t.spec.provider!=='claude'||t.approvedAt===undefined||t.stopReason) fail('Native execution not approved',409);
    if(t.nativeRuntimeId!==undefined&&t.nativeRuntimeId!==runtimeId) fail('Native runtime already bound',409);
    const deadline=Math.min(sum(t.activeRunStartedAt!,t.spec.maxRunMs),t.spec.endsAt);
    if(now>=deadline) fail('Native execution expired',409);
    t.nativeRuntimeId=runtimeId;
    return {taskId:t.id,spec:clone(t.spec),...(t.checkpoint?{checkpoint:clone(t.checkpoint)}:{}),deadline};
  }); }
  workerState(id:string):AutonomousWorkerState {
    const t=this.task(id); return {taskId:t.id,status:t.status,endsAt:t.spec.endsAt,iteration:t.iteration,...(t.nextRunAt!==undefined?{nextRunAt:t.nextRunAt}:{})};
  }
  nativeReady(lease:AutonomousLease,runtimeId:string,now:number):{ready:true} { return this.atomic(()=>{
    text(runtimeId); const t=this.authorize(lease,now);
    if(!subscription(t)||t.spec.provider!=='claude'||t.nativeRuntimeId!==runtimeId||t.nativeReceipt||t.stopReason) fail('Native reporter not ready',409);
    return {ready:true};
  }); }
  recordNativeReceipt(lease:AutonomousLease,value:AutonomousNativeReceipt,now:number):{recorded:true} { return this.atomic(()=>{
    const t=this.authorize(lease,now); receipt(value,t,lease.runId,value?.quota?t.activeRunStartedAt!:now);
    if(t.nativeReceipt&&!sameReceipt(t.nativeReceipt,value)) fail('Native receipt conflict',409);
    t.nativeReceipt=clone(value); return {recorded:true};
  }); }
  heartbeat(lease:AutonomousLease,now:number):AutonomousLease { return this.atomic(()=>{
    const t=this.authorize(lease,now);
    t.lease!.expiresAt=Math.min(sum(now,30000),sum(t.activeRunStartedAt!,t.spec.maxRunMs),t.spec.endsAt);
    return clone(t.lease as AutonomousLease);
  }); }
  finish(lease:AutonomousLease,r:AutonomousRunResult,now:number):AutonomousTask {
    if(this.task(lease.taskId).spec.execution) fail('Cloud finish is private',409);
    return this.finishInternal(lease,r,now);
  }
  finishCloud(lease:AutonomousLease,r:AutonomousRunResult,checksPassed:boolean,now:number):AutonomousTask { return this.atomic(()=>{
    if(!this.task(lease.taskId).spec.execution||typeof checksPassed!=='boolean') fail('Invalid cloud finish',409);
    if(!this.task(lease.taskId).nativeReceipt) fail('Matching stopped native receipt required',409);
    const finished=this.finishInternal(lease,r,now);
    if(!checksPassed) {
      // Independent verification changes task policy, never the receipt-attested model result.
      const t=this.task(lease.taskId);
      if(!t.stopReason||t.stopReason.startsWith('completed:')||t.stopReason.startsWith('failed:')) this.stop(t,'failed','Cloud quality verification failed',now);
      return this.public(t);
    }
    return finished;
  }); }
  finishUnstartedCloud(lease:AutonomousLease,now:number):AutonomousTask { return this.atomic(()=>{
    const t=this.authorize(lease,now,true);
    if(!t.spec.execution||t.nativeRuntimeId!==undefined||t.nativeReceipt!==undefined) fail('Cloud run may have started',409);
    return this.finishInternal(lease,{outcome:'failed',costMicros:0,usage:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0}},now);
  }); }
  abandonCloud(lease:AutonomousLease,now:number):AutonomousTask { return this.atomic(()=>{
    integer(now); const t=this.task(lease.taskId);
    if(!t.spec.execution) fail('Not a cloud profile',409);
    if(!t.lease&&t.runs.some(r=>r.runId===lease.runId&&r.workerId===lease.workerId)) return this.public(t);
    const l=t.lease;
    if(!l||l.runId!==lease.runId||l.token!==lease.token||l.workerId!==lease.workerId||now<t.activeRunStartedAt!) fail('Stale cloud lease',409);
    // Preserve unknown billing and stop intent. No manufactured zero-cost failure or human cancel.
    l.expiresAt=Math.min(l.expiresAt,Math.max(now,sum(t.activeRunStartedAt!,1)));
    this.advance(t,l.expiresAt);return this.public(t);
  }); }
  private finishInternal(lease:AutonomousLease,r:AutonomousRunResult,now:number):AutonomousTask { return this.atomic(()=>{
    const t=this.authorize(lease,now,true);object(r);
    // A previously recorded stopped receipt may precede a slow verifier. Keep its reset unchanged.
    if(r.quota&&t.nativeReceipt)receipt(t.nativeReceipt,t,lease.runId);
    result(r,t,now,r.quota&&t.nativeReceipt?t.activeRunStartedAt!:now);
    if(t.runs.length>=historyLimit(t.spec)) fail('Run limit');
    let evidence:AutonomousRun['billingEvidence'];
    if(subscription(t)) {
      const preflight=r.outcome==='failed'&&r.costMicros===0&&!r.checkpoint&&!t.nativeRuntimeId&&!t.nativeReceipt&&Object.values(r.usage).every(v=>v===0);
      if(!preflight) {
        const n=t.nativeReceipt,c=r.checkpoint;
        if(r.costMicros!==null||!n||!c||!sameQuota(n.quota,r.quota)||n.usageUnavailable!==r.usageUnavailable||n.outcome!==r.outcome||n.wakeAt!==r.wakeAt||n.sessionId!==c.sessionId||n.model!==c.model||n.sequence!==c.sequence||
          (['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens'] as const).some(k=>n.usage[k]!==r.usage[k])) fail('Matching stopped native receipt required',409);
        evidence='subscription_runtime';
      }
    }
    const cost=subscription(t)||r.costMicros===null?0:r.costMicros; const spent=sum(t.spentMicros,cost); sum(spent,t.reservedMicros);
    const saved=clone(r); if(saved.message) saved.message=safeNote(saved.message);
    t.runs.push({...saved,...(t.activeScheduleAt!==undefined?{scheduledAt:t.activeScheduleAt}:{}),...(evidence?{billingEvidence:evidence}:{}),runId:lease.runId,workerId:lease.workerId,startedAt:t.activeRunStartedAt!,finishedAt:now});
    t.spentMicros=spent; delete t.lease; delete t.activeRunStartedAt; delete t.activeScheduleAt; delete t.nativeRuntimeId; delete t.nativeReceipt;
    if(r.checkpoint) t.checkpoint=clone(r.checkpoint);
    for(let i=0;i<t.actions.length;i++)if(t.actions[i]!.status==='reserved')t.actions[i]={...t.actions[i]!,status:'unknown'};
    if(t.stopReason) { this.finalize(t); return this.public(t); }
    // Retain terminal intent while billing/actions/cleanup remain unresolved.
    // A worker cannot turn a scope suspension into a terminal decision.
    if(t.status==='running'&&(r.outcome==='complete'||r.outcome==='failed')) {
      if(t.spentMicros>=t.spec.budgetMicros) this.stop(t,'budget_exceeded','Budget exhausted',now);
      else if(r.outcome==='complete') this.stop(t,'completed','Execution complete',now);
      else this.stop(t,'failed','Executor failed',now);
      return this.public(t);
    }
    if(this.unresolved(t)||t.runs.some(unknownRun)) { this.help(t,'Unresolved action or unknown run cost',now); return this.public(t); }
    if(t.spentMicros>=t.spec.budgetMicros) this.stop(t,'budget_exceeded','Budget exhausted',now);
    else if(t.status==='awaiting_input') { /* Scope suspension requires a revised approval. */ }
    else if(r.outcome==='complete'||t.iteration>=t.spec.maxIterations) this.stop(t,'completed','Execution complete',now);
    else if(r.outcome==='failed') this.stop(t,'failed','Executor failed',now);
    else if(r.outcome==='input') this.help(t,r.message??'Operator input required',now);
    else if(r.outcome==='wait') { t.status='waiting'; t.nextRunAt=r.wakeAt; }
    else t.status='ready';
    if(t.status==='ready'||t.status==='waiting'){
      // A result wake is a lower bound, never an already approved daily occurrence.
      if(t.spec.schedule)delete t.nextRunAt;
      this.scheduleNext(t,r.outcome==='wait'?Math.max(now,r.wakeAt!):now,now);
    }
    return this.public(t);
  }); }
  cancel(id:string,reason:string,now:number):AutonomousTask { return this.atomic(()=>{
    integer(now); const t=this.task(id); if(terminal.has(t.status)||(longRunning(t.spec)&&t.stopReason?.startsWith('cancelled:'))) return this.public(t);
    this.note(t,'cancel',reason,now); this.stop(t,'cancelled','Operator cancelled',now); this.advance(t,now); return this.public(t);
  }); }
  message(id:string,message:string,now:number):AutonomousTask { return this.atomic(()=>{
    integer(now); const t=this.task(id); if(terminal.has(t.status)||t.status==='stopping') fail('Task is stopping or terminal',409);
    this.note(t,'message',message,now); // Messages never grant scope, reconcile money, or approve execution.
    return this.public(t);
  }); }
  reserve(lease:AutonomousLease,request:AutonomousActionRequest,now:number):AutonomousAction { return this.atomic(()=>{
    const t=this.authorize(lease,now); object(request); keys(request,['requestId','tool','system','operation','estimatedCostMicros']);
    text(request.requestId); text(request.tool); text(request.system); text(request.operation); integer(request.estimatedCostMicros);
    const prior=t.actions.find(a=>a.requestId===request.requestId);
    if(prior) { if(['tool','system','operation','estimatedCostMicros'].some(k=>prior[k as keyof AutonomousAction]!==request[k as keyof AutonomousActionRequest])) fail('Reservation conflict',409); return clone(prior); }
    if(!t.spec.tools.includes(request.tool)||!t.spec.systems.includes(request.system)||(request.tool===AUTONOMOUS_EXTERNAL_TOOL&&(!t.spec.externalProfiles?.length||!autonomousExternalOperation(request.system,request.operation)))) { this.help(t,'Requested action exceeds approved scope',now); throw new AutonomousError('Action outside approved scope',422,true); }
    const reserved=sum(t.reservedMicros,request.estimatedCostMicros);
    if(sum(t.spentMicros,reserved)>t.spec.budgetMicros) { this.stop(t,'budget_exceeded','Action exceeds budget',now); throw new AutonomousError('Budget exceeded',422,true); }
    if(t.actions.length>=historyLimit(t.spec)) fail('Action limit');
    const a:AutonomousAction={...clone(request),id:`${t.id}:action:${t.actions.length+1}`,status:'reserved'};
    t.actions.push(a); t.reservedMicros=reserved; return clone(a);
  }); }
  /** Trusted bridge only: ownership is proved before this operation, never by model input. */
  acceptExternal(lease:AutonomousLease,actionId:string,resource:ResourceInput|undefined,now:number):AutonomousAction { return this.atomic(()=>{
    const t=this.authorize(lease,now,true),found=t.actions.find(action=>action.id===actionId);if(!found)fail('Action not found',404);let a:AutonomousAction=found;
    if(a.tool!==AUTONOMOUS_EXTERNAL_TOOL||!t.spec.externalProfiles?.length||!t.spec.systems.includes(a.system)||!autonomousExternalOperation(a.system,a.operation))fail('External action scope required',409);
    if(resource){object(resource);keys(resource,['id','system','cleanupOperation']);text(resource.id);text(resource.system);text(resource.cleanupOperation);if(resource.system!==a.system)fail('Resource system mismatch');}
    const prior=t.resources.find(r=>r.actionId===a.id);
    if(a.status==='accepted'){
      if(JSON.stringify(prior?{id:prior.id,system:prior.system,cleanupOperation:prior.cleanupOperation}:undefined)!==JSON.stringify(resource))fail('Acceptance conflict',409);
      return clone(a);
    }
    if(!['reserved','unknown'].includes(a.status)||a.actualCostMicros!==undefined||a.resourceId!==undefined)fail('Action cannot be accepted',409);
    a=this.mutableRecord(t.actions,a);
    if(resource){
      if(t.resources.some(r=>r.id===resource.id)||t.resources.length>=historyLimit(t.spec))fail('Resource identity or capacity conflict',409);
      a.resourceId=resource.id;t.resources.push({...clone(resource),actionId:a.id,status:t.stopReason||t.status==='awaiting_input'?'cleanup_pending':'active'});
    }
    a.status='accepted';return clone(a);
  }); }
  /** Trusted verified billing; resource identity is always read from the canonical ledger. */
  settleExternal(id:string,actionId:string,actualCostMicros:number,success:boolean,now:number,review?:AutonomousOperatorBillingReview):AutonomousAction { return this.atomic(()=>{
    integer(now);const t=this.task(id),a=t.actions.find(action=>action.id===actionId);if(!a)fail('Action not found',404);
    if(a.tool!==AUTONOMOUS_EXTERNAL_TOOL||!t.spec.externalProfiles?.length||!t.spec.systems.includes(a.system)||!['reserved','unknown','accepted','succeeded','failed'].includes(a.status)||!autonomousExternalOperation(a.system,a.operation))fail('External action scope required',409);
    const prior=t.resources.find(r=>r.actionId===a.id);
    if((a.status==='reserved'||a.status==='unknown')&&(prior||a.resourceId!==undefined)||prior&&prior.status!=='cleaned')fail('Confirmed external resource absence required',409);
    const resource=prior?{id:prior.id,system:prior.system,cleanupOperation:prior.cleanupOperation}:undefined;
    integer(actualCostMicros);if(typeof success!=='boolean')fail('Invalid success');
    let evidence:AutonomousOperatorBillingEvidence|undefined;
    if(review!==undefined){object(review);keys(review,['evidenceRef','reason']);billingEvidenceRef(review.evidenceRef);text(review.reason,1000);const reason=safeNote(review.reason);text(reason,1000);
      evidence={source:'operator_attested',evidenceRef:review.evidenceRef,reason,reasonHash:createHash('sha256').update(reason).digest('hex'),at:now};
      const saved=(a as ReviewedAction).operatorBillingEvidence;
      if(a.status==='succeeded'||a.status==='failed'){
        if(!saved||saved.evidenceRef!==evidence.evidenceRef||saved.reasonHash!==evidence.reasonHash||saved.reason!==evidence.reason)fail('Operator billing evidence conflict',409);
      }else this.note(t,'reconciliation',billingNote(a.id,evidence),now,true);
    }
    const settled=this.settleAction(t,a,actualCostMicros,success,resource,true) as ReviewedAction;
    if(evidence&&!settled.operatorBillingEvidence)settled.operatorBillingEvidence={...evidence};
    return clone(settled);
  }); }
  private settleAction(t:AutonomousTask,a:AutonomousAction,cost:number,success:boolean,resource:ResourceInput|undefined,external=false):AutonomousAction {
    integer(cost); if(typeof success!=='boolean') fail('Invalid success');
    if(resource) { object(resource); keys(resource,['id','system','cleanupOperation']); text(resource.id); text(resource.system); text(resource.cleanupOperation); if(resource.system!==a.system) fail('Resource system mismatch'); }
    if(a.status==='succeeded'||a.status==='failed') {
      const prior=t.resources.find(r=>r.actionId===a.id);
      if(a.actualCostMicros!==cost||(a.status==='succeeded')!==success||JSON.stringify(prior?{id:prior.id,system:prior.system,cleanupOperation:prior.cleanupOperation}:undefined)!==JSON.stringify(resource)) fail('Settlement conflict',409);
      return a;
    }
    const prior=external?t.resources.find(r=>r.actionId===a.id):undefined;
    if(resource&&t.resources.some(r=>r.id===resource.id&&r!==prior)) fail('Resource ID reused',409);
    if(resource&&!prior&&t.resources.length>=historyLimit(t.spec)) fail('Resource limit');
    const spent=sum(t.spentMicros,cost); integer(t.reservedMicros-a.estimatedCostMicros);
    sum(spent,t.reservedMicros-a.estimatedCostMicros);
    a=this.mutableRecord(t.actions,a);
    t.spentMicros=spent; t.reservedMicros-=a.estimatedCostMicros; a.actualCostMicros=cost; a.status=success?'succeeded':'failed';
    if(resource&&!prior) { a.resourceId=resource.id; t.resources.push({...clone(resource),actionId:a.id,status:t.stopReason||t.status==='awaiting_input'?'cleanup_pending':'active'}); }
    if(t.spentMicros>=t.spec.budgetMicros&&!t.stopReason) this.stop(t,'budget_exceeded','Budget exhausted',0);
    this.finalize(t);return a;
  }
  settle(lease:AutonomousLease,actionId:string,actualCostMicros:number,success:boolean,resource:ResourceInput|undefined,now:number):AutonomousAction { return this.atomic(()=>{
    const t=this.authorize(lease,now,true); const a=t.actions.find(a=>a.id===actionId); if(!a) fail('Action not found',404);
    if(a.tool===AUTONOMOUS_EXTERNAL_TOOL)fail('Trusted external settlement required',409);
    return clone(this.settleAction(t,a,actualCostMicros,success,resource));
  }); }
  reconcile(id:string,actionId:string,actualCostMicros:number,success:boolean,resource:ResourceInput|undefined,reason:string,now:number):AutonomousTask { return this.atomic(()=>{
    integer(now); const t=this.task(id); this.advance(t,now);
    if(t.lease) fail('Live owner must settle',409); const a=t.actions.find(a=>a.id===actionId); if(!a) fail('Action not found',404);
    if(a.tool===AUTONOMOUS_EXTERNAL_TOOL)fail('Trusted external settlement required',409);
    if(a.status==='reserved'&&t.status!=='stopping') fail('Action has not lost its owner',409);
    if(a.status==='succeeded'||a.status==='failed') { this.settleAction(t,a,actualCostMicros,success,resource); return this.public(t); }
    this.note(t,'reconciliation',reason,now); this.settleAction(t,a,actualCostMicros,success,resource); return this.public(t);
  }); }
  resume(id:string,revision:number,reason:string,now:number):AutonomousTask { return this.atomic(()=>{
    integer(now); integer(revision,1); const t=this.task(id);requireExecutionPins(t.spec);
    if(t.status!=='awaiting_input'||t.revision!==revision||t.approvedAt===undefined||t.lease||this.unresolved(t)||t.runs.some(unknownRun)||t.stopReason||now>=t.spec.endsAt||t.spentMicros>=t.spec.budgetMicros||t.iteration>=t.spec.maxIterations||t.resources.some(r=>r.status==='cleanup_pending')) fail('Task cannot resume',409);
    this.note(t,'approval',reason,now); t.status='ready'; this.scheduleNext(t,now); return this.public(t);
  }); }
  reconcileRun(id:string,runId:string,cost:number,reason:string,now:number):AutonomousTask { return this.atomic(()=>{
    integer(now); integer(cost); const t=this.task(id); if(t.lease) fail('Live owner cannot be reconciled',409);
    const r=t.runs.find(r=>r.runId===runId); if(!r) fail('Run not found',404);
    if(now<r.finishedAt) fail('Reconciliation precedes finished run');
    if(r.costMicros!==null) fail('Run cost is already known',409);
    if(subscription(t)) {
      if(cost!==0||r.billingEvidence==='subscription_runtime') fail('Subscription reconciliation requires unresolved stopped run and zero amount',409);
      if(r.billingEvidence==='subscription_operator') return this.public(t);
      this.note(t,'reconciliation',reason,now); this.mutableRecord(t.runs,r).billingEvidence='subscription_operator';
      this.advance(t,now); this.finalize(t); return this.public(t);
    }
    if(r.reconciledCostMicros!==undefined) { if(r.reconciledCostMicros!==cost) fail('Run reconciliation conflict',409); return this.public(t); }
    const spent=sum(t.spentMicros,cost); sum(spent,t.reservedMicros);
    this.note(t,'reconciliation',reason,now); t.spentMicros=spent; this.mutableRecord(t.runs,r).reconciledCostMicros=cost;
    if(t.spentMicros>=t.spec.budgetMicros&&!t.stopReason) this.stop(t,'budget_exceeded','Budget exhausted',now);
    this.advance(t,now); this.finalize(t); return this.public(t);
  }); }
  /** Private bridge operation: provider absence is proved outside core, never by the worker. */
  cleanedExternal(id:string,resourceId:string,now:number):AutonomousTask { return this.atomic(()=>{
    integer(now);const t=this.task(id),r=t.resources.find(resource=>resource.id===resourceId);if(!r)fail('Resource not found',404);
    const a=t.actions.find(action=>action.id===r.actionId);
    if(!a||a.resourceId!==r.id||a.system!==r.system||a.tool!==AUTONOMOUS_EXTERNAL_TOOL||!t.spec.externalProfiles?.length||!t.spec.systems.includes(r.system)||!autonomousExternalOperation(a.system,a.operation)||!['accepted','succeeded','failed'].includes(a.status))fail('External resource scope required',409);
    this.mutableRecord(t.resources,r).status='cleaned';this.finalize(t);return this.public(t);
  }); }
  cleaned(id:string,resourceId:string,now:number):AutonomousTask { return this.atomic(()=>{
    integer(now); const t=this.task(id); const r=t.resources.find(r=>r.id===resourceId); if(!r) fail('Resource not found',404);
    if(t.actions.some(a=>a.id===r.actionId&&a.tool===AUTONOMOUS_EXTERNAL_TOOL))fail('Trusted external absence proof required',409);
    if(r.status==='active') fail('Resource is not pending cleanup',409); this.mutableRecord(t.resources,r).status='cleaned'; this.advance(t,now); this.finalize(t); return this.public(t);
  }); }
  /** Broker-observed cost overrun stops the task through the existing budget stop. No-op when already stopping or terminal. */
  stopExternalBudget(id:string,reason:string,now:number):AutonomousTask { return this.atomic(()=>{
    integer(now); text(id); text(reason); const t=this.task(id);
    if(terminal.has(t.status)||t.status==='stopping'||t.stopReason) return this.public(t);
    this.stop(t,'budget_exceeded',reason,now); this.advance(t,now); return this.public(t);
  }); }
  /** Read-only lease check for worker-reported tool audit. Never mutates the task. */
  toolAuditScope(lease:AutonomousLease,now:number):{taskId:string;runId:string;iteration:number} {
    const t=this.authorize(lease,now,true); return {taskId:t.id,runId:lease.runId,iteration:t.iteration};
  }
  tick(now:number):void { this.atomic(()=>{ integer(now); for(const id of Object.keys(this.state.tasks))this.advance(this.task(id),now); }); }
  private unresolved(t:AutonomousTask) { return t.actions.some(a=>a.status==='reserved'||a.status==='unknown'); }
  private help(t:AutonomousTask,message:string,now:number) { this.note(t,'help',message,now); t.status='awaiting_input'; for(let i=0;i<t.resources.length;i++)if(t.resources[i]!.status==='active')t.resources[i]={...t.resources[i]!,status:'cleanup_pending'}; }
  private stop(t:AutonomousTask,status:AutonomousStatus,reason:string,_now:number) {
    t.stopReason=`${status}: ${reason}`; t.status='stopping'; delete t.nextRunAt;
    for(let i=0;i<t.resources.length;i++)if(t.resources[i]!.status==='active')t.resources[i]={...t.resources[i]!,status:'cleanup_pending'}; this.finalize(t);
  }
  private finalize(t:AutonomousTask) {
    if(!t.stopReason||t.lease||this.unresolved(t)||t.actions.some(a=>a.status==='accepted')||t.resources.some(r=>r.status!=='cleaned')||t.runs.some(unknownRun)) return;
    t.status=t.stopReason.split(':')[0] as AutonomousStatus;
  }
  /** Central schedule gate; never grants execution authority or alters approval. */
  private scheduleNext(t:AutonomousTask,after:number,now=after):boolean {
    if(!t.spec.schedule) return t.status==='ready';
    if(t.stopReason||terminal.has(t.status)) return false;
    if(t.nextRunAt!==undefined&&after>=t.nextRunAt&&after-t.nextRunAt<=DAILY_DISPATCH_GRACE_MS) { t.status='ready'; return true; }
    let wakeAt:number;
    try { wakeAt=nextDailyOccurrence(t.spec.schedule,after,t.lastScheduleKey).wakeAt; }
    catch { this.stop(t,'expired','No schedule occurrence within range',after); return false; }
    if(wakeAt>=t.spec.endsAt) { this.stop(t,'expired','No schedule occurrence before deadline',after); return false; }
    // after may be an executor-requested lower bound, so compare against actual finish separately.
    if(wakeAt===now) { t.status='ready'; t.nextRunAt=wakeAt; return true; }
    t.status='waiting'; t.nextRunAt=wakeAt; return false;
  }
  private advance(t:AutonomousTask,now:number) {
    if(terminal.has(t.status)) return;
    if(now>=t.spec.endsAt&&!t.stopReason) this.stop(t,'expired','Deadline reached',now);
    if(t.lease&&now>=t.lease.expiresAt) {
      t.runs.push({runId:t.lease.runId,workerId:t.lease.workerId,startedAt:t.activeRunStartedAt!,finishedAt:t.lease.expiresAt,
        ...(t.activeScheduleAt!==undefined?{scheduledAt:t.activeScheduleAt}:{}),outcome:'failed',costMicros:null,usageUnavailable:true,usage:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0},message:'Lease expired; usage unavailable, billing requires reconciliation'});
      delete t.lease; delete t.activeRunStartedAt; delete t.activeScheduleAt; delete t.nativeRuntimeId; delete t.nativeReceipt; for(let i=0;i<t.actions.length;i++)if(t.actions[i]!.status==='reserved')t.actions[i]={...t.actions[i]!,status:'unknown'};
      if(t.stopReason) this.finalize(t);
      else if(this.unresolved(t)||t.runs.some(unknownRun)||!t.checkpoint||t.status==='awaiting_input') this.help(t,'Lost lease requires operator review',now);
      else if(t.iteration>=t.spec.maxIterations) this.stop(t,'completed','Iteration limit',now);
      else t.status='ready';
    }
    if(t.status==='waiting'&&t.nextRunAt!==undefined&&now>=t.nextRunAt) { if(!t.spec.schedule) delete t.nextRunAt; t.status='ready'; }
    this.finalize(t);
  }
  private validateState(state:AutonomousState) {
    object(state); keys(state,['version','tasks']); if(state.version!==1) fail('Unsupported state version'); object(state.tasks);
    if(Object.keys(state.tasks).length>MAX_TASKS) fail('Task limit'); const requests=new Set<string>();
    for(const [id,t] of Object.entries(state.tasks)) {
      object(t); keys(t,['id','spec','revision','status','createdAt','approvedAt','nextRunAt','lastScheduleKey','activeScheduleAt','iteration','activeRunStartedAt','nativeRuntimeId','nativeReceipt','lease','checkpoint','runs','actions','resources','interventions','spentMicros','reservedMicros','stopReason']);
      text(id); if(t.id!==id) fail('Task ID mismatch'); validateSpec(t.spec,false); if(requests.has(t.spec.requestId)) fail('Duplicate request'); requests.add(t.spec.requestId);
      integer(t.revision,1); integer(t.createdAt); validateCloudDeadline(t.spec,t.createdAt); integer(t.iteration); integer(t.spentMicros); integer(t.reservedMicros);
      if(!statuses.has(t.status)||t.iteration>t.spec.maxIterations||t.createdAt>=t.spec.endsAt) fail('Invalid task state');
      if(t.approvedAt!==undefined) { integer(t.approvedAt); if(t.approvedAt<t.createdAt||t.approvedAt>=t.spec.endsAt) fail('Invalid approval time'); }
      if(t.nextRunAt!==undefined) { integer(t.nextRunAt); if(t.nextRunAt>=t.spec.endsAt||!['ready','waiting'].includes(t.status)||t.status==='ready'&&!t.spec.schedule) fail('Invalid pending wake'); }
      if(t.lastScheduleKey!==undefined) {
        if(!t.spec.schedule||t.iteration===0) fail('Unexpected schedule key');
        try { nextDailyOccurrence(t.spec.schedule,0,t.lastScheduleKey); } catch { fail('Invalid schedule key'); }
      }
      if(t.spec.schedule) {
        const starts=[...t.runs.map(r=>({at:r.scheduledAt??r.startedAt,actual:r.startedAt})),...(t.activeRunStartedAt!==undefined?[{at:t.activeScheduleAt??t.activeRunStartedAt,actual:t.activeRunStartedAt}]:[])];
        let last:string|undefined;
        for(const {at,actual} of starts) {
          if(actual<at||actual-at>DAILY_DISPATCH_GRACE_MS||!t.interventions.some(i=>i.kind==='approval'&&i.at<=at)) fail('Invalid scheduled dispatch time');
          const occurrence=nextDailyOccurrence(t.spec.schedule,at);
          if(occurrence.wakeAt!==at||(last!==undefined&&occurrence.key<=last)) fail('Invalid scheduled run history');
          last=occurrence.key;
        }
        if(last!==t.lastScheduleKey) fail('Schedule key does not match history');
        if(['ready','waiting'].includes(t.status)&&t.nextRunAt!==undefined&&nextDailyOccurrence(t.spec.schedule,t.nextRunAt,last).wakeAt!==t.nextRunAt) fail('Waiting outside approved schedule');
      }
      if(t.activeScheduleAt!==undefined) { integer(t.activeScheduleAt); if(!t.spec.schedule||!t.lease) fail('Unexpected active schedule'); }
      if(!t.spec.schedule&&t.runs.some(r=>r.scheduledAt!==undefined)) fail('Unexpected scheduled run');
      if(t.spec.schedule&&t.nextRunAt!==undefined&&t.nextRunAt<t.approvedAt!) fail('Pending occurrence before approval');
      if(t.status==='waiting'&&(t.nextRunAt===undefined||t.nextRunAt>=t.spec.endsAt)) fail('Invalid waiting state');
      if(t.status!=='awaiting_approval'&&t.approvedAt===undefined&&t.status!=='cancelled'&&t.status!=='expired'&&t.status!=='stopping') fail('Missing approval');
      if(t.stopReason!==undefined) { text(t.stopReason,16000); const end=t.stopReason.split(':')[0] as AutonomousStatus; if(!terminal.has(end)) fail('Invalid stop reason'); }
      if(t.checkpoint!==undefined) checkpoint(t.checkpoint,t.spec.model);
      if(t.nativeRuntimeId!==undefined) { text(t.nativeRuntimeId); if(!t.lease||t.spec.provider!=='claude'||t.approvedAt===undefined) fail('Invalid native runtime binding'); }
      if(t.lease) {
        object(t.lease); keys(t.lease,['taskId','runId','workerId','token','expiresAt']); text(t.lease.token); text(t.lease.runId); text(t.lease.workerId); integer(t.lease.expiresAt); integer(t.activeRunStartedAt); if(t.activeRunStartedAt<t.createdAt||t.lease.expiresAt>sum(t.activeRunStartedAt,t.spec.maxRunMs)) fail('Invalid run time boundary');
        if(t.lease.taskId!==id||t.lease.expiresAt>t.spec.endsAt||t.lease.expiresAt<=t.createdAt||!['running','awaiting_input','stopping'].includes(t.status)||t.iteration===0) fail('Invalid persisted lease');
      } else if(t.status==='running'||t.activeRunStartedAt!==undefined) fail('Running without lease');
      if(t.nativeReceipt!==undefined) { if(!t.lease) fail('Receipt without active run'); receipt(t.nativeReceipt,t,t.lease.runId); }
      const limit=historyLimit(t.spec);
      array(t.runs,limit); array(t.actions,limit); array(t.resources,limit);
      array(t.interventions,recoveryLimit(t.spec));
      let spent=0,reserved=0; const runIds=new Set<string>();
      let previous:AutonomousCheckpoint|undefined;
      for(const r of t.runs) {
        object(r); keys(r,['outcome','checkpoint','usage','costMicros','wakeAt','message','runId','workerId','startedAt','finishedAt','reconciledCostMicros','usageUnavailable','billingEvidence','quota','scheduledAt']); text(r.runId); text(r.workerId); integer(r.startedAt); integer(r.finishedAt);
        if(r.startedAt<t.createdAt||r.finishedAt<r.startedAt||r.finishedAt>t.spec.endsAt||(r.finishedAt===t.spec.endsAt&&(r.outcome!=='failed'||r.costMicros!==null))||runIds.has(r.runId)) fail('Invalid run history'); runIds.add(r.runId);
        if(!r.quota&&Object.hasOwn(r,'usageUnavailable')&&(r.usageUnavailable!==true||r.outcome!=='failed'||r.costMicros!==null||r.checkpoint!==undefined||r.wakeAt!==undefined||r.finishedAt<=r.startedAt)) fail('Invalid unavailable usage record');
        const {runId:_run,workerId:_worker,startedAt:_start,finishedAt:_finish,reconciledCostMicros:_reconciled,usageUnavailable:_unavailable,billingEvidence:_evidence,scheduledAt:_scheduled,...outcome}=r;
        if(r.quota&&r.billingEvidence!=='subscription_runtime') fail('Quota lacks runtime evidence');
        result({...outcome,...(r.quota&&Object.hasOwn(r,'usageUnavailable')?{usageUnavailable:r.usageUnavailable}:{})},{...t,checkpoint:previous},r.finishedAt,r.quota?r.startedAt:r.finishedAt);
        if(r.billingEvidence==='subscription_runtime'&&r.checkpoint&&r.checkpoint.sequence!==sum(previous?.sequence??0,1)) fail('Invalid subscription checkpoint sequence');
        if(r.checkpoint) previous=r.checkpoint;
        if(r.usageUnavailable&&Object.values(r.usage).some(value=>value!==0)) fail('Unavailable usage must have zero placeholders');
        if(r.message&&r.message!==safeNote(r.message)) fail('Unredacted run message');
        if(r.reconciledCostMicros!==undefined) { integer(r.reconciledCostMicros); if(r.costMicros!==null) fail('Known cost cannot be reconciled'); }
        if(r.billingEvidence!==undefined) {
          if(!subscription(t)||t.spec.provider!=='claude'||r.costMicros!==null||r.reconciledCostMicros!==undefined||!['subscription_runtime','subscription_operator'].includes(r.billingEvidence)) fail('Invalid billing evidence');
          if(r.billingEvidence==='subscription_operator'&&(!r.usageUnavailable||!t.interventions.some(i=>i.kind==='reconciliation'&&i.at>=r.finishedAt))) fail('Operator evidence lacks stopped review');
          if(r.billingEvidence==='subscription_runtime'&&(r.usageUnavailable&&!r.quota||!r.checkpoint)) fail('Invalid runtime evidence');
        }
        if(subscription(t)) {
          if(r.reconciledCostMicros!==undefined||r.costMicros!==null&&(r.costMicros!==0||r.outcome!=='failed'||r.checkpoint||Object.values(r.usage).some(v=>v!==0))) fail('Invalid subscription run cost');
          if(r.costMicros===null&&!r.usageUnavailable&&r.billingEvidence!=='subscription_runtime') fail('Missing runtime evidence');
        }
        if(!subscription(t)&&(r.costMicros!==null||r.reconciledCostMicros!==undefined)) spent=sum(spent,r.costMicros??r.reconciledCostMicros!);
      }
      if(t.runs.length+(t.lease?1:0)!==t.iteration||(t.lease&&runIds.has(t.lease.runId))) fail('Invalid iteration history');
      if(JSON.stringify(previous)!==JSON.stringify(t.checkpoint)) fail('Checkpoint is not committed history');
      const actionIds=new Set<string>(), actionRequests=new Set<string>();
      const billingNotes=new Map<string,number>(),usedBillingNotes=new Set<string>();
      for(const i of t.interventions)if(i.kind==='reconciliation'&&typeof i.message==='string'&&i.message.startsWith(BILLING_NOTE_PREFIX)){const key=JSON.stringify([i.at,i.message]);billingNotes.set(key,(billingNotes.get(key)??0)+1);}
      for(const a of t.actions) {
        object(a); keys(a,['id','requestId','tool','system','operation','estimatedCostMicros','status','actualCostMicros','resourceId','operatorBillingEvidence']);
        for(const v of [a.id,a.requestId,a.tool,a.system,a.operation]) text(v);
        integer(a.estimatedCostMicros); if(actionIds.has(a.id)||actionRequests.has(a.requestId)) fail('Duplicate action'); actionIds.add(a.id); actionRequests.add(a.requestId);
        if(!t.spec.tools.includes(a.tool)||!t.spec.systems.includes(a.system)||(a.tool===AUTONOMOUS_EXTERNAL_TOOL&&(!t.spec.externalProfiles?.length||!autonomousExternalOperation(a.system,a.operation)))) fail('Persisted action outside scope');
        if(!['reserved','accepted','succeeded','failed','unknown'].includes(a.status)) fail('Invalid action status');
        if(a.status==='reserved'||a.status==='unknown'||a.status==='accepted') { if(a.actualCostMicros!==undefined||(a.status!=='accepted'&&a.resourceId!==undefined)) fail('Unsettled action has settlement'); reserved=sum(reserved,a.estimatedCostMicros); }
        else { integer(a.actualCostMicros); spent=sum(spent,a.actualCostMicros); }
        if(a.status==='accepted'&&(a.tool!==AUTONOMOUS_EXTERNAL_TOOL||!t.spec.externalProfiles?.length))fail('Invalid accepted external action');
        if(a.status==='reserved'&&!t.lease) fail('Reservation without owner');
        if(a.resourceId!==undefined) text(a.resourceId);
        const evidence=(a as ReviewedAction).operatorBillingEvidence;
        if(evidence!==undefined){object(evidence);keys(evidence,['source','evidenceRef','reason','reasonHash','at']);
          if(evidence.source!=='operator_attested'||a.tool!==AUTONOMOUS_EXTERNAL_TOOL||!['succeeded','failed'].includes(a.status))fail('Invalid operator billing provenance');
          billingEvidenceRef(evidence.evidenceRef);text(evidence.reason,1000);if(evidence.reason!==safeNote(evidence.reason)||typeof evidence.reasonHash!=='string'||evidence.reasonHash!==createHash('sha256').update(evidence.reason).digest('hex'))fail('Invalid operator billing review');integer(evidence.at);if(evidence.at<t.createdAt)fail('Invalid billing review time');
          const key=JSON.stringify([evidence.at,billingNote(a.id,evidence)]);if(billingNotes.get(key)!==1||usedBillingNotes.has(key))fail('Billing evidence requires one human reconciliation');usedBillingNotes.add(key);
        }
      }
      if(t.spentMicros!==spent||t.reservedMicros!==reserved) fail('Ledger totals mismatch'); sum(spent,reserved);
      const resourceIds=new Set<string>(),resourceActions=new Set<string>();
      for(const r of t.resources) {
        object(r); keys(r,['id','system','cleanupOperation','status','actionId']); for(const v of [r.id,r.system,r.cleanupOperation,r.actionId]) text(v);
        const a=t.actions.find(a=>a.id===r.actionId);
        if(!a||a.resourceId!==r.id||a.system!==r.system||resourceIds.has(r.id)||resourceActions.has(r.actionId)||!['active','cleanup_pending','cleaned'].includes(r.status)) fail('Invalid resource ledger');
        resourceIds.add(r.id); resourceActions.add(r.actionId);
        if(t.stopReason&&r.status==='active') fail('Stopping resource not pending cleanup');
      }
      if(t.actions.some(a=>a.resourceId&&!resourceIds.has(a.resourceId))) fail('Missing resource');
      for(const i of t.interventions) {
        object(i); keys(i,['kind','message','at','revision']); if(!['approval','message','help','revision','reconciliation','cancel'].includes(i.kind)) fail('Invalid intervention');
        if(i.message.startsWith(BILLING_NOTE_PREFIX)&&!usedBillingNotes.has(JSON.stringify([i.at,i.message])))fail('Unbound billing audit event');
        integer(i.at); integer(i.revision,1); if(i.revision>t.revision||i.at<t.createdAt||safeNote(i.message)!==i.message) fail('Invalid intervention history');
      }
      // 기존 기본 프로필의 유효한 이력은 그대로 복원하고 확장된 이력에는 복구 예약을 검사한다.
      if(longRunning(t.spec)||t.interventions.length>MAX_ITEMS) {
        const cancellations=t.interventions.filter(i=>i.kind==='cancel').length;
        if(cancellations>1||t.interventions.length-cancellations>recoveryLimit(t.spec)-1||
          t.interventions.length+recoveryReservations(t)+(cancellations?0:1)>recoveryLimit(t.spec)||
          t.interventions.filter(i=>!['reconciliation','cancel'].includes(i.kind)).length>interventionLimit(t.spec)-1||
          t.interventions.filter(i=>!['help','reconciliation','cancel'].includes(i.kind)).length>historyLimit(t.spec)) fail('Invalid intervention capacity');
      }
      if(t.approvedAt!==undefined&&!t.interventions.some(i=>i.kind==='approval'&&i.revision===t.revision&&i.at===t.approvedAt)) fail('Approval lacks history');
      if(t.status==='awaiting_approval'&&(t.approvedAt!==undefined||t.lease||t.stopReason)) fail('Invalid unapproved state');
      if(t.status==='stopping'&&!t.stopReason) fail('Stopping without reason');
      if(t.stopReason&&!terminal.has(t.status)&&t.status!=='stopping') fail('Stop reason on executable state');
      if((t.status==='ready'||t.status==='waiting'||t.status==='running')&&t.resources.some(r=>r.status==='cleanup_pending')) fail('Runnable task has pending cleanup');
      if(terminal.has(t.status)&&(t.lease||this.unresolved(t)||t.actions.some(a=>a.status==='accepted')||t.resources.some(r=>r.status!=='cleaned')||t.runs.some(unknownRun)||!t.stopReason||!t.stopReason.startsWith(t.status+':'))) fail('Premature terminal state');
      if((t.status==='ready'||t.status==='waiting')&&(this.unresolved(t)||t.runs.some(unknownRun)||t.stopReason)) fail('Unsafe runnable state');
    }
  }
}
