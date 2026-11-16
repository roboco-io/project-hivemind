import {LargeArtifactStore} from '../large-artifact-store.ts';
import {largeArtifactKey,authorizeArtifactRead,type LargeArtifactRef,type ArtifactReadGrant} from '../large-artifact.ts';
import {validateClaudeResultMetrics} from '../claude-result-metrics.ts';
import {advanceComputeGroup,assignGroup,type ComputeGroupSpec,type ComputeGroupRecord} from '../compute-group.ts';
import {ensureSchedulerAlarm} from './scheduler-alarm.ts';
import {randomBytes,randomUUID} from 'node:crypto';
import {DurableObject,WorkerEntrypoint} from 'cloudflare:workers';
import type {CredentialRecord,JobRecord,JobSpec,RuntimeInput,RuntimeResult,SchedulerState,Snapshot,RalphCheckpoint,RalphFeedback} from '../contracts.ts';
import {terminal} from '../contracts.ts';
import {Scheduler,type AgentOutcome,type ComputeOutcome} from '../scheduler.ts';
import {validateSnapshot} from '../snapshot.ts';
import {openAuthReturn,openCredential,sealCredential,validateAuth,type StoredCredential} from '../crypto.ts';
import {ApiError,authorize,handleApi,json,type ApiService} from './api.ts';
import {advanceWorkflow,changedPaths,workflowFingerprint,type WorkflowRecord,type WorkflowSpec} from '../workflow.ts';
import {advanceCarbonCampaign,reserveCarbonRequest,settleCarbonRequest,terraSizingOrder,terraCachePairOrder,type NpmCacheMode,type BenchmarkInstance,type CarbonOutcome,type CarbonCampaign,type CarbonEffort,type CarbonUsage} from '../carbon-benchmark.ts';
import {handleCarbonGateway, syntheticCarbonStream} from '../carbon-gateway.ts';
import {sha256} from '../snapshot.ts';
import {handleTerraGateway,syntheticTerraStream,terraCredential,terraOrigin} from '../terra-gateway.ts';
import {latencySequenceTurns,type TerraGatewayTiming,type TerraLatencyMode} from '../terra-latency.ts';
import {npmCacheOrigin,npmCachePath,npmCacheMaxBytes,npmCacheKey,npmCacheLockPath} from '../npm-cache-object.ts';
import runtimeBuild from '../../runtime-build.json' with {type:'json'};
declare global {namespace Cloudflare {interface GlobalProps {mainModule:typeof import('./worker.ts')}}}

interface Env {
 CF_VERSION_METADATA?:{id:string};
 ARTIFACTS:R2Bucket;CREDENTIALS:R2Bucket;
 SCHEDULER:DurableObjectNamespace<SchedulerDO>;RUNNER:DurableObjectNamespace<RunnerDO>;
 GEMINI_BENCHMARK_KEY?:string;TERRA_BENCHMARK_AUTH?:string;
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

const dependencyHosts=['registry.npmjs.org','github.com','codeload.github.com','objects.githubusercontent.com',
 'release-assets.githubusercontent.com','binaries.prisma.sh','raw.githubusercontent.com','realworld-docs.netlify.app'];
function dependencyOutbound(request:Request,providerHosts:string[]=[]){
 const url=new URL(request.url);
 if(providerHosts.includes(url.hostname))return outbound(request,providerHosts);
 if(!['GET','HEAD'].includes(request.method)&&!(request.method==='POST'&&url.hostname==='github.com'&&url.pathname.endsWith('/git-upload-pack')))
  return Promise.resolve(new Response('Denied',{status:403}));
 return outbound(request,dependencyHosts);
}
export class ResourceComputeOutbound extends WorkerEntrypoint<Env>{async fetch(request:Request){
 const url=new URL(request.url);
 if(url.hostname==='hivemind-artifacts.invalid'){
  const digest=url.pathname.slice(1),auth=request.headers.get('authorization')??'';
  if(request.method!=='GET'||url.protocol!=='https:'||url.port||url.search||url.username||url.password||!/^[a-f0-9]{64}$/.test(digest)||!/^Bearer hma_[a-f0-9]{64}$/.test(auth))return new Response('Denied',{status:403});
  const ref=await this.env.SCHEDULER.getByName('owner').artifactRead(auth.slice(7),digest);
  if(!ref)return new Response('Denied',{status:403});
  const object=await this.env.ARTIFACTS.get(largeArtifactKey(digest));
  if(!object||object.size!==ref.sizeBytes)return new Response('Unavailable',{status:404});
  return new Response(object.body,{headers:{'content-type':'application/octet-stream','content-length':String(object.size),'cache-control':'no-store'}});
 }
 return dependencyOutbound(request);
}}
export class ResourceCodexOutbound extends WorkerEntrypoint<Env>{fetch(request:Request){return dependencyOutbound(request,['chatgpt.com','auth.openai.com','api.openai.com']);}}
export class ResourceClaudeOutbound extends WorkerEntrypoint<Env>{fetch(request:Request){return dependencyOutbound(request,['api.anthropic.com','claude.ai','claude.com','platform.claude.com']);}}

export class CarbonOutbound extends WorkerEntrypoint<Env>{
 async fetch(request:Request){
  const url=new URL(request.url);
  if(url.origin===npmCacheOrigin){
   if(url.pathname!==npmCachePath||url.search||!['GET','PUT'].includes(request.method))return new Response(null,{status:404});
   const authorization=request.headers.get('authorization')??'';
   if(!/^Bearer hmb_[a-f0-9]{64}$/.test(authorization))return new Response(null,{status:403});
   const write=request.method==='PUT';
   const key=await this.env.SCHEDULER.getByName('owner').npmCacheGrant(authorization.slice(7),write);
   if(!key)return new Response(null,{status:403});
   if(!write){
    const cached=await this.env.ARTIFACTS.get(key);
    if(!cached)return new Response(null,{status:404});
    const digest=cached.customMetadata?.sha256;
    if(cached.size>npmCacheMaxBytes||!digest||!/^[a-f0-9]{64}$/.test(digest)){
     await cached.body.cancel();
     return new Response(null,{status:502});
    }
    return new Response(cached.body,{headers:{'content-type':'application/octet-stream',
     'content-length':String(cached.size),'x-hivemind-cache-length':String(cached.size),'x-hivemind-cache-sha256':digest,'cache-control':'no-store'}});
   }
   const length=Number(request.headers.get('x-hivemind-cache-length')),digest=request.headers.get('x-hivemind-cache-sha256');
   if(!request.body||!Number.isSafeInteger(length)||length<=0||length>npmCacheMaxBytes||!digest||!/^[a-f0-9]{64}$/.test(digest))
    return new Response(null,{status:400});
   if(await this.env.ARTIFACTS.head(key))return new Response(null,{status:409});
   const {readable,writable}=new FixedLengthStream(length);
   const controller=new AbortController();
   const transfer=request.body.pipeTo(writable,{signal:controller.signal}).then(()=>true,()=>false);
   try{
    const saved=await this.env.ARTIFACTS.put(key,readable,{onlyIf:{etagDoesNotMatch:'*'},sha256:digest,customMetadata:{sha256:digest}});
    if(!saved){controller.abort();await transfer;return new Response(null,{status:409});}
    if(!await transfer)return new Response(null,{status:502});
    return new Response(null,{status:201});
   }catch{
    controller.abort();
    await transfer;
    return new Response(null,{status:502});
   }
  }
  if(url.origin===terraOrigin){
   const scheduler=this.env.SCHEDULER.getByName('owner');
   const probe=request.headers.get('x-hivemind-terra-probe')==='1';
   const auth=terraCredential(this.env.TERRA_BENCHMARK_AUTH);
   return handleTerraGateway(request,{
    credential:probe?{access:'fixture',accountId:'fixture',expires:Date.now()+60000}:auth,
    ...(probe?{fetchImpl:async()=>syntheticTerraStream()}:{}),
    reserve:capability=>scheduler.reserveCarbon(capability,'medium',1,probe,'terra'),
    settle:(...args)=>scheduler.settleCarbon(...args),
   });
  }
  const synthetic=url.origin==='https://hivemind-carbon-probe.invalid';
  if(synthetic||url.hostname==='generativelanguage.googleapis.com'){
   const scheduler=this.env.SCHEDULER.getByName('owner');
   const upstream=synthetic?new Request('https://generativelanguage.googleapis.com'+url.pathname+url.search,request):request;
   return handleCarbonGateway(upstream,{key:synthetic?'nonbillable-fixture':this.env.GEMINI_BENCHMARK_KEY,
    ...(synthetic?{fetchImpl:async()=>syntheticCarbonStream()}:{}),
    reserve:(capability,effort,estimate)=>scheduler.reserveCarbon(capability,effort,estimate,synthetic),
    settle:(capability,reservationId,usage,tokens,failure)=>scheduler.settleCarbon(capability,reservationId,usage,tokens,failure)});
  }
  if(!['GET','HEAD'].includes(request.method)&&!(request.method==='POST'&&url.hostname==='github.com'&&url.pathname.endsWith('/git-upload-pack')))return new Response('Denied',{status:403});
  return outbound(request,['registry.npmjs.org','github.com','codeload.github.com','objects.githubusercontent.com',
   'release-assets.githubusercontent.com','realworld-docs.netlify.app','binaries.prisma.sh','raw.githubusercontent.com']);
 }
}

interface RunnerMetadata {jobId:string;attempt:string;kind:'agent'|'compute';provider?:'codex'|'claude';prepared:boolean;launchIssued:boolean;pid?:number;stopped:boolean;runtimeRevision?:string;ralphToken?:string}
interface RuntimeState {prepared:boolean;started:{jobId:string;attempt:string;pid:number;startedAt:number}|null;resultReady:boolean;cancelRequested:boolean}
class InvalidRuntimeResult extends Error {}
type Completion={kind:'agent';outcome:AgentOutcome}|{kind:'compute';outcome:ComputeOutcome};
export class RunnerDO extends DurableObject<Env>{
 private metadata?:RunnerMetadata;
 private revisionVerified=false;
 constructor(ctx:DurableObjectState,env:Env){super(ctx,env);ctx.blockConcurrencyWhile(async()=>{this.metadata=await ctx.storage.get<RunnerMetadata>('metadata');});}
 private async save(){await this.ctx.storage.put('metadata',this.metadata!);}
 private async request(path:string,method='GET',value?:unknown,timeout=1500){const container=this.ctx.container;if(!container?.running)throw new Error('Runtime unavailable');return container.getTcpPort(3000).fetch(new Request(`http://runtime${path}`,{method,headers:{'content-type':'application/json',...(path.startsWith('/ralph/')&&this.metadata?.ralphToken?{'x-hivemind-ralph':this.metadata.ralphToken}:{})},...(value===undefined?{}:{body:JSON.stringify(value)}),signal:AbortSignal.timeout(timeout)}));}
 async ensure(job:JobRecord):Promise<{ready:boolean;lost:boolean;prepared:boolean;launchIssued:boolean;legacy?:boolean}>{return this.ctx.blockConcurrencyWhile(async()=>{
  this.revisionVerified=false;
  if(this.metadata&&(this.metadata.jobId!==job.id||this.metadata.attempt!==job.attempt))throw new Error('Attempt mismatch');
  if(!this.metadata){this.metadata={jobId:job.id,attempt:job.attempt,kind:job.kind,provider:job.provider,prepared:false,launchIssued:false,stopped:false};await this.save();}
  const container=this.ctx.container;if(!container)throw new Error('Runtime binding missing');
  if(this.metadata.stopped||(!container.running&&(this.metadata.prepared||this.metadata.launchIssued)))return {ready:false,lost:true,prepared:this.metadata.prepared,launchIssued:this.metadata.launchIssued};
  if(!container.running)container.start({image:container.images.runtime,instance:job.executionGroup?.instance??job.carbon?.instance??'standard-1',enableInternet:false,
   ...(job.executionGroup||job.carbon?.instance?{labels:{'hvm-bench-job':job.id}}:{})});
  const handler=job.carbon?this.ctx.exports.CarbonOutbound:job.executionGroup?.dependencyNetwork?
   (job.kind==='compute'?this.ctx.exports.ResourceComputeOutbound:job.provider==='claude'?this.ctx.exports.ResourceClaudeOutbound:this.ctx.exports.ResourceCodexOutbound):job.kind==='compute'?this.ctx.exports.ComputeOutbound:job.provider==='claude'?this.ctx.exports.ClaudeOutbound:this.ctx.exports.CodexOutbound;
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
  if(input.ralph){this.metadata.ralphToken=input.ralph.token;await this.save();}
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
 async checkpoint():Promise<string|null>{
  const response=await this.request('/ralph/checkpoint','GET',undefined,3000);
  if(response.status===404)return null;
  if(!response.ok)throw new Error('Ralph checkpoint unavailable');
  const text=await response.text();
  if(text.length>8*1024*1024)throw new Error('Ralph checkpoint is too large');
  return text;
 }
 async feedback(round:number,snapshotId:string,feedback:RalphFeedback):Promise<boolean>{
  const response=await this.request('/ralph/feedback','POST',{round,snapshotId,...feedback});
  if(response.status===409)return false;
  if(!response.ok)throw new Error('Ralph feedback unavailable');
  return true;
 }
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
 private async schedule(){if(Object.values(this.scheduler.state.computeGroups??{}).some(g=>g.status==='RUNNING'||g.status==='INTEGRATING')||Object.values(this.scheduler.state.workflows??{}).some(w=>w.status==='RUNNING'||w.status==='INTEGRATING')||Object.values(this.scheduler.state.carbonCampaigns??{}).some(c=>c.phase!=='done')||this.scheduler.list().some(job=>job.status==='QUEUED'||!job.containerStopped||!terminal(job.status)))await ensureSchedulerAlarm(this.ctx.storage);}
 async fetch(request:Request){return this.ctx.blockConcurrencyWhile(async()=>{
  if(new URL(request.url).pathname==='/v1/terra-auth-readiness'&&request.method==='GET'){
   const denied=authorize(request,this.env.CONTROL_TOKEN);if(denied)return denied;
   const credential=terraCredential(this.env.TERRA_BENCHMARK_AUTH);
   return json({present:typeof this.env.TERRA_BENCHMARK_AUTH==='string',valid:!!credential,
     enough:!!credential&&credential.expires-Date.now()>=1500000});
  }
  const response=await handleApi(request,this.env.CONTROL_TOKEN,this);await this.save();await this.schedule();return response;});}
 private artifactStore(){return new LargeArtifactStore(this.env.ARTIFACTS,this.ctx.storage);}
 async beginLargeArtifact(ref:LargeArtifactRef){return this.artifactStore().begin(ref);}
 async putLargeArtifactPart(id:string,part:number,data:Uint8Array){return this.artifactStore().part(id,part,data);}
 async completeLargeArtifact(id:string){return this.artifactStore().complete(id);}
 async abortLargeArtifact(id:string){return this.artifactStore().abort(id);}
 async largeArtifact(digest:string){const head=await this.artifactStore().head(digest);if(!head)throw new ApiError(404);return head;}
 async artifactRead(token:string,digest:string):Promise<LargeArtifactRef|null>{
  if(!/^hma_[a-f0-9]{64}$/.test(token)||!/^[a-f0-9]{64}$/.test(digest))return null;
  const grant=await this.ctx.storage.get<ArtifactReadGrant>('large-cap:'+sha256(token));
  const job=grant?this.scheduler.state.jobs[grant.jobId]:undefined;
  if(!authorizeArtifactRead(grant,job,digest,Date.now()))return null;
  return job!.largeArtifacts!.find(r=>r.sha256===digest)!;
 }
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
 async createComputeGroup(spec:ComputeGroupSpec){
  const groups=this.scheduler.state.computeGroups??={};
  const previous=Object.values(groups).find(g=>g.spec.idempotencyKey===spec.idempotencyKey);
  if(previous){if(JSON.stringify(previous.spec)!==JSON.stringify(spec))throw new ApiError(409);return previous;}
  await this.snapshot(spec.snapshotId);
  for(const ref of spec.artifacts??[])if(!await this.artifactStore().head(ref))throw new ApiError(422);
  const group:ComputeGroupRecord={id:randomUUID(),spec,status:'DRAFT',createdAt:Date.now()};
  groups[group.id]=group;
  return group;
 }
 private recordComputeGroup(id:string){
  const groups=this.scheduler.state.computeGroups??{};
  if(!Object.hasOwn(groups,id))throw new ApiError(404);
  return groups[id]!;
 }
 async approveComputeGroup(id:string){
  const group=this.recordComputeGroup(id);
  if(group.status!=='DRAFT')return group;
  await this.snapshot(group.spec.snapshotId);
  for(const ref of group.spec.artifacts??[])if(!await this.artifactStore().head(ref))throw new ApiError(422);
  const candidate=new Scheduler(this.scheduler.state);
  const record=candidate.state.computeGroups![id]!,now=Date.now();
  record.jobIds=record.spec.checks.map(check=>{
   const job=candidate.enqueueCompute(record.spec.snapshotId,check,now);
   assignGroup(candidate.state.jobs[job.id]!,id,record.spec.concurrency,record.spec.instance);
   if(record.spec.artifacts)candidate.state.jobs[job.id]!.largeArtifacts=structuredClone(record.spec.artifacts);
   return job.id;
  });
  Object.assign(record,{status:'RUNNING',approvedAt:now,
   deadline:now+record.spec.checks.reduce((sum,c)=>sum+c.timeoutMs,0)+record.spec.integration.timeoutMs+60000});
  this.scheduler=candidate;
  return record;
 }
 async computeGroup(id:string){
  const group=this.recordComputeGroup(id);
  const read=async(id:string)=>{
   const job=this.scheduler.get(id);
   return {job,result:job.resultKey?await this.readResult(job.resultKey):undefined};
  };
  return {group,jobs:await Promise.all((group.jobIds??[]).map(read)),
   integration:group.integrationId?await read(group.integrationId):undefined};
 }
 async cancelComputeGroup(id:string){
  const group=this.recordComputeGroup(id);
  if(['SUCCEEDED','FAILED','CANCELLED'].includes(group.status))return group;
  if(group.status==='DRAFT'){group.status='CANCELLED';group.finishedAt=Date.now();return group;}
  group.cancellationRequested=true;
  for(const jobId of [...(group.jobIds??[]),...(group.integrationId?[group.integrationId]:[])])await this.cancel(jobId);
  return group;
 }
 async createWorkflow(spec:WorkflowSpec){
  const workflows=this.scheduler.state.workflows??={};
  const previous=Object.values(workflows).find(w=>w.spec.idempotencyKey===spec.idempotencyKey);
  if(previous){
   if(workflowFingerprint(previous.spec)!==workflowFingerprint(spec))throw new ApiError(409);
   return previous;
  }
  await this.assertContract(spec);
  const workflow:WorkflowRecord={id:randomUUID(),spec,status:'DRAFT',createdAt:Date.now()};
  workflows[workflow.id]=workflow;
  return workflow;
 }
 private recordWorkflow(id:string):WorkflowRecord{
  const workflows=this.scheduler.state.workflows??{};
  if(!Object.hasOwn(workflows,id))throw new ApiError(404);
  return workflows[id]!;
 }
 private async assertContract(spec:WorkflowSpec){
  const source=await this.snapshot(spec.snapshotId);
  if(source.files.find(file=>file.path===spec.contractPath)?.sha256!==spec.contractHash)throw new ApiError(422);
 }
 async approveWorkflow(id:string){
  const draft=this.recordWorkflow(id);
  if(draft.status!=='DRAFT')return draft;
  await this.assertContract(draft.spec);
  if(this.env.CODEX_SANDBOX_APPROVED!=='true'||this.env.CLAUDE_NESTED_APPROVED!=='true')throw new ApiError(503);
  const candidate=new Scheduler(this.scheduler.state);
  const workflow=candidate.state.workflows![id]!;
  const now=Date.now();
  const workerIds=workflow.spec.workers.map(({writes,...worker})=>{
   const instructions=`Use the fixed contract in ${workflow.spec.contractPath}. Only edit: ${writes.join(', ')}.\n\n${worker.instructions}`;
   const job=candidate.submit({...worker,instructions,snapshotId:workflow.spec.snapshotId,idempotencyKey:`workflow:${id}:${worker.provider}`},now);
   candidate.state.jobs[job.id]!.ralph={maxRounds:3,writes};
   candidate.state.jobs[job.id]!.executionGroup={id,concurrency:workflow.spec.concurrency??2,instance:workflow.spec.instance??'standard-1',dependencyNetwork:workflow.spec.instance!==undefined};
   return job.id;
  }) as [string,string];
  const deadline=now+workflow.spec.workers.reduce((total,worker)=>total+worker.timeoutMs,0)+workflow.spec.integration.timeoutMs+60000;
  Object.assign(workflow,{workerIds,status:'RUNNING',approvedAt:now,deadline});
  this.scheduler=candidate;
  return workflow;
 }
 async workflow(id:string,includeResult:boolean){
  const workflow=this.recordWorkflow(id);
  const workers=(workflow.workerIds??[]).map(id=>this.scheduler.get(id));
  const integration=workflow.integrationId?this.scheduler.get(workflow.integrationId):undefined;
  if(!includeResult)return {workflow,workers,integration};
  if(workflow.status!=='SUCCEEDED'&&workflow.status!=='FAILED')throw new ApiError(409);
  return {workflow,workers:await Promise.all(workers.map(async job=>({job,result:job.resultKey?await this.readResult(job.resultKey):undefined}))),
   integration:integration?{job:integration,result:integration.resultKey?await this.readResult(integration.resultKey):undefined}:undefined,
   output:workflow.outputSnapshotId?await this.snapshot(workflow.outputSnapshotId):undefined};
 }
 private enqueueCarbon(campaign:CarbonCampaign,effort:CarbonEffort,instance?:BenchmarkInstance,cacheMode?:NpmCacheMode){
  const job=this.scheduler.enqueueCompute(campaign.snapshotId,{id:'carbon-benchmark',argv:['node','carbon-internal'],timeoutMs:(campaign.latency==='replay'||campaign.latency==='cache-replay')?600000:campaign.latency==='sequence'?360000:campaign.latency===true?120000:1200000},Date.now());
  this.scheduler.state.jobs[job.id]!.carbon={campaignId:campaign.id,effort,probe:campaign.probe,model:campaign.model,instance,latency:campaign.latency,cacheMode};
  return job.id;
 }
 async createCarbon(snapshotId:string,requestId:string,probe:boolean,model?:'terra',instance?:BenchmarkInstance,sizing?:boolean,latency?:TerraLatencyMode){
  if(latency==='realworld-warm'||latency==='realworld-cache-pairs'||latency==='realworld-cold'||latency==='realworld-r2-cache')instance='standard-3';
  const campaigns=this.scheduler.state.carbonCampaigns??={};
  const old=Object.values(campaigns).find(c=>c.requestId===requestId);
  if(old){if(old.snapshotId!==snapshotId||old.probe!==probe||old.model!==model||old.instance!==instance||old.sizing!==sizing||old.latency!==latency)throw new ApiError(409);return old;}
  if(!probe){
   if(latency==='replay'||latency==='cache-replay')throw new ApiError(400);
   if(model==='terra'){
    const auth=terraCredential(this.env.TERRA_BENCHMARK_AUTH);
    if(!auth||auth.expires-Date.now()<(sizing||latency==='realworld-cache-pairs'?7_800_000:1_500_000))throw new ApiError(503);
    if(auth.requestId!==requestId)throw new ApiError(409);
   }else if(!this.env.GEMINI_BENCHMARK_KEY)throw new ApiError(503);
   const verified=Object.values(campaigns).some(c=>c.probe&&c.model===model&&c.latency===latency&&c.snapshotId===snapshotId&&c.runtimeRevision===runtimeBuild.digest&&
     c.phase==='done'&&c.runs.length===(model==='terra'?1:2)&&c.runs.every(run=>this.scheduler.get(run.id).status==='SUCCEEDED'));
   if(sizing){
    const sizes=new Set(Object.values(campaigns).filter(c=>c.probe&&c.model==='terra'&&!c.latency&&c.snapshotId===snapshotId&&
      c.runtimeRevision===runtimeBuild.digest&&c.phase==='done'&&c.runs.length===1&&this.scheduler.get(c.runs[0]!.id).status==='SUCCEEDED').map(c=>c.instance));
    if(!sizes.has('standard-1')||!sizes.has('standard-3'))throw new ApiError(422);
   }else if(!verified)throw new ApiError(422);
  }
  if(!await this.env.ARTIFACTS.head(snapshotKey(snapshotId)))throw new ApiError(422);
  if(Object.values(campaigns).some(c=>c.phase!=='done'))throw new ApiError(409);
  const priorSpentMicros=probe?0:Object.values(campaigns).filter(c=>!c.probe&&c.model===model&&c.latency===latency&&c.snapshotId===snapshotId)
   .reduce((sum,c)=>sum+c.runs.reduce((total,r)=>total+r.spentMicros+(r.reservedMicros??0),0),0);
  if(priorSpentMicros>=20_000_000)throw new ApiError(422);
  const campaign:CarbonCampaign={id:randomUUID(),snapshotId,priorSpentMicros,phase:'compare',requestId,probe,model,instance,sizing,latency,runtimeRevision:runtimeBuild.digest,runs:[]};
  const firstInstance=sizing?terraSizingOrder[0]:instance;
  const cacheMode=latency==='realworld-cold'?'cold':latency==='realworld-cache-pairs'?(probe?'warm':terraCachePairOrder[0]):undefined;
  for(const effort of (model==='terra'?['medium']:['medium','low']) as CarbonEffort[])
   campaign.runs.push({id:this.enqueueCarbon(campaign,effort,firstInstance,cacheMode),effort,instance:firstInstance,cacheMode,spentMicros:0,requests:0});
  campaigns[campaign.id]=campaign;
  return campaign;
 }
 async carbon(id:string){
  const records=this.scheduler.state.carbonCampaigns??{};
  if(!Object.hasOwn(records,id))throw new ApiError(404);
  const campaign=records[id]!;
  return {campaign,runs:await Promise.all(campaign.runs.map(async run=>{
   const job=this.scheduler.get(run.id);
   return {job,result:job.resultKey?await this.readResult(job.resultKey):undefined};
  }))};
 }
 async npmCacheGrant(capability:string,write:boolean){
  const id=await this.ctx.storage.get<string>('carbon-cap:'+sha256(capability));
  if(!id)return null;
  const job=this.scheduler.get(id);
  if(job.carbon?.latency!=='realworld-r2-cache'||(write&&!job.carbon.probe)||
    !['STARTING','RUNNING'].includes(job.status)||job.cancellationRequested||job.deadline<=Date.now())return null;
  const snapshot=await this.snapshot(job.snapshotId);
  const lock=snapshot.files.find(file=>file.path===npmCacheLockPath);
  return lock?npmCacheKey(lock.sha256):null;
 }
 async reserveCarbon(capability:string,effort:CarbonEffort|null,estimate:number,synthetic=false,model?:'terra'){
  return this.ctx.blockConcurrencyWhile(async()=>{
   const id=await this.ctx.storage.get<string>('carbon-cap:'+sha256(capability));
   if(!id)return null;
   const job=this.scheduler.get(id);
   if(!job.carbon||(job.carbon.latency==='replay'||job.carbon.latency==='cache-replay')||job.carbon.model!==model||Boolean(job.carbon.probe)!==synthetic||(effort!==null&&job.carbon.effort!==effort)||job.cancellationRequested||
    !['STARTING','RUNNING'].includes(job.status)||job.deadline<=Date.now())return null;
   const campaign=this.scheduler.state.carbonCampaigns?.[job.carbon.campaignId];
   if(!campaign||(model==='terra'&&!synthetic&&campaign.requestId!==terraCredential(this.env.TERRA_BENCHMARK_AUTH)?.requestId)||
    (campaign.latency&&campaign.runs.some(run=>run.id===id&&run.requests>=((campaign.latency==='realworld'||campaign.latency==='realworld-warm'||campaign.latency==='realworld-cache-pairs'||campaign.latency==='realworld-cold'||campaign.latency==='realworld-r2-cache')?500:campaign.latency==='sequence'?latencySequenceTurns:campaign.latency==='wire-replay'&&!campaign.probe?26:1)))||!reserveCarbonRequest(campaign,id,estimate))return null;
   const reservationId=randomUUID();
   await this.ctx.storage.put('carbon-reservation:'+id,reservationId);
   await this.save();
   return {effort:job.carbon.effort,reservationId};
  });
 }
 async settleCarbon(capability:string,reservationId:string,usage:number|null,tokens?:CarbonUsage,failure?:string,modelWaitMs?:number,timing?:TerraGatewayTiming){
  return this.ctx.blockConcurrencyWhile(async()=>{
   const id=await this.ctx.storage.get<string>('carbon-cap:'+sha256(capability));
   if(!id||await this.ctx.storage.get<string>('carbon-reservation:'+id)!==reservationId)throw new Error('Stale Carbon reservation');
   const job=this.scheduler.get(id);
   const campaign=this.scheduler.state.carbonCampaigns?.[job.carbon?.campaignId??''];
   if(!campaign)throw new Error('Missing Carbon campaign');
   settleCarbonRequest(campaign,id,usage,tokens,failure);
   const run=campaign.runs.find(run=>run.id===id)!;
   if(Number.isSafeInteger(modelWaitMs)&&modelWaitMs!>=0)run.modelWaitMs=(run.modelWaitMs??0)+modelWaitMs!;
   if((campaign.latency==='wire-replay'||campaign.latency==='sequence'||campaign.latency==='realworld'||campaign.latency==='realworld-warm'||campaign.latency==='realworld-cache-pairs'||campaign.latency==='realworld-cold'||campaign.latency==='realworld-r2-cache')&&timing)(run.gatewayTimings??=[]).push(timing);
   else if(campaign.latency&&timing)run.gatewayTiming=timing;
   await this.save();
   await this.ctx.storage.delete('carbon-reservation:'+id);
  });
 }
 private async advanceCarbon(){
  for(const campaign of Object.values(this.scheduler.state.carbonCampaigns??{})){
   if(campaign.phase==='done')continue;
   const outcomes=new Map<string,CarbonOutcome>();
   for(const run of campaign.runs){
    const job=this.scheduler.get(run.id);
    const ended=terminal(job.status)&&job.containerStopped;
    if(!ended)return;
    const result=job.resultKey?await this.readResult(job.resultKey) as {carbon?:{elapsedMs:number}}:undefined;
    outcomes.set(job.id,{terminal:ended,cancelled:job.status==='CANCELLED',passed:job.status==='SUCCEEDED'&&!!result?.carbon&&!run.blocked,
     durationMs:result?.carbon?.elapsedMs??Number.MAX_SAFE_INTEGER});
   }
   advanceCarbonCampaign(campaign,id=>outcomes.get(id),(effort,instance,cacheMode)=>this.enqueueCarbon(campaign,effort,instance,cacheMode));
  }
 }
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
   for(const group of Object.values(this.scheduler.state.computeGroups??{}))advanceComputeGroup(group,this.scheduler,Date.now());
   await this.advanceCarbon();
   const plans=Object.values(this.scheduler.state.workflows??{}).filter(w=>w.status==='RUNNING'||w.status==='INTEGRATING');
   if(plans.length){
    const turn=await this.ctx.storage.get<number>('workflowCursor')??0;
    await this.ctx.storage.put('workflowCursor',(turn+1)%plans.length);
    await advanceWorkflow(plans[turn%plans.length]!,this.scheduler,{read:id=>this.snapshot(id),write:s=>this.putSnapshot(s)},Date.now());
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
   const input:RuntimeInput={version:1,jobId:job.id,attempt:job.attempt,mode:job.kind,snapshot:await this.snapshot(job.snapshotId),timeoutMs,...(job.executionGroup?.dependencyNetwork?{resourceMeasurement:true}:{})};
   if(job.kind==='agent'){
    const credential=this.scheduler.state.credentials[job.credentialId!]!;if(credential.generation!==job.credentialGeneration||credential.activeJobId!==job.id)throw new Error('Credential ownership mismatch');
    const object=await this.env.CREDENTIALS.get(credential.objectKey);if(!object)throw new Error('Credential unavailable');
    input.model=job.model;input.effort=job.effort;
    input.auth=validateAuth(job.provider!,await openCredential(await object.json() as StoredCredential,credential.id,credential.generation,this.env.AUTH_STORAGE_KEY));input.provider=job.provider;input.instructions=job.instructions;input.authReturnPublicKey=this.env.AUTH_RETURN_PUBLIC_KEY;input.claudeNestedCompatible=job.provider==='claude'&&this.env.CLAUDE_NESTED_APPROVED==='true';
    if(job.ralph){
     const key=`ralphToken:${job.id}`;
     let token=await this.ctx.storage.get<string>(key);
     if(!token){token=randomBytes(32).toString('hex');await this.ctx.storage.put(key,token);}
     input.ralph={...job.ralph,token};
    }
   }else{
    input.argv=job.argv;
    if(job.largeArtifacts){
     const key='large-token:'+job.id;let capability=await this.ctx.storage.get<string>(key);
     if(!capability){capability='hma_'+randomBytes(32).toString('hex');await this.ctx.storage.put(key,capability);}
     await this.ctx.storage.put('large-cap:'+sha256(capability),{jobId:job.id,attempt:job.attempt,expiresAt:job.deadline} satisfies ArtifactReadGrant);
     input.largeArtifacts={refs:job.largeArtifacts,capability};
    }
    if(job.carbon){
     const key='carbon-token:'+job.id;
     let token=await this.ctx.storage.get<string>(key);
     if(token===undefined){token='hmb_'+randomBytes(32).toString('hex');await this.ctx.storage.put(key,token);}
     if(token)await this.ctx.storage.put('carbon-cap:'+sha256(token),job.id);
     input.carbon={effort:job.carbon.effort,capability:token,probe:job.carbon.probe,model:job.carbon.model,instance:job.carbon.instance,latency:job.carbon.latency,cacheMode:job.carbon.cacheMode};
    }
   }
   await runner.prepare(input);
  }
  if(job.cancellationRequested||job.status==='CANCELLING')await runner.cancel();
  if(!readiness.legacy)await runner.launch();const polled=JSON.parse(await runner.poll()) as {lost:boolean;state?:RuntimeState;result?:RuntimeResult};
  if(polled.lost){const stopped=await runner.stop();this.scheduler.quarantine(job.id,job.attempt,'CONTAINER_LOST',Date.now(),stopped);return;}
  if(polled.state?.started&&job.status==='STARTING')this.scheduler.running(job.id,job.attempt,Date.now());
  if(polled.result){try{await this.complete(job,polled.result);}catch(error){if(!(error instanceof InvalidRuntimeResult))throw error;const stopped=await runner.stop();this.scheduler.quarantine(job.id,job.attempt,'INVALID_RUNTIME_RESULT',Date.now(),stopped);}return;}
  if(Date.now()>await this.hardDeadline(job)){const stopped=await runner.stop();this.scheduler.quarantine(job.id,job.attempt,'RESULT_MISSING_AFTER_DEADLINE',Date.now(),stopped);}
  else if(job.ralph&&job.status==='RUNNING'&&!job.cancellationRequested)await this.advanceRalph(job,runner);

 }
 private async advanceRalph(job:JobRecord,runner:DurableObjectStub<RunnerDO>){
  const raw=await runner.checkpoint();
  if(!raw)return;
  const value=JSON.parse(raw) as RalphCheckpoint;
  if(!Number.isInteger(value.round)||value.round<1||value.round>job.ralph!.maxRounds||
     typeof value.sessionId!=='string'||!/^[a-f0-9-]{36}$/i.test(value.sessionId))throw new InvalidRuntimeResult();
  const snapshot=validateSnapshot(value.snapshot);
  const stored=this.scheduler.state.jobs[job.id]!;
  let checkpoint=stored.checkpoint;
  if(checkpoint&&value.round<checkpoint.round)return;
  if(!checkpoint||checkpoint.round!==value.round){
   if(checkpoint&&checkpoint.sessionId!==value.sessionId)throw new InvalidRuntimeResult();
   const paths=changedPaths(await this.snapshot(job.snapshotId),snapshot);
   const rejected=!paths.length||paths.some(path=>!job.ralph!.writes.includes(path));
   if(!rejected)await this.putSnapshot(snapshot);
   const checkIds=rejected?[]:job.checks.map(spec=>{
    const check=this.scheduler.enqueueCompute(snapshot.digest,spec,Date.now());
    if(job.executionGroup)this.scheduler.state.jobs[check.id]!.executionGroup={...job.executionGroup};
    return check.id;
   });
   if(checkpoint)(stored.checkpointHistory??=[]).push(checkpoint);
   checkpoint={round:value.round,sessionId:value.sessionId,snapshotId:snapshot.digest,checkIds,rejected};
   stored.checkpoint=checkpoint;
   await this.save();
  }else if(checkpoint.sessionId!==value.sessionId||checkpoint.snapshotId!==snapshot.digest)throw new InvalidRuntimeResult();
  const checks=checkpoint.checkIds.map(id=>this.scheduler.get(id));
  if(checks.some(job=>!terminal(job.status)||!job.containerStopped))return;
  const accepted=!checkpoint.rejected&&checks.length===job.checks.length&&checks.every(c=>c.status==='SUCCEEDED');
  const failures=checks.filter(c=>c.status!=='SUCCEEDED');
  // Stable feedback is safe to replay if the transport response is lost.
  const diagnostics=await Promise.all(failures.map(async check=>{
   if(!check.resultKey)return '';
   const result=await this.readResult(check.resultKey) as {process?:{stdout?:string;stderr?:string}};
   return (String(result.process?.stdout??'')+'\n'+String(result.process?.stderr??'')).slice(-650);
  }));
  const message=accepted?'All required independent checks passed.':checkpoint.rejected?'Changes exceeded the approved write scope.':
   `Failed checks: ${failures.map(c=>`${c.checkId}: ${c.errorCode??c.status}`).join(', ')}. Inspect the test specification and repair only your assigned files.\n${diagnostics.join('\n')}`.slice(0,2000);
  await runner.feedback(checkpoint.round,checkpoint.snapshotId,{accepted,message});
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
  let ralphRounds:RuntimeResult['ralphRounds'];
  if(job.ralph&&result.ralphRounds!==undefined){
   if(!Array.isArray(result.ralphRounds)||result.ralphRounds.length>job.ralph.maxRounds||
    result.ralphRounds.some((r,i)=>!r||r.round!==i+1||!auditId(r.sessionId)||r.sessionId!==result.sessionId||
      !/^[a-f0-9]{64}$/.test(r.snapshotId)||typeof r.accepted!=='boolean'||!Number.isSafeInteger(r.startedAt)||!Number.isSafeInteger(r.finishedAt)||r.startedAt<0||r.finishedAt<r.startedAt||r.accepted&&i!==result.ralphRounds!.length-1))throw new InvalidRuntimeResult();
   ralphRounds=result.ralphRounds.map(r=>({round:r.round,sessionId:r.sessionId,snapshotId:r.snapshotId,accepted:r.accepted,startedAt:r.startedAt,finishedAt:r.finishedAt}));
  }
  if(job.ralph&&result.process.status==='passed'&&result.process.exitCode===0){
   const last=ralphRounds?.at(-1),checkpoint=job.checkpoint;
   if(!last?.accepted||!checkpoint||checkpoint.rejected||checkpoint.round!==last.round||
    checkpoint.sessionId!==last.sessionId||checkpoint.snapshotId!==last.snapshotId||output?.digest!==last.snapshotId||
    checkpoint.checkIds.length!==job.checks.length||checkpoint.checkIds.some(id=>this.scheduler.get(id).status!=='SUCCEEDED'))throw new InvalidRuntimeResult();
  }
  if(result.carbon!==undefined&&!job.carbon)throw new InvalidRuntimeResult();
  if(job.carbon&&result.process.status==='passed'){
   const evidence=result.carbon;
   if(!evidence||evidence.model!==job.carbon.model||evidence.effort!==job.carbon.effort||!Number.isSafeInteger(evidence.elapsedMs)||evidence.elapsedMs<0||
     !Array.isArray(evidence.scores)||(job.carbon.model==='terra'&&!job.carbon.probe&&
      !this.scheduler.state.carbonCampaigns?.[job.carbon.campaignId]?.runs.find(run=>run.id===job.id&&!run.blocked&&!run.reservedMicros&&run.usage&&run.requests>0))||(job.carbon.latency===true&&(!evidence.latency||evidence.latency.transport!=='sse'||evidence.latency.requests!==1))||
     ((job.carbon.latency==='realworld-warm'||job.carbon.cacheMode==='warm')&&!evidence.npm?.seed)||
     ((job.carbon.latency==='realworld-cache-pairs'||job.carbon.latency==='realworld-cold')&&(!evidence.npm?.lockSha256||evidence.npm.cacheMode!==job.carbon.cacheMode))||
     (job.carbon.latency==='realworld-r2-cache'&&(!evidence.npm?.lockSha256||!evidence.npm.r2?.restore))||
     (job.carbon.latency==='wire-replay'&&evidence.wireReplay?.length!==(job.carbon.probe?1:26))||
     (job.carbon.latency==='replay'&&evidence.replay?.samples.length!==3)||
     (job.carbon.latency==='cache-replay'&&evidence.cacheReplay?.length!==6)||
     (job.carbon.latency==='sequence'&&(evidence.latencyTurns?.length!==latencySequenceTurns||evidence.latencyTurns.some(turn=>turn.transport!=='sse'||turn.requests!==1)))||(!job.carbon.probe&&(!job.carbon.latency||job.carbon.latency==='realworld'||job.carbon.latency==='realworld-warm'||job.carbon.latency==='realworld-cache-pairs'||job.carbon.latency==='realworld-cold'||job.carbon.latency==='realworld-r2-cache')&&(evidence.scores.length!==3||
       evidence.scores.some(score=>score.files!==13||score.requests!==154||score.exitCode!==0))))throw new InvalidRuntimeResult();
  }
  if(result.resources!==undefined){
   const value=result.resources;
   if(!job.executionGroup?.dependencyNetwork||!value||typeof value!=='object'||Array.isArray(value)||
    Object.keys(value).some(key=>!['usageUsec','throttledUsec','throttledPeriods','peakMemoryBytes','memorySource','memoryLimitBytes'].includes(key))||
    Object.entries(value).some(([key,n])=>key==='memorySource'?!['cgroup-peak','cgroup-sampled','process-rss-sampled'].includes(String(n)):
      typeof n!=='number'||!Number.isSafeInteger(n)||n<0))throw new InvalidRuntimeResult();
  }
  let claudeResultMetrics:RuntimeResult['claudeResultMetrics'];
  if(result.claudeResultMetrics!==undefined){
   if(job.kind!=='agent'||job.provider!=='claude')throw new InvalidRuntimeResult();
   try{claudeResultMetrics=validateClaudeResultMetrics(result.claudeResultMetrics);}catch{throw new InvalidRuntimeResult();}
  }
  if(result.largeArtifacts!==undefined){
   const a=result.largeArtifacts;
   if(job.kind!=='compute'||!job.largeArtifacts||!a||Object.keys(a).some(k=>!['durationMs','receipts'].includes(k))||
    !Number.isFinite(a.durationMs)||a.durationMs<0||!Array.isArray(a.receipts)||a.receipts.length!==job.largeArtifacts.length)throw new InvalidRuntimeResult();
   for(const [index,receipt] of a.receipts.entries()){
    const ref=job.largeArtifacts[index]!;
    if(!receipt||Object.keys(receipt).some(k=>!['name','sha256','sizeBytes','format','expandedBytes','maxFiles','files'].includes(k))||
     receipt.name!==ref.name||receipt.sha256!==ref.sha256||receipt.sizeBytes!==ref.sizeBytes||receipt.format!==ref.format||receipt.maxFiles!==ref.maxFiles||
     !Number.isSafeInteger(receipt.expandedBytes)||receipt.expandedBytes<0||receipt.expandedBytes>ref.expandedBytes||
     !Number.isSafeInteger(receipt.files)||receipt.files<1||receipt.files>ref.maxFiles)throw new InvalidRuntimeResult();
   }
  }else if(job.largeArtifacts&&result.process.status==='passed')throw new InvalidRuntimeResult();
  if(output)await this.putSnapshot(output);
  // Only allowlisted result fields enter normal artifacts. The sealed auth return stays private.
  const safe={version:1,jobId:result.jobId,attempt:result.attempt,inputSnapshotId:result.inputSnapshotId,outputSnapshotId:output?.digest,process:result.process,summary:result.summary,errorCode:result.errorCode,sourceUnchanged:result.sourceUnchanged,credentialsAbsent:result.credentialsAbsent,provider:result.provider,sessionId:result.sessionId,usage:result.usage,claudeResultMetrics,subagentReceipts:result.subagentReceipts,mcpReceipts,sandboxReceipts,ralphRounds,carbon:result.carbon,resources:result.resources,largeArtifacts:result.largeArtifacts,sandboxPolicy:result.sandboxPolicy,boundary};
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
async function diagnoseCarbon(env:Env):Promise<Response>{
 const key=env.GEMINI_BENCHMARK_KEY;
 if(!key)return json({modelAvailable:false,category:'SECRET_UNAVAILABLE'},503);
 let response:Response;
 try{
  response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-4-carbon',
   {headers:{'x-goog-api-key':key},redirect:'manual',signal:AbortSignal.timeout(8000)});
 }catch(error){
  const name=error instanceof Error?error.name:'UnknownError';
  return json({modelAvailable:false,category:'TRANSPORT',errorType:name});
 }
 if(!response.ok){
  let reason: string|undefined;
  try{
   const result=await response.json() as {error?:{status?:unknown;message?:unknown}};
   if(typeof result.error?.status==='string'&&/^[A-Z_]{1,60}$/.test(result.error.status))reason=result.error.status;
   if(typeof result.error?.message==='string'&&/location is not supported|unsupported location/i.test(result.error.message))reason='LOCATION_UNSUPPORTED';
  }catch{/* Preserve the HTTP status. */}
  return json({http:response.status,modelAvailable:false,reason});
 }
 try{
  const value=await response.json() as {name?:string;inputTokenLimit?:number;outputTokenLimit?:number;thinking?:boolean};
  return json({http:response.status,modelAvailable:value.name==='models/gemini-4-carbon',
   inputTokenLimit:value.inputTokenLimit,outputTokenLimit:value.outputTokenLimit,thinking:value.thinking===true});
 }catch{return json({http:response.status,modelAvailable:false,category:'INVALID_METADATA'});}
}
export default {async fetch(request:Request,env:Env){const path=new URL(request.url).pathname;if(path==='/health'&&request.method==='GET')return json({ok:true,service:'hivemind-cloudflare',workerVersion:env.CF_VERSION_METADATA?.id,expectedRuntimeRevision:runtimeBuild.digest});if(!path.startsWith('/v1/'))return json({error:'Not found'},404);const denied=authorize(request,env.CONTROL_TOKEN);if(denied)return denied;if(path==='/v1/carbon-diagnostics'&&request.method==='GET')return diagnoseCarbon(env);try{return await env.SCHEDULER.getByName('owner').fetch(request);}catch{return json({error:'Service is unavailable'},503);}}};
