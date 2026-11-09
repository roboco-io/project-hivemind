import {createHash,randomUUID} from 'node:crypto';
import type {CredentialRecord,JobRecord,JobSpec,SchedulerState,Status,CheckSpec} from './contracts.ts';
import {terminal} from './contracts.ts';

export interface AgentOutcome {outputSnapshotId?:string;authGeneration:number;authObjectKey:string;containerStopped:boolean;success:boolean;errorCode?:string;resultKey?:string}
export interface ComputeOutcome {success:boolean;containerStopped:boolean;sourceUnchanged:boolean;resultKey?:string;errorCode?:string}
type State=SchedulerState&{completionReceipts?:Record<string,string>};
export class SchedulerError extends Error {statusCode:number;constructor(message:string,statusCode=409){super(message);this.name='SchedulerError';this.statusCode=statusCode;}}
const copy=<T>(value:T):T=>structuredClone(value);
const own=<T>(values:Record<string,T>,key:string):T|undefined=>Object.hasOwn(values,key)?values[key]:undefined;
const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function object(value:unknown,name:string):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new SchedulerError(`Invalid ${name}`,400);return value as Record<string,unknown>;}
function only(value:Record<string,unknown>,keys:string[],name:string){if(Object.keys(value).some(key=>!keys.includes(key)))throw new SchedulerError(`Unexpected ${name} field`,400);}
function string(value:unknown,name:string,max:number):string {if(typeof value!=='string'||!value.trim()||value.length>max||value.includes('\0'))throw new SchedulerError(`Invalid ${name}`,400);return value;}
function id(value:unknown,name:string):string {const result=string(value,name,128);if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(result))throw new SchedulerError(`Invalid ${name}`,400);return result;}
function number(value:unknown,name:string,min=0,max=Number.MAX_SAFE_INTEGER):number {if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)throw new SchedulerError(`Invalid ${name}`,400);return value;}
function digest(value:unknown,name:string):string {const result=string(value,name,64);if(!/^[a-f0-9]{64}$/.test(result))throw new SchedulerError(`Invalid ${name}`,400);return result;}
function now(value:number){return number(value,'time',0,Number.MAX_SAFE_INTEGER-3600000);}
function objectKey(value:unknown):string {const key=string(value,'credential object key',1024);if(key.startsWith('/')||key.split('/').some(part=>!part||part==='.'||part==='..'))throw new SchedulerError('Invalid credential object key',400);return key;}
function provider(value:unknown):'codex'|'claude' {if(value!=='codex'&&value!=='claude')throw new SchedulerError('Invalid provider',400);return value;}
function check(value:unknown):CheckSpec {
 const item=object(value,'check');only(item,['id','argv','timeoutMs'],'check');
 if(!Array.isArray(item.argv)||item.argv.length<1||item.argv.length>32)throw new SchedulerError('Invalid check argv',400);
 return {id:id(item.id,'check id'),argv:item.argv.map(arg=>string(arg,'argument',1000)),timeoutMs:number(item.timeoutMs,'check timeout',1000,3600000)};
}
export function validateJobSpec(value:unknown):JobSpec {
 const item=object(value,'job');only(item,['provider','credentialId','snapshotId','instructions','checks','timeoutMs','idempotencyKey'],'job');
 if(!Array.isArray(item.checks)||item.checks.length<1||item.checks.length>4)throw new SchedulerError('Expected one to four required checks',400);
 const checks=item.checks.map(check);if(new Set(checks.map(value=>value.id)).size!==checks.length)throw new SchedulerError('Duplicate check id',400);
 return {provider:provider(item.provider),credentialId:id(item.credentialId,'credential id'),snapshotId:digest(item.snapshotId,'snapshot id'),instructions:string(item.instructions,'instructions',24000),checks,timeoutMs:number(item.timeoutMs,'job timeout',1000,3600000),idempotencyKey:id(item.idempotencyKey,'idempotency key')};
}
function agentReceipt(value:AgentOutcome){return fingerprint({success:value.success,containerStopped:value.containerStopped,authGeneration:value.authGeneration,authObjectKey:value.authObjectKey,outputSnapshotId:value.outputSnapshotId??null,errorCode:value.errorCode??null,resultKey:value.resultKey??null});}
function computeReceipt(value:ComputeOutcome){return fingerprint({success:value.success,containerStopped:value.containerStopped,sourceUnchanged:value.sourceUnchanged,resultKey:value.resultKey??null,errorCode:value.errorCode??null});}

export class Scheduler {
 state:State;
 constructor(state?:SchedulerState){
  if(state&&(state.version!==1||!state.jobs||!state.credentials||!state.idempotency))throw new SchedulerError('Unsupported or corrupt scheduler state',500);
  this.state=state?copy(state):{version:1,jobs:{},credentials:{},idempotency:{}};
  this.state.completionReceipts??={};
 }
 private record(id:string):JobRecord {const value=own(this.state.jobs,id);if(!value)throw new SchedulerError('Job not found',404);return value;}
 private attempt(id:string,attempt:string):JobRecord {const value=this.record(id);if(value.attempt!==attempt)throw new SchedulerError('Stale or invalid attempt');return value;}
 private credential(id:string):CredentialRecord {const value=own(this.state.credentials,id);if(!value)throw new SchedulerError('Credential not found',422);return value;}
 private receiptKey(job:JobRecord){return `${job.id}:${job.attempt}`;}
 private replay(job:JobRecord,hash:string):boolean {const saved=own(this.state.completionReceipts!,this.receiptKey(job));if(saved&&saved!==hash)throw new SchedulerError('Conflicting duplicate completion');return Boolean(saved);}
 private saveReceipt(job:JobRecord,hash:string){this.state.completionReceipts![this.receiptKey(job)]=hash;}
 get(id:string):JobRecord{return copy(this.record(id));}
 list():JobRecord[]{return Object.values(this.state.jobs).map(copy);}
 registerCredential(record:CredentialRecord):void {
  const credential:CredentialRecord={id:id(record.id,'credential id'),provider:provider(record.provider),generation:number(record.generation,'credential generation'),objectKey:objectKey(record.objectKey),quarantined:false};
  if(record.quarantined!==false||record.activeJobId!==undefined)throw new SchedulerError('Credential registration must be ready and unowned',400);
  const previous=own(this.state.credentials,credential.id);
  if(previous){
   if(previous.provider!==credential.provider)throw new SchedulerError('Cannot change credential provider');
   if(previous.activeJobId){const active=this.record(previous.activeJobId);if(!active.containerStopped)throw new SchedulerError('Credential has an active container; stop must be confirmed');if(!previous.quarantined)throw new SchedulerError('Credential is busy');}
   if(credential.generation<=previous.generation)throw new SchedulerError('Credential generation must increase');
  }
  this.state.credentials[credential.id]=credential;
 }
 submit(input:JobSpec,time:number):JobRecord {
  now(time);const spec=validateJobSpec(input),hash=fingerprint(spec),saved=own(this.state.idempotency,spec.idempotencyKey);
  if(saved){if(saved.fingerprint!==hash)throw new SchedulerError('Idempotency key conflicts with another payload');return this.get(saved.jobId);}
  const credential=this.credential(spec.credentialId);if(credential.provider!==spec.provider)throw new SchedulerError('Credential provider does not match job',422);if(credential.quarantined)throw new SchedulerError('Credential is quarantined',422);
  const job:JobRecord={id:randomUUID(),attempt:randomUUID(),kind:'agent',provider:spec.provider,credentialId:credential.id,snapshotId:spec.snapshotId,status:'QUEUED',instructions:spec.instructions,checks:copy(spec.checks),childIds:[],createdAt:time,deadline:0,timeoutMs:spec.timeoutMs,containerStopped:true,authSynced:false};
  this.state.jobs[job.id]=job;this.state.idempotency[spec.idempotencyKey]={fingerprint:hash,jobId:job.id};return copy(job);
 }
 dispatch(time:number):JobRecord[] {
  now(time);this.expire(time);const jobs=Object.values(this.state.jobs);let agents=jobs.filter(j=>j.kind==='agent'&&!j.containerStopped).length,compute=jobs.filter(j=>j.kind==='compute'&&!j.containerStopped).length;const chosen:JobRecord[]=[];
  for(const job of jobs){
   if(job.status!=='QUEUED')continue;
   if(job.kind==='agent'){
    if(agents>=2)continue;const credential=this.credential(job.credentialId!);if(credential.quarantined||credential.activeJobId)continue;
    credential.activeJobId=job.id;job.credentialGeneration=credential.generation;agents++;
   }else{
    if(compute>=4)continue;const parent=this.record(job.parentId!);if(parent.status!=='VERIFYING'){this.cancelOne(job,'CANCELLED',time);continue;}compute++;
   }
   job.status='STARTING';job.containerStopped=false;job.startedAt=time;
   job.deadline=number(time+job.timeoutMs,'deadline');if(job.parentId)job.deadline=Math.min(job.deadline,this.record(job.parentId).deadline);
   chosen.push(copy(job));
  }
  return chosen;
 }
 running(id:string,attempt:string,time:number):JobRecord {
  now(time);const job=this.attempt(id,attempt);
  if(job.status==='RUNNING'||job.status==='CANCELLING')return copy(job);
  if(job.status!=='STARTING')throw new SchedulerError('Job is not starting');
  if(job.deadline<=time)this.cancelOne(job,'TIMED_OUT',time);else job.status='RUNNING';return copy(job);
 }
 agentFinished(id:string,attempt:string,outcome:AgentOutcome,time:number):JobRecord {
  now(time);const job=this.attempt(id,attempt);if(job.kind!=='agent')throw new SchedulerError('Expected agent job',400);
  const hash=agentReceipt(outcome);if(this.replay(job,hash))return copy(job);
  if(!['STARTING','RUNNING','SAVING','CANCELLING'].includes(job.status)||job.authSynced)throw new SchedulerError('Agent is not accepting a completion');
  const credential=this.credential(job.credentialId!);if(credential.activeJobId!==job.id||credential.generation!==job.credentialGeneration)throw new SchedulerError('Credential ownership changed');
  if(typeof outcome.success!=='boolean'||typeof outcome.containerStopped!=='boolean')throw new SchedulerError('Invalid completion flags',400);
  const errorCode=outcome.errorCode===undefined?undefined:string(outcome.errorCode,'error code',200);
  const outputSnapshotId=outcome.outputSnapshotId===undefined?undefined:digest(outcome.outputSnapshotId,'output snapshot id');
  const resultKey=outcome.resultKey===undefined?undefined:string(outcome.resultKey,'result key',1024);
  if(outputSnapshotId!==undefined)job.outputSnapshotId=outputSnapshotId;
  if(resultKey!==undefined)job.resultKey=resultKey;
  let key:string|undefined;try{key=objectKey(outcome.authObjectKey);}catch{/* No valid durable writeback. */}
  if(!outcome.containerStopped||outcome.authGeneration!==job.credentialGeneration!+1||!key){
   this.quarantine(job.id,job.attempt,'AUTH_WRITEBACK_UNCONFIRMED',time,outcome.containerStopped===true);this.saveReceipt(job,hash);return copy(job);
  }
  credential.generation=outcome.authGeneration;credential.objectKey=key;delete credential.activeJobId;
  job.containerStopped=true;job.authSynced=true;
  if(job.deadline<=time&&!job.cancellationRequested){job.cancellationRequested=true;job.errorCode='TIMED_OUT';}
  if(job.cancellationRequested){job.status=job.errorCode==='TIMED_OUT'?'TIMED_OUT':'CANCELLED';job.finishedAt=time;}
  else if(!outcome.success||!job.outputSnapshotId){job.status=errorCode==='NEEDS_REAUTH'?'NEEDS_REAUTH':errorCode==='TIMED_OUT'?'TIMED_OUT':'FAILED';job.errorCode=errorCode??(!job.outputSnapshotId?'MISSING_OUTPUT_SNAPSHOT':'AGENT_FAILED');job.finishedAt=time;if(job.status==='NEEDS_REAUTH')credential.quarantined=true;}
  else{
   job.status='VERIFYING';
   for(const required of job.checks){
    const child:JobRecord={id:randomUUID(),attempt:randomUUID(),kind:'compute',parentId:job.id,checkId:required.id,snapshotId:job.outputSnapshotId,argv:copy(required.argv),checks:[],childIds:[],status:'QUEUED',createdAt:time,deadline:0,timeoutMs:required.timeoutMs,containerStopped:true,authSynced:true};
    this.state.jobs[child.id]=child;job.childIds.push(child.id);
   }
  }
  this.saveReceipt(job,hash);return copy(job);
 }
 computeFinished(id:string,attempt:string,outcome:ComputeOutcome,time:number):JobRecord {
  now(time);const job=this.attempt(id,attempt);if(job.kind!=='compute')throw new SchedulerError('Expected compute job',400);
  const hash=computeReceipt(outcome);if(this.replay(job,hash))return copy(job);
  if(!['STARTING','RUNNING','SAVING','CANCELLING'].includes(job.status))throw new SchedulerError('Compute job is not accepting a completion');
  if(typeof outcome.success!=='boolean'||typeof outcome.containerStopped!=='boolean'||typeof outcome.sourceUnchanged!=='boolean')throw new SchedulerError('Invalid completion flags',400);
  const resultKey=outcome.resultKey===undefined?undefined:string(outcome.resultKey,'result key',1024);
  const errorCode=outcome.errorCode===undefined?undefined:string(outcome.errorCode,'error code',200);
  if(!outcome.containerStopped){job.status='CANCELLING';job.errorCode='CONTAINER_STOP_UNCONFIRMED';return copy(job);}
  job.containerStopped=true;job.finishedAt=time;if(resultKey!==undefined)job.resultKey=resultKey;
  if(job.deadline<=time&&!job.cancellationRequested){job.cancellationRequested=true;job.errorCode='TIMED_OUT';}
  if(job.cancellationRequested)job.status=job.errorCode==='TIMED_OUT'?'TIMED_OUT':'CANCELLED';
  else if(outcome.success&&outcome.sourceUnchanged){job.status='SUCCEEDED';delete job.errorCode;}
  else{job.status='FAILED';job.errorCode=!outcome.sourceUnchanged?'SOURCE_CHANGED':errorCode??'CHECK_FAILED';}
  this.saveReceipt(job,hash);this.settleParent(job.parentId!,time);return copy(job);
 }
 quarantine(id:string,attempt:string,code:string,time:number,containerStopped=false):JobRecord {
  now(time);const job=this.attempt(id,attempt);string(code,'error code',200);
  if(job.kind==='agent'){
   if(job.authSynced)throw new SchedulerError('Cannot quarantine a released credential owner');
   if(terminal(job.status)&&job.status!=='AUTH_SYNC_FAILED')throw new SchedulerError('Agent is already terminal');
   const credential=this.credential(job.credentialId!);if(credential.activeJobId!==job.id)throw new SchedulerError('Credential ownership changed');
   credential.quarantined=true;job.status='AUTH_SYNC_FAILED';job.errorCode=code;job.containerStopped=job.containerStopped||containerStopped;job.finishedAt=time;
  }else{
   if(terminal(job.status)){if(!job.containerStopped)job.containerStopped=containerStopped;return copy(job);}
   job.errorCode=code;job.containerStopped=containerStopped;
   if(containerStopped){job.status='FAILED';job.finishedAt=time;this.settleParent(job.parentId!,time);}else job.status='CANCELLING';
  }
  return copy(job);
 }
 private cancelOne(job:JobRecord,reason:'CANCELLED'|'TIMED_OUT',time:number){
  if(terminal(job.status))return;
  job.cancellationRequested=true;job.errorCode=reason;
  if(job.status==='QUEUED'){job.status=reason;job.containerStopped=true;job.finishedAt=time;}
  else job.status='CANCELLING';
 }
 private cancel(id:string,reason:'CANCELLED'|'TIMED_OUT',time:number):JobRecord[] {
  const job=this.record(id);if(terminal(job.status))return [];
  const changed:JobRecord[]=[];this.cancelOne(job,reason,time);changed.push(copy(job));
  if(job.kind==='agent'){
   for(const childId of job.childIds){const child=this.record(childId);if(!terminal(child.status)){this.cancelOne(child,reason,time);changed.push(copy(child));}}
   this.settleParent(job.id,time);
  }else this.settleParent(job.parentId!,time);
  return changed;
 }
 requestCancel(id:string,time:number):JobRecord[]{now(time);return this.cancel(id,'CANCELLED',time);}
 expire(time:number):JobRecord[] {
  now(time);const changed:JobRecord[]=[];
  for(const job of Object.values(this.state.jobs))if(job.deadline>0&&job.deadline<=time&&!terminal(job.status)&&job.status!=='CANCELLING')changed.push(...this.cancel(job.id,'TIMED_OUT',time));
  return changed;
 }
 private settleParent(id:string,time:number){
  const parent=this.record(id);if(!['VERIFYING','CANCELLING'].includes(parent.status)||!parent.containerStopped||!parent.authSynced||parent.childIds.length===0)return;
  const children=parent.childIds.map(child=>this.record(child));if(children.some(child=>!terminal(child.status)||!child.containerStopped))return;
  parent.finishedAt=time;
  if(parent.cancellationRequested)parent.status=parent.errorCode==='TIMED_OUT'?'TIMED_OUT':'CANCELLED';
  else if(children.length===parent.checks.length&&children.every(child=>child.status==='SUCCEEDED'&&child.snapshotId===parent.outputSnapshotId)){parent.status='SUCCEEDED';delete parent.errorCode;}
  else{parent.status='FAILED';parent.errorCode='REQUIRED_CHECK_FAILED';}
 }
}
