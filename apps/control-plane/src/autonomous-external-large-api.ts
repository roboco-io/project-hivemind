import {timingSafeEqual} from 'node:crypto';
import type {AutonomousLease} from '../../../packages/contracts/src/autonomous.js';
import type {ExternalLargeLimits,ExternalLargeManifest} from '../../../packages/contracts/src/autonomous-external-large.js';
import type {ExternalLargeStore} from '../../../packages/adapters/src/autonomous-external-large-store.ts';
import {LARGE_PART_BYTES,externalLargeManifestDigest,largeOwnerKey,largeStorageRef,validateExternalLargeManifest,validateLargePath,validateLargeSha256,validateLargeSize} from '../../../packages/core/src/autonomous-external-large.ts';

export interface ExternalLargeAuthority {taskId:string;revision:number;profileId:string}
export interface ExternalLargeApiOptions {
 workerToken:string;
 store:Pick<ExternalLargeStore,'begin'|'part'|'complete'|'abort'|'open'>;
 limits:ExternalLargeLimits;
 /** Server-owned authority check (lease, running task, approved profile). Injected so this file does not import the bridge. */
 authorize(taskId:string,body:{lease:AutonomousLease;runtimeId:string;profileId:string}):Promise<ExternalLargeAuthority>;
 /** Persists the canonical manifest under its digest so a later action can load it. */
 saveManifest(manifest:ExternalLargeManifest,digest:string):Promise<void>;
 partBytes?:number;ttlMs?:number;now?:()=>number;
}
class ApiError extends Error {readonly statusCode:number;constructor(statusCode:number){super('Large artifact request rejected');this.statusCode=statusCode;}}
function deny(status=400):never{throw new ApiError(status);}
const KNOWN=[400,401,403,404,409,413,422,503];
function obj(value:unknown,keys:string[]):Record<string,unknown>{
 if(value===null||typeof value!=='object'||Array.isArray(value))deny();
 const r=value as Record<string,unknown>,actual=Object.keys(r);
 if(actual.length!==keys.length||!keys.every(k=>Object.hasOwn(r,k)))deny();return r;
}
function text(value:unknown):string{if(typeof value!=='string'||value.length<1||value.length>1000||/[\p{Cc}]/u.test(value))deny();return value;}
function lease(value:unknown,id:string):AutonomousLease{
 const l=obj(value,['taskId','runId','workerId','token','expiresAt']);
 for(const k of ['taskId','runId','workerId','token'])text(l[k]);
 if(typeof l.expiresAt!=='number'||!Number.isSafeInteger(l.expiresAt)||l.expiresAt<0||l.taskId!==id)deny();
 return {...l} as unknown as AutonomousLease;
}
const equal=(a:string,b:string)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
async function readBytes(request:Request,max:number):Promise<Uint8Array>{
 const length=request.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>max))deny(413);
 const reader=request.body?.getReader();if(!reader)deny();
 const chunks:Uint8Array[]=[];let bytes=0;
 try{for(;;){const item=await reader.read();if(item.done)break;bytes+=item.value.byteLength;if(bytes>max){await reader.cancel();deny(413);}chunks.push(item.value);}}finally{reader.releaseLock();}
 const out=new Uint8Array(bytes);let offset=0;for(const c of chunks){out.set(c,offset);offset+=c.byteLength;}return out;
}
async function jsonBody(request:Request):Promise<unknown>{
 const raw=await readBytes(request,256*1024);
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{return deny();}
}
function fileInput(value:unknown,limits:ExternalLargeLimits){
 const f=obj(value,['path','size','sha256']);
 try{return {path:validateLargePath(f.path),size:validateLargeSize(f.size,limits.maxFileBytes),sha256:validateLargeSha256(f.sha256)};}catch{return deny();}
}

/** Routes: POST /v1/autonomous-tasks/{id}/external-large/{begin,part,complete,abort,manifest}. Returns undefined for other paths. */
export async function handleExternalLargeApi(request:Request,o:ExternalLargeApiOptions):Promise<Response|undefined>{
 const url=new URL(request.url),match=url.pathname.match(/^\/v1\/autonomous-tasks\/([^/]+)\/external-large(?:\/([^/]+))?$/);
 if(!match)return undefined;
 const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});
 try{
  if(!o.workerToken)return json({error:'Large artifact unavailable'},503);
  if(!equal(request.headers.get('authorization')??'','Bearer '+o.workerToken))return json({error:'Unauthorized'},401);
  const route=match[2];if(request.method!=='POST'||url.search||!route||!['begin','part','complete','abort','manifest'].includes(route))return json({error:'Not found'},404);
  let id:string;try{id=decodeURIComponent(match[1]!);}catch{return deny();}text(id);
  const now=o.now??Date.now,partBytes=o.partBytes??LARGE_PART_BYTES;
  const authority=async(b:{lease:AutonomousLease;runtimeId:string;profileId:string})=>{
   const a=await o.authorize(id,b);
   if(!a||a.taskId!==id||a.profileId!==b.profileId||!Number.isSafeInteger(a.revision)||a.revision<1)deny(409);return a;
  };
  if(route==='part'){
   const header=request.headers.get('x-large-meta');if(!header||header.length>4096)return deny();
   let parsed:unknown;try{parsed=JSON.parse(header);}catch{return deny();}
   const m=obj(parsed,['lease','runtimeId','profileId','uploadId','part']);
   const body={lease:lease(m.lease,id),runtimeId:text(m.runtimeId),profileId:text(m.profileId)},uploadId=text(m.uploadId);
   if(typeof m.part!=='number'||!Number.isSafeInteger(m.part))deny();
   const a=await authority(body),data=await readBytes(request,partBytes);
   return json(await o.store.part(uploadId,m.part as number,data,a));
  }
  const raw=await jsonBody(request);
  if(route==='begin'){
   const b=obj(raw,['lease','runtimeId','profileId','file']),body={lease:lease(b.lease,id),runtimeId:text(b.runtimeId),profileId:text(b.profileId)},file=fileInput(b.file,o.limits);
   const a=await authority(body);return json(await o.store.begin(a,file,now()+(o.ttlMs??24*3600*1000)));
  }
  if(route==='manifest'){
   const b=obj(raw,['lease','runtimeId','profileId','files']),body={lease:lease(b.lease,id),runtimeId:text(b.runtimeId),profileId:text(b.profileId)};
   const list=b.files;if(!Array.isArray(list)||list.length<1||list.length>o.limits.maxFiles)return deny();
   const inputs=list.map(f=>fileInput(f,o.limits)),a=await authority(body),owner=largeOwnerKey(a.taskId,a.revision,a.profileId);
   const files=inputs.map(f=>({...f,storageRef:largeStorageRef(owner,f.sha256)}));
   let manifest:ExternalLargeManifest;
   try{manifest=validateExternalLargeManifest({version:1,taskId:a.taskId,revision:a.revision,profileId:a.profileId,files},o.limits);}catch{return deny();}
   for(const f of manifest.files){const opened=await o.store.open(f,a);try{await opened.body.cancel();}catch{/* ignore */}}
   const digest=externalLargeManifestDigest(manifest);await o.saveManifest(manifest,digest);
   return json({manifestDigest:digest,files:manifest.files.length});
  }
  const b=obj(raw,['lease','runtimeId','profileId','uploadId']),body={lease:lease(b.lease,id),runtimeId:text(b.runtimeId),profileId:text(b.profileId)},uploadId=text(b.uploadId);
  const a=await authority(body);
  return json(route==='complete'?await o.store.complete(uploadId,a):await o.store.abort(uploadId,a));
 }catch(error){
  const code=(error as {statusCode?:number})?.statusCode;
  return json({error:'Large artifact unavailable'},code&&KNOWN.includes(code)?code:503);
 }
}
