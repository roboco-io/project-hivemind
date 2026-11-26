import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {handleExternalLargeApi,type ExternalLargeApiOptions} from '../apps/control-plane/src/autonomous-external-large-api.ts';
import {createExternalLargeStore,type ExternalLargeBucket,type ExternalLargeRecordPort,type ExternalLargeUploadRecord} from '../packages/adapters/src/autonomous-external-large-store.ts';
import {externalLargeManifestDigest,largeOwnerKey,largeStorageRef} from '../packages/core/src/autonomous-external-large.ts';
import type {ExternalLargeManifest} from '../packages/contracts/src/autonomous-external-large.js';
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const bytes=(t:string)=>new TextEncoder().encode(t);
function memory(){
 const objects=new Map<string,Uint8Array>(),uploads=new Map<string,Map<number,Uint8Array>>(),rows=new Map<string,ExternalLargeUploadRecord>(),cancelled=new Set<string>();let n=0;
 const bucket:ExternalLargeBucket={
  async createMultipartUpload(key){const id='mp'+n++;uploads.set(id,new Map());void key;return {uploadId:id};},
  resumeMultipartUpload(key,id){return {async uploadPart(i,d){uploads.get(id)!.set(i,d.slice());return {etag:'e'+i};},async complete(ps){const all=ps.map(p=>uploads.get(id)!.get(p.partNumber)!);objects.set(key,Buffer.concat(all));},async abort(){uploads.delete(id);}};},
  async get(key){const o=objects.get(key);return o?{size:o.length,body:new Blob([o as Uint8Array<ArrayBuffer>]).stream() as ReadableStream<Uint8Array>}:null;},
  async delete(key){objects.delete(key);},
 };
 const records:ExternalLargeRecordPort={
  async get(id){const r=rows.get(id);return r&&structuredClone(r);},async put(r){rows.set(r.uploadId,structuredClone(r));},
  async listTask(t,v){return [...rows.values()].filter(r=>r.taskId===t&&r.revision===v).map(r=>structuredClone(r));},
  async isCancelled(t,v){return cancelled.has(t+':'+v);},async markCancelled(t,v){cancelled.add(t+':'+v);},
 };
 return {bucket,records};
}
const lease={taskId:'t1',runId:'r',workerId:'w',token:'LEASE-SECRET',expiresAt:9};
const auth={lease,runtimeId:'RUNTIME-SECRET',profileId:'hf'};
const limits={maxFileBytes:20,maxTotalBytes:30,maxFiles:3};
function fixture(patch:Partial<ExternalLargeApiOptions>={}){
 const m=memory(),saved:{manifest:ExternalLargeManifest;digest:string}[]=[],authorized:unknown[]=[];let clock=1000;
 const store=createExternalLargeStore({...m,limits,partBytes:4,now:()=>clock});
 const options:ExternalLargeApiOptions={workerToken:'worker-token',store,limits,partBytes:4,ttlMs:60000,now:()=>clock,
  async authorize(id,body){authorized.push({id,body});return {taskId:id,revision:1,profileId:body.profileId};},
  async saveManifest(manifest,digest){saved.push({manifest,digest});},...patch};
 const call=(route:string,init:RequestInit&{id?:string}={},token='worker-token')=>handleExternalLargeApi(new Request(`http://x/v1/autonomous-tasks/${init.id??'t1'}/external-large/${route}`,{method:'POST',...init,headers:{authorization:'Bearer '+token,...(init.headers as Record<string,string>|undefined)}}),options);
 const json=(route:string,body:unknown,extra:{id?:string}={})=>call(route,{body:JSON.stringify(body),headers:{'content-type':'application/json'},...extra});
 const part=(uploadId:string,n:number,data:Uint8Array,meta:unknown={...auth,uploadId,part:n})=>call('part',{body:data as unknown as BodyInit,headers:{'x-large-meta':JSON.stringify(meta)}});
 return {options,store,saved,authorized,json,part,call,time(v:number){clock=v;}};
}
const content=bytes('0123456789');
const file={path:'m/a.bin',size:10,sha256:sha(content)};
async function upload(f:ReturnType<typeof fixture>){
 const b=await (await f.json('begin',{...auth,file}))!.json() as {uploadId:string;count:number};
 for(let i=1;i<=b.count;i++){const r=await f.part(b.uploadId,i,content.slice((i-1)*4,i*4));assert.equal(r!.status,200);}
 return b.uploadId;
}
test('begin, parts, complete and manifest flow',async()=>{
 const f=fixture(),b=await (await f.json('begin',{...auth,file}))!.json() as any;
 assert.equal(b.partBytes,4);assert.equal(b.count,3);assert.equal(b.status,'uploading');assert.equal(b.expiresAt,61000);
 const again=await (await f.json('begin',{...auth,file}))!.json() as any;assert.equal(again.uploadId,b.uploadId);
 for(let i=1;i<=3;i++)assert.equal((await f.part(b.uploadId,i,content.slice((i-1)*4,i*4)))!.status,200);
 const done=await f.json('complete',{...auth,uploadId:b.uploadId});assert.equal(done!.status,200);
 const owner=largeOwnerKey('t1',1,'hf'),expected={...file,storageRef:largeStorageRef(owner,file.sha256)};
 assert.deepEqual(await done!.json(),expected);
 const m=await f.json('manifest',{...auth,files:[file]});assert.equal(m!.status,200);
 const manifest:ExternalLargeManifest={version:1,taskId:'t1',revision:1,profileId:'hf',files:[expected]};
 assert.deepEqual(await m!.json(),{manifestDigest:externalLargeManifestDigest(manifest),files:1});
 assert.deepEqual(f.saved,[{manifest,digest:externalLargeManifestDigest(manifest)}]);
 assert.equal(f.authorized.length>=5,true);
 const aborted=await f.json('abort',{...auth,uploadId:b.uploadId});assert.equal(aborted!.status,409);
});
test('paths outside external-large are not handled; unknown routes and methods are 404',async()=>{
 const f=fixture();
 assert.equal(await handleExternalLargeApi(new Request('http://x/v1/autonomous-tasks/t1/external-artifact',{method:'POST'}),f.options),undefined);
 assert.equal(await handleExternalLargeApi(new Request('http://x/health'),f.options),undefined);
 assert.equal((await f.json('nope',{}))!.status,404);
 assert.equal((await f.call('begin',{method:'GET'}))!.status,404);
});
test('worker token is required and compared before any work; missing configuration is 503',async()=>{
 const f=fixture();
 assert.equal((await f.call('begin',{body:'{}'},'wrong'))!.status,401);
 assert.equal((await handleExternalLargeApi(new Request('http://x/v1/autonomous-tasks/t1/external-large/begin',{method:'POST',body:'{}'}),f.options))!.status,401);
 assert.equal((await fixture({workerToken:''}).json('begin',{...auth,file}))!.status,503);
 assert.equal(f.authorized.length,0);
});
test('authority failures and mismatches stop before the store',async()=>{
 const denied=fixture({async authorize(){throw Object.assign(Error('SECRET-DETAIL'),{statusCode:403});}});
 const r=await denied.json('begin',{...auth,file});assert.equal(r!.status,403);
 const text=await r!.text();assert.ok(!/SECRET|LEASE|RUNTIME/.test(text));
 const other=fixture({async authorize(){return {taskId:'other',revision:1,profileId:'hf'};}});
 assert.equal((await other.json('begin',{...auth,file}))!.status,409);
 const profile=fixture({async authorize(){return {taskId:'t1',revision:1,profileId:'zzz'};}});
 assert.equal((await profile.json('begin',{...auth,file}))!.status,409);
 const crash=fixture({async authorize(){throw Error('boom');}});
 assert.equal((await crash.json('begin',{...auth,file}))!.status,503);
});
test('request bodies are validated: lease task, unknown fields, client expiry, bad json',async()=>{
 const f=fixture();
 assert.equal((await f.json('begin',{...auth,lease:{...lease,taskId:'t9'},file}))!.status,400);
 assert.equal((await f.json('begin',{...auth,file,expiresAt:99999999}))!.status,400);
 assert.equal((await f.json('begin',{...auth,file:{...file,extra:1}}))!.status,400);
 assert.equal((await f.json('begin',{...auth,file:{...file,size:21}}))!.status,400);
 assert.equal((await f.json('begin',{...auth,file:{...file,path:'../x'}}))!.status,400);
 assert.equal((await f.call('begin',{body:'not json'}))!.status,400);
 assert.equal((await f.call('begin',{body:'{"a":"'+'x'.repeat(300000)+'"}'}))!.status,413);
 assert.equal(f.authorized.length,0);
});
test('part body limits and metadata',async()=>{
 const f=fixture(),id=(await (await f.json('begin',{...auth,file}))!.json() as any).uploadId;
 assert.equal((await f.part(id,1,bytes('01234')))!.status,413);
 assert.equal((await f.part(id,1,bytes('012')))!.status,400);
 assert.equal((await f.part(id,9,bytes('0123')))!.status,400);
 assert.equal((await f.call('part',{body:bytes('0123')}))!.status,400);
 assert.equal((await f.call('part',{body:bytes('0123'),headers:{'x-large-meta':'{'}}))!.status,400);
 assert.equal((await f.part(id,1,bytes('0123'),{...auth,uploadId:id,part:1,extra:1}))!.status,400);
 assert.equal((await f.part(id,1,bytes('0123'),{...auth,uploadId:id,part:'1'}))!.status,400);
 const chunked=new Request('http://x/v1/autonomous-tasks/t1/external-large/part',{method:'POST',headers:{authorization:'Bearer worker-token','x-large-meta':JSON.stringify({...auth,uploadId:id,part:1})},body:new ReadableStream({start(c){c.enqueue(bytes('01234'));c.enqueue(bytes('5678'));c.close();}}),duplex:'half'} as RequestInit);
 assert.equal((await handleExternalLargeApi(chunked,f.options))!.status,413);
 assert.equal((await f.part(id,1,bytes('0123')))!.status,200);
});
test('hash mismatch is 409 and expiry and cancel are enforced through the API',async()=>{
 const f=fixture(),id=(await (await f.json('begin',{...auth,file}))!.json() as any).uploadId;
 for(const [i,t] of [[1,'0123'],[2,'4567'],[3,'XX']] as const)await f.part(id,i,bytes(t));
 assert.equal((await f.json('complete',{...auth,uploadId:id}))!.status,409);
 const g=fixture(),gid=await upload(g);g.time(61000);
 assert.equal((await g.part(gid,1,bytes('0123')))!.status,409);
 const h=fixture(),hid=(await (await h.json('begin',{...auth,file}))!.json() as any).uploadId;
 await h.store.abortOwner('t1',1);
 assert.equal((await h.part(hid,1,bytes('0123')))!.status,409);
 assert.equal((await h.json('begin',{...auth,file}))!.status,409);
});
test('an upload id of another task is not found, and unfinished files cannot enter a manifest',async()=>{
 const f=fixture(),id=await upload(f);
 const t2={...auth,lease:{...lease,taskId:'t2'}};
 assert.equal((await f.json('complete',{...t2,uploadId:id},{id:'t2'}))!.status,404);
 assert.equal((await f.json('abort',{...t2,uploadId:id},{id:'t2'}))!.status,404);
 assert.equal((await f.call('part',{id:'t2',body:bytes('0123'),headers:{'x-large-meta':JSON.stringify({...t2,uploadId:id,part:1})}}))!.status,404);
 assert.equal((await f.json('complete',{...auth,uploadId:id}))!.status,200);
 const m=fixture();await m.json('begin',{...auth,file});
 assert.equal((await m.json('manifest',{...auth,files:[file]}))!.status,404);
 assert.equal((await m.json('manifest',{...auth,files:[file,file]}))!.status,400);
 assert.equal((await m.json('manifest',{...auth,files:[]}))!.status,400);
 assert.equal(m.saved.length,0);
});
test('part authority is checked before the body is read',async()=>{
 let pulled=false;
 const f=fixture({async authorize(){throw Object.assign(new Error('x'),{statusCode:409});}});
 const body=new ReadableStream<Uint8Array>({pull(c){pulled=true;c.enqueue(bytes('0123'));c.close();}},{highWaterMark:0});
 const req=new Request('http://x/v1/autonomous-tasks/t1/external-large/part',{method:'POST',headers:{authorization:'Bearer worker-token','x-large-meta':JSON.stringify({...auth,uploadId:'u',part:1})},body,duplex:'half'} as RequestInit);
 assert.equal((await handleExternalLargeApi(req,f.options))!.status,409);
 assert.equal(pulled,false);
});
