import {createHash,randomUUID} from 'node:crypto';
import {largeArtifactKey,PART_BYTES,validateLargeArtifactRef,type LargeArtifactRef} from './large-artifact.ts';
export interface UploadRecord {id:string;ref:LargeArtifactRef;uploadId:string;expiresAt:number;status:'uploading'|'complete'|'aborted';parts:Record<string,{partNumber:number;etag:string;size:number;sha256:string}>}
interface Store {get<T>(key:string):Promise<T|undefined>;put(key:string,value:unknown):Promise<void>}
export class ArtifactStoreError extends Error {statusCode:number;constructor(statusCode:number){super('Artifact request rejected');this.statusCode=statusCode;}}
const equal=(a:LargeArtifactRef,b:LargeArtifactRef)=>JSON.stringify(a)===JSON.stringify(b);
export class LargeArtifactStore {
 private bucket:R2Bucket; private storage:Store;
 constructor(bucket:R2Bucket,storage:Store){this.bucket=bucket;this.storage=storage;}
 async head(refOrDigest:LargeArtifactRef|string){
  const digest=typeof refOrDigest==='string'?refOrDigest:refOrDigest.sha256;
  const object=await this.bucket.head(largeArtifactKey(digest));if(!object)return undefined;
  let ref:LargeArtifactRef;try{ref=validateLargeArtifactRef(JSON.parse(object.customMetadata?.reference??''));}catch{throw new ArtifactStoreError(409);}
  if(ref.sha256!==digest||object.size!==ref.sizeBytes||(typeof refOrDigest!=='string'&&!equal(ref,refOrDigest)))throw new ArtifactStoreError(409);
  return {ref,contentHashVerification:'runtime-required' as const};
 }
 async begin(value:unknown,now=Date.now()){
  const ref=validateLargeArtifactRef(value);const present=await this.head(ref);if(present)return {status:'complete',...present};
  const lock='large-upload-digest:'+ref.sha256,priorId=await this.storage.get<string>(lock);
  if(priorId){const prior=await this.record(priorId);if(!equal(prior.ref,ref))throw new ArtifactStoreError(409);
   if(prior.status==='uploading'&&prior.expiresAt>now)return this.publicRecord(prior);
   if(prior.status==='uploading')await this.abort(prior.id);
  }
  const multipart=await this.bucket.createMultipartUpload(largeArtifactKey(ref.sha256),{customMetadata:{reference:JSON.stringify(ref)}});
  const record:UploadRecord={id:randomUUID(),ref,uploadId:multipart.uploadId,expiresAt:now+86400000,status:'uploading',parts:{}};
  await this.storage.put('large-upload:'+record.id,record);await this.storage.put(lock,record.id);
  return this.publicRecord(record);
 }
 private publicRecord(r:UploadRecord){return {id:r.id,ref:r.ref,status:r.status,expiresAt:r.expiresAt,partBytes:PART_BYTES,parts:Object.values(r.parts).map(p=>({partNumber:p.partNumber,size:p.size,sha256:p.sha256})),contentHashVerification:'runtime-required'};}
 private async record(id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new ArtifactStoreError(400);const r=await this.storage.get<UploadRecord>('large-upload:'+id);if(!r)throw new ArtifactStoreError(404);return r;}
 async part(id:string,number:number,data:Uint8Array,now=Date.now()){
  const r=await this.record(id);if(r.status!=='uploading'||r.expiresAt<=now)throw new ArtifactStoreError(409);
  const count=Math.ceil(r.ref.sizeBytes/PART_BYTES),size=number===count?r.ref.sizeBytes-(count-1)*PART_BYTES:PART_BYTES;
  if(!Number.isInteger(number)||number<1||number>count||data.byteLength!==size)throw new ArtifactStoreError(400);
  const sha256=createHash('sha256').update(data).digest('hex'),prior=r.parts[String(number)];
  if(prior){if(prior.sha256!==sha256||prior.size!==size)throw new ArtifactStoreError(409);return {partNumber:number,sha256,size,reused:true};}
  const multipart=this.bucket.resumeMultipartUpload(largeArtifactKey(r.ref.sha256),r.uploadId);
  const part=await multipart.uploadPart(number,data);r.parts[String(number)]={partNumber:number,etag:part.etag,size,sha256};
  await this.storage.put('large-upload:'+r.id,r);return {partNumber:number,sha256,size,reused:false};
 }
 async complete(id:string,now=Date.now()){
  const r=await this.record(id);if(r.status==='aborted')throw new ArtifactStoreError(409);
  const existing=await this.head(r.ref);
  if(existing){r.status='complete';await this.storage.put('large-upload:'+id,r);return {status:'complete',...existing};}
  if(r.status!=='uploading'||r.expiresAt<=now)throw new ArtifactStoreError(409);
  const count=Math.ceil(r.ref.sizeBytes/PART_BYTES),parts=Object.values(r.parts).sort((a,b)=>a.partNumber-b.partNumber);
  if(parts.length!==count||parts.some((p,i)=>p.partNumber!==i+1)||parts.reduce((n,p)=>n+p.size,0)!==r.ref.sizeBytes)throw new ArtifactStoreError(409);
  await this.bucket.resumeMultipartUpload(largeArtifactKey(r.ref.sha256),r.uploadId).complete(parts.map(({partNumber,etag})=>({partNumber,etag})));
  const stored=await this.head(r.ref);if(!stored)throw new ArtifactStoreError(503);
  r.status='complete';await this.storage.put('large-upload:'+id,r);return {status:'complete',...stored};
 }
 async abort(id:string){const r=await this.record(id);if(r.status==='complete'||await this.head(r.ref))throw new ArtifactStoreError(409);if(r.status==='uploading')await this.bucket.resumeMultipartUpload(largeArtifactKey(r.ref.sha256),r.uploadId).abort();r.status='aborted';await this.storage.put('large-upload:'+id,r);return {status:'aborted'};}
}
