import {createHash,randomUUID} from 'node:crypto';
import type {ExternalLargeFile,ExternalLargeLimits} from '../../contracts/src/autonomous-external-large.js';
import {LARGE_PART_BYTES,largeOwnerKey,largePartPlan,largeStorageRef,validateLargePath,validateLargeSha256,validateLargeSize} from '../../core/src/autonomous-external-large.ts';

export class ExternalLargeStoreError extends Error {readonly statusCode:number;constructor(statusCode:number){super('Large artifact request rejected');this.statusCode=statusCode;}}
const fail=(statusCode:number):never=>{throw new ExternalLargeStoreError(statusCode);};

/** R2-shaped multipart bucket. Injected; the real binding is wired by integration. */
export interface ExternalLargeMultipart {
 uploadPart(partNumber:number,data:Uint8Array):Promise<{etag:string}>;
 complete(parts:{partNumber:number;etag:string}[]):Promise<unknown>;
 abort():Promise<unknown>;
}
export interface ExternalLargeBucket {
 createMultipartUpload(key:string):Promise<{uploadId:string}>;
 resumeMultipartUpload(key:string,uploadId:string):ExternalLargeMultipart;
 get(key:string):Promise<{size:number;body:ReadableStream<Uint8Array>}|null>;
 delete(key:string):Promise<unknown>;
}
export interface ExternalLargeOwner {taskId:string;revision:number;profileId:string}
export interface ExternalLargeUploadRecord extends ExternalLargeOwner {
 uploadId:string;bucketUploadId:string;ownerKey:string;path:string;size:number;sha256:string;storageRef:string;expiresAt:number;
 status:'uploading'|'complete'|'aborted'|'failed'|'cancelled';
 parts:Record<string,{etag:string;size:number;sha256:string}>;
}
/** Durable upload ledger. Implementations must return copies. */
export interface ExternalLargeRecordPort {
 get(uploadId:string):Promise<ExternalLargeUploadRecord|undefined>;
 put(record:ExternalLargeUploadRecord):Promise<void>;
 listTask(taskId:string,revision:number):Promise<ExternalLargeUploadRecord[]>;
 isCancelled(taskId:string,revision:number):Promise<boolean>;
 markCancelled(taskId:string,revision:number):Promise<void>;
}
/** Hard cap on upload records of any status per (task, revision). The ledger has no row delete, so begin must bound it. */
export const LARGE_MAX_UPLOAD_RECORDS=64;
/** Largest value the cap may take. The SQL ledger bounds listTask to this many rows. */
export const LARGE_UPLOAD_RECORDS_CEILING=256;
export interface ExternalLargeStoreOptions {
 bucket:ExternalLargeBucket;records:ExternalLargeRecordPort;limits:ExternalLargeLimits;
 /** Test seam. Production keeps the 8 MiB default. */
 partBytes?:number;now?:()=>number;
 /** Upload records of any status per (task, revision). Default 64, at most 256. */
 maxUploadRecords?:number;
}
export interface ExternalLargePartInfo {partNumber:number;size:number;sha256:string}
export interface ExternalLargeBegin {
 uploadId:string;status:'uploading'|'complete';partBytes:number;count:number;expiresAt:number;
 parts:ExternalLargePartInfo[];file?:ExternalLargeFile;
}
const REF=/^external-large\/[a-f0-9]{64}\/([a-f0-9]{64})$/;
const live=(r:ExternalLargeUploadRecord,now:number)=>r.status==='complete'||(r.status==='uploading'&&r.expiresAt>now);
const sameOwner=(r:ExternalLargeUploadRecord,o:ExternalLargeOwner)=>r.taskId===o.taskId&&r.revision===o.revision&&r.profileId===o.profileId;

export function createExternalLargeStore(o:ExternalLargeStoreOptions){
 const {bucket,records,limits}=o,partBytes=o.partBytes??LARGE_PART_BYTES,now=o.now??Date.now,maxRecords=o.maxUploadRecords??LARGE_MAX_UPLOAD_RECORDS;
 if(!Number.isSafeInteger(maxRecords)||maxRecords<1||maxRecords>LARGE_UPLOAD_RECORDS_CEILING)throw new RangeError('Invalid maxUploadRecords');
 const fileOf=(r:ExternalLargeUploadRecord):ExternalLargeFile=>({path:r.path,size:r.size,sha256:r.sha256,storageRef:r.storageRef});
 const partsOf=(r:ExternalLargeUploadRecord):ExternalLargePartInfo[]=>Object.entries(r.parts).map(([n,p])=>({partNumber:Number(n),size:p.size,sha256:p.sha256})).sort((a,b)=>a.partNumber-b.partNumber);
 const view=(r:ExternalLargeUploadRecord):ExternalLargeBegin=>({uploadId:r.uploadId,status:r.status==='complete'?'complete':'uploading',partBytes,count:largePartPlan(r.size,partBytes).count,expiresAt:r.expiresAt,parts:partsOf(r),...(r.status==='complete'?{file:fileOf(r)}:{})});
 async function load(uploadId:string,owner?:ExternalLargeOwner){
  if(typeof uploadId!=='string'||uploadId.length<1||uploadId.length>100)fail(400);
  const r=await records.get(uploadId);if(!r||owner&&!sameOwner(r,owner))fail(404);return r!;
 }
 async function release(r:ExternalLargeUploadRecord,status:'aborted'|'cancelled'|'failed'){
  try{await bucket.resumeMultipartUpload(r.storageRef,r.bucketUploadId).abort();}catch{/* best effort; the ledger is authoritative */}
  r.status=status;await records.put(r);
 }
 return {
  async begin(owner:ExternalLargeOwner,input:{path:string;size:number;sha256:string},expiresAt:number):Promise<ExternalLargeBegin>{
   try{validateLargePath(input.path);validateLargeSize(input.size,limits.maxFileBytes);validateLargeSha256(input.sha256);}catch{fail(400);}
   if(!Number.isSafeInteger(expiresAt)||expiresAt<=now())fail(400);
   if(await records.isCancelled(owner.taskId,owner.revision))fail(409);
   const ownerKey=largeOwnerKey(owner.taskId,owner.revision,owner.profileId),storageRef=largeStorageRef(ownerKey,input.sha256);
   const all=await records.listTask(owner.taskId,owner.revision),mine=all.filter(r=>sameOwner(r,owner));
   const prior=mine.find(r=>r.sha256===input.sha256&&live(r,now()));if(prior)return view(prior);
   // A resume above returns the existing record and adds none. Only a new record counts against the cap.
   if(all.length>=maxRecords)fail(413);
   for(const r of mine)if(r.status==='uploading'&&r.expiresAt<=now())await release(r,'aborted');
   const others=mine.filter(r=>live(r,now()));
   if(others.some(r=>r.path===input.path))fail(409);
   if(others.length+1>limits.maxFiles||others.reduce((n,r)=>n+r.size,0)+input.size>limits.maxTotalBytes)fail(413);
   const multipart=await bucket.createMultipartUpload(storageRef);
   const record:ExternalLargeUploadRecord={...owner,uploadId:randomUUID(),bucketUploadId:multipart.uploadId,ownerKey,path:input.path,size:input.size,sha256:input.sha256,storageRef,expiresAt,status:'uploading',parts:{}};
   await records.put(record);return view(record);
  },
  async part(uploadId:string,partNumber:number,data:Uint8Array,owner?:ExternalLargeOwner){
   const r=await load(uploadId,owner);
   if(r.status!=='uploading'||r.expiresAt<=now()||await records.isCancelled(r.taskId,r.revision))fail(409);
   const plan=largePartPlan(r.size,partBytes);
   if(!Number.isInteger(partNumber)||partNumber<1||partNumber>plan.count||!(data instanceof Uint8Array))fail(400);
   if(data.byteLength!==(partNumber===plan.count?plan.lastBytes:plan.partBytes))fail(400);
   const hash=createHash('sha256').update(data).digest('hex'),prior=r.parts[String(partNumber)];
   if(prior){if(prior.sha256!==hash)fail(409);return {partNumber,size:data.byteLength,sha256:hash,reused:true};}
   const uploaded=await bucket.resumeMultipartUpload(r.storageRef,r.bucketUploadId).uploadPart(partNumber,data);
   const latest=await records.get(uploadId);if(!latest||latest.status!=='uploading')fail(409);
   latest!.parts[String(partNumber)]={etag:uploaded.etag,size:data.byteLength,sha256:hash};await records.put(latest!);
   return {partNumber,size:data.byteLength,sha256:hash,reused:false};
  },
  async complete(uploadId:string,owner?:ExternalLargeOwner):Promise<ExternalLargeFile>{
   const r=await load(uploadId,owner);
   if(r.status==='complete')return fileOf(r);
   if(r.status!=='uploading'||r.expiresAt<=now()||await records.isCancelled(r.taskId,r.revision))fail(409);
   const plan=largePartPlan(r.size,partBytes),parts=Object.entries(r.parts).map(([n,p])=>({partNumber:Number(n),etag:p.etag,size:p.size})).sort((a,b)=>a.partNumber-b.partNumber);
   if(parts.length!==plan.count||parts.some((p,i)=>p.partNumber!==i+1)||parts.reduce((n,p)=>n+p.size,0)!==r.size)fail(409);
   try{await bucket.resumeMultipartUpload(r.storageRef,r.bucketUploadId).complete(parts.map(({partNumber,etag})=>({partNumber,etag})));}catch{fail(503);}
   const object=await bucket.get(r.storageRef);if(!object)fail(503);
   const hash=createHash('sha256');let total=0;
   const reader=object!.body.getReader();
   try{for(;;){const item=await reader.read();if(item.done)break;total+=item.value.byteLength;hash.update(item.value);}}finally{reader.releaseLock();}
   if(object!.size!==r.size||total!==r.size||hash.digest('hex')!==r.sha256){
    await bucket.delete(r.storageRef);r.status='failed';await records.put(r);fail(409);
   }
   const latest=await records.get(uploadId);
   if(!latest||latest.status!=='uploading'||await records.isCancelled(r.taskId,r.revision)){await bucket.delete(r.storageRef);fail(409);}
   latest!.status='complete';await records.put(latest!);return fileOf(latest!);
  },
  async abort(uploadId:string,owner?:ExternalLargeOwner){
   const r=await load(uploadId,owner);
   if(r.status==='complete')fail(409);
   if(r.status==='uploading')await release(r,'aborted');
   return {status:'aborted' as const};
  },
  /** Cancel every upload of a task revision, all profiles. Idempotent. Returns the number of records changed. */
  async abortOwner(taskId:string,revision:number):Promise<number>{
   await records.markCancelled(taskId,revision);let changed=0;
   for(const r of await records.listTask(taskId,revision)){
    if(r.status==='uploading'){await release(r,'cancelled');changed++;}
    else if(r.status==='complete'){await bucket.delete(r.storageRef);r.status='cancelled';await records.put(r);changed++;}
   }
   return changed;
  },
  /** Size check, plus a verified-upload check when an owner is given. The caller hashes the stream it reads. */
  async open(file:ExternalLargeFile,owner?:ExternalLargeOwner){
   const m=typeof file?.storageRef==='string'?REF.exec(file.storageRef):null;
   if(!m||m[1]!==file.sha256||!Number.isSafeInteger(file.size)||file.size<1)fail(400);
   // With an owner, only a file whose upload was verified by complete() may be opened. An object can exist
   // before verification (multipart complete, then re-hash), so existence alone is not proof.
   if(owner){
    const done=(await records.listTask(owner.taskId,owner.revision)).find(r=>sameOwner(r,owner)&&r.status==='complete'&&r.storageRef===file.storageRef&&r.sha256===file.sha256&&r.size===file.size&&r.path===file.path);
    if(!done)fail(404);
   }
   const object=await bucket.get(file.storageRef);if(!object)fail(404);
   if(object!.size!==file.size){try{await object!.body.cancel();}catch{/* ignore */}fail(409);}
   return {size:object!.size,body:object!.body};
  },
 };
}
export type ExternalLargeStore=ReturnType<typeof createExternalLargeStore>;
