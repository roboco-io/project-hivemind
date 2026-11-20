import {validateAutonomousCapabilities,validateAutonomousModelPin} from '../../contracts/src/autonomous.ts';
import type {AutonomousLease} from '../../contracts/src/autonomous.js';
import type {AutonomousExecutor} from './autonomous-runner.js';
import type {NativeSnapshot,NativeClaudeRuntimePort,NativeClaudeRequest,NativeClaudeResponse} from '../../contracts/src/autonomous-native.js';
const LIMIT=12*1024*1024;
const rejected=()=>new Error('Native Claude iteration rejected');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Serialize untrusted dynamic values without invoking accessors or toJSON. */
function privateJson(value:unknown):string {
 const chunks:string[]=[],seen=new Set<object>(),encoder=new TextEncoder();let size=0,nodes=0;
 const append=(s:string)=>{size+=encoder.encode(s).length;if(size>LIMIT)throw rejected();chunks.push(s);};
 const quote=(s:string)=>{if(s.length>LIMIT)throw rejected();append(JSON.stringify(s));};
 const walk=(v:unknown,depth:number):void=>{
  if(++nodes>100000||depth>64)throw rejected();
  if(typeof v==='string'){quote(v);return;}
  if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)){append(JSON.stringify(v));return;}
  if(typeof v!=='object'||seen.has(v))throw rejected();
  const array=Array.isArray(v);if(!array&&Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)throw rejected();
  if(array&&v.length>100000||Object.getOwnPropertySymbols(v).length)throw rejected();
  const desc=Object.getOwnPropertyDescriptors(v),names=Object.keys(desc).filter(k=>!(array&&k==='length'));
  if(array&&(names.length!==v.length||names.some((k,i)=>k!==String(i))))throw rejected();
  seen.add(v);append(array?'[':'{');
  for(let i=0;i<names.length;i++){const k=names[i]!,p=desc[k]!;if(!('value'in p)||!p.enumerable||k==='toJSON')throw rejected();if(i)append(',');if(!array){quote(k);append(':');}walk(p.value,depth+1);}
  append(array?']':'}');seen.delete(v);
 };
 walk(value,0);return chunks.join('');
}
function fields(value:object,allowed:readonly string[],required:readonly string[]=allowed):void {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(value,k)))throw rejected();
}
function toolsAllowed(value:Pick<NativeClaudeRequest,'tools'|'web'|'externalProfiles'>):boolean {try{validateAutonomousCapabilities(value);return true;}catch{return false;}}
function validateSession(session:NativeClaudeRequest['session'],model:string):void {
 fields(session,['sessionId','model','sequence','data']);
 if(typeof session.sessionId!=='string'||!uuid.test(session.sessionId)||session.model!==model||!Number.isSafeInteger(session.sequence)||session.sequence<0||session.sequence>=Number.MAX_SAFE_INTEGER)throw rejected();
}
function validateBody(data:unknown,session:NativeClaudeRequest['session'],taskId:string):void {
 if(!data||typeof data!=='object'||Array.isArray(data))throw rejected();
 const b=data as {taskId?:unknown;version?:unknown;sessionId?:unknown;model?:unknown;workspacePath?:unknown;snapshot?:unknown;transcripts?:unknown};
 if(Object.hasOwn(b,'executionLease')||Object.hasOwn(b,'taskId')&&b.taskId!==taskId)throw rejected();
 if(b.version!==1||b.sessionId!==session.sessionId||b.model!==session.model||b.workspacePath!=='/workspace'||!b.snapshot||typeof b.snapshot!=='object'||!Array.isArray(b.transcripts)||!b.transcripts.length)throw rejected();
}
function validateLease(lease:AutonomousLease,taskId:string):void {
 fields(lease,['taskId','runId','workerId','token','expiresAt']);
 if(lease.taskId!==taskId||![lease.taskId,lease.runId,lease.workerId,lease.token].every(v=>typeof v==='string'&&v.trim().length>0&&v.length<=256)||!Number.isSafeInteger(lease.expiresAt)||lease.expiresAt<=Date.now())throw rejected();
}
function validateRequest(r:NativeClaudeRequest):void {
 fields(r,['version','taskId','executionLease','model','subagentModel','tools','goal','session','subscriptionAuth','maxRunMs','initialSnapshot','web','externalProfiles'],['version','taskId','executionLease','model','tools','goal','session','subscriptionAuth','maxRunMs']);
 if(r.version!==1||typeof r.taskId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(r.taskId)||!toolsAllowed(r)||typeof r.goal!=='string'||!r.goal||r.goal.length>24000||r.goal.includes('\0')||!Number.isSafeInteger(r.maxRunMs)||r.maxRunMs<1||r.maxRunMs>3600000||typeof r.subscriptionAuth!=='string'||!/^sk-ant-oat01-[A-Za-z0-9_-]{8,262100}$/.test(r.subscriptionAuth))throw rejected();
 validateAutonomousModelPin(r.model);validateAutonomousModelPin(r.subagentModel??r.model);
 validateLease(r.executionLease,r.taskId);
 validateSession(r.session,r.model);
 const privateBody=privateJson(r.session.data);if(privateBody.includes(r.executionLease.token)||privateBody.includes(r.subscriptionAuth))throw rejected();
 if(r.session.sequence===0){if(r.session.data!==null||!r.initialSnapshot)throw rejected();}
 else {if(r.initialSnapshot!==undefined)throw rejected();validateBody(r.session.data,r.session,r.taskId);}
}
function validateResponse(value:unknown,request:NativeClaudeRequest):NativeClaudeResponse {
 const text=privateJson(value);if(text.includes(request.subscriptionAuth)||text.includes(request.executionLease.token))throw rejected();
 const r=JSON.parse(text) as NativeClaudeResponse;
 fields(r,['version','session','usage','outcome','wakeAt','boundary','quota','usageUnavailable'],['version','session','usage','outcome','boundary']);
 fields(r.boundary,['platform','verified','noNewPrivs','capabilitiesDropped']);
 if(r.version!==1||r.boundary.platform!=='linux'||r.boundary.verified!==true||r.boundary.noNewPrivs!==1||r.boundary.capabilitiesDropped!==true)throw rejected();
 validateSession(r.session,request.model);
 if(r.session.sessionId!==request.session.sessionId||r.session.sequence!==request.session.sequence+1)throw rejected();
 validateBody(r.session.data,r.session,request.taskId);
 fields(r.usage,['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens']);
 if(!Object.values(r.usage).every(v=>Number.isSafeInteger(v)&&v>=0)||!['continue','complete','wait','input','failed'].includes(r.outcome))throw rejected();
 if(r.outcome==='wait'? !Number.isSafeInteger(r.wakeAt)||r.wakeAt!<=0||r.quota===undefined&&r.wakeAt!<=Date.now():r.wakeAt!==undefined)throw rejected();
 if(r.quota!==undefined) {
  fields(r.quota,['kind','resetsAt','evidence']);
  if(r.quota.kind!=='rejected'||r.quota.evidence!=='claude_rate_limit_event'||!Number.isSafeInteger(r.quota.resetsAt)||r.quota.resetsAt<=0||r.outcome!=='wait'||r.wakeAt!==r.quota.resetsAt)throw rejected();
  const body=r.session.data as {transcripts?:{path:string;content:string}[]};
  if(!body.transcripts?.some(t=>t.path===r.session.sessionId+'.jsonl'&&typeof t.content==='string'&&t.content.trim().length>0))throw rejected();
 }
 if(Object.hasOwn(r,'usageUnavailable')&&(r.usageUnavailable!==true||!r.quota||Object.values(r.usage).some(v=>v!==0)))throw rejected();
 return r;
}
async function guarded<T>(operation:()=>Promise<T>,signal:AbortSignal):Promise<T> {
 if(signal.aborted)throw rejected();let listener:(()=>void)|undefined;
 const aborted=new Promise<never>((_resolve,reject)=>{listener=()=>reject(rejected());signal.addEventListener('abort',listener,{once:true});});
 try {return await Promise.race([Promise.resolve().then(()=>{if(signal.aborted)throw rejected();return operation();}),aborted]);}
 finally {if(listener)signal.removeEventListener('abort',listener);}
}
export function createClaudeAutonomousExecutor(options:{runtime:NativeClaudeRuntimePort;initialSnapshot?:NativeSnapshot}):AutonomousExecutor {
 return async context=>{
  try {
   const spec=JSON.parse(privateJson(context.spec)) as typeof context.spec;
   const credentials=JSON.parse(privateJson(context.credentials)) as Record<string,string>;
   const session=JSON.parse(privateJson(context.session)) as typeof context.session;
   if(spec.provider!=='claude'||context.model!==spec.model||context.subagentModel!==spec.subagentModel||!Array.isArray(spec.systems)||!toolsAllowed(spec)||!Array.isArray(spec.credentialIds)||spec.credentialIds.length!==1||typeof spec.credentialIds[0]!=='string'||!spec.credentialIds[0].length||Object.keys(credentials).join(',')!=='claudeSubscription')throw rejected();
   validateAutonomousCapabilities(spec);
   const request=JSON.parse(privateJson({version:1,taskId:context.taskId,executionLease:context.executionLease,model:spec.model,subagentModel:spec.subagentModel??spec.model,tools:spec.tools,...(spec.web?{web:spec.web}:{}),...(spec.externalProfiles?{externalProfiles:spec.externalProfiles}:{}),goal:spec.goal,session,subscriptionAuth:credentials.claudeSubscription,maxRunMs:spec.maxRunMs,...(session.sequence===0&&options.initialSnapshot!==undefined?{initialSnapshot:options.initialSnapshot}:{})})) as NativeClaudeRequest;
   validateRequest(request);
   const r=validateResponse(await guarded(()=>options.runtime.execute(JSON.parse(privateJson(request)) as NativeClaudeRequest,context.signal),context.signal),request);
   if(context.signal.aborted||r.quota&&r.quota.resetsAt>=spec.endsAt)throw rejected();
   return {outcome:r.outcome,usage:r.usage,costMicros:null,session:r.session,...(r.quota?{quota:{...r.quota}}:{}),...(r.usageUnavailable?{usageUnavailable:true as const}:{}),...(r.wakeAt===undefined?{}:{wakeAt:r.wakeAt})};
  }catch{throw rejected();}
 };
}
export function createClaudeRuntimeHttpPort(options:{url:string;token:string;fetchImpl?:typeof fetch}):NativeClaudeRuntimePort {
 let endpoint:string;
 try {
  const url=new URL(options.url);
  if(url.username||url.password||options.url.split('/')[2]?.includes('@')||options.url.includes('?')||options.url.includes('#')||!['/','/iteration',''].includes(url.pathname)||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))||typeof options.token!=='string'||!options.token||options.token.length>4096||/[\s\x00-\x1f\x7f]/.test(options.token))throw rejected();
  endpoint=new URL('/iteration',url).href;
 }catch{throw rejected();}
 const fetchImpl=options.fetchImpl??fetch,token=options.token;
 return {async execute(request,signal){
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try {
   const body=privateJson(request),wire=JSON.parse(body) as NativeClaudeRequest;validateRequest(wire);
   const response=await guarded(()=>fetchImpl(endpoint,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body,signal,redirect:'error'}),signal);
   if(!response.ok||response.redirected||Number(response.headers.get('content-length')??0)>LIMIT||!response.body){void response.body?.cancel().catch(()=>{});throw rejected();}
   reader=response.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});const chunks:string[]=[];let bytes=0;
   while(true){const part=await guarded(()=>reader!.read(),signal);if(part.done)break;bytes+=part.value.byteLength;if(bytes>LIMIT)throw rejected();chunks.push(decoder.decode(part.value,{stream:true}));}
   chunks.push(decoder.decode());
   const result=validateResponse(JSON.parse(chunks.join('')),wire);
   if(privateJson(result).includes(token))throw rejected();
   return result;
  }catch{throw rejected();}finally{if(reader){void reader.cancel().catch(()=>{});reader.releaseLock();}}
 }};
}
