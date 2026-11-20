/** Operator-only HTTP facade. This port never exposes its remote credential. */
export interface AutonomousCloudProxy {forward(request:Request):Promise<Response>}
export interface AutonomousCloudProxyConfig {baseUrl:string;controlToken:string}
export interface AutonomousCloudProxyOptions {fetch?:typeof fetch;localTokens?:readonly string[]}
const PREFIX='/api/cloudflare/autonomous-tasks',REMOTE='/v1/autonomous-tasks';
const REQUEST_LIMIT=65536,RESPONSE_LIMIT=2*1024*1024,TIMEOUT_MS=5000;
class ProxyError extends Error{readonly statusCode:number;constructor(statusCode=503){super('Cloudflare autonomous request unavailable');this.statusCode=statusCode;}}
const fail=(status=400):never=>{throw new ProxyError(status);};
const errorResponse=(status:number)=>Response.json({error:'Cloudflare autonomous request unavailable'},{status,headers:{'cache-control':'no-store'}});
function route(request:Request):string{
 const url=new URL(request.url);if(!['GET','POST'].includes(request.method))fail(404);
 if(url.pathname!==PREFIX&&!url.pathname.startsWith(PREFIX+'/'))fail(404);
 const suffix=url.pathname.slice(PREFIX.length),parts=suffix?suffix.slice(1).split('/').map(s=>{try{return decodeURIComponent(s);}catch{return fail();}}):[];
 for(const [index,part] of parts.entries()){const pattern=index===2&&parts[1]==='external-actions'?/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/:/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;if(!pattern.test(part))fail(404);}
 const [id,action,requestId,operation]=parts;
 const allowed=request.method==='GET'?(parts.length===0||parts.length===1||(parts.length===2&&['external-actions','external-profiles','history','tool-calls'].includes(action!))):
  (parts.length===0||(parts.length===2&&['approve','revise','cancel','message','resume','reconcile','reconcile-run','cleaned','external-approval','external-cancel'].includes(action!))||(parts.length===4&&action==='external-actions'&&!!requestId&&['reconcile','cleanup','billing'].includes(operation!)));
 if(!allowed)fail(404);
 const params=url.searchParams;
 if(params.has('view')){if(request.method!=='GET'||parts.length!==1||params.size!==1||params.get('view')!=='summary')fail();return REMOTE+'/'+parts.map(encodeURIComponent).join('/')+url.search;}
 const history=request.method==='GET'&&parts.length===2&&action==='history';
 if(url.search&&(request.method!=='GET'||!(id===undefined||parts.length===2&&['external-actions','history','tool-calls'].includes(action!))))fail();
 if(history&&!params.has('kind'))fail();
 for(const key of params.keys())if(!(history?['kind','limit','cursor']:['limit','cursor']).includes(key)||params.getAll(key).length!==1)fail();
 if(history&&!['runs','actions','resources','interventions'].includes(params.get('kind')!))fail();
 if(params.has('limit')){const n=params.get('limit')!;if(!/^[1-9][0-9]{0,2}$/.test(n)||Number(n)>100)fail();}
 if(params.has('cursor')){const c=params.get('cursor')!;if(!c||c.length>4096||!/^[A-Za-z0-9_.-]+$/.test(c))fail();}
 return REMOTE+(parts.length?'/'+parts.map(encodeURIComponent).join('/'):'')+url.search;
}
export function validateAutonomousCloudRequest(request:Request):void{route(request);}
async function bounded(response:Response|Request,limit:number):Promise<string>{
 const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>limit))fail(413);
 const reader=response.body?.getReader();if(!reader)return '';let size=0;const chunks:Uint8Array[]=[];
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>limit){await reader.cancel();fail(413);}chunks.push(part.value);}}finally{reader.releaseLock();}
 return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
}
type Shape=true|{[key:string]:Shape}|readonly [Shape];
const usage:Shape={inputTokens:true,cacheReadTokens:true,cacheWriteTokens:true,outputTokens:true};
const spec:Shape={requestId:true,goal:true,provider:true,model:true,subagentModel:true,endsAt:true,budgetMicros:true,tools:[true],systems:[true],credentialIds:[true],maxRunMs:true,maxIterations:true,externalProfiles:[true],web:{allowedHosts:[true]},billingPolicy:{model:true,budget:true},schedule:{kind:true,timeZone:true,localTime:true},execution:{backend:true,mode:true,snapshotId:true,checks:[{id:true,argv:[true],timeoutMs:true}]}};
const action:Shape={id:true,requestId:true,tool:true,system:true,operation:true,estimatedCostMicros:true,status:true,actualCostMicros:true,resourceId:true};
const externalAction:Shape={parameterHash:true,parameters:{lifetimeMs:true,startActionId:true,artifactDigest:true,expectedHead:true,manifestDigest:true,keySuffix:true,putActionId:true},parametersSubset:{lifetimeMs:true,startActionId:true,artifactDigest:true,expectedHead:true,manifestDigest:true,keySuffix:true,putActionId:true},providerResult:{kind:true,id:true,oid:true},profileId:true,approvedTarget:{accountId:true,region:true,workloadId:true,repository:true,revision:true,branch:true,bucket:true,prefix:true,visibility:true},approvedProfileHash:true,operatorBillingEvidence:{source:true,evidenceRef:true,reasonHash:true,at:true},revision:true,resourceId:true,billingSource:true,evidenceRef:true,attestedAt:true,requestId:true,phase:true,actionId:true,status:true,operation:true,effect:true,cleanupStatus:true,verifiedCostMicros:true,billingFinal:true};
const profile:Shape={id:true,profileHash:true,enabled:true,provider:true,target:{accountId:true,region:true,workloadId:true,repository:true,revision:true,branch:true,visibility:true,bucket:true,prefix:true,kmsKeyId:true,maxObjectBytes:true,retentionDays:true},hfVisibilityDisplay:{visibility:true,publicEffect:true,notice:true},operations:[true],maxLifetimeMs:true,upperBoundMicros:true,maxActiveActions:true};
const task:Shape={id:true,spec,revision:true,status:true,createdAt:true,approvedAt:true,nextRunAt:true,iteration:true,activeRunStartedAt:true,spentMicros:true,reservedMicros:true,stopReason:true,counts:{humanInterventions:true,helpRequests:true,toolCalls:true,workerToolCalls:true},lease:{expiresAt:true},runs:[{runId:true,workerId:true,startedAt:true,finishedAt:true,scheduledAt:true,outcome:true,usage,costMicros:true,wakeAt:true,message:true,usageUnavailable:true,reconciledCostMicros:true,billingEvidence:true,quota:{kind:true,resetsAt:true,evidence:true}}],actions:[action],resources:[{id:true,system:true,cleanupOperation:true,status:true,actionId:true}],interventions:[{kind:true,message:true,at:true,revision:true}]};
function project(value:unknown,shape:Shape,tokens:readonly string[]):unknown{
 if(shape===true){
  if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value;
  if(typeof value!=='string')return undefined;if(value.length>16384)fail(503);
  let result=value;for(const token of tokens)if(token)for(const variant of new Set([token,encodeURIComponent(token)]))result=result.replaceAll(variant,'[REDACTED]');
  return result.replace(/Bearer\s+[^\s"<>]+/gi,'Bearer [REDACTED]');
 }
 if(Array.isArray(shape)){if(!Array.isArray(value))return undefined;if(value.length>65536)fail(503);return value.map(v=>project(v,shape[0]!,tokens)).filter(v=>v!==undefined);}
 if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
 const result:Record<string,unknown>={};for(const [key,child] of Object.entries(shape))if(Object.hasOwn(value,key)){const v=project((value as Record<string,unknown>)[key],child,tokens);if(v!==undefined){if(key==='resourceId'&&(typeof v!=='string'||!v.length||v.length>240||/[\p{Cc}]/u.test(v)))fail(503);if(key==='evidenceRef'&&(typeof v!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(v)||v.includes('://')))fail(503);if(key==='billingSource'&&!['provider_verified','operator_attested'].includes(v as string))fail(503);if(key==='attestedAt'&&(!Number.isSafeInteger(v)||Number(v)<0))fail(503);result[key]=v;}}return result;
}
/** Worker-reported tool calls. The values are the worker's own report, not independent proof. */
const toolAuditRecord:Shape={sequence:true,tool:true,inputDigest:true,inputSummary:true,inputTruncated:true,outcome:true,startedAt:true,durationMs:true,subagent:true,runId:true,iteration:true,receivedAt:true,source:true};
const toolAuditPage:Shape={source:true,items:[toolAuditRecord],totals:{recorded:true,denied:true,errors:true,droppedByWorker:true,droppedByStore:true},nextCursor:true};
function publicValue(value:unknown,tokens:readonly string[]):unknown{
 if(Array.isArray(value))return value.map(v=>publicValue(v,tokens));
 if(!value||typeof value!=='object')fail(503);const v=value as Record<string,unknown>;
 if(v.source==='worker_report'&&Object.hasOwn(v,'totals')){if(!Array.isArray(v.items)||v.items.length>100)fail(503);return project(v,toolAuditPage,tokens);}
 if(Object.hasOwn(v,'items')&&Object.hasOwn(v,'kind')){
  const shapes:Record<string,Shape>={runs:{runId:true,workerId:true,startedAt:true,finishedAt:true,scheduledAt:true,outcome:true,usage,costMicros:true,wakeAt:true,message:true,usageUnavailable:true,reconciledCostMicros:true,billingEvidence:true,quota:{kind:true,resetsAt:true,evidence:true}},actions:action,resources:{id:true,system:true,cleanupOperation:true,status:true,actionId:true},interventions:{kind:true,message:true,at:true,revision:true}};
  if(typeof v.kind!=='string'||!Object.hasOwn(shapes,v.kind)||!Array.isArray(v.items)||v.items.length>100)fail(503);
  return project(v,{taskId:true,kind:true,revision:true,items:[shapes[v.kind as string]!],nextCursor:true},tokens);
 }
 if(Object.hasOwn(v,'items')){const entries=v.items;if(!Array.isArray(entries)||entries.length>100)return fail(503);return {...project(v,{nextCursor:true},tokens) as Record<string,unknown>,items:entries.map(item=>publicValue(item,tokens))};}
 if(Object.hasOwn(v,'profiles'))return project(v,{profiles:[profile],enabled:true,available:true},tokens);
 if(Object.hasOwn(v,'phase')){
  const out=project(v,externalAction,tokens) as Record<string,unknown>;
  const hex=(value:unknown,sizes:readonly number[])=>typeof value==='string'&&sizes.includes(value.length)&&/^[a-f0-9]+$/.test(value);
  if(v.parameterHash!==undefined&&!hex(out.parameterHash,[64]))fail(503);
  for(const key of ['parameters','parametersSubset'])if(v[key]!==undefined){if(!v[key]||typeof v[key]!=='object'||Array.isArray(v[key]))fail(503);const source=v[key] as Record<string,unknown>,subset=out[key] as Record<string,unknown>;
   if(Object.hasOwn(source,'lifetimeMs')&&(!Number.isSafeInteger(subset.lifetimeMs)||Number(subset.lifetimeMs)<1))fail(503);
   if(Object.hasOwn(source,'startActionId')&&(typeof subset.startActionId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(subset.startActionId)||subset.startActionId.includes('://')))fail(503);
   if(Object.hasOwn(source,'artifactDigest')&&!hex(subset.artifactDigest,[64]))fail(503);
   if(Object.hasOwn(source,'expectedHead')&&!hex(subset.expectedHead,[40,64]))fail(503);
   if(Object.hasOwn(source,'manifestDigest')&&!hex(subset.manifestDigest,[64]))fail(503);
   if(Object.hasOwn(source,'keySuffix')&&(typeof subset.keySuffix!=='string'||!/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,239}$/.test(subset.keySuffix)||subset.keySuffix.includes('..')||subset.keySuffix.includes('//')||subset.keySuffix.endsWith('/')))fail(503);
   if(Object.hasOwn(source,'putActionId')&&(typeof subset.putActionId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(subset.putActionId)||subset.putActionId.includes('://')))fail(503);
  }
  if(v.providerResult!==undefined){const result=out.providerResult as Record<string,unknown>|undefined;if(!result||!v.providerResult||typeof v.providerResult!=='object'||Array.isArray(v.providerResult))return fail(503);
   if(result.kind==='aws_instance'){if(typeof result.id!=='string'||!/^i-[a-f0-9]{8,32}$/.test(result.id))fail(503);out.providerResult={kind:result.kind,id:result.id};}
   else if(result.kind==='hf_commit'||result.kind==='github_commit'){if(!hex(result.oid,[40,64]))fail(503);out.providerResult={kind:result.kind,oid:result.oid};}
   else fail(503);
  }
  if(out.profileId!==undefined&&(typeof out.profileId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(out.profileId)))fail(503);
  if(out.approvedProfileHash!==undefined&&(typeof out.approvedProfileHash!=='string'||!/^[a-f0-9]{64}$/.test(out.approvedProfileHash)))fail(503);
  if(v.approvedTarget!==undefined){const target=v.approvedTarget;if(!target||typeof target!=='object'||Array.isArray(target))fail(503);const t=target as Record<string,unknown>,keys=Object.keys(t);
   const text=(x:unknown,max:number)=>typeof x==='string'&&x.length>0&&x.length<=max&&!/[\p{Cc}]/u.test(x);
   if(Object.hasOwn(t,'accountId')){
    const s3=Object.hasOwn(t,'bucket'),allowed=s3?['accountId','region','bucket','prefix']:['accountId','region','workloadId'];
    if(keys.length!==allowed.length||!keys.every(k=>allowed.includes(k))||typeof t.accountId!=='string'||!/^\d{12}$/.test(t.accountId)||typeof t.region!=='string'||!/^[a-z]{2}-[a-z]+-\d$/.test(t.region))fail(503);
    if(s3){if(typeof t.bucket!=='string'||!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(t.bucket)||typeof t.prefix!=='string'||!/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,126}\/$/.test(t.prefix)||t.prefix.includes('..')||t.prefix.includes('//'))fail(503);}
    else if(!text(t.workloadId,100))fail(503);
   }
   else{const ref=Object.hasOwn(t,'revision')?'revision':'branch',visible=ref==='revision'&&Object.hasOwn(t,'visibility');if(keys.length!==(visible?3:2)||visible&&t.visibility!=='private'&&t.visibility!=='public'||!keys.every(k=>['repository',ref,...(visible?['visibility']:[])].includes(k))||typeof t.repository!=='string'||t.repository.length>200||!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(t.repository)||!text(t[ref],150)||! /^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(t[ref] as string)||(t[ref] as string).includes('..')||(t[ref] as string).includes('//'))fail(503);}
  }
  if(out.revision!==undefined&&(!Number.isSafeInteger(out.revision)||Number(out.revision)<1))fail(503);
  const evidence=out.operatorBillingEvidence as Record<string,unknown>|undefined;
  if(evidence&&(evidence.source!=='operator_attested'||typeof evidence.reasonHash!=='string'||!/^[a-f0-9]{64}$/.test(evidence.reasonHash)||!Number.isSafeInteger(evidence.at)||Number(evidence.at)<0))fail(503);
  return out;
 }
 if(Object.hasOwn(v,'taskId'))return project(v,{taskId:true,revision:true,profileId:true,profileIds:[true],admissionStopped:true},tokens);
 if(Object.hasOwn(v,'id'))return project(v,Object.hasOwn(v,'profileHash')||Object.hasOwn(v,'target')?profile:task,tokens);
 fail(503);
}
/** Reapply at the app boundary even for an injected port. Never relay headers or raw errors. */
export async function projectAutonomousCloudResponse(response:Response,tokens:readonly string[]=[]):Promise<Response>{
 try{
  if(response.status<200||response.status>=300){
   if(response.status===413){try{const value=JSON.parse(await bounded(response,RESPONSE_LIMIT));if(value?.code==='AUTONOMOUS_PAGE_REQUIRED')return Response.json({error:'Task history requires bounded pages',code:'AUTONOMOUS_PAGE_REQUIRED'},{status:413,headers:{'cache-control':'no-store'}});}catch{/* Never reflect an untrusted provider error body. */}}
   return errorResponse([400,401,403,404,409,413,422,503].includes(response.status)?response.status:503);
  }
  const raw=await bounded(response,RESPONSE_LIMIT);const value=publicValue(JSON.parse(raw),tokens);
  return Response.json(value,{status:response.status,headers:{'cache-control':'no-store'}});
 }catch{return errorResponse(503);}
}
export function createAutonomousCloudProxy(config:AutonomousCloudProxyConfig,options:AutonomousCloudProxyOptions={}):AutonomousCloudProxy{
 let origin:URL;const token=config.controlToken;
 try{origin=new URL(config.baseUrl);if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||typeof token!=='string'||!token||token.length>4096||/[\s\p{Cc}]/u.test(token))throw Error();}catch{throw new Error('Invalid autonomous Cloudflare proxy configuration.');}
 const tokens=[token,...(options.localTokens??[])],fetcher=options.fetch??globalThis.fetch;
 return {async forward(request){
  try{
   const path=route(request);let body:string|undefined;
   if(request.method==='POST'){body=await bounded(request,REQUEST_LIMIT);let parsed:unknown;try{parsed=JSON.parse(body);}catch{fail();}if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))fail();
    if(new URL(request.url).pathname.endsWith('/billing')){
     const b=parsed as Record<string,unknown>;if(Object.keys(b).some(k=>!['actualCostMicros','evidenceRef','reason','revision'].includes(k))||!Number.isSafeInteger(b.actualCostMicros)||Number(b.actualCostMicros)<1||typeof b.evidenceRef!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(b.evidenceRef)||b.evidenceRef.includes('://')||/^(?:sk-|hf_|ghp_|ghs_|github_pat_|AKIA|ASIA)/i.test(b.evidenceRef)||typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>1000||/[\p{Cc}]/u.test(b.reason)||(b.revision!==undefined&&(!Number.isSafeInteger(b.revision)||Number(b.revision)<1)))fail();
     body=JSON.stringify({actualCostMicros:b.actualCostMicros,evidenceRef:b.evidenceRef,reason:b.reason,...(b.revision===undefined?{}:{revision:b.revision})});
    }
    if(new URL(request.url).pathname.endsWith('/approve')){
     const b=parsed as Record<string,unknown>;if(Object.keys(b).some(k=>!['revision','reason','externalProfileHashes'].includes(k))||!Number.isSafeInteger(b.revision)||Number(b.revision)<1||typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>12000)fail();
     if(b.externalProfileHashes!==undefined){const hashes=b.externalProfileHashes;if(!hashes||typeof hashes!=='object'||Array.isArray(hashes))fail();const entries=Object.entries(hashes!);if(entries.length<1||entries.length>3||entries.some(([id,hash])=>!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)||typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)))fail();}
     body=JSON.stringify({revision:b.revision,reason:b.reason,...(b.externalProfileHashes===undefined?{}:{externalProfileHashes:b.externalProfileHashes})});
    }
   }
   const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
   try{return await Promise.race([(async()=>{const response=await fetcher(new URL(path,origin),{method:request.method,headers:{authorization:'Bearer '+token,...(body===undefined?{}:{'content-type':'application/json'})},body,redirect:'error',signal:abort.signal});if(response.redirected)fail(503);return projectAutonomousCloudResponse(response,tokens);})(),new Promise<Response>((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new ProxyError());},TIMEOUT_MS);})]);}
   finally{if(timer)clearTimeout(timer);abort.abort();}
  }catch(error){return errorResponse(error instanceof ProxyError?error.statusCode:503);}
 }};
}
