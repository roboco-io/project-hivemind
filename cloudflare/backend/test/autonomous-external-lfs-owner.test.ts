import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openLargeFor} from '../src/autonomous-external.ts';
import {createExternalLargeStore,type ExternalLargeBucket} from '../../../packages/adapters/src/autonomous-external-large-store.ts';
import {createExternalLargeRecordPort} from '../../../packages/adapters/src/autonomous-external-large-sql.ts';
import type {ExternalInvocation} from '../../../packages/contracts/src/autonomous-external.ts';

const data=new TextEncoder().encode('0123456789'),sha=createHash('sha256').update(data).digest('hex');
function fixture(){
 const db=new DatabaseSync(':memory:'),objects=new Map<string,Uint8Array>(),uploads=new Map<string,{key:string;parts:Map<number,Uint8Array>}>();let next=0;
 const sql={exec(q:string,...b:(string|number|null)[]){const st=db.prepare(q);return st.columns().length?[...st.iterate(...b)] as never:(st.run(...b),[] as never);},transactionSync<T>(fn:()=>T){db.exec('BEGIN IMMEDIATE');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}}};
 const bucket:ExternalLargeBucket={
  async createMultipartUpload(key){const id='mp'+next++;uploads.set(id,{key,parts:new Map()});return {uploadId:id};},
  resumeMultipartUpload(key,id){const u=uploads.get(id)!;return {async uploadPart(n,d){u.parts.set(n,d.slice());return {etag:'e'+n};},async complete(parts){objects.set(key,Buffer.concat(parts.sort((a,b)=>a.partNumber-b.partNumber).map(p=>u.parts.get(p.partNumber)!)));},async abort(){uploads.delete(id);}};},
  async get(key){const o=objects.get(key);return o?{size:o.length,body:new ReadableStream<Uint8Array>({start(c){c.enqueue(o.slice());c.close();}})}:null;},
  async delete(key){objects.delete(key);},
 };
 const store=createExternalLargeStore({bucket,records:createExternalLargeRecordPort(sql),limits:{maxFileBytes:100,maxTotalBytes:1000,maxFiles:4},partBytes:4,now:()=>1000});
 return {store,db};
}
const invocation=(taskId:string,profileId='hf')=>({taskId,revision:1,profile:{id:profileId}}) as unknown as ExternalInvocation;
async function complete(store:ReturnType<typeof fixture>['store'],taskId:string){
 const owner={taskId,revision:1,profileId:'hf'},begun=await store.begin(owner,{path:'w.bin',size:10,sha256:sha},5000);
 for(let n=1;n<=begun.count;n++)await store.part(begun.uploadId,n,data.slice((n-1)*4,n*4),owner);
 return store.complete(begun.uploadId,owner);
}
test('the LFS open wiring reads only files the invoking owner completed, even with a forged storageRef',async()=>{
 const {store,db}=fixture();try{
  const mine=await complete(store,'t1'),theirs=await complete(store,'t2'),open=openLargeFor(store);
  assert.notEqual(mine.storageRef,theirs.storageRef);
  const chunks:Uint8Array[]=[];for await(const c of (await open(mine,invocation('t1'))) as unknown as AsyncIterable<Uint8Array>)chunks.push(c);
  assert.equal(Buffer.concat(chunks).toString(),'0123456789');
  // The other owner's object exists in the bucket, but the invocation of t1 does not own it.
  await assert.rejects(open(theirs,invocation('t1')),(e:{statusCode?:number})=>e.statusCode===404);
  await assert.rejects(open(mine,invocation('t1','other-profile')),(e:{statusCode?:number})=>e.statusCode===404);
 }finally{db.close();}
});
