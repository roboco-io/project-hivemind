import {DurableObject,WorkerEntrypoint} from 'cloudflare:workers';
import type {CredentialRecord,JobRecord,JobSpec,RuntimeInput,RuntimeResult,SchedulerState,Snapshot} from '../contracts.ts';
import {terminal} from '../contracts.ts';
import {Scheduler,type AgentOutcome,type ComputeOutcome} from '../scheduler.ts';
import {validateSnapshot} from '../snapshot.ts';
import {openAuthReturn,openCredential,sealCredential,validateAuth,type StoredCredential} from '../crypto.ts';
import {ApiError,authorize,handleApi,json,type ApiService} from './api.ts';
import runtimeBuild from '../../runtime-build.json' with {type:'json'};
declare global {namespace Cloudflare {interface GlobalProps {mainModule:typeof import('./worker.ts')}}}

interface Env {
 CF_VERSION_METADATA?:{id:string};
 ARTIFACTS:R2Bucket;CREDENTIALS:R2Bucket;
 SCHEDULER:DurableObjectNamespace<SchedulerDO>;RUNNER:DurableObjectNamespace<RunnerDO>;
 CONTROL_TOKEN?:string;AUTH_STORAGE_KEY:string;AUTH_RETURN_PRIVATE_KEY:string;AUTH_RETURN_PUBLIC_KEY:string;CLAUDE_NESTED_APPROVED?:string;CODEX_SANDBOX_APPROVED?:string;
}
const CA='/etc/cloudflare/certs/cloudflare-containers-ca.crt';
const snapshotKey=(digest:string)=>`snapshots/${digest}.json`;
const credentialKey=(id:string,generation:number)=>`credentials/${id}/g${generation}.json`;
const resultKey=(job:JobRecord)=>`results/${job.id}/${job.attempt}.json`;
const outbound=(request:Request,hosts:string[])=>{const url=new URL(request.url);return url.protocol==='https:'&&hosts.includes(url.hostname)&&!url.username&&!url.password&&(!url.port||url.port==='443')?fetch(request,{redirect:'manual'}):Promise.resolve(new Response('Denied',{status:403}));};
export class CodexOutbound extends WorkerEntrypoint<Env>{fetch(request:Request){return outbound(request,['chatgpt.com','auth.openai.com','api.openai.com']);}}
export class ClaudeOutbound extends WorkerEntrypoint<Env>{fetch(request:Request){return outbound(request,['api.anthropic.com','claude.ai','claude.com','platform.claude.com']);}}
export class ComputeOutbound extends WorkerEntrypoint<Env>{fetch(request:Request){return outbound(request,['registry.npmjs.org','github.com','codeload.github.com','objects.githubusercontent.com','release-assets.githubusercontent.com']);}}

interface RunnerMetadata {jobId:string;attempt:string;kind:'agent'|'compute';provider?:'codex'|'claude';prepared:boolean;launchIssued:boolean;pid?:number;stopped:boolean;runtimeRevision?:string}
interface RuntimeState {prepared:boolean;started:{jobId:string;attempt:string;pid:number;startedAt:number}|null;resultReady:boolean;cancelRequested:boolean}
class InvalidRuntimeResult extends Error {}
type Completion={kind:'agent';outcome:AgentOutcome}|{kind:'compute';outcome:ComputeOutcome};
export class RunnerDO extends DurableObject<Env>{
 private metadata?:RunnerMetadata;
 private revisionVerified=false;
 constructor(ctx:DurableObjectState,env:Env){super(ctx,env);ctx.blockConcurrencyWhile(async()=>{this.metadata=await ctx.storage.get<RunnerMetadata>('metadata');});}
 private async save(){await this.ctx.storage.put('metadata',this.metadata!);}
 private async request(path:string,method='GET',value?:unknown,timeout=1500){const container=this.ctx.container;if(!container?.running)throw new Error('Runtime unavailable');return container.getTcpPort(3000).fetch(new Request(`http://runtime${path}`,{method,headers:{'content-type':'application/json'},...(value===undefined?{}:{body:JSON.stringify(value)}),signal:AbortSignal.timeout(timeout)}));}
 async ensure(job:JobRecord):Promise<{ready:boolean;lost:boolean;prepared:boolean;launchIssued:boolean;legacy?:boolean}>{return this.ctx.blockConcurrencyWhile(async()=>{
  this.revisionVerified=false;
  if(this.metadata&&(this.metadata.jobId!==job.id||this.metadata.attempt!==job.attempt))throw new Error('Attempt mismatch');
  if(!this.metadata){this.metadata={jobId:job.id,attempt:job.attempt,kind:job.kind,provider:job.provider,prepared:false,launchIssued:false,stopped:false};await this.save();}
  const container=this.ctx.container;if(!container)throw new Error('Runtime binding missing');
  if(this.metadata.stopped||(!container.running&&(this.metadata.prepared||this.metadata.launchIssued)))return {ready:false,lost:true,prepared:this.metadata.prepared,launchIssued:this.metadata.launchIssued};
  if(!container.running)container.start({image:container.images.runtime,instance:'standard-1',enableInternet:false});
  const handler=job.kind==='compute'?this.ctx.exports.ComputeOutbound:job.provider==='claude'?this.ctx.exports.ClaudeOutbound:this.ctx.exports.CodexOutbound;
  await container.interceptAllOutboundHttp(handler);await container.interceptOutboundHttps('*',handler);
  const legacy=!this.metadata.runtimeRevision&&(this.metadata.prepared||this.metadata.launchIssued);let ready=false,revisionToPin:string|undefined;
  try{const response=await this.request('/health');if(response.ok){
   const health=await response.json() as {ok?:unknown;runtimeRevision?:unknown};
   if(legacy)ready=health.ok===true;
   else{
    const expected=this.metadata.runtimeRevision??runtimeBuild.digest;
    ready=health.ok===true&&typeof health.runtimeRevision==='string'&&/^[a-f0-9]{64}$/.test(health.runtimeRevision)&&health.runtimeRevision===expected;
    if(ready&&!this.metadata.runtimeRevision)revisionToPin=expected;
   }
  }}catch{/* Cold starts and stale images stay unprepared. */}
  if(revisionToPin!==undefined){
   const candidate:RunnerMetadata={...this.metadata,runtimeRevision:revisionToPin};
   await this.ctx.storage.put('metadata',candidate);
   this.metadata=candidate;
  }
  this.revisionVerified=ready&&!legacy;
  return {ready,lost:false,prepared:this.metadata.prepared,launchIssued:this.metadata.launchIssued,...(legacy?{legacy:true}:{})};
 });}
 async prepare(input:RuntimeInput){return this.ctx.blockConcurrencyWhile(async()=>{
  if(!this.revisionVerified||!this.metadata?.runtimeRevision)throw new Error('Runtime revision is not verified');
  if(!this.metadata||input.jobId!==this.metadata.jobId||input.attempt!==this.metadata.attempt||this.metadata.stopped)throw new Error('Attempt mismatch');
  const response=await this.request('/prepare','POST',input,3000);if(!response.ok)throw new Error('Prepare rejected');this.metadata.prepared=true;await this.save();
 });}
 async launch(){return this.ctx.blockConcurrencyWhile(async()=>{
  if(!this.metadata?.prepared||this.metadata.stopped)throw new Error('Runtime not prepared');
  if(this.metadata.launchIssued)return;
  if(!this.revisionVerified||!this.metadata.runtimeRevision)throw new Error('Runtime revision is not verified');
  // Persist before exec: an uncertain exec is never automatically replayed.
  this.metadata.launchIssued=true;await this.save();
  const process=await this.ctx.container!.exec(['setpriv','--no-new-privs','--inh-caps=-all','--ambient-caps=-all','--bounding-set=-all','node','/opt/hivemind/backend/src/runtime/run.ts'],{cwd:'/workspace',stdout:'ignore',stderr:'ignore',env:{SSL_CERT_FILE:CA,NODE_EXTRA_CA_CERTS:CA}});
  this.metadata.pid=process.pid;await this.save();
 });}
 async poll():Promise<string>{
  if(!this.ctx.container?.running)return JSON.stringify({lost:true});
  const response=await this.request('/state');if(!response.ok)throw new Error('Runtime state unavailable');const state=await response.json() as RuntimeState;
  if(state.started&&(state.started.jobId!==this.metadata?.jobId||state.started.attempt!==this.metadata?.attempt))throw new Error('Runtime identity mismatch');
  if(!state.resultReady)return JSON.stringify({lost:false,state});
  const result=await this.request('/result','GET',undefined,3000);if(!result.ok)throw new Error('Runtime result unavailable');const text=await result.text();if(text.length>8*1024*1024)throw new Error('Runtime result is too large');return JSON.stringify({lost:false,state,result:JSON.parse(text)});
 }
 async cancel(){try{if(this.ctx.container?.running)await this.request('/cancel','POST');}catch{/* Hard deadline cleanup remains scheduled. */}}
 async stop():Promise<boolean>{return this.ctx.blockConcurrencyWhile(async()=>{if(this.ctx.container?.running)await this.ctx.container.destroy();const stopped=!this.ctx.container?.running;if(stopped&&this.metadata){this.metadata.stopped=true;await this.save();}return stopped;});}
}

export class SchedulerDO extends DurableObject<Env> implements ApiService {
 private scheduler=new Scheduler();
 constructor(ctx:DurableObjectState,env:Env){super(ctx,env);ctx.blockConcurrencyWhile(async()=>{const state=await ctx.storage.get<SchedulerState>('state');if(state)this.scheduler=new Scheduler(state);});}
 private async save(){await this.ctx.storage.put('state',this.scheduler.state);}
 private async schedule(){if(this.scheduler.list().some(job=>job.status==='QUEUED'||!job.containerStopped||!terminal(job.status)))await this.ctx.storage.setAlarm(Date.now()+2000);}
 async fetch(request:Request){return this.ctx.blockConcurrencyWhile(async()=>{const response=await handleApi(request,this.env.CONTROL_TOKEN,this);await this.save();await this.schedule();return response;});}
 async putSnapshot(snapshot:Snapshot){const key=snapshotKey(snapshot.digest);const old=await this.env.ARTIFACTS.get(key);if(old){const value=validateSnapshot(await old.json());if(JSON.stringify(value)!==JSON.stringify(snapshot))throw new ApiError(409);}else await this.env.ARTIFACTS.put(key,JSON.stringify(snapshot),{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});return {snapshotId:snapshot.digest};}
 async registerCredential(id:string,provider:'codex'|'claude',auth:string){
  const prior=Object.hasOwn(this.scheduler.state.credentials,id)?this.scheduler.state.credentials[id]:undefined;
  let generation=(prior?.generation??-1)+1;
  const candidate=():CredentialRecord=>({id,provider,generation,objectKey:credentialKey(id,generation),quarantined:false});
  // Reject provider changes or live owners before touching credential storage.
  new Scheduler(this.scheduler.state).registerCredential(candidate());
  // A failed writeback may have saved a generation that metadata never adopted.
  // Registration allocates a fresh immutable object; it never rewrites that evidence.
  for(let scanned=0;scanned<64;scanned++,generation++){
   const record=candidate();if(await this.env.CREDENTIALS.head(record.objectKey))continue;
   new Scheduler(this.scheduler.state).registerCredential(record);
   await this.storeCredential(auth,id,generation,record.objectKey);this.scheduler.registerCredential(record);return record;
  }
  throw new ApiError(409);
 }
 async credentials(){return Object.values(this.scheduler.state.credentials).map(record=>({...record}));}
 async submit(spec:JobSpec){if(spec.provider==='codex'&&this.env.CODEX_SANDBOX_APPROVED!=='true')throw new ApiError(503);if(spec.provider==='claude'&&this.env.CLAUDE_NESTED_APPROVED!=='true')throw new ApiError(503);if(!await this.env.ARTIFACTS.head(snapshotKey(spec.snapshotId)))throw new ApiError(422);return this.scheduler.submit(spec,Date.now());}
 async jobs(){return this.scheduler.list();}
 async job(id:string){return this.scheduler.get(id);}
 async cancel(id:string){const now=Date.now();for(const job of this.scheduler.requestCancel(id,now))if(!job.containerStopped)await this.ctx.storage.put(`cancelAt:${job.id}`,now);return this.scheduler.get(id);}
 private async snapshot(digest:string){const object=await this.env.ARTIFACTS.get(snapshotKey(digest));if(!object)throw new ApiError(404);return validateSnapshot(await object.json());}
 async result(id:string){const job=this.scheduler.get(id);if(!job.outputSnapshotId)throw new ApiError(409);return {job,input:await this.snapshot(job.snapshotId),output:await this.snapshot(job.outputSnapshotId),result:job.resultKey?await this.readResult(job.resultKey):undefined,checks:await Promise.all(job.childIds.map(async id=>{const child=this.scheduler.get(id);return {job:child,result:child.resultKey?await this.readResult(child.resultKey):undefined};}))};}
 private async readResult(key:string){const object=await this.env.ARTIFACTS.get(key);if(!object)throw new ApiError(404);return object.json();}
 private async storeCredential(auth:string,id:string,generation:number,key:string){
  const existing=await this.env.CREDENTIALS.get(key);if(existing){if(await openCredential(await existing.json() as StoredCredential,id,generation,this.env.AUTH_STORAGE_KEY)!==auth)throw new Error('Conflicting credential writeback');return;}
  const sealed=await sealCredential(auth,id,generation,this.env.AUTH_STORAGE_KEY);
  const saved=await this.env.CREDENTIALS.put(key,JSON.stringify(sealed),{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
  if(!saved){const object=await this.env.CREDENTIALS.get(key);if(!object||await openCredential(await object.json() as StoredCredential,id,generation,this.env.AUTH_STORAGE_KEY)!==auth)throw new Error('Conflicting credential writeback');}
 }
 private runner(job:JobRecord){return this.env.RUNNER.getByName(`${job.id}:${job.attempt}`);}
 private async hardDeadline(job:JobRecord){if(job.cancellationRequested&&job.errorCode==='CANCELLED')return (await this.ctx.storage.get<number>(`cancelAt:${job.id}`)??job.deadline)+10000;return job.deadline+10000;}
 async alarm(){return this.ctx.blockConcurrencyWhile(async()=>{
  try{this.scheduler.expire(Date.now());this.scheduler.dispatch(Date.now());await this.save();
   const active=this.scheduler.list().filter(job=>!job.containerStopped),cursor=await this.ctx.storage.get<number>('alarmCursor')??0;
   // Bound one alarm below the Durable Object concurrency lock deadline.
   const selected=active.length?Array.from({length:Math.min(2,active.length)},(_,i)=>active[(cursor+i)%active.length]!):[];
   await this.ctx.storage.put('alarmCursor',active.length?(cursor+selected.length)%active.length:0);
   for(const job of selected){
    try{await this.advance(job);}catch{/* Keep the credential lane owned and retry bounded cleanup. */
     if(Date.now()>await this.hardDeadline(job)){let stopped=false;try{stopped=await this.runner(job).stop();}catch{}this.scheduler.quarantine(job.id,job.attempt,'RUNTIME_UNAVAILABLE',Date.now(),stopped);}
    }
    await this.save();
   }
  }finally{await this.save();await this.schedule();}
 });}
 private async advance(job:JobRecord){
  const runner=this.runner(job);
  const pending=await this.ctx.storage.get<Completion>(`completion:${job.id}`);if(pending){await this.finish(job,pending);return;}
  if(job.status==='AUTH_SYNC_FAILED'){const stopped=await runner.stop();this.scheduler.quarantine(job.id,job.attempt,job.errorCode??'AUTH_SYNC_FAILED',Date.now(),stopped);return;}
  const readiness=await runner.ensure(job);
  if(readiness.lost){const stopped=await runner.stop();this.scheduler.quarantine(job.id,job.attempt,'CONTAINER_LOST',Date.now(),stopped);return;}
  if(!readiness.ready){if(Date.now()>await this.hardDeadline(job)){const stopped=await runner.stop();this.scheduler.quarantine(job.id,job.attempt,'RUNTIME_START_TIMEOUT',Date.now(),stopped);}return;}
  if(!readiness.legacy&&!readiness.prepared){
   const timeoutKey=`runtimeTimeout:${job.id}:${job.attempt}`;
   let timeoutMs=await this.ctx.storage.get<number>(timeoutKey);
   if(timeoutMs===undefined){timeoutMs=Math.max(1000,Math.min(job.timeoutMs,job.deadline-Date.now()));await this.ctx.storage.put(timeoutKey,timeoutMs);}
   if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>job.timeoutMs)throw new Error('Invalid prepared timeout');
   const input:RuntimeInput={version:1,jobId:job.id,attempt:job.attempt,mode:job.kind,snapshot:await this.snapshot(job.snapshotId),timeoutMs};
   if(job.kind==='agent'){
    const credential=this.scheduler.state.credentials[job.credentialId!]!;if(credential.generation!==job.credentialGeneration||credential.activeJobId!==job.id)throw new Error('Credential ownership mismatch');
    const object=await this.env.CREDENTIALS.get(credential.objectKey);if(!object)throw new Error('Credential unavailable');
    input.auth=validateAuth(job.provider!,await openCredential(await object.json() as StoredCredential,credential.id,credential.generation,this.env.AUTH_STORAGE_KEY));input.provider=job.provider;input.instructions=job.instructions;input.authReturnPublicKey=this.env.AUTH_RETURN_PUBLIC_KEY;input.claudeNestedCompatible=job.provider==='claude'&&this.env.CLAUDE_NESTED_APPROVED==='true';
   }else input.argv=job.argv;
   await runner.prepare(input);
  }
  if(job.cancellationRequested||job.status==='CANCELLING')await runner.cancel();
  if(!readiness.legacy)await runner.launch();const polled=JSON.parse(await runner.poll()) as {lost:boolean;state?:RuntimeState;result?:RuntimeResult};
  if(polled.lost){const stopped=await runner.stop();this.scheduler.quarantine(job.id,job.attempt,'CONTAINER_LOST',Date.now(),stopped);return;}
  if(polled.state?.started&&job.status==='STARTING')this.scheduler.running(job.id,job.attempt,Date.now());
  if(polled.result){try{await this.complete(job,polled.result);}catch(error){if(!(error instanceof InvalidRuntimeResult))throw error;const stopped=await runner.stop();this.scheduler.quarantine(job.id,job.attempt,'INVALID_RUNTIME_RESULT',Date.now(),stopped);}return;}
  if(Date.now()>await this.hardDeadline(job)){const stopped=await runner.stop();this.scheduler.quarantine(job.id,job.attempt,'RESULT_MISSING_AFTER_DEADLINE',Date.now(),stopped);}
 }
 private async complete(job:JobRecord,result:RuntimeResult){
  if(result.version!==1||result.jobId!==job.id||result.attempt!==job.attempt||result.inputSnapshotId!==job.snapshotId||!result.process||!['passed','failed','timed_out','error','not_run'].includes(result.process.status)||(result.errorCode!==undefined&&result.errorCode!=='NEEDS_REAUTH'))throw new InvalidRuntimeResult();
  const boundary=result.boundary;if(!boundary?.verified||boundary.platform!=='linux'||boundary.noNewPrivs!==1||['CapInh','CapPrm','CapEff','CapBnd','CapAmb'].some(name=>!/^0+$/.test(boundary.capabilities[name]??'')))throw new InvalidRuntimeResult();
  let output:Snapshot|undefined;try{output=result.snapshot?validateSnapshot(result.snapshot):undefined;}catch{throw new InvalidRuntimeResult();}
  if(job.kind==='agent'&&(result.provider!==job.provider||result.sandboxPolicy!==(job.provider==='codex'?'codex-workspace':this.env.CLAUDE_NESTED_APPROVED==='true'?'claude-nested-compatible':'claude-strict')))throw new InvalidRuntimeResult();
  if(job.kind==='compute'&&(!result.credentialsAbsent||result.authReturn||result.provider||result.errorCode||result.sandboxPolicy!=='compute-workspace'))throw new InvalidRuntimeResult();
  if(result.mcpReceipts!==undefined&&(!Array.isArray(result.mcpReceipts)||result.mcpReceipts.length>64||result.mcpReceipts.some(item=>!item||typeof item.callId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(item.callId)||typeof item.nonce!=='string'||!/^[a-f0-9]{32}$/.test(item.nonce)||item.marker!=='hivemind-phase0-mcp-v1')||job.kind==='compute'&&result.mcpReceipts.length>0))throw new InvalidRuntimeResult();
  const mcpReceipts=result.mcpReceipts?.map(item=>({callId:item.callId,nonce:item.nonce,marker:item.marker}));
  const auditId=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
  if(result.sandboxReceipts!==undefined&&(!Array.isArray(result.sandboxReceipts)||result.sandboxReceipts.length>256||result.sandboxReceipts.some(item=>!item||!auditId(item.sessionId)||!(item.agentId===null||auditId(item.agentId))||!auditId(item.toolUseId)||typeof item.commandHash!=='string'||!/^[a-f0-9]{64}$/.test(item.commandHash)||typeof item.timestamp!=='string'||item.timestamp.length!==24||!Number.isFinite(Date.parse(item.timestamp))||new Date(item.timestamp).toISOString()!==item.timestamp)||job.kind==='compute'&&result.sandboxReceipts.length>0))throw new InvalidRuntimeResult();
  const sandboxReceipts=result.sandboxReceipts?.map(item=>({sessionId:item.sessionId,agentId:item.agentId,toolUseId:item.toolUseId,commandHash:item.commandHash,timestamp:item.timestamp}));
  if(output)await this.putSnapshot(output);
  // Only allowlisted result fields enter normal artifacts. The sealed auth return stays private.
  const safe={version:1,jobId:result.jobId,attempt:result.attempt,inputSnapshotId:result.inputSnapshotId,outputSnapshotId:output?.digest,process:result.process,summary:result.summary,errorCode:result.errorCode,sourceUnchanged:result.sourceUnchanged,credentialsAbsent:result.credentialsAbsent,provider:result.provider,sessionId:result.sessionId,usage:result.usage,subagentReceipts:result.subagentReceipts,mcpReceipts,sandboxReceipts,sandboxPolicy:result.sandboxPolicy,boundary};
  const key=resultKey(job);await this.env.ARTIFACTS.put(key,JSON.stringify(safe),{httpMetadata:{contentType:'application/json'}});
  if(job.kind==='agent'){
   if(!result.authReturn)throw new InvalidRuntimeResult();
   let auth:string;try{auth=validateAuth(job.provider!,await openAuthReturn(result.authReturn,this.env.AUTH_RETURN_PRIVATE_KEY));}catch{throw new InvalidRuntimeResult();}const generation=job.credentialGeneration!+1,authKey=credentialKey(job.credentialId!,generation);
   await this.storeCredential(auth,job.credentialId!,generation,authKey);
   await this.queueCompletion(job,{kind:'agent',outcome:{success:!result.errorCode&&result.process.status==='passed'&&result.process.exitCode===0,outputSnapshotId:output?.digest,authGeneration:generation,authObjectKey:authKey,containerStopped:true,resultKey:key,errorCode:result.errorCode??(result.process.status==='timed_out'?'TIMED_OUT':undefined)}});
  }else{
   await this.queueCompletion(job,{kind:'compute',outcome:{success:result.process.status==='passed'&&result.process.exitCode===0&&result.credentialsAbsent===true,containerStopped:true,sourceUnchanged:result.sourceUnchanged===true&&(!output||output.digest===job.snapshotId),resultKey:key}});
  }
 }
 private async queueCompletion(job:JobRecord,completion:Completion){await this.ctx.storage.put(`completion:${job.id}`,completion);await this.finish(job,completion);}
 private async finish(job:JobRecord,completion:Completion){
  if(!await this.runner(job).stop())return;
  if(completion.kind==='agent')this.scheduler.agentFinished(job.id,job.attempt,completion.outcome,Date.now());else this.scheduler.computeFinished(job.id,job.attempt,completion.outcome,Date.now());
  await this.save();await this.ctx.storage.delete(`completion:${job.id}`);
 }
}
export default {async fetch(request:Request,env:Env){const path=new URL(request.url).pathname;if(path==='/health'&&request.method==='GET')return json({ok:true,service:'hivemind-cloudflare',workerVersion:env.CF_VERSION_METADATA?.id,expectedRuntimeRevision:runtimeBuild.digest});if(!path.startsWith('/v1/'))return json({error:'Not found'},404);const denied=authorize(request,env.CONTROL_TOKEN);if(denied)return denied;try{return await env.SCHEDULER.getByName('owner').fetch(request);}catch{return json({error:'Service is unavailable'},503);}}};
