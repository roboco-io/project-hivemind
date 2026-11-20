import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {handleExternalLargeApi} from '../../../apps/control-plane/src/autonomous-external-large-api.ts';
import {createExternalLargeStore,type ExternalLargeBucket} from '../../../packages/adapters/src/autonomous-external-large-store.ts';
import {createExternalLargeRecordPort} from '../../../packages/adapters/src/autonomous-external-large-sql.ts';
import type {ExternalLargeManifest} from '../../../packages/contracts/src/autonomous-external-large.js';
export const largeLease={taskId:'task',runId:'run',workerId:'worker',token:'lease-secret-value',expiresAt:Date.now()+60000};
const limits={maxFileBytes:64*1024*1024,maxTotalBytes:128*1024*1024,maxFiles:4};
// Server side of the seam: the real handler and store over local SQL and an in-memory bucket. Only the network hop is replaced.
export function largeServer(expectedRuntimeId='runtime-1',workerToken='worker-token'){
 const db=new DatabaseSync(':memory:'),objects=new Map<string,Uint8Array>(),pending=new Map<string,Map<number,Uint8Array>>();let counter=0;
 const sql={exec(query:string,...bindings:(string|number|null)[]){const st=db.prepare(query);const result=st.columns().length?st.all(...bindings):(st.run(...bindings),[]);return Object.assign(result,{toArray(){return [...result];}});},transactionSync<T>(fn:()=>T){db.exec('BEGIN IMMEDIATE');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}}};
 const bucket:ExternalLargeBucket={
  async createMultipartUpload(){const id='mp-'+(++counter);pending.set(id,new Map());return {uploadId:id};},
  resumeMultipartUpload(key,id){return {async uploadPart(n,data){pending.get(id)!.set(n,new Uint8Array(data));return {etag:'e'+n};},async complete(parts){const m=pending.get(id)!;objects.set(key,Buffer.concat(parts.map(p=>m.get(p.partNumber)!)));pending.delete(id);},async abort(){pending.delete(id);}};},
  async get(key){const o=objects.get(key);return o?{size:o.byteLength,body:new Response(o as unknown as BodyInit).body!}:null;},
  async delete(key){objects.delete(key);},
 };
 const store=createExternalLargeStore({bucket,records:createExternalLargeRecordPort(sql),limits}),manifests=new Map<string,ExternalLargeManifest>(),seen:{op:string;headers:Headers;json?:any}[]=[];
 const handler=async(request:Request)=>{
  const op=new URL(request.url).pathname.split('/').at(-1)!,copy=request.clone();
  seen.push({op,headers:copy.headers,...(op==='part'?{}:{json:await copy.json()})});
  return (await handleExternalLargeApi(request,{workerToken,store,limits,authorize:async(id,b)=>{assert.equal(id,'task');assert.deepEqual(b.lease,largeLease);assert.equal(b.runtimeId,expectedRuntimeId);return {taskId:id,revision:1,profileId:b.profileId};},saveManifest:async(m,d)=>{manifests.set(d,m);}}))!;
 };
 return {db,objects,manifests,seen,fetchImpl:((url:string|URL|Request,init?:RequestInit)=>handler(new Request(url as string,init))) as typeof fetch};
}
