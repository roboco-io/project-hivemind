import {summarizeAutonomousTask} from '../../../packages/core/src/autonomous-repository.ts';
import {validateAutonomousCapabilities} from '../../../packages/contracts/src/autonomous.ts';
import type { AutonomousEngine } from '../../../packages/core/src/autonomous.js';
import type { AutonomousSpec, AutonomousLease, AutonomousRunResult, AutonomousActionRequest, AutonomousNativeReceipt, AutonomousTask } from '../../../packages/contracts/src/autonomous.js';

export type AutonomousOperation = 'acceptExternal'|'settleExternal'|'cleanedExternal'|'getSummary'|'historyPage'|'create'|'list'|'listPage'|'get'|'approve'|'revise'|'cancel'|'message'|'cleaned'|'claim'|'nativeStart'|'nativeReady'|'recordNativeReceipt'|'workerState'|'heartbeat'|'finish'|'reserve'|'settle'|'reconcile'|'resume'|'reconcileRun'|'tick'|'claimCloud'|'finishCloud'|'abandonCloud'|'finishUnstartedCloud';
export interface AutonomousApiService { execute(operation: AutonomousOperation, input: Record<string, unknown>): Promise<unknown> }
export interface AutonomousTransactionalStore { transaction<T>(fn: (engine: AutonomousEngine) => T, operation?:AutonomousOperation): T }
type Body = Record<string, unknown>;
class HttpError extends Error { statusCode: number; constructor(statusCode: number) { super('Invalid autonomous request'); this.statusCode=statusCode; } }
function object(value: unknown, required: string[], optional: string[] = []): Body {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400);
 const item=value as Body;
 if(required.some(key=>!Object.hasOwn(item,key)) || Object.keys(item).some(key=>!required.includes(key)&&!optional.includes(key))) throw new HttpError(400);
 return item;
}
function text(value:unknown): asserts value is string { if(typeof value!=='string'||!value.trim()||value.length>12000||value.includes('\0')) throw new HttpError(400); }
function integer(value:unknown): asserts value is number { if(!Number.isSafeInteger(value)||Number(value)<0) throw new HttpError(400); }
function strings(value:unknown) { if(!Array.isArray(value)||value.length>128) throw new HttpError(400); value.forEach(text); }
function spec(value:unknown): void {
 const item=object(value,['requestId','goal','provider','model','endsAt','budgetMicros','tools','systems','credentialIds','maxRunMs','maxIterations'],['subagentModel','billingPolicy','execution','schedule','web','externalProfiles']);
 if(item.execution!==undefined||item.web!==undefined||item.externalProfiles!==undefined||Array.isArray(item.tools)&&item.tools.some(tool=>tool==='WebFetch'||tool==='mcp__hivemind__action')){try{validateAutonomousCapabilities(item as unknown as import('../../../packages/contracts/src/autonomous.js').AutonomousSpec);}catch{throw new HttpError(400);}}
 if(item.schedule!==undefined){const schedule=object(item.schedule,['kind','timeZone','localTime']);if(schedule.kind!=='daily')throw new HttpError(400);text(schedule.timeZone);text(schedule.localTime);}
 if(item.billingPolicy!==undefined){const policy=object(item.billingPolicy,['model','budget']);if(policy.model!=='subscription'||policy.budget!=='external_actions'||item.provider!=='claude')throw new HttpError(400);}
 for(const key of ['requestId','goal','model']) text(item[key]);
 if(!['mock','claude','codex'].includes(String(item.provider))) throw new HttpError(400);
 if(item.execution!==undefined){
  const e=object(item.execution,['backend','snapshotId','checks'],['mode']);
  if(e.backend!=='cloudflare'||typeof e.snapshotId!=='string'||!/^[a-f0-9]{64}$/.test(e.snapshotId)||(e.mode!==undefined&&!['pilot','long_running'].includes(String(e.mode))))throw new HttpError(400);
  if(!Array.isArray(e.checks)||e.checks.length<1||e.checks.length>4)throw new HttpError(400);
  for(const check of e.checks){const c=object(check,['id','argv','timeoutMs']);text(c.id);strings(c.argv);if((c.argv as unknown[]).length<1||(c.argv as unknown[]).length>32)throw new HttpError(400);integer(c.timeoutMs);if(Number(c.timeoutMs)<1000||Number(c.timeoutMs)>10000)throw new HttpError(400);}
 }
 if(item.subagentModel!==undefined) text(item.subagentModel);
 for(const key of ['endsAt','budgetMicros','maxRunMs','maxIterations']) integer(item[key]);
 for(const key of ['tools','systems','credentialIds']) strings(item[key]);
}
function lease(value:unknown,id:string):void {
 const item=object(value,['taskId','runId','workerId','token','expiresAt']);
 for(const key of ['taskId','runId','workerId','token']) text(item[key]); integer(item.expiresAt);
 if(item.taskId!==id) throw new HttpError(400);
}
function quotaFields(item:Body):void {
 if(item.quota!==undefined){const q=object(item.quota,['kind','resetsAt','evidence']);integer(q.resetsAt);if(q.kind!=='rejected'||q.evidence!=='claude_rate_limit_event'||item.outcome!=='wait'||item.wakeAt!==q.resetsAt)throw new HttpError(400);}
 if(Object.hasOwn(item,'usageUnavailable')&&(item.usageUnavailable!==true||!item.quota||Object.values(item.usage as Body).some(v=>v!==0)))throw new HttpError(400);
}
function result(value:unknown):void {
 const item=object(value,['outcome','usage','costMicros'],['checkpoint','wakeAt','message','quota','usageUnavailable']);
 if(!['continue','wait','input','complete','failed'].includes(String(item.outcome))) throw new HttpError(400);
 const usage=object(item.usage,['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens']); Object.values(usage).forEach(integer);
 if(item.costMicros!==null) integer(item.costMicros);
 if(item.wakeAt!==undefined) integer(item.wakeAt); if(item.message!==undefined) text(item.message);
 quotaFields(item);if(item.quota!==undefined&&(item.checkpoint===undefined||item.costMicros!==null))throw new HttpError(400);
 if(item.checkpoint!==undefined){const c=object(item.checkpoint,['sessionId','objectKey','model','sequence']);text(c.sessionId);text(c.objectKey);text(c.model);integer(c.sequence);}
}
function action(value:unknown):void {
 const item=object(value,['requestId','tool','system','operation','estimatedCostMicros']);
 for(const key of ['requestId','tool','system','operation']) text(item[key]); integer(item.estimatedCostMicros);
}
function validate(operation:AutonomousOperation, value:unknown,id:string):Body {
 if(operation==='create'){spec(value);return {spec:value};}
 const fields: Partial<Record<AutonomousOperation,string[]>>={approve:['revision','reason'],revise:['spec','reason'],cancel:['reason'],message:['message'],cleaned:['resourceId'],claim:['workerId'],nativeStart:['lease','runtimeId'],nativeReady:['lease','runtimeId'],recordNativeReceipt:['lease','receipt'],heartbeat:['lease'],finish:['lease','result'],reserve:['lease','request'],settle:['lease','actionId','actualCostMicros','success'],reconcile:['actionId','actualCostMicros','success','reason'],resume:['revision','reason'],reconcileRun:['runId','actualCostMicros','reason']};
 const item=object(value,fields[operation]??[],operation==='approve'?['externalProfileHashes']:['settle','reconcile'].includes(operation)?['resource']:[]);
 if(item.externalProfileHashes!==undefined){const hashes=item.externalProfileHashes;if(!hashes||typeof hashes!=='object'||Array.isArray(hashes)||Object.keys(hashes).length<1||Object.keys(hashes).length>3||Object.entries(hashes).some(([id,hash])=>!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)||typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)))throw new HttpError(400);}
 if('lease' in item) lease(item.lease,id);
 if('receipt' in item){const r=object(item.receipt,['runId','runtimeId','sessionId','model','sequence','usage','stopped','outcome'],['wakeAt','quota','usageUnavailable']);for(const key of ['runId','runtimeId','sessionId','model'])text(r[key]);integer(r.sequence);if(r.sequence<1)throw new HttpError(400);if(!['continue','wait','input','complete','failed'].includes(String(r.outcome)))throw new HttpError(400);if(r.wakeAt!==undefined)integer(r.wakeAt);if(r.stopped!==true)throw new HttpError(400);const u=object(r.usage,['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens']);Object.values(u).forEach(integer);quotaFields(r);}
 for(const key of ['reason','message','resourceId','workerId','actionId','runId','runtimeId']) if(key in item) text(item[key]);
 if('revision' in item) integer(item.revision); if('spec' in item) spec(item.spec); if('result' in item) result(item.result); if('request' in item) action(item.request);
 if(operation==='reconcileRun') integer(item.actualCostMicros);
 if(operation==='settle'||operation==='reconcile') {integer(item.actualCostMicros);if(typeof item.success!=='boolean') throw new HttpError(400);if(item.resource!==undefined){const r=object(item.resource,['id','system','cleanupOperation']);Object.values(r).forEach(text);}}
 return {id,...item};
}
async function readBody(request:Request):Promise<unknown> {
 const limit=65536, length=request.headers.get('content-length');
 if(length!==null&&(!/^\d+$/.test(length)||Number(length)>limit)) throw new HttpError(413);
 const reader=request.body?.getReader(); if(!reader) throw new HttpError(400);
 const chunks:Uint8Array[]=[]; let size=0;
 try { for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new HttpError(413);}chunks.push(value);} }
 finally {reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new HttpError(400);}
}
function publicView(value:unknown,worker=false):unknown {
 if(Array.isArray(value)) return value.map(v=>publicView(v,worker));
 if(value&&typeof value==='object') return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='token'&&key!=='nativeReceipt'&&key!=='nativeRuntimeId'&&(worker||key!=='checkpoint')).map(([key,v])=>[key,publicView(v,worker)]));
 return value;
}
function equalToken(a:string,b:string):boolean { let diff=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++) diff|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return diff===0; }
export async function handleAutonomousApi(request:Request,options:{operatorToken:string;workerToken:string;reporterToken?:string;service:AutonomousApiService}):Promise<Response> {
 const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
 try {
  const url=new URL(request.url);
  const parts=url.pathname.match(/^\/v1\/autonomous-tasks(?:\/([^/]+)(?:\/([a-z-]+))?)?\/?$/);
  if(!parts) return json({error:'Not found'},404);
  const id=parts[1]?decodeURIComponent(parts[1]):'',suffix=parts[2];
  if(suffix&&['accept-external','settle-external','cleaned-external'].includes(suffix))return json({error:'Not found'},404);
  const worker=!!suffix&&['claim','native-start','heartbeat','finish','reserve','settle','worker-state'].includes(suffix);
  if(worker&&(!options.workerToken||options.workerToken===options.operatorToken)) return json({error:'Worker authentication unavailable'},503);
  const reporter=!!suffix&&['native-ready','native-receipt'].includes(suffix);
  if(reporter&&(!options.reporterToken||/[\s\p{Cc}]/u.test(options.reporterToken)||!options.operatorToken.trim()||!options.workerToken.trim()||options.reporterToken===options.operatorToken||options.reporterToken===options.workerToken))return json({error:'Reporter authentication unavailable'},503);
  const expected=reporter?options.reporterToken:worker?options.workerToken:options.operatorToken;
  if(!expected||!equalToken(request.headers.get('authorization')??'',`Bearer ${expected}`)) return json({error:'Unauthorized'},401);
  let operation:AutonomousOperation;
  if(request.method==='GET'&&suffix==='history')operation='historyPage';
  else if(request.method==='GET'&&suffix==='worker-state')operation='workerState';
  else if(request.method==='GET'&&!suffix) operation=id?'get':'list';
  else if(request.method==='POST'&&!id) operation='create';
  else if(request.method==='POST'&&suffix&&['approve','revise','cancel','message','cleaned','claim','native-start','native-ready','native-receipt','heartbeat','finish','reserve','settle','reconcile','resume','reconcile-run'].includes(suffix)) operation=suffix==='native-ready'?'nativeReady':suffix==='native-receipt'?'recordNativeReceipt':suffix==='native-start'?'nativeStart':suffix==='reconcile-run'?'reconcileRun':suffix as AutonomousOperation;
  else return json({error:'Not found'},404);
  let query:Body={};
  const params=url.searchParams;
  const pageQuery=()=>{
   if(params.has('limit')){const v=params.get('limit')!;if(!/^[1-9][0-9]{0,2}$/.test(v)||Number(v)>100)throw new HttpError(400);query.limit=Number(v);}
   if(params.has('cursor')){const v=params.get('cursor')!;if(!v||v.length>4096||!/^[A-Za-z0-9_.-]+$/.test(v))throw new HttpError(400);query.cursor=v;}
  };
  if(url.search.length>8192)throw new HttpError(400);
  if(operation==='historyPage'){
   for(const key of params.keys())if(!['kind','limit','cursor'].includes(key)||params.getAll(key).length!==1)throw new HttpError(400);
   const kind=params.get('kind');if(!kind||!['runs','actions','resources','interventions'].includes(kind))throw new HttpError(400);
   query.kind=kind;pageQuery();
  }else if(operation==='get'&&url.search){
   if([...params.keys()].length!==1||params.getAll('view').length!==1||params.get('view')!=='summary')throw new HttpError(400);
   operation='getSummary';
  }else if(url.search){
   if(operation!=='list')throw new HttpError(400);
   for(const key of params.keys())if(!['limit','cursor'].includes(key)||params.getAll(key).length!==1)throw new HttpError(400);
   pageQuery();operation='listPage';
  }
  const input:Body=request.method==='GET'?(id?{id,...query}:query):validate(operation,await readBody(request),id);
  if(operation==='get'||operation==='list')input.maxBytes=2*1024*1024;
  const output=await options.service.execute(operation,input);
  const summaryMutation=['create','approve','revise','cancel','message','resume','reconcileRun','cleaned','reconcile'].includes(operation);
  const task=output as AutonomousTask|undefined;
  const visible=!worker&&!reporter&&summaryMutation&&task&&typeof task.id==='string'&&typeof task.status==='string'&&task.spec?.execution?.mode==='long_running'&&Array.isArray(task.runs)?summarizeAutonomousTask(task):output;
  // Only the successful claimant receives its lease credential and checkpoint reference.
  const body=operation==='claim'&&output ? {lease:(output as {lease:unknown}).lease,task:publicView((output as {task:unknown}).task,true)} : operation==='nativeStart' ? publicView(output,true) : operation==='heartbeat' ? output : publicView(visible);
  return json(body,operation==='create'?201:200);
 } catch(error) {
  const code=(error as {statusCode?:unknown;status?:unknown})?.statusCode??(error as {status?:unknown})?.status;
  const status=typeof code==='number'&&[400,401,403,404,409,413,422,503].includes(code)?code:500;
  if((error as {code?:unknown})?.code==='AUTONOMOUS_PAGE_REQUIRED')return json({error:'Task history requires bounded pages',code:'AUTONOMOUS_PAGE_REQUIRED'},413);
  if((error as {code?:unknown})?.code==='AUTONOMOUS_STORAGE_CAPACITY') return json({error:'Autonomous storage capacity exceeded'},413);
  return json({error:status===500?'Autonomous operation failed':status===409?'Autonomous policy conflict':'Invalid autonomous request'},status);
 }
}

/** Called inside one persistence transaction, with a server-owned clock and random IDs. */
export function executeAutonomousOperation(engine:AutonomousEngine,operation:AutonomousOperation,input:Body,now:number):unknown {
 engine.tick(now);
 const id=input.id as string,l=input.lease as AutonomousLease;
 switch(operation) {
  case 'getSummary':{const getSummary=Reflect.get(engine,'getSummary');if(typeof getSummary!=='function')throw new HttpError(503);return Reflect.apply(getSummary,engine,[id]);}
  case 'historyPage':{const historyPage=Reflect.get(engine,'historyPage');if(typeof historyPage!=='function')throw new HttpError(503);return Reflect.apply(historyPage,engine,[input]);}
  case 'listPage':{const listPage=Reflect.get(engine,'listPage');if(typeof listPage!=='function')throw new HttpError(503);return Reflect.apply(listPage,engine,[input]);}
  case 'list':return Reflect.apply(engine.list,engine,[input.maxBytes]); case 'get':return engine.get(id,input.maxBytes as number|undefined);
  case 'create':return engine.create(input.spec as AutonomousSpec,now,crypto.randomUUID());
  case 'approve':return engine.approve(id,input.revision as number,input.reason as string,now);
  case 'revise':return engine.revise(id,input.spec as AutonomousSpec,input.reason as string,now);
  case 'cancel':return engine.cancel(id,input.reason as string,now);
  case 'message':return engine.message(id,input.message as string,now);
  case 'cleaned':return engine.cleaned(id,input.resourceId as string,now);
  case 'abandonCloud':return engine.abandonCloud(l,now);
  case 'claimCloud':return engine.claimCloud(id,input.workerId as string,input.token as string,input.runId as string,now);
  case 'finishUnstartedCloud':return engine.finishUnstartedCloud(l,now);
  case 'finishCloud':return engine.finishCloud(l,input.result as AutonomousRunResult,input.checksPassed as boolean,now);
  case 'claim':{const granted=engine.claim(id,input.workerId as string,crypto.randomUUID(),crypto.randomUUID(),now);return granted?{lease:granted,task:engine.get(id)}:null;}
  case 'workerState':return engine.workerState(id);
  case 'nativeReady':return engine.nativeReady(l,input.runtimeId as string,now);
  case 'recordNativeReceipt':return engine.recordNativeReceipt(l,input.receipt as AutonomousNativeReceipt,now);
  case 'nativeStart':return engine.nativeStart(l,input.runtimeId as string,now);
  case 'heartbeat':return engine.heartbeat(l,now);
  case 'finish':return engine.finish(l,input.result as AutonomousRunResult,now);
  case 'acceptExternal':return engine.acceptExternal(l,input.actionId as string,input.resource as {id:string;system:string;cleanupOperation:string}|undefined,now);
  case 'cleanedExternal':return engine.cleanedExternal(id,input.resourceId as string,now);
  case 'settleExternal':return engine.settleExternal(id,input.actionId as string,input.actualCostMicros as number,input.success as boolean,now,
    input.review as {evidenceRef:string;reason:string}|undefined);
  case 'reserve':return engine.reserve(l,input.request as AutonomousActionRequest,now);
  case 'settle':return engine.settle(l,input.actionId as string,input.actualCostMicros as number,input.success as boolean,input.resource as {id:string;system:string;cleanupOperation:string}|undefined,now);
  case 'reconcile':return engine.reconcile(id,input.actionId as string,input.actualCostMicros as number,input.success as boolean,input.resource as {id:string;system:string;cleanupOperation:string}|undefined,input.reason as string,now);
  case 'resume':return engine.resume(id,input.revision as number,input.reason as string,now);
  case 'reconcileRun':return engine.reconcileRun(id,input.runId as string,input.actualCostMicros as number,input.reason as string,now);
  case 'tick':return undefined;
 }
}
export function createAutonomousApiService(store:AutonomousTransactionalStore,clock:()=>number=Date.now):AutonomousApiService {
 return {async execute(operation,input){return store.transaction(engine=>executeAutonomousOperation(engine,operation,input,clock()),operation);}};
}
