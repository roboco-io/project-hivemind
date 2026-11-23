import {TeamEngine,TeamError} from '../../../packages/core/src/team.js';
import type {TeamRepository} from '../../../packages/core/src/team-store.js';
import type {TeamActor} from '../../../packages/contracts/src/team.js';
export interface TeamEventPage {events:ReturnType<TeamEngine['events']>;nextAfter?:number}
export interface TeamNotePage {notes:ReturnType<TeamEngine['notes']>;nextAfter?:number}
export interface TeamPageQuery {after?:number;limit?:number}
export type TeamReadSection='summary'|'tasks'|'events'|'notes';
export type TeamReadResult=ReturnType<TeamEngine['summary']>|{tasks:ReturnType<TeamEngine['tasks']>}|TeamEventPage|TeamNotePage;
export type TeamWorkerOperation='tasks'|'claim'|'heartbeat'|'submit'|'notes';
export type TeamBlockInput=Parameters<TeamEngine['block']>[1];
export type TeamReviewInput=Parameters<TeamEngine['review']>[1];
export interface TeamService {
 summary(workflowId:string):Promise<ReturnType<TeamEngine['summary']>>;
 tasks(workflowId:string):Promise<{tasks:ReturnType<TeamEngine['tasks']>}>;
 events(workflowId:string,query?:TeamPageQuery):Promise<TeamEventPage>;
 notes(workflowId:string,query?:TeamPageQuery):Promise<TeamNotePage>;
 block(workflowId:string,input:TeamBlockInput):Promise<ReturnType<TeamEngine['summary']>>;
 review(workflowId:string,input:TeamReviewInput):Promise<ReturnType<TeamEngine['summary']>>;
 workerRead(workflowId:string,actor:TeamActor,section:TeamReadSection,query?:TeamPageQuery):Promise<TeamReadResult>;
 workerOperation(workflowId:string,actor:TeamActor,operation:TeamWorkerOperation,input:unknown):Promise<unknown>;
}
export interface TeamApiOptions {
 operatorToken:string;service:TeamService;
 authorizeWorker?:(request:Request,workflowId:string)=>Promise<TeamActor>;
 forbiddenValues?:readonly string[];
}
class ApiError extends Error {readonly status:number;constructor(status:number){super('Team request denied');this.status=status;}}
function deny(status=400):never{throw new ApiError(status);}
/** Map only trusted engine errors, inside the synchronous callback; storage failures stay 500. */
function coreCall<T>(fn:()=>T):T {
 try{return fn();}catch(error){
 if(error instanceof TeamError&&[400,404,409,413].includes(error.statusCode))deny(error.statusCode);
 throw error;
 }
}
function object(value:unknown,required:string[],optional:string[]=[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))deny();
 const v=value as Record<string,unknown>;
 if(Object.keys(v).some(k=>!required.includes(k)&&!optional.includes(k))||required.some(k=>!Object.hasOwn(v,k)))deny();return v;
}
function id(v:unknown):asserts v is string {if(typeof v!=='string'||! /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v))deny();}
function integer(v:unknown,min=0):asserts v is number {if(!Number.isSafeInteger(v)||Number(v)<min)deny();}
function text(v:unknown,max:number):asserts v is string{if(typeof v!=='string'||!v.trim()||Buffer.byteLength(v)>max||/[\p{Cc}]/u.test(v))deny();}
function workerInput(operation:TeamWorkerOperation,value:unknown):Record<string,unknown>{
 switch(operation){
 case 'tasks':{const v=object(value,['id','title','dependencies','writes'],['assignee']);id(v.id);text(v.title,1024);for(const key of ['dependencies','writes']){const a=v[key];if(!Array.isArray(a)||a.length>(key==='writes'?32:128)||a.some(x=>typeof x!=='string'||x.length>512))deny();}if(v.assignee!==undefined)id(v.assignee);return v;}
 case 'claim':{const v=object(value,['taskId']);id(v.taskId);return v;}
 case 'notes':{const v=object(value,['text'],['taskId']);text(v.text,2048);if(v.taskId!==undefined)id(v.taskId);return v;}
 case 'heartbeat':case 'submit':{
 const v=object(value,operation==='submit'?['lease','evidenceRef','outcome']:['lease']);
 const l=object(v.lease,['taskId','memberId','token','generation','expiresAt']);id(l.taskId);id(l.memberId);text(l.token,256);integer(l.generation,1);integer(l.expiresAt);
 if(operation==='submit'){id(v.evidenceRef);if(v.outcome!=='candidate'&&v.outcome!=='failed')deny();}return v;
 }
 }
}
function operatorInput(operation:'block'|'review',value:unknown):TeamBlockInput|TeamReviewInput{
 const v=object(value,operation==='block'?['category','reason','evidenceRef']:['reason']);text(v.reason,2048);
 if(operation==='block'){if(!['sandbox_escape','credential_scope','monitor_tampering','identity_mismatch'].includes(String(v.category)))deny();id(v.evidenceRef);}return v as unknown as TeamBlockInput|TeamReviewInput;
}
function secrets(values:readonly string[]):string[]{
 if(values.length>260)deny(503);let bytes=0;for(const v of values){if(typeof v!=='string'||v.length>65536)deny(503);bytes+=Buffer.byteLength(v);if(Buffer.byteLength(v)>65536||bytes>262144)deny(503);}
 const result=new Set<string>();for(const v of values){if(!v)continue;result.add(v);result.add(encodeURIComponent(v));result.add(Buffer.from(v).toString('base64'));result.add(Buffer.from(v).toString('base64url'));result.add(Buffer.from(v).toString('hex'));result.add(JSON.stringify(v).slice(1,-1));}return [...result];
}
function assertNoSecrets(value:unknown,values:readonly string[],status=400):void{
 const scan=(v:unknown):void=>{if(typeof v==='string'){if(values.some(s=>v.includes(s)))deny(status);}else if(v&&typeof v==='object'){for(const [k,x] of Object.entries(v)){if(values.some(s=>k.includes(s)))deny(status);scan(x);}}};scan(value);
}
function publicView(value:unknown):unknown{
 if(Array.isArray(value))return value.map(publicView);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['token','generation','generations','leases','lease','fences','signingKey','capability','operatorToken','workerToken'].includes(k)).map(([k,v])=>[k,publicView(v)]));return value;
}
export function createTeamService({repository,now=Date.now}:{repository:TeamRepository;now?:()=>number}):TeamService{
 const teamId=(e:TeamEngine,w:string)=>{const state=e.snapshot();if(!state||state.spec.workflowId!==w)deny(404);return state.spec.id;};
 const read=async(workflowId:string)=>{const state=await repository.read(workflowId);if(!state||state.spec.workflowId!==workflowId)deny(404);return new TeamEngine(state);};
 return {
 async summary(w){const e=await read(w);return e.summary(teamId(e,w));},
 async tasks(w){const e=await read(w);return {tasks:e.tasks(teamId(e,w))};},
 async events(w,q){const e=await read(w);const events=e.events(teamId(e,w),{...q,limit:q?.limit??100});return {events,...(events.length===(q?.limit??100)?{nextAfter:events.at(-1)!.sequence}:{})};},
 async notes(w,q){const e=await read(w);const notes=e.notes(teamId(e,w),{...q,limit:q?.limit??100});return {notes,...(notes.length===(q?.limit??100)?{nextAfter:notes.at(-1)!.sequence}:{})};},
 async block(w,input){return repository.mutate(w,e=>coreCall(()=>e.block(teamId(e,w),operatorInput('block',input) as TeamBlockInput,now())),{recovery:true});},
 async review(w,input){return repository.mutate(w,e=>coreCall(()=>e.review(teamId(e,w),operatorInput('review',input) as TeamReviewInput,now())),{recovery:true});},
 async workerRead(w,actor,section,q){
 const e=await read(w);return coreCall(()=>{
 const t=teamId(e,w);e.authorizeActor(t,actor,now());
 let result:TeamReadResult;
 switch(section){
 case 'summary':result=e.summary(t);break;
 case 'tasks':result={tasks:e.tasks(t)};break;
 case 'events':{const events=e.events(t,{...q,limit:q?.limit??100});result={events,...(events.length===(q?.limit??100)?{nextAfter:events.at(-1)!.sequence}:{})};break;}
 case 'notes':{const notes=e.notes(t,{...q,limit:q?.limit??100});result={notes,...(notes.length===(q?.limit??100)?{nextAfter:notes.at(-1)!.sequence}:{})};break;}
 }
 result=publicView(result) as TeamReadResult;
 assertNoSecrets(result,secrets(e.snapshot()!.leases.map(l=>l.token)),500);return result;
 });
 },
 async workerOperation(w,actor,operation,input){
 const v=workerInput(operation,input);
 return repository.mutate(w,e=>coreCall(()=>{
 const t=teamId(e,w);if(actor.teamId!==t)deny(403);
 switch(operation){
 case 'tasks':return e.addTask(t,actor,v as unknown as Parameters<TeamEngine['addTask']>[2],now());
 case 'claim':return e.claim(t,actor,v.taskId as string,now());
 case 'heartbeat':return e.heartbeat(t,actor,v.lease as Parameters<TeamEngine['heartbeat']>[2],now());
 case 'submit':return e.submit(t,actor,v.lease as Parameters<TeamEngine['submit']>[2],{evidenceRef:v.evidenceRef as string,outcome:v.outcome as 'candidate'|'failed'},now());
 case 'notes':return e.addNote(t,actor,v as unknown as Parameters<TeamEngine['addNote']>[2],now());
 }
 }));
 },
 };
}

async function body(request:Request):Promise<unknown>{
 const size=request.headers.get('content-length');if(size&&(!/^\d+$/.test(size)||Number(size)>65536))deny(413);
 if(!request.body)deny();const reader=request.body.getReader();let count=0;const chunks:Uint8Array[]=[];
 let timer:ReturnType<typeof setTimeout>|undefined;
 const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new ApiError(408)),5000);});
 try{
 while(true){const {done,value}=await Promise.race([reader.read(),deadline]);if(done)break;count+=value.byteLength;if(count>65536)deny(413);chunks.push(value);}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{deny();}
 }catch(error){void reader.cancel().catch(()=>{});throw error;}
 finally{clearTimeout(timer);reader.releaseLock();}
}

export async function handleTeamApi(request:Request,options:TeamApiOptions):Promise<Response|undefined>{
 const url=new URL(request.url);const match=/^\/v1\/workflows\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})\/team(?:\/(tasks|events|notes|block|review|claim|heartbeat|submit))?$/.exec(url.pathname);
 if(!match)return undefined;const workflowId=match[1]!;const section=match[2]??'summary';
 const worker=request.method==='POST'&&['tasks','claim','heartbeat','submit','notes'].includes(section);
 const sharedRead=request.method==='GET'&&['summary','tasks','events','notes'].includes(section);
 const operatorOnly=request.method==='POST'&&['block','review'].includes(section);
 const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
 try{
 if(!worker&&!sharedRead&&!operatorOnly)deny(405);
 if(typeof options.operatorToken!=='string'||options.operatorToken.length>65536)deny(503);
 let actor:TeamActor|undefined;
 const exactOperator=!!options.operatorToken&&request.headers.get('authorization')===`Bearer ${options.operatorToken}`;
 if(worker||sharedRead&&!exactOperator){if(!options.authorizeWorker)deny(401);try{actor=await options.authorizeWorker(request,workflowId);}catch{deny(401);}if(!actor)deny(401);id(actor.teamId);id(actor.memberId);id(actor.jobId);id(actor.attempt);}
 else if(!exactOperator)deny(401);
 const query:TeamPageQuery={};for(const [k,v] of url.searchParams){if(!['events','notes'].includes(section)||request.method!=='GET'||!['after','limit'].includes(k)||url.searchParams.getAll(k).length!==1||!/^\d+$/.test(v))deny();const n=Number(v);integer(n,k==='limit'?1:0);if(k==='limit'&&n>100)deny();query[k as keyof TeamPageQuery]=n;}
 if((options.forbiddenValues?.length??0)>256)deny(503);
 const authorization=request.headers.get('authorization')??'';if(authorization.length>65536)deny(503);const forbidden=secrets([options.operatorToken,authorization,authorization.replace(/^Bearer /,''),...(options.forbiddenValues??[])]);
 let result:unknown;
 if(request.method==='GET'){
 result=actor?await options.service.workerRead(workflowId,actor,section as TeamReadSection,query):section==='summary'?await options.service.summary(workflowId):section==='tasks'?await options.service.tasks(workflowId):section==='events'?await options.service.events(workflowId,query):await options.service.notes(workflowId,query);
 }else{
 const value=await body(request);assertNoSecrets(value,forbidden);
 if(worker){const input=workerInput(section as TeamWorkerOperation,value);result=await options.service.workerOperation(workflowId,actor!,section as TeamWorkerOperation,input);}
 else {const input=operatorInput(section as 'block'|'review',value);result=section==='block'?await options.service.block(workflowId,input as TeamBlockInput):await options.service.review(workflowId,input as TeamReviewInput);}
 }

 if(!worker)result=publicView(result);assertNoSecrets(result,forbidden,500);return json(result??{ok:true});
 }catch(error){const status=error instanceof ApiError?error.status:500;return json({error:status===401?'Unauthorized':'Team request unavailable'},status);}
}
