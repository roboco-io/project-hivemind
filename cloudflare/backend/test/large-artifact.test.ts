import test from 'node:test';
import assert from 'node:assert/strict';
import {validateLargeArtifactRef,largeArtifactKey,authorizeArtifactRead,PART_BYTES} from '../src/large-artifact.ts';
const ref={name:'source',sha256:'a'.repeat(64),sizeBytes:100000000,format:'tar.gz',expandedBytes:1000000000,maxFiles:100000};
test('large artifact references bind names, digests and bounded declared expansion',()=>{
 assert.deepEqual(validateLargeArtifactRef(ref),ref);
 for(const bad of [{...ref,url:'https://elsewhere'},{...ref,name:'../source'},{...ref,sizeBytes:9*1024**3},{...ref,maxFiles:1000001},{...ref,expandedBytes:20*1024**3}])assert.throws(()=>validateLargeArtifactRef(bad));
 assert.equal(largeArtifactKey(ref.sha256),'large-inputs/'+ref.sha256);
 assert.throws(()=>largeArtifactKey('../credentials'));
 assert.equal(PART_BYTES,8*1024*1024);
});
test('artifact read capability is bound to live job, attempt, digest and expiry',()=>{
 const job={id:'j',attempt:'a',kind:'compute',status:'RUNNING',deadline:200,containerStopped:false,cancellationRequested:false,largeArtifacts:[ref]};
 const grant={jobId:'j',attempt:'a',expiresAt:200};
 assert.equal(authorizeArtifactRead(grant,job,ref.sha256,100),true);
 for(const [g,j,d,t] of [[grant,job,ref.sha256,200],[{...grant,attempt:'old'},job,ref.sha256,100],[grant,{...job,status:'SUCCEEDED'},ref.sha256,100],[grant,{...job,cancellationRequested:true},ref.sha256,100],[grant,job,'b'.repeat(64),100],[grant,{...job,containerStopped:true},ref.sha256,100]] as const)assert.equal(authorizeArtifactRead(g,j,d,t),false);
});

import {LargeArtifactStore} from '../src/large-artifact-store.ts';
function fixture(){
 const records=new Map<string,unknown>(),objects=new Map<string,any>(),uploads=new Map<string,any>();let uploadsStarted=0;
 const storage={async get<T>(key:string){return structuredClone(records.get(key)) as T|undefined},async put(key:string,value:unknown){records.set(key,structuredClone(value))}};
 const bucket={async head(key:string){return objects.get(key)},async createMultipartUpload(key:string,options:any){const uploadId=String(++uploadsStarted);uploads.set(uploadId,{key,options,parts:new Map<number,Uint8Array>()});return {uploadId}},resumeMultipartUpload(key:string,id:string){const u=uploads.get(id);assert.equal(u.key,key);return {
  async uploadPart(n:number,data:Uint8Array){u.parts.set(n,data);return {partNumber:n,etag:'etag-'+n}},
  async complete(parts:any[]){assert.equal(parts.length,u.parts.size);objects.set(key,{size:[...u.parts.values()].reduce((n:number,b:any)=>n+b.byteLength,0),customMetadata:u.options.customMetadata});},
  async abort(){uploads.delete(id);},
 }}} as unknown as R2Bucket;
 return {store:new LargeArtifactStore(bucket,storage),uploadsStarted:()=>uploadsStarted};
}
test('multipart validates exact parts, duplicate contents, completeness and immutable reference',async()=>{
 const {store,uploadsStarted}=fixture();const r={...ref,sizeBytes:PART_BYTES+3};const upload:any=await store.begin(r,0);
 assert.equal(uploadsStarted(),1);assert.equal((await store.begin(r,1) as any).id,upload.id);
 await assert.rejects(store.part(upload.id,1,new Uint8Array(3),1));
 await assert.rejects(store.part(upload.id,3,new Uint8Array(3),1));
 await store.part(upload.id,1,new Uint8Array(PART_BYTES),1);
 assert.equal((await store.part(upload.id,1,new Uint8Array(PART_BYTES),1)).reused,true);
 await assert.rejects(store.part(upload.id,1,new Uint8Array(PART_BYTES).fill(1),1));
 await assert.rejects(store.complete(upload.id,1));
 await store.part(upload.id,2,new Uint8Array(3),1);const result=await store.complete(upload.id,2);
 assert.equal(result.contentHashVerification,'runtime-required');
 assert.equal((await store.complete(upload.id,3)).status,'complete');
 await assert.rejects(store.abort(upload.id));
 await assert.rejects(store.begin({...r,expandedBytes:r.expandedBytes-1},3));
 assert.equal((await store.begin(r,4)).status,'complete');assert.equal(uploadsStarted(),1);
});
test('expired and aborted upload cannot accept parts or complete',async()=>{
 const {store}=fixture(),r={...ref,sizeBytes:3};const u:any=await store.begin(r,0);
 await assert.rejects(store.part(u.id,1,new Uint8Array(3),86400000));
 await assert.rejects(store.complete(u.id,86400000));
 await store.abort(u.id);await assert.rejects(store.part(u.id,1,new Uint8Array(3),1));await assert.rejects(store.complete(u.id,1));
});
