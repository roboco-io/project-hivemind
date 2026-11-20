import type {SchedulerJobQuery,SchedulerJobPage} from '../scheduler-jobs.ts';
import {PART_BYTES,validateLargeArtifactRef,type LargeArtifactRef} from '../large-artifact.ts';
import {validateComputeGroupSpec,type ComputeGroupSpec} from '../compute-group.ts';
import type {TerraLatencyMode} from '../terra-latency.ts';
import type {BenchmarkInstance} from '../carbon-benchmark.ts';
import type {JobSpec,Provider,Snapshot} from '../contracts.ts';
import {validateJobSpec} from '../scheduler.ts';
import {validateSnapshot} from '../snapshot.ts';
import {validateWorkflowSpec,type WorkflowSpec} from '../workflow.ts';
import {validateAuth} from '../crypto.ts';

export const MAX_BODY_BYTES=8*1024*1024;
export class ApiError extends Error {statusCode:number;constructor(statusCode:number){super('Request failed');this.statusCode=statusCode;}}
export interface ApiService {
 beginLargeArtifact?(ref:LargeArtifactRef):Promise<unknown>;
 putLargeArtifactPart?(id:string,part:number,data:Uint8Array):Promise<unknown>;
 completeLargeArtifact?(id:string):Promise<unknown>;
 abortLargeArtifact?(id:string):Promise<unknown>;
 largeArtifact?(digest:string):Promise<unknown>;
 putSnapshot(snapshot:Snapshot):Promise<unknown>;
 registerCredential(id:string,provider:Provider,auth:string):Promise<unknown>;
 credentials():Promise<unknown>;
 submit(spec:JobSpec):Promise<unknown>;
 jobs():Promise<unknown>;
 jobsPage?(query:SchedulerJobQuery):Promise<SchedulerJobPage>;
 job(id:string):Promise<unknown>;
 cancel(id:string):Promise<unknown>;
 result(id:string):Promise<unknown>;
 createComputeGroup?(spec:ComputeGroupSpec):Promise<unknown>;
 approveComputeGroup?(id:string):Promise<unknown>;
 computeGroup?(id:string):Promise<unknown>;
 cancelComputeGroup?(id:string):Promise<unknown>;
 createWorkflow?(spec:WorkflowSpec):Promise<unknown>;
 approveWorkflow?(id:string):Promise<unknown>;
 workflow?(id:string,includeResult:boolean):Promise<unknown>;
 createCarbon?(snapshotId:string,requestId:string,probe:boolean,model?:'terra',instance?:BenchmarkInstance,sizing?:boolean,latency?:TerraLatencyMode):Promise<unknown>;
 carbon?(id:string):Promise<unknown>;
}
export const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
export function authorize(request:Request,token:string|undefined):Response|null {
 if(!token)return json({error:'Service is not configured'},503);
 const expected=`Bearer ${token}`,actual=request.headers.get('authorization')??'';
 let difference=actual.length^expected.length;for(let i=0;i<expected.length;i++)difference|=expected.charCodeAt(i)^(actual.charCodeAt(i)||0);
 return difference?json({error:'Unauthorized'},401):null;
}
export const isAutonomousPath=(path:string)=>path==='/v1/autonomous-tasks'||path.startsWith('/v1/autonomous-tasks/');
export function authorizeAutonomousRoute(request:Request,operatorToken:string|undefined,workerToken:string|undefined,reporterToken?:string):Response|null {
 if(/\/(?:acceptExternal|settleExternal|cleanedExternal|accept-external|settle-external|cleaned-external)\/?$/.test(new URL(request.url).pathname))return json({error:'Not found'},404);
 const worker=/^\/v1\/autonomous-tasks\/[^/]+\/(claim|native-start|heartbeat|finish|reserve|settle|worker-state|external-action|external-artifact)\/?$/.test(new URL(request.url).pathname);
 if(worker&&(!workerToken?.trim()||!operatorToken?.trim()||workerToken===operatorToken))return json({error:'Service is not configured'},503);
 const reporter=/^\/v1\/autonomous-tasks\/[^/]+\/(native-ready|native-receipt)\/?$/.test(new URL(request.url).pathname);
 if(reporter&&(!reporterToken||/[\s\p{Cc}]/u.test(reporterToken)||!operatorToken?.trim()||!workerToken?.trim()||reporterToken===operatorToken||reporterToken===workerToken))return json({error:'Service is not configured'},503);
 return authorize(request,reporter?reporterToken:worker?workerToken:operatorToken);
}
// Autonomous policy wakes only for a future transition. Existing scheduler alarms win.
export async function scheduleAutonomousAlarm(storage:{getAlarm():Promise<number|null>;setAlarm(time:number):Promise<unknown>},tasks:readonly {status:string;spec:{endsAt:number};nextRunAt?:number;lease?:{expiresAt:number}}[],now:number):Promise<void>{
 let next=Infinity;
 for(const task of tasks){
  if(['completed','cancelled','budget_exceeded','expired','failed'].includes(task.status))continue;
  const dates=[task.spec.endsAt];
  if(task.status==='waiting'&&task.nextRunAt!==undefined)dates.push(task.nextRunAt);
  if(task.lease)dates.push(task.lease.expiresAt);
  for(const date of dates)if(Number.isFinite(date)&&date>now)next=Math.min(next,date);
 }
 if(!Number.isFinite(next))return;
 const current=await storage.getAlarm();
 if(current===null||current<=now||next<current)await storage.setAlarm(next);
}
async function body(request:Request):Promise<unknown>{
 const length=request.headers.get('content-length');if(length&&(!/^\d+$/.test(length)||Number(length)>MAX_BODY_BYTES))throw new ApiError(413);
 if(!request.body)throw new ApiError(400);
 const reader=request.body.getReader();const chunks:Uint8Array[]=[];let total=0;
 try{while(true){const next=await reader.read();if(next.done)break;total+=next.value.length;if(total>MAX_BODY_BYTES){await reader.cancel();throw new ApiError(413);}chunks.push(next.value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new ApiError(400);}
}
async function partBody(request:Request):Promise<Uint8Array>{
 const length=request.headers.get('content-length');if(!length||!/^\d+$/.test(length)||Number(length)<1||Number(length)>PART_BYTES||!request.body)throw new ApiError(413);
 const reader=request.body.getReader(),parts:Uint8Array[]=[];let total=0;
 try{while(true){const next=await reader.read();if(next.done)break;total+=next.value.byteLength;if(total>Number(length)){await reader.cancel();throw new ApiError(413);}parts.push(next.value);}}finally{reader.releaseLock();}
 if(total!==Number(length))throw new ApiError(400);const out=new Uint8Array(total);let offset=0;for(const p of parts){out.set(p,offset);offset+=p.byteLength;}return out;
}
export async function handleApi(request:Request,token:string|undefined,service:ApiService):Promise<Response>{
 const path=new URL(request.url).pathname;
 if(path==='/health'&&request.method==='GET')return json({ok:true,service:'hivemind-cloudflare'});
 if(!path.startsWith('/v1/'))return json({error:'Not found'},404);
 const denied=authorize(request,token);if(denied)return denied;
 try{
  let match:RegExpExecArray|null;
  if(path==='/v1/large-artifact-uploads'&&request.method==='POST'&&service.beginLargeArtifact){
   const raw=await body(request) as {ref?:unknown};let ref:LargeArtifactRef;
   try{if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>k!=='ref'))throw Error();ref=validateLargeArtifactRef(raw.ref);}catch{throw new ApiError(400);}
   return json(await service.beginLargeArtifact(ref),201);
  }
  if((match=/^\/v1\/large-artifact-uploads\/([a-f0-9-]{36})\/parts\/([1-9][0-9]{0,3})$/.exec(path))&&request.method==='PUT'&&service.putLargeArtifactPart)
   return json(await service.putLargeArtifactPart(match[1]!,Number(match[2]),await partBody(request)));
  if((match=/^\/v1\/large-artifact-uploads\/([a-f0-9-]{36})\/(complete|abort)$/.exec(path))&&request.method==='POST'){
   if(match[2]==='complete'&&service.completeLargeArtifact)return json(await service.completeLargeArtifact(match[1]!));
   if(match[2]==='abort'&&service.abortLargeArtifact)return json(await service.abortLargeArtifact(match[1]!));
  }
  if((match=/^\/v1\/large-artifacts\/([a-f0-9]{64})$/.exec(path))&&request.method==='GET'&&service.largeArtifact)return json(await service.largeArtifact(match[1]!));

  if(request.method==='PUT'&&(match=/^\/v1\/snapshots\/([a-f0-9]{64})$/.exec(path))){let snapshot:Snapshot;try{snapshot=validateSnapshot(await body(request));}catch(error){if(error instanceof ApiError)throw error;throw new ApiError(400);}if(snapshot.digest!==match[1])throw new ApiError(400);return json(await service.putSnapshot(snapshot),201);}
  if(request.method==='POST'&&(match=/^\/v1\/credentials\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/.exec(path))){const value=await body(request);if(!value||typeof value!=='object'||Array.isArray(value))throw new ApiError(400);const data=value as Record<string,unknown>;if(Object.keys(data).some(k=>!['provider','auth'].includes(k))||(data.provider!=='codex'&&data.provider!=='claude'))throw new ApiError(400);let auth:string;try{auth=validateAuth(data.provider,data.auth);}catch{throw new ApiError(400);}return json(await service.registerCredential(match[1]!,data.provider,auth),201);}
  if(request.method==='GET'&&path==='/v1/credentials')return json(await service.credentials());
  if(request.method==='POST'&&path==='/v1/compute-groups'&&service.createComputeGroup)
   return json(await service.createComputeGroup(validateComputeGroupSpec(await body(request))),201);
  if((match=/^\/v1\/compute-groups\/([a-f0-9-]{36})(\/approve|\/cancel)?$/.exec(path))){
   if(request.method==='GET'&&!match[2]&&service.computeGroup)return json(await service.computeGroup(match[1]!));
   if(request.method==='POST'&&match[2]==='/approve'&&service.approveComputeGroup)return json(await service.approveComputeGroup(match[1]!),202);
   if(request.method==='POST'&&match[2]==='/cancel'&&service.cancelComputeGroup)return json(await service.cancelComputeGroup(match[1]!),202);
  }
  if(request.method==='POST'&&path==='/v1/workflows'&&service.createWorkflow){
   const raw=await body(request);
   let spec:WorkflowSpec;try{spec=validateWorkflowSpec(raw);}catch{throw new ApiError(400);}
   return json(await service.createWorkflow(spec),201);
  }
  if((match=/^\/v1\/workflows\/([a-f0-9-]{36})(\/approve|\/result)?$/.exec(path))){
   if(request.method==='POST'&&match[2]==='/approve'&&service.approveWorkflow)return json(await service.approveWorkflow(match[1]!),202);
   if(request.method==='GET'&&match[2]!=='/approve'&&service.workflow)return json(await service.workflow(match[1]!,match[2]==='/result'));
  }
  if(request.method==='POST'&&['/v1/carbon-benchmarks','/v1/terra-benchmarks'].includes(path)&&service.createCarbon){
   const raw=await body(request);
   if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new ApiError(400);
   const value=raw as Record<string,unknown>;
   const model=path==='/v1/terra-benchmarks'?'terra':undefined;
   if(Object.keys(value).some(k=>!['snapshotId','requestId','probe','instance','sizing','latency'].includes(k))||
     (value.instance!==undefined&&(model!=='terra'||value.probe!==true||(value.instance!=='standard-1'&&value.instance!=='standard-3')))||
     (value.latency!==undefined&&(model!=='terra'||(value.latency!==true&&value.latency!=='sequence'&&value.latency!=='realworld'&&value.latency!=='realworld-warm'&&value.latency!=='realworld-cache-pairs'&&value.latency!=='realworld-cold'&&value.latency!=='realworld-r2-cache'&&value.latency!=='wire-replay'&&value.latency!=='replay'&&value.latency!=='cache-replay')||value.sizing!==undefined||(value.latency!=='cache-replay'&&value.instance!==undefined)))||
     ((value.latency==='replay'||value.latency==='cache-replay')&&value.probe!==true)||
     (value.latency==='cache-replay'&&value.instance===undefined)||
     (value.sizing!==undefined&&(model!=='terra'||value.probe!==false||value.sizing!==true))||
     typeof value.snapshotId!=='string'||!/^[a-f0-9]{64}$/.test(value.snapshotId)||
     typeof value.requestId!=='string'||!/^[a-zA-Z0-9_-]{1,120}$/.test(value.requestId)||
     typeof value.probe!=='boolean')throw new ApiError(400);
   return json(await service.createCarbon(value.snapshotId,value.requestId,value.probe,model,value.instance as BenchmarkInstance|undefined,value.sizing===true?true:undefined,value.latency as TerraLatencyMode|undefined),202);
  }
  if(request.method==='GET'&&(match=/^\/v1\/(?:carbon|terra)-benchmarks\/([a-f0-9-]{36})$/.exec(path))&&service.carbon)
   return json(await service.carbon(match[1]!));
  if(request.method==='POST'&&path==='/v1/jobs'){let spec:JobSpec;try{spec=validateJobSpec(await body(request));}catch(error){if(error instanceof ApiError)throw error;throw new ApiError(400);}if(spec.idempotencyKey.startsWith('workflow:'))throw new ApiError(400);return json(await service.submit(spec),202);}
  if(request.method==='GET'&&path==='/v1/jobs'){
   const url=new URL(request.url);if(!url.search)return json(await service.jobs());if(url.search.length>2048)throw new ApiError(400);
   const query:SchedulerJobQuery={};for(const key of url.searchParams.keys())if(!['view','limit','cursor'].includes(key)||url.searchParams.getAll(key).length!==1)throw new ApiError(400);
   if(url.searchParams.has('view')&&url.searchParams.get('view')!=='summary')throw new ApiError(400);
   if(url.searchParams.has('limit')){const value=url.searchParams.get('limit')!;if(!/^[1-9][0-9]{0,2}$/.test(value)||Number(value)>100)throw new ApiError(400);query.limit=Number(value);}
   if(url.searchParams.has('cursor')){const value=url.searchParams.get('cursor')!;if(!value||value.length>1024)throw new ApiError(400);query.cursor=value;}
   if(!service.jobsPage)throw new ApiError(503);return json(await service.jobsPage(query));
  }
  if((match=/^\/v1\/jobs\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})(\/cancel|\/result)?$/.exec(path))){if(request.method==='GET'&&!match[2])return json(await service.job(match[1]!));if(request.method==='GET'&&match[2]==='/result')return json(await service.result(match[1]!));if(request.method==='POST'&&match[2]==='/cancel')return json(await service.cancel(match[1]!),202);}
  return json({error:'Not found'},404);
 }catch(error){if((error as {code?:unknown})?.code==='PAGE_REQUIRED')return json({error:'PAGE_REQUIRED',summaryPath:'/v1/jobs?view=summary&limit=20'},413);const status=error instanceof ApiError?error.statusCode:typeof error==='object'&&error!==null&&'statusCode'in error&&[400,404,409,413,422,503].includes(Number(error.statusCode))?Number(error.statusCode):500;return json({error:status===500?'Service is unavailable':status===413?'Request body is too large':'Request could not be accepted'},status);}
}
