import type {AutonomousWebEnv,AutonomousWebPolicy} from '../runtime/autonomous-web.ts';
import type {AutonomousLease,AutonomousCheckpoint,AutonomousRunResult,AutonomousTask} from '../../../../packages/contracts/src/autonomous.ts';
import type {AutonomousCloudPorts,AutonomousCloudSubmission,AutonomousCloudPoll} from '../autonomous-cloud.ts';
import type {AutonomousStorage} from '../autonomous-service.ts';
import type {Scheduler} from '../scheduler.ts';
import {terminal} from '../contracts.ts';
import {sha256} from '../snapshot.ts';
export interface NativeCloudEnv extends AutonomousWebEnv {AUTONOMOUS_EXTERNAL_ENABLED?:string;AUTONOMOUS_QUOTA_PAUSE_ENABLED?:string;AUTONOMOUS_CLOUD_ENABLED?:string;AUTONOMOUS_CONTROL_ORIGIN?:string;AUTONOMOUS_SESSION_KEY?:string;AUTONOMOUS_WORKER_TOKEN?:string;AUTONOMOUS_REPORTER_TOKEN?:string;CONTROL_TOKEN?:string;AUTH_STORAGE_KEY?:string;AUTH_RETURN_PUBLIC_KEY?:string;AUTH_RETURN_PRIVATE_KEY?:string;CLAUDE_NESTED_APPROVED?:string}
export function sessionKey(env:NativeCloudEnv):Uint8Array {
 const raw=env.AUTONOMOUS_SESSION_KEY??'';if(!/^[A-Za-z0-9+/]{43}=$/.test(raw))throw Error('Native configuration unavailable');
 const key=Uint8Array.from(atob(raw),c=>c.charCodeAt(0));if(key.length!==32)throw Error('Native configuration unavailable');return key;
}
export function controlOrigin(env:NativeCloudEnv):string {
 const url=new URL(env.AUTONOMOUS_CONTROL_ORIGIN??'');if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Native configuration unavailable');return url.origin;
}
export function cloudReadiness(env:NativeCloudEnv):{enabled:boolean;ready:boolean;checks:Record<string,boolean>} {
 const checks:Record<string,boolean>={enabled:env.AUTONOMOUS_CLOUD_ENABLED==='true',origin:false,sessionKey:false,tokens:false,authReturn:!!env.AUTH_RETURN_PUBLIC_KEY&&!!env.AUTH_RETURN_PRIVATE_KEY,credentialKey:!!env.AUTH_STORAGE_KEY,sandbox:env.CLAUDE_NESTED_APPROVED==='true'};
 try{controlOrigin(env);checks.origin=true;}catch{}try{sessionKey(env);checks.sessionKey=env.AUTONOMOUS_SESSION_KEY!==env.AUTH_STORAGE_KEY;}catch{}
 const tokens=[env.CONTROL_TOKEN,env.AUTONOMOUS_WORKER_TOKEN,env.AUTONOMOUS_REPORTER_TOKEN],management=[env.AUTH_STORAGE_KEY,env.AUTH_RETURN_PRIVATE_KEY,env.AUTONOMOUS_SESSION_KEY];checks.tokens=tokens.every(t=>typeof t==='string'&&t.length>0&&t.length<=4096&&!/[\s\p{Cc}]/u.test(t))&&new Set(tokens).size===3&&tokens.slice(1).every(token=>!management.includes(token));
 return {enabled:checks.enabled!,ready:Object.values(checks).every(Boolean),checks};
}
export const nativeApprovalKey=(taskId:string)=>'autonomous-cloud-approval:'+taskId;
export function nativeConfigurationFingerprint(env:NativeCloudEnv,runtimeRevision:string,externalPolicyFingerprint?:string):string {
 if(!cloudReadiness(env).ready)throw Error('Native configuration unavailable');
 const pinned:unknown[]=[controlOrigin(env),runtimeRevision,env.CONTROL_TOKEN,env.AUTH_STORAGE_KEY,env.AUTH_RETURN_PUBLIC_KEY,env.AUTH_RETURN_PRIVATE_KEY,env.AUTONOMOUS_WORKER_TOKEN,env.AUTONOMOUS_REPORTER_TOKEN,env.AUTONOMOUS_SESSION_KEY,env.CLAUDE_NESTED_APPROVED,(env as NativeCloudEnv & {AUTONOMOUS_LONG_RUNNING_ENABLED?:string}).AUTONOMOUS_LONG_RUNNING_ENABLED==='true',env.AUTONOMOUS_WEB_ENABLED==='true',env.AUTONOMOUS_WEB_ALLOWED_HOSTS??'',env.AUTONOMOUS_QUOTA_PAUSE_ENABLED==='true'];
 if(env.AUTONOMOUS_EXTERNAL_ENABLED==='true'||externalPolicyFingerprint!==undefined)pinned.push(['external',env.AUTONOMOUS_EXTERNAL_ENABLED==='true',externalPolicyFingerprint??'unavailable']);
 return sha256(JSON.stringify(pinned));
}
export function allowNativeControl(request:Request,env:NativeCloudEnv):boolean {
 try {const url=new URL(request.url);if(url.origin!==controlOrigin(env)||url.username||url.password||url.search||url.hash||request.method!=='POST')return false;
 const match=/^\/v1\/autonomous-tasks\/[A-Za-z0-9_-]{1,128}\/(native-start|heartbeat|native-ready|native-receipt|external-action)$/.exec(url.pathname);if(!match)return false;
 if(match[1]==='external-action'&&env.AUTONOMOUS_EXTERNAL_ENABLED!=='true')return false;
 const token=['native-ready','native-receipt'].includes(match[1]!)?env.AUTONOMOUS_REPORTER_TOKEN:env.AUTONOMOUS_WORKER_TOKEN;
 return !!token&&token!==env.CONTROL_TOKEN&&env.AUTONOMOUS_REPORTER_TOKEN!==env.AUTONOMOUS_WORKER_TOKEN&&request.headers.get('authorization')==='Bearer '+token;
 }catch{return false;}
}
/** Private storage only: never part of SchedulerState or public result artifacts. */
export interface NativeJobPrivate {webPolicy?:AutonomousWebPolicy;lease:AutonomousLease;task:Pick<AutonomousTask,'id'|'spec'|'revision'>;runtimeId:string;sessionId:string;configurationFingerprint?:string;checkpoint?:AutonomousCheckpoint;result?:AutonomousRunResult}
/** Never duplicate core history in a single DO value. Legacy full task rows remain readable. */
export function boundedNativeJobPrivate(value:NativeJobPrivate):NativeJobPrivate {
 const row={...value,task:{id:value.task.id,spec:structuredClone(value.task.spec),revision:value.task.revision}};
 if(Buffer.byteLength(JSON.stringify(row))>128*1024)throw Error('Native private job capacity exceeded');return row;
}
export const nativeJobKey=(jobId:string)=>'autonomous-native:'+jobId;
interface LegacyPortOptions {scheduler:Scheduler;storage:AutonomousStorage;enabled:()=>boolean;configurationReady?:(task:AutonomousTask)=>Promise<boolean>;configurationFingerprint?:()=>string;sourceReady?:(snapshotId:string)=>Promise<boolean>;save:()=>Promise<void>}
export class LegacyAutonomousCloudPorts implements AutonomousCloudPorts {
 private readonly options:LegacyPortOptions;
 constructor(options:LegacyPortOptions){this.options=options;}
 async available(task:AutonomousTask):Promise<boolean>{
  const {scheduler}=this.options,c=scheduler.state.credentials[task.spec.credentialIds[0]??''];
  if(!this.options.enabled()||task.spec.provider!=='claude'||!c||c.provider!=='claude'||c.quarantined||c.activeJobId)return false;
  if(this.options.configurationReady&&!await this.options.configurationReady(task))return false;
  if(!task.spec.execution||!await this.options.sourceReady?.(task.spec.execution.snapshotId))return false;
  const jobs=scheduler.list();return !jobs.some(j=>j.kind==='agent'&&j.status==='QUEUED')&&!jobs.some(j=>j.autonomous&&(j.status==='QUEUED'||!terminal(j.status)||!j.containerStopped))&&jobs.filter(j=>j.kind==='agent'&&!j.containerStopped).length<2;
 }
 async submit(input:AutonomousCloudSubmission):Promise<{jobId:string}>{
  if(!this.options.enabled()||!input.task.spec.execution||!await this.options.sourceReady?.(input.snapshotId))throw Error('Native execution disabled');
  if(this.options.configurationReady&&!await this.options.configurationReady(input.task))throw Error('Native approval configuration changed');
  const {task,lease,jobId}=input;
  if(this.options.scheduler.list().some(j=>j.id!==jobId&&j.autonomous&&(j.status==='QUEUED'||!terminal(j.status)||!j.containerStopped)))throw Error('Native pilot slot is occupied');
  const privateRowBase=boundedNativeJobPrivate({task,lease,runtimeId:crypto.randomUUID(),sessionId:crypto.randomUUID(),...(this.options.configurationFingerprint?{configurationFingerprint:this.options.configurationFingerprint()}:{}),...(task.checkpoint?{checkpoint:task.checkpoint}:{})});
  const job=this.options.scheduler.submit({provider:'claude',credentialId:task.spec.credentialIds[0]!,snapshotId:input.snapshotId,instructions:task.spec.goal,checks:task.spec.execution!.checks,timeoutMs:task.spec.maxRunMs,idempotencyKey:input.idempotencyKey},Date.now(),jobId);
  if(job.autonomous&&(job.autonomous.taskId!==task.id||job.autonomous.runId!==lease.runId))throw Error('Native identity conflict');
  // Bind synchronously before any private-storage await: a partial submission must
  // never be dispatched through the legacy provider execution path.
  this.options.scheduler.state.jobs[jobId]!.autonomous={taskId:task.id,runId:lease.runId};
  const existing=await this.options.storage.get<NativeJobPrivate>(nativeJobKey(jobId));
  if(existing&&(existing.lease.taskId!==lease.taskId||existing.lease.runId!==lease.runId))throw Error('Native identity conflict');
  const approval=await this.options.storage.get<{revision:number;web?:AutonomousWebPolicy}>(nativeApprovalKey(task.id));
  const webPolicy=approval&&approval.revision===task.revision?approval.web:undefined;
  if(Reflect.get(task.spec,'web')!==undefined&&!webPolicy)throw Error('Native web approval missing');
  if(!existing)await this.options.storage.put(nativeJobKey(jobId),boundedNativeJobPrivate({...privateRowBase,...(webPolicy?{webPolicy}:{})}));
  await this.options.save();return {jobId:job.id};
 }
 async poll(jobId:string):Promise<AutonomousCloudPoll>{
  const job=this.options.scheduler.state.jobs[jobId];if(!job)return {state:'unknown'};
  if(!terminal(job.status)||!job.containerStopped)return {state:'pending'};
  if(job.autonomous&&job.status==='FAILED'&&job.authDisposition==='unchanged_unstarted'&&job.authSynced)return {state:'unstarted',stopped:true,authSynced:true};
  const row=await this.options.storage.get<NativeJobPrivate>(nativeJobKey(jobId));if(!row?.result||!job.authSynced)return {state:'unknown'};
  return {state:'finished',stopped:job.containerStopped,authSynced:job.authSynced,checksPassed:job.status==='SUCCEEDED',snapshotId:job.outputSnapshotId??job.snapshotId,result:row.result};
 }
 async cancel(jobId:string):Promise<void>{if(!Object.hasOwn(this.options.scheduler.state.jobs,jobId))return;this.options.scheduler.requestCancel(jobId,Date.now());await this.options.save();}
 async quarantine(credentialId:string,jobId:string):Promise<void>{
  const job=this.options.scheduler.state.jobs[jobId];if(!job)return;
  if(job.credentialId!==credentialId)throw Error('Credential identity mismatch');
  const credential=this.options.scheduler.state.credentials[credentialId];
  if(job.containerStopped&&job.authSynced||credential?.activeJobId!==job.id)return;
  this.options.scheduler.quarantine(job.id,job.attempt,'NATIVE_EXECUTION_UNCERTAIN',Date.now(),job.containerStopped);await this.options.save();
 }
}
