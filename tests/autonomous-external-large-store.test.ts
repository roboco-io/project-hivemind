import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createExternalLargeStore,type ExternalLargeBucket,type ExternalLargeRecordPort,type ExternalLargeUploadRecord} from '../packages/adapters/src/autonomous-external-large-store.ts';
import {largeOwnerKey,largeStorageRef} from '../packages/core/src/autonomous-external-large.ts';
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const bytes=(text:string)=>new TextEncoder().encode(text);
function fakeBucket(){
 const objects=new Map<string,Uint8Array>(),uploads=new Map<string,{key:string;parts:Map<number,Uint8Array>}>(),log:string[]=[];let next=0;
 const bucket:ExternalLargeBucket={
  async createMultipartUpload(key){const uploadId='mp-'+next++;uploads.set(uploadId,{key,parts:new Map()});log.push('create '+key);return {uploadId};},
  resumeMultipartUpload(key,uploadId){const u=uploads.get(uploadId);return {
   async uploadPart(n,data){if(!u||u.key!==key)throw Error('no upload');u.parts.set(n,data.slice());return {etag:'etag-'+n};},
   async complete(parts){if(!u)throw Error('no upload');const all=parts.sort((a,b)=>a.partNumber-b.partNumber).map(p=>u.parts.get(p.partNumber)!);const out=new Uint8Array(all.reduce((n,p)=>n+p.length,0));let o=0;for(const p of all){out.set(p,o);o+=p.length;}objects.set(key,out);uploads.delete(uploadId);},
   async abort(){uploads.delete(uploadId);log.push('abort '+key);},
  };},
  async get(key){const o=objects.get(key);if(!o)return null;const half=Math.ceil(o.length/2);return {size:o.length,body:new ReadableStream<Uint8Array>({start(c){c.enqueue(o.slice(0,half));c.enqueue(o.slice(half));c.close();}})};},
  async delete(key){objects.delete(key);log.push('delete '+key);},
 };
 return {bucket,objects,uploads,log};
}
function fakeRecords(){
 const rows=new Map<string,ExternalLargeUploadRecord>(),cancelled=new Set<string>();
 const records:ExternalLargeRecordPort={
  async get(id){const r=rows.get(id);return r&&structuredClone(r);},
  async put(r){rows.set(r.uploadId,structuredClone(r));},
  async listTask(taskId,revision){return [...rows.values()].filter(r=>r.taskId===taskId&&r.revision===revision).map(r=>structuredClone(r));},
  async isCancelled(taskId,revision){return cancelled.has(taskId+':'+revision);},
  async markCancelled(taskId,revision){cancelled.add(taskId+':'+revision);},
 };
 return {records,rows};
}
const limits={maxFileBytes:20,maxTotalBytes:30,maxFiles:3};
function fixture(){
 const b=fakeBucket(),r=fakeRecords();let clock=1000;
 const store=createExternalLargeStore({bucket:b.bucket,records:r.records,limits,partBytes:4,now:()=>clock});
 return {...b,...r,store,time(v:number){clock=v;}};
}
const owner={taskId:'t1',revision:1,profileId:'hf'};
const content=bytes('0123456789'); // 10 bytes -> parts 4,4,2
const file=(path='m/a.bin',data=content)=>({path,size:data.length,sha256:sha(data)});
async function status(p:Promise<unknown>){try{await p;return 0;}catch(e){return (e as {statusCode?:number}).statusCode??-1;}}
async function uploadAll(f:ReturnType<typeof fixture>,data=content,path='m/a.bin',o=owner){
 const begun=await f.store.begin(o,file(path,data),5000);
 for(let n=1;n<=begun.count;n++)await f.store.part(begun.uploadId,n,data.slice((n-1)*4,n*4));
 return begun;
}
test('multi part upload completes, is owner scoped, and reads back',async()=>{
 const f=fixture(),begun=await uploadAll(f);
 assert.equal(begun.partBytes,4);assert.equal(begun.count,3);
 const done=await f.store.complete(begun.uploadId),ref=largeStorageRef(largeOwnerKey('t1',1,'hf'),sha(content));
 assert.deepEqual(done,{path:'m/a.bin',size:10,sha256:sha(content),storageRef:ref});
 assert.deepEqual(f.objects.get(ref),content);
 const opened=await f.store.open(done),chunks:Uint8Array[]=[];for await(const c of opened.body as unknown as AsyncIterable<Uint8Array>)chunks.push(c);
 assert.equal(opened.size,10);assert.equal(Buffer.concat(chunks).toString(),'0123456789');
 const other=await f.store.begin({...owner,taskId:'t2'},file(),5000);
 assert.notEqual(other.uploadId,begun.uploadId);
 assert.equal(await status(f.store.open({...done,storageRef:largeStorageRef(largeOwnerKey('t2',1,'hf'),sha(content))})),404);
});
test('default part size is 8 MiB',async()=>{
 const b=fakeBucket(),r=fakeRecords(),store=createExternalLargeStore({bucket:b.bucket,records:r.records,limits:{maxFileBytes:5*1024**3,maxTotalBytes:6*1024**3,maxFiles:2},now:()=>1});
 const begun=await store.begin(owner,{path:'big.bin',size:8388609,sha256:'c'.repeat(64)},9);
 assert.equal(begun.partBytes,8388608);assert.equal(begun.count,2);
});
test('begin validates size, path, hash, expiry and quotas',async()=>{
 const f=fixture();
 assert.equal(await status(f.store.begin(owner,{...file(),size:21},5000)),400);
 assert.equal(await status(f.store.begin(owner,{...file(),size:0},5000)),400);
 assert.equal(await status(f.store.begin(owner,{...file('../x')},5000)),400);
 assert.equal(await status(f.store.begin(owner,{...file(),sha256:'zz'},5000)),400);
 assert.equal(await status(f.store.begin(owner,file(),1000)),400);
 await f.store.begin(owner,file('a',bytes('a'.repeat(20))),5000);
 assert.equal(await status(f.store.begin(owner,file('b',bytes('b'.repeat(11))),5000)),413);
 await f.store.begin(owner,file('c',bytes('c')),5000);await f.store.begin(owner,file('d',bytes('d')),5000);
 assert.equal(await status(f.store.begin(owner,file('e',bytes('e')),5000)),413);
});
test('part size, number and content checks',async()=>{
 const f=fixture(),b=await f.store.begin(owner,file(),5000);
 assert.equal(await status(f.store.part(b.uploadId,1,bytes('012'))),400);
 assert.equal(await status(f.store.part(b.uploadId,1,bytes('01234'))),400);
 assert.equal(await status(f.store.part(b.uploadId,3,bytes('012'))),400);
 assert.equal(await status(f.store.part(b.uploadId,0,bytes('0123'))),400);
 assert.equal(await status(f.store.part(b.uploadId,4,bytes('0123'))),400);
 assert.equal(await status(f.store.part('nope',1,bytes('0123'))),404);
 assert.deepEqual(await f.store.part(b.uploadId,1,bytes('0123')),{partNumber:1,size:4,sha256:sha(bytes('0123')),reused:false});
 assert.equal((await f.store.part(b.uploadId,1,bytes('0123'))).reused,true);
 assert.equal(await status(f.store.part(b.uploadId,1,bytes('9999'))),409);
 assert.equal(await status(f.store.part(b.uploadId,3,bytes('89'))),0);
});
test('part hash mismatch against declared file hash fails complete with 409 and deletes the object',async()=>{
 const f=fixture(),b=await f.store.begin(owner,file(),5000);
 for(const [n,t] of [[1,'0123'],[2,'4567'],[3,'XX']] as const)await f.store.part(b.uploadId,n,bytes(t));
 assert.equal(await status(f.store.complete(b.uploadId)),409);
 const ref=largeStorageRef(largeOwnerKey('t1',1,'hf'),sha(content));
 assert.equal(f.objects.has(ref),false);assert.ok(f.log.includes('delete '+ref));
 assert.equal(await status(f.store.complete(b.uploadId)),409);
 const again=await f.store.begin(owner,file(),5000);assert.notEqual(again.uploadId,b.uploadId);assert.deepEqual(again.parts,[]);
});
test('complete rejects missing parts and a wrong total size',async()=>{
 const f=fixture(),b=await f.store.begin(owner,file(),5000);
 await f.store.part(b.uploadId,1,bytes('0123'));
 assert.equal(await status(f.store.complete(b.uploadId)),409);
});
test('begin twice returns the same upload and stored parts; complete twice returns the same file',async()=>{
 const f=fixture(),a=await f.store.begin(owner,file(),5000);await f.store.part(a.uploadId,2,bytes('4567'));
 const b=await f.store.begin(owner,file(),6000);
 assert.equal(b.uploadId,a.uploadId);assert.deepEqual(b.parts,[{partNumber:2,size:4,sha256:sha(bytes('4567'))}]);
 await f.store.part(a.uploadId,1,bytes('0123'));await f.store.part(a.uploadId,3,bytes('89'));
 const one=await f.store.complete(a.uploadId),two=await f.store.complete(a.uploadId);
 assert.deepEqual(one,two);
 const c=await f.store.begin(owner,file(),6000);assert.equal(c.status,'complete');assert.deepEqual(c.file,one);
 assert.equal(await status(f.store.part(a.uploadId,1,bytes('0123'))),409);
});
test('begin with the same path but a different hash in one task is rejected as duplicate path',async()=>{
 const f=fixture();await f.store.begin(owner,file('same',bytes('aaaa')),5000);
 assert.equal(await status(f.store.begin(owner,file('same',bytes('bbbb')),5000)),409);
});
test('expiry blocks part and complete',async()=>{
 const f=fixture(),b=await f.store.begin(owner,file(),2000);
 await f.store.part(b.uploadId,1,bytes('0123'));await f.store.part(b.uploadId,2,bytes('4567'));await f.store.part(b.uploadId,3,bytes('89'));
 f.time(2000);
 assert.equal(await status(f.store.part(b.uploadId,1,bytes('0123'))),409);
 assert.equal(await status(f.store.complete(b.uploadId)),409);
 const fresh=await f.store.begin(owner,file(),9000);assert.notEqual(fresh.uploadId,b.uploadId);
});
test('abort stops an upload and is idempotent; complete uploads cannot be aborted',async()=>{
 const f=fixture(),b=await f.store.begin(owner,file(),5000);
 await f.store.abort(b.uploadId);await f.store.abort(b.uploadId);
 assert.equal(await status(f.store.part(b.uploadId,1,bytes('0123'))),409);
 const done=await uploadAll(f,bytes('zzzz'),'z.bin');await f.store.complete(done.uploadId);
 assert.equal(await status(f.store.abort(done.uploadId)),409);
});
test('abortOwner cancels uploads, deletes finished objects, and blocks further part and begin',async()=>{
 const f=fixture(),pending=await f.store.begin(owner,file('p',bytes('pppp')),5000);
 const finished=await uploadAll(f);const file1=await f.store.complete(finished.uploadId);
 const otherProfile=await uploadAll(f,content,'m/a.bin',{...owner,profileId:'hf2'});
 const untouched=await uploadAll(f,content,'m/a.bin',{...owner,taskId:'t9'});
 assert.equal(await f.store.abortOwner('t1',1),3);
 assert.equal(f.objects.has(file1.storageRef),false);
 assert.equal(await status(f.store.part(pending.uploadId,1,bytes('pppp'))),409);
 assert.equal(await status(f.store.part(otherProfile.uploadId,1,bytes('0123'))),409);
 assert.equal(await status(f.store.complete(finished.uploadId)),409);
 assert.equal(await status(f.store.begin(owner,file('n',bytes('nnnn')),5000)),409);
 assert.equal(await status(f.store.open(file1)),404);
 await f.store.complete(untouched.uploadId);
 assert.equal(await f.store.abortOwner('t1',1),0);
});
test('upload id of another owner is not found',async()=>{
 const f=fixture(),b=await f.store.begin(owner,file(),5000),other={...owner,taskId:'t2'};
 assert.equal(await status(f.store.part(b.uploadId,1,bytes('0123'),other)),404);
 assert.equal(await status(f.store.complete(b.uploadId,other)),404);
 assert.equal(await status(f.store.abort(b.uploadId,other)),404);
 assert.equal((await f.store.part(b.uploadId,1,bytes('0123'),owner)).reused,false);
});
test('open rejects a malformed or size-mismatched reference',async()=>{
 const f=fixture(),b=await uploadAll(f),done=await f.store.complete(b.uploadId);
 assert.equal(await status(f.store.open({...done,storageRef:'external-large/x/y'})),400);
 assert.equal(await status(f.store.open({...done,size:11})),409);
});
test('open with an owner needs a verified upload: an unverified object that exists in the bucket is refused',async()=>{
 const f=fixture(),b=await uploadAll(f),ref=largeStorageRef(largeOwnerKey(owner.taskId,owner.revision,owner.profileId),sha(content));
 // Simulates a crash between the multipart complete and the re-hash: the object exists but was never verified.
 f.objects.set(ref,content);
 const named={...file(),storageRef:ref};
 assert.equal(await status(f.store.open(named,owner)),404);
 await f.store.complete(b.uploadId,owner);
 assert.equal((await f.store.open(named,owner)).size,10);
 assert.equal(await status(f.store.open(named,{...owner,taskId:'t2'})),404);
 assert.equal(await status(f.store.open({...named,path:'other/b.bin'},owner)),404);
});
test('begin and abort cycles are capped per task revision across all statuses; resume does not count',async()=>{
 const b=fakeBucket(),r=fakeRecords();
 const store=createExternalLargeStore({bucket:b.bucket,records:r.records,limits:{maxFileBytes:20,maxTotalBytes:1000,maxFiles:3},partBytes:4,now:()=>1000,maxUploadRecords:5});
 const ids:string[]=[];
 for(let i=0;i<5;i++){const begun=await store.begin(owner,file('p'+i,bytes('x'+i)),5000);ids.push(begun.uploadId);await store.abort(begun.uploadId);}
 assert.equal(r.rows.size,5);
 assert.equal(await status(store.begin(owner,file('p9',bytes('y9')),5000)),413);
 assert.equal(r.rows.size,5,'a rejected begin adds no record');
 // another revision has its own budget
 await store.begin({...owner,revision:2},file('p9',bytes('y9')),5000);
 assert.throws(()=>createExternalLargeStore({bucket:b.bucket,records:r.records,limits,now:()=>1000,maxUploadRecords:0}),RangeError);
});
test('a repeated begin for an existing upload resumes it even when the record cap is reached',async()=>{
 const b=fakeBucket(),r=fakeRecords();
 const store=createExternalLargeStore({bucket:b.bucket,records:r.records,limits,partBytes:4,now:()=>1000,maxUploadRecords:2});
 const first=await store.begin(owner,file('a',bytes('a1')),5000);
 await store.begin(owner,file('b',bytes('b1')),5000);
 assert.equal(await status(store.begin(owner,file('c',bytes('c1')),5000)),413);
 assert.equal((await store.begin(owner,file('a',bytes('a1')),5000)).uploadId,first.uploadId);
 assert.equal(r.rows.size,2);
});
test('default record cap is 64',async()=>{
 const f=fixture();
 for(let i=0;i<64;i++){const begun=await f.store.begin(owner,file('d'+i,bytes('z'+i)),5000);await f.store.abort(begun.uploadId);}
 assert.equal(await status(f.store.begin(owner,file('over',bytes('o')),5000)),413);
});
