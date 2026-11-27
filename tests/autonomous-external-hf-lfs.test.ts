import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {hfLfsCommit,hfLfsProof,lfsPointer,HF_LFS_MAX_FILE_BYTES,type HfLfsOptions,type HfLfsInvocation} from '../packages/adapters/src/autonomous-external-hf-lfs.ts';
import type {ExternalLargeManifest} from '../packages/contracts/src/autonomous-external-large.js';
import {HF_RELEASE_UPLOAD_HOSTS} from '../packages/adapters/src/model-factory-hf-publisher.ts';

const TOKEN='TEST_ONLY_HF_TOKEN_CANARY_0001';
const sha=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
const PARENT='a'.repeat(40),COMMIT='b'.repeat(40);
const bytes=new TextEncoder().encode('large-file-content');
const OID=sha(bytes);
const inv:HfLfsInvocation={taskId:'t1',revision:1,ownershipToken:'own-1',idempotencyKey:'idem-1',parametersHash:'c'.repeat(64),expiresAt:2_000_000};
const mark='hivemind:'+sha(JSON.stringify([inv.ownershipToken,inv.idempotencyKey,inv.parametersHash]));
const manifest=(over:Partial<ExternalLargeManifest['files'][number]>={}):ExternalLargeManifest=>({version:1,taskId:'t1',revision:1,profileId:'hf',files:[{path:'models/a.bin',size:bytes.byteLength,sha256:OID,storageRef:`external-large/${'d'.repeat(64)}/${OID}`,...over}]});

interface Call{url:string;method:string;headers:Record<string,string>;body?:string}
interface Fake{calls:Call[];opts:HfLfsOptions;state:{commits:{id:string;title:string}[];siblings:unknown[];info:Record<string,unknown>;uploadHref:string;existing:boolean;failCommit:boolean;commitBodies:string[]}}
// Swappable fixture: the fake large-object source is the default. SUPERLITE_REAL=1 is
// not wired for this file because the real store needs bucket ports owned by p4a;
// the seam is the single `open(file)` function below.
function fixture():Fake{
  const state={commits:[] as {id:string;title:string}[],siblings:[] as unknown[],info:{private:true,sha:PARENT} as Record<string,unknown>,uploadHref:'https://lfs-bucket.example.test/upload/1?sig=x',existing:false,failCommit:false,commitBodies:[] as string[]};
  const calls:Call[]=[];
  const fetch=async(url:string|URL|Request,init:RequestInit={})=>{
    const u=String(url),method=init.method??'GET',headers=Object.fromEntries(Object.entries((init.headers??{}) as Record<string,string>).map(([k,v])=>[k.toLowerCase(),v]));
    assert.equal(init.redirect,'manual');
    let body:string|undefined;
    if(init.body&&typeof init.body==='object'&&'getReader' in init.body){const chunks:Buffer[]=[];for await(const c of init.body as unknown as AsyncIterable<Uint8Array>)chunks.push(Buffer.from(c));body=u.includes('/commit/')?Buffer.concat(chunks).toString('utf8'):'STREAM:'+sha(Buffer.concat(chunks));}
    else body=init.body as string|undefined;
    calls.push({url:u,method,headers,body});
    const json=(v:unknown)=>new Response(JSON.stringify(v),{status:200});
    if(u.endsWith('/preupload/main'))return json({files:JSON.parse(body!).files.map((f:any)=>({path:f.path,uploadMode:'lfs',shouldIgnore:false,oid:null}))});
    if(u.endsWith('/commits/main'))return json(state.commits);
    if(u.includes('/revision/main?'))return json(state.info);
    if(u.includes(`/revision/${COMMIT}?`))return json({private:true,sha:COMMIT,siblings:state.siblings});
    if(u.endsWith('.git/info/lfs/objects/batch'))return json({objects:[{oid:OID,size:bytes.byteLength,...(state.existing?{}:{actions:{upload:{href:state.uploadHref,header:{'x-amz-meta':'1',Authorization:'Basic SERVER'}},verify:{href:'https://huggingface.co/o/r.git/info/lfs/verify'}}})}]});
    if(method==='PUT')return new Response('',{status:200});
    if(u.endsWith('/lfs/verify'))return json({});
    if(u.endsWith('/commit/main')){
      state.commitBodies.push(body??'');
      if(state.failCommit){state.commits.push({id:COMMIT,title:mark});state.siblings.push({rfilename:'models/a.bin',lfs:{sha256:OID,size:bytes.byteLength}});throw new Error('socket hang up');}
      return json({commitOid:COMMIT});
    }
    return new Response('nope',{status:404});
  };
  const opts:HfLfsOptions={repository:'o/r',revision:'main',message:'add weights',fetch:fetch as typeof globalThis.fetch,now:()=>1_000_000,uploadHosts:['lfs-bucket.example.test'],visibility:'private',open:async f=>{assert.equal(f.sha256,OID);return new Blob([bytes]).stream();}};
  return {calls,opts,state};
}
// After the commit, the fake server knows the file as an LFS sibling.
const withSibling=(f:Fake)=>f.state.siblings.push({rfilename:'models/a.bin',lfs:{sha256:OID,size:bytes.byteLength}});

test('lfsPointer: exact text, size 0 rejected',()=>{
  assert.equal(lfsPointer(OID,5),`version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 5\n`);
  assert.throws(()=>lfsPointer(OID,0));
  assert.throws(()=>lfsPointer('xyz',5));
});

test('lfs commit: happy path uploads without Authorization, verifies, commits with mark',async()=>{
  const f=fixture();
  const original=f.state;void original;
  // The commit response is followed by the proof, which reads the commit back.
  const run=hfLfsCommit.bind(null,inv,TOKEN,manifest(),f.opts);
  const realFetch=f.opts.fetch!;
  f.opts.fetch=(async(u:string,i:RequestInit)=>{const r=await realFetch(u,i);if(String(u).endsWith('/commit/main')){f.state.commits.push({id:COMMIT,title:mark});withSibling(f);}return r;}) as typeof fetch;
  assert.deepEqual(await run(),{commitOid:COMMIT});
  const put=f.calls.find(c=>c.method==='PUT')!;
  assert.equal(put.url,f.state.uploadHref);
  assert.equal(put.body,'STREAM:'+OID);
  assert.equal(put.headers.authorization,undefined);
  assert.equal(put.headers['x-amz-meta'],'1');
  for(const c of f.calls.filter(c=>c.url.startsWith('https://lfs-bucket')))assert.ok(!JSON.stringify(c.headers).includes(TOKEN));
  const lines=f.state.commitBodies[0]!.trim().split('\n').map(l=>JSON.parse(l));
  assert.equal(lines[0].key,'header');assert.equal(lines[0].value.summary,mark);assert.equal(lines[0].value.parentCommit,PARENT);assert.equal(lines[0].value.description,'add weights');
  assert.deepEqual(lines[1],{key:'lfsFile',value:{path:'models/a.bin',algo:'sha256',oid:OID,size:bytes.byteLength}});
});

test('lfs commit: href outside the allow-list is rejected and no token is sent there',async()=>{
  for(const href of ['https://evil.example.test/u','http://lfs-bucket.example.test/u','https://user:pw@lfs-bucket.example.test/u','https://lfs-bucket.example.test:8443/u']){
    const f=fixture();f.state.uploadHref=href;
    await assert.rejects(hfLfsCommit(inv,TOKEN,manifest(),f.opts));
    assert.equal(f.calls.filter(c=>c.method==='PUT').length,0);
    assert.ok(!f.calls.some(c=>new URL(c.url).origin!=='https://huggingface.co'&&JSON.stringify(c.headers).includes(TOKEN)));
    assert.ok(f.state.commitBodies.length===0);
  }
});

test('lfs commit: public configuration is rejected before any request',async()=>{
  const f=fixture();f.opts.visibility='public';
  await assert.rejects(hfLfsCommit(inv,TOKEN,manifest(),f.opts));
  assert.equal(f.calls.length,0);
});

test('lfs commit: repository with private:true required (public repo / string flag rejected, no POST)',async()=>{
  for(const info of [{private:false,sha:PARENT},{private:'false',sha:PARENT},{private:'true',sha:PARENT}]){
    const f=fixture();f.state.info=info;
    await assert.rejects(hfLfsCommit(inv,TOKEN,manifest(),f.opts));
    assert.equal(f.calls.filter(c=>c.method==='POST'||c.method==='PUT').length,0);
  }
});

test('lfs commit: file over 5 GiB or bad manifest is rejected before any request',async()=>{
  for(const m of [manifest({size:HF_LFS_MAX_FILE_BYTES+1}),manifest({size:0}),manifest({path:'../x'}),manifest({path:'/abs'}),manifest({path:'a//b'}),manifest({sha256:'Z'}),{...manifest(),taskId:'other'},{...manifest(),files:[]}]){
    const f=fixture();
    await assert.rejects(hfLfsCommit(inv,TOKEN,m as ExternalLargeManifest,f.opts));
    assert.equal(f.calls.length,0);
  }
  const ok=manifest({size:HF_LFS_MAX_FILE_BYTES});void ok;
});

test('lfs commit: object already on the server skips upload',async()=>{
  const f=fixture();f.state.existing=true;
  const realFetch=f.opts.fetch!;
  f.opts.fetch=(async(u:string,i:RequestInit)=>{const r=await realFetch(u,i);if(String(u).endsWith('/commit/main')){f.state.commits.push({id:COMMIT,title:mark});withSibling(f);}return r;}) as typeof fetch;
  await hfLfsCommit(inv,TOKEN,manifest(),f.opts);
  assert.equal(f.calls.filter(c=>c.method==='PUT').length,0);
});

test('lfs commit: lost commit response is recovered by inspect via the mark',async()=>{
  const f=fixture();f.state.failCommit=true;
  await assert.rejects(hfLfsCommit(inv,TOKEN,manifest(),f.opts));
  assert.deepEqual(await hfLfsProof(inv,TOKEN,manifest(),f.opts),{commitOid:COMMIT});
  assert.deepEqual(await hfLfsProof(inv,TOKEN,manifest(),f.opts,COMMIT),{commitOid:COMMIT});
  assert.equal(await hfLfsProof(inv,TOKEN,manifest(),f.opts,'e'.repeat(40)),null);
  // A second run finds the commit first and posts nothing more.
  const before=f.state.commitBodies.length;
  assert.deepEqual(await hfLfsCommit(inv,TOKEN,manifest(),f.opts),{commitOid:COMMIT});
  assert.equal(f.state.commitBodies.length,before);
});

test('lfs proof: null when no marked commit, rejects when blob differs',async()=>{
  const f=fixture();
  assert.equal(await hfLfsProof(inv,TOKEN,manifest(),f.opts),null);
  f.state.commits.push({id:COMMIT,title:mark});f.state.siblings.push({rfilename:'models/a.bin',lfs:{sha256:'f'.repeat(64),size:bytes.byteLength}});
  await assert.rejects(hfLfsProof(inv,TOKEN,manifest(),f.opts));
});

test('lfs commit: expired action and aborted signal stop before requests',async()=>{
  const f=fixture();f.opts.now=()=>inv.expiresAt;
  await assert.rejects(hfLfsCommit(inv,TOKEN,manifest(),f.opts));
  const g=fixture();const c=new AbortController();c.abort();g.opts.signal=c.signal;
  await assert.rejects(hfLfsCommit(inv,TOKEN,manifest(),g.opts));
  assert.equal(g.calls.filter(x=>x.method!=='GET').length,0);
});

test('lfs commit: an invalid message is rejected before any request or upload',async()=>{
  for(const message of ['','bad\nmessage','x'.repeat(513)]){
    const f=fixture();f.opts.message=message;
    await assert.rejects(hfLfsCommit(inv,TOKEN,manifest(),f.opts));
    assert.equal(f.calls.length,0);
  }
});

function protocolFixture(transform:(value:any)=>any=(v)=>v){
  const f=fixture(), original=f.opts.fetch!;
  f.opts.fetch=(async(u:any,i:any)=>{
    if(String(u).endsWith('/objects/batch')){
      const response=await original(u,i);return Response.json(transform(await response.json()));
    }
    if(String(u).endsWith('/lfs/verify'))return new Response(null,{status:204});
    if(String(u).includes('/multipart/complete'))return new Response(null,{status:204});
    const response=await original(u,i);
    if(i?.method==='PUT')return new Response(null,{headers:{etag:'"part"'}});
    if(String(u).endsWith('/commit/main')){f.state.commits.push({id:COMMIT,title:mark});withSibling(f);}
    return response;
  }) as typeof fetch;
  return f;
}
test('protocol: exact revision and advertised transfers; empty verify succeeds',async()=>{
  const f=protocolFixture();await hfLfsCommit(inv,TOKEN,manifest(),f.opts);
  const batch=JSON.parse(f.calls.find(c=>c.url.endsWith('/objects/batch'))!.body!);
  assert.deepEqual(batch.ref,{name:'main'});assert.deepEqual(batch.transfers,['basic','multipart']);
});
test('protocol: duplicate content uploads once but commits both paths',async()=>{
  const f=protocolFixture(),m=manifest();m.files.push({...m.files[0]!,path:'copy.bin'});
  f.state.siblings.push({rfilename:'copy.bin',lfs:{sha256:OID,size:bytes.length}});
  await hfLfsCommit(inv,TOKEN,m,f.opts);assert.equal(f.calls.filter(c=>c.method==='PUT').length,1);
  assert.equal(f.state.commitBodies[0]!.trim().split('\n').length,3);
});
test('protocol: multipart streams numeric parts and sends ETag completion',async()=>{
  const f=protocolFixture(v=>{v.transfer='multipart';v.objects[0].actions.upload={href:'https://huggingface.co/o/r.git/info/lfs/multipart/complete',header:{chunk_size:'10','2':'https://lfs-bucket.example.test/part2','1':'https://lfs-bucket.example.test/part1'}};return v;});
  const fetch=f.opts.fetch!,completed:any[]=[];
  f.opts.fetch=(async(u:any,i:any)=>{if(String(u).endsWith('/multipart/complete'))completed.push({body:JSON.parse(i.body),headers:i.headers});return fetch(u,i);}) as typeof globalThis.fetch;
  await hfLfsCommit(inv,TOKEN,manifest(),f.opts);
  assert.deepEqual(f.calls.filter(c=>c.method==='PUT').map(c=>c.body),['STREAM:'+sha(bytes.slice(0,10)),'STREAM:'+sha(bytes.slice(10))]);
  assert.deepEqual(completed[0].body,{oid:OID,parts:[{partNumber:1,etag:'"part"'},{partNumber:2,etag:'"part"'}]});
  assert.equal(completed[0].headers.authorization,undefined);
});
test('protocol: malformed transfer and arbitrary HF verification route fail before commit',async()=>{
  for(const change of [ (v:any)=>{v.transfer='unknown';}, (v:any)=>{v.objects[0].actions.verify.href='https://huggingface.co/api/models/o/r/commit/main';}, (v:any)=>{v.objects[0].actions.upload.header={chunk_size:'0','1':'https://lfs-bucket.example.test/u'};} ]){
    const f=protocolFixture(v=>{change(v);return v;});await assert.rejects(hfLfsCommit(inv,TOKEN,manifest(),f.opts));assert.equal(f.state.commitBodies.length,0);
  }
});

test('preupload: mixed regular and LFS uses same commit and bounded sample',async()=>{
 const f=protocolFixture(),m=manifest();m.files.push({...m.files[0]!,path:'config.json'});
 const fetch=f.opts.fetch!;let payload:any;
 f.opts.open=async()=>new ReadableStream({start(c){for(let n=0;n<bytes.length;n+=2)c.enqueue(bytes.slice(n,n+2));c.close();}});
 f.opts.fetch=(async(u:any,i:any)=>{
   if(String(u).endsWith('/preupload/main')){payload=JSON.parse(i.body);return Response.json({files:payload.files.map((x:any)=>({path:x.path,uploadMode:x.path==='config.json'?'regular':'lfs',shouldIgnore:false,oid:null}))});}
   if(String(u).endsWith('/commit/main')&&typeof i.body!=='string'){i={...i,body:await new Response(i.body).text()};}
   if(String(u).includes(`/revision/${COMMIT}?`))return Response.json({private:true,sha:COMMIT,siblings:[{rfilename:'models/a.bin',lfs:{sha256:OID,size:bytes.length}},{rfilename:'config.json',size:bytes.length,blobId:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')}]});
   return fetch(u,i);
 }) as typeof globalThis.fetch;
 await hfLfsCommit(inv,TOKEN,m,f.opts);
 assert.deepEqual(payload.files.map((x:any)=>x.sample),[Buffer.from(bytes).toString('base64'),Buffer.from(bytes).toString('base64')]);
 const lines=f.state.commitBodies[0]!.trim().split('\n').map(x=>JSON.parse(x));
 assert.deepEqual(lines[2],{key:'file',value:{path:'config.json',encoding:'base64',content:Buffer.from(bytes).toString('base64')}});
});
test('preupload: ignored missing and unknown modes fail without transfers or commit',async()=>{
 for(const files of [[],[{path:'models/a.bin',uploadMode:'lfs',shouldIgnore:true}],[{path:'models/a.bin',uploadMode:'xet',shouldIgnore:false}]]){
  const f=protocolFixture(),fetch=f.opts.fetch!;
  f.opts.fetch=(async(u:any,i:any)=>String(u).endsWith('/preupload/main')?Response.json({files}):fetch(u,i)) as typeof globalThis.fetch;
  await assert.rejects(hfLfsCommit(inv,TOKEN,manifest(),f.opts));assert.equal(f.calls.filter(x=>x.method==='PUT').length,0);assert.equal(f.state.commitBodies.length,0);
 }
});

test('stream: changed bytes after preflight and sample never commit',async()=>{
 const f=protocolFixture();let opens=0;
 f.opts.open=async()=>new Blob([++opens<=2?bytes:new Uint8Array(bytes.length).fill(120)]).stream();
 await assert.rejects(hfLfsCommit(inv,TOKEN,manifest(),f.opts));assert.equal(f.state.commitBodies.length,0);
});
test('stream: cancelled held preflight open stops before provider effects',async()=>{
 const f=protocolFixture(),c=new AbortController();f.opts.signal=c.signal;
 f.opts.open=async()=>new Promise(()=>{});
 const result=hfLfsCommit(inv,TOKEN,manifest(),f.opts);c.abort();await assert.rejects(result);assert.equal(f.calls.length,0);
});
test('protocol: missing ETag rejects multipart completion and commit',async()=>{
 const f=protocolFixture(v=>{v.objects[0].actions.upload={href:'https://huggingface.co/o/r.git/info/lfs/multipart/complete',header:{chunk_size:String(bytes.length),'1':'https://lfs-bucket.example.test/part1'}};return v;});
 const fetch=f.opts.fetch!;f.opts.fetch=(async(u:any,i:any)=>{const r=await fetch(u,i);return i.method==='PUT'?new Response(null):r;}) as typeof globalThis.fetch;
 await assert.rejects(hfLfsCommit(inv,TOKEN,manifest(),f.opts));assert.equal(f.state.commitBodies.length,0);
});
test('protocol: storage completion and verify never receive credentials',async()=>{
 const f=protocolFixture(v=>{v.objects[0].actions={upload:{href:'https://lfs-bucket.example.test/multipart/complete',header:{chunk_size:String(bytes.length),'1':'https://lfs-bucket.example.test/part1',Authorization:'SECRET'}},verify:{href:'https://lfs-bucket.example.test/lfs/verify',header:{Authorization:'SECRET'}}};return v;});
 const fetch=f.opts.fetch!,seen:any[]=[];
 f.opts.fetch=(async(u:any,i:any)=>{if(String(u).includes('/multipart/complete')||String(u).endsWith('/lfs/verify')){seen.push(i.headers);return new Response(null,{status:204});}return fetch(u,i);}) as typeof globalThis.fetch;
 await hfLfsCommit(inv,TOKEN,manifest(),f.opts);assert.equal(seen.length,2);for(const h of seen){assert.equal(h.authorization,undefined);assert.ok(!JSON.stringify(h).includes(TOKEN));}
});
test('visibility: public opt-in verifies public info and proof',async()=>{
 const f=protocolFixture();f.opts.visibility='public';f.opts.allowPublicLarge=true;f.state.info.private=false;
 const fetch=f.opts.fetch!;f.opts.fetch=(async(u:any,i:any)=>{const r=await fetch(u,i);if(String(u).includes(`/revision/${COMMIT}?`)){const v=await r.json();v.private=false;return Response.json(v);}return r;}) as typeof globalThis.fetch;
 assert.deepEqual(await hfLfsCommit(inv,TOKEN,manifest(),f.opts),{commitOid:COMMIT});
});

test('proof: expired invocation permits bounded GET-only recovery',async()=>{
 const f=fixture();f.opts.now=()=>inv.expiresAt+100;f.state.commits.push({id:COMMIT,title:mark});withSibling(f);
 assert.deepEqual(await hfLfsProof(inv,TOKEN,manifest(),f.opts),{commitOid:COMMIT});
 assert.ok(f.calls.length>0&&f.calls.every(c=>c.method==='GET'));
 const g=fixture();g.opts.now=f.opts.now;await assert.rejects(hfLfsCommit(inv,TOKEN,manifest(),g.opts));assert.equal(g.calls.length,0);
});

test('stream: upload accepts exact content-length consumption without EOF read',async()=>{
 const f=protocolFixture(),fetch=f.opts.fetch!;
 f.opts.fetch=(async(u:any,i:any)=>{
  if(i.method==='PUT'){
   const reader=i.body.getReader();let read=0;
   while(read<Number(i.headers['content-length'])){const n=await reader.read();assert.equal(n.done,false);read+=n.value.length;}
   reader.releaseLock();return new Response(null,{status:200});
  }
  return fetch(u,i);
 }) as typeof globalThis.fetch;
 assert.deepEqual(await hfLfsCommit(inv,TOKEN,manifest(),f.opts),{commitOid:COMMIT});
});
test('stream: early upload response cannot proceed to commit',async()=>{
 const f=protocolFixture(),fetch=f.opts.fetch!;
 f.opts.fetch=(async(u:any,i:any)=>i.method==='PUT'?new Response(null):fetch(u,i)) as typeof globalThis.fetch;
 await assert.rejects(hfLfsCommit(inv,TOKEN,manifest(),f.opts));assert.equal(f.state.commitBodies.length,0);
});
test('stream: commit response without consuming body cannot prove success',async()=>{
 const f=protocolFixture(),fetch=f.opts.fetch!;
 f.opts.fetch=(async(u:any,i:any)=>String(u).endsWith('/commit/main')?Response.json({commitOid:COMMIT}):fetch(u,i)) as typeof globalThis.fetch;
 await assert.rejects(hfLfsCommit(inv,TOKEN,manifest(),f.opts));assert.equal(f.state.commits.length,0);
});

test('protocol: realistic signed HF completion preserves query without bearer',async()=>{
 const href='https://huggingface.co/api/complete_multipart?uploadId=id%2B1&bucket=lfs&prefix=abc&expiration=123&signature=signed';
 const f=protocolFixture(v=>{v.objects[0].actions.upload={href,header:{chunk_size:String(bytes.length),'1':'https://lfs-bucket.example.test/part1'}};return v;});
 const fetch=f.opts.fetch!;let completion:any;
 f.opts.fetch=(async(u:any,i:any)=>{if(String(u)===href){completion=i;return new Response(null,{status:204});}return fetch(u,i);}) as typeof globalThis.fetch;
 await hfLfsCommit(inv,TOKEN,manifest(),f.opts);assert.ok(completion);assert.equal(completion.headers.authorization,undefined);assert.equal(completion.headers.Authorization,undefined);
});
test('protocol: HF completion rejects arbitrary API routes and malformed signed URLs',async()=>{
 for(const href of ['https://huggingface.co/api/models/o/r/commit/main','https://huggingface.co/api/complete_multipart?signature=s#fragment','https://user@huggingface.co/api/complete_multipart?signature=s','https://huggingface.co:8443/api/complete_multipart?signature=s']){
  const f=protocolFixture(v=>{v.objects[0].actions.upload={href,header:{chunk_size:String(bytes.length),'1':'https://lfs-bucket.example.test/part1'}};return v;});
  await assert.rejects(hfLfsCommit(inv,TOKEN,manifest(),f.opts));assert.equal(f.state.commitBodies.length,0);assert.equal(f.calls.filter(c=>c.method==='PUT').length,0);
 }
});

test('preflight: encoded protected message and path fail before provider requests',async()=>{
 const encoded=Buffer.from(TOKEN).toString('base64');
 for(const field of ['message','path']){
  const f=fixture(),m=manifest();if(field==='message')f.opts.message=encoded;else m.files[0]!.path=encoded;
  await assert.rejects(hfLfsCommit(inv,TOKEN,m,f.opts));assert.equal(f.calls.length,0);
 }
});

test('visibility: repository flipped public after upload rejects before commit',async()=>{
 const f=protocolFixture(),fetch=f.opts.fetch!;
 f.opts.fetch=(async(u:any,i:any)=>{const response=await fetch(u,i);if(i.method==='PUT')f.state.info.private=false;return response;}) as typeof globalThis.fetch;
 await assert.rejects(hfLfsCommit(inv,TOKEN,manifest(),f.opts));
 assert.equal(f.calls.filter(c=>c.method==='PUT').length,1);
 assert.equal(f.calls.filter(c=>c.url.endsWith('/commit/main')).length,0);
});

test('preflight: repeated provider credential does not consume distinct protected-value budget',async()=>{
 const f=protocolFixture();
 f.opts.forbiddenValues=[...Array.from({length:255},(_,n)=>`protected-canary-${n.toString().padStart(4,'0')}`),TOKEN,TOKEN];
 assert.deepEqual(await hfLfsCommit(inv,TOKEN,manifest(),f.opts),{commitOid:COMMIT});
});

type FixedBridgeGlobal=typeof globalThis&{FixedLengthStream?:new(length:number)=>{readable:ReadableStream<Uint8Array>;writable:WritableStream<Uint8Array>}};
async function workerBridge(run:(native:WeakSet<object>,lengths:number[])=>Promise<void>,adjust=0){
 const g=globalThis as FixedBridgeGlobal,previous=Object.getOwnPropertyDescriptor(g,'FixedLengthStream');
 const native=new WeakSet<object>(),lengths:number[]=[];
 Object.defineProperty(g,'FixedLengthStream',{configurable:true,value:class{
  readable:ReadableStream<Uint8Array>;writable:WritableStream<Uint8Array>;
  constructor(length:number){
   lengths.push(length);let count=0;const expected=length+adjust;
   const stream=new TransformStream<Uint8Array,Uint8Array>({transform(chunk,c){count+=chunk.length;if(count>expected)throw new Error('fixed length overrun');c.enqueue(chunk);},flush(){if(count!==expected)throw new Error('fixed length underrun');}});
   this.readable=stream.readable;this.writable=stream.writable;native.add(this.readable);
  }
 }});
 try{await run(native,lengths);}finally{if(previous)Object.defineProperty(g,'FixedLengthStream',previous);else delete g.FixedLengthStream;}
}
test('Workers: PUT fetch receives native fixed-length body without buffering parts',async()=>{
 await workerBridge(async(native,lengths)=>{
  const f=protocolFixture(),fetch=f.opts.fetch!;
  f.opts.fetch=(async(u:any,i:any)=>{if(i.method==='PUT')assert.ok(native.has(i.body));return fetch(u,i);}) as typeof globalThis.fetch;
  await hfLfsCommit(inv,TOKEN,manifest(),f.opts);assert.deepEqual(lengths,[bytes.length]);
 });
});
test('Workers: fixed-length underrun and overrun prohibit commit',async()=>{
 for(const adjust of [-1,1])await workerBridge(async()=>{
  const f=protocolFixture();await assert.rejects(hfLfsCommit(inv,TOKEN,manifest(),f.opts));assert.equal(f.state.commitBodies.length,0);
 },adjust);
});
test('Workers: cancelling a held upload stops pipeline and source',async()=>{
 await workerBridge(async()=>{
  const f=protocolFixture(),fetch=f.opts.fetch!,c=new AbortController();let opens=0,cancelled=0;
  f.opts.signal=c.signal;f.opts.open=async()=>++opens<=2?new Blob([bytes]).stream():new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled++;}});
  f.opts.fetch=(async(u:any,i:any)=>{if(i.method==='PUT'){queueMicrotask(()=>c.abort());return new Promise(()=>{});}return fetch(u,i);}) as typeof globalThis.fetch;
  await assert.rejects(hfLfsCommit(inv,TOKEN,manifest(),f.opts));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(cancelled,1);assert.equal(f.state.commitBodies.length,0);
 });
});

test('proof: late opened iterator cleanup rejection stays handled after cancellation',async()=>{
 const f=fixture(),c=new AbortController();f.opts.signal=c.signal;
 f.state.commits.push({id:COMMIT,title:mark});
 f.state.siblings.push({rfilename:'models/a.bin',size:bytes.length,blobId:createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')});
 let deliver!:(source:AsyncIterable<Uint8Array>)=>void,opened!:()=>void,cleaned=false;
 const started=new Promise<void>(resolve=>{opened=resolve;});
 f.opts.open=()=>{opened();return new Promise(resolve=>{deliver=resolve;});};
 const run=hfLfsProof(inv,TOKEN,manifest(),f.opts);await started;c.abort();await assert.rejects(run);
 deliver({[Symbol.asyncIterator](){return {next:async()=>({done:true,value:undefined}),return:()=>{cleaned=true;return Promise.reject(new Error('late cleanup rejected'));}};}});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(cleaned,true);
});

test('Workers: synchronous fetch failure cancels pipeline without unhandled writer rejection',async()=>{
 await workerBridge(async()=>{
  const f=protocolFixture(),fetch=f.opts.fetch!;let opens=0,cancelled=0;
  f.opts.open=async()=>++opens<=2?new Blob([bytes]).stream():new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled++;}});
  f.opts.fetch=((u:any,i:any)=>{if(i.method==='PUT')throw new Error('fetch failed');return fetch(u,i);}) as typeof globalThis.fetch;
  await assert.rejects(hfLfsCommit(inv,TOKEN,manifest(),f.opts));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(cancelled,1);assert.equal(f.state.commitBodies.length,0);
 });
});

test('Workers: fetch rejecting redirect error mode accepts HF manual requests',async()=>{
 const f=protocolFixture(),fetch=f.opts.fetch!;
 f.opts.fetch=((u:any,i:any)=>{if(i.redirect==='error')throw new TypeError('Workers rejects redirect error');assert.equal(i.redirect,'manual');return fetch(u,i);}) as typeof globalThis.fetch;
 assert.deepEqual(await hfLfsCommit(inv,TOKEN,manifest(),f.opts),{commitOid:COMMIT});
});
test('redirect: manual 302 never follows or forwards authorization',async()=>{
 const f=fixture(),seen:{url:string;headers:any}[]=[];
 f.opts.fetch=(async(u:any,i:any)=>{assert.equal(i.redirect,'manual');seen.push({url:String(u),headers:i.headers});return new Response(null,{status:302,headers:{location:'https://evil.example.test/steal'}});}) as typeof globalThis.fetch;
 await assert.rejects(hfLfsCommit(inv,TOKEN,manifest(),f.opts));
 assert.equal(seen.length,1);assert.ok(seen[0]!.url.startsWith('https://huggingface.co/api/models/o/r/revision/'));assert.equal(f.state.commitBodies.length,0);
});

test('protocol: an upload host outside the list is refused by name, and the release publisher allows the S3 accelerate host',async()=>{
  const ACCEL='hf-hub-lfs-us-east-1.s3-accelerate.amazonaws.com';
  const withAccel=(v:any)=>{v.transfer='multipart';v.objects[0].actions.upload={href:'https://huggingface.co/o/r.git/info/lfs/multipart/complete',header:{chunk_size:'10','1':`https://${ACCEL}/part1`,'2':`https://${ACCEL}/part2`}};return v;};
  const refused=protocolFixture(withAccel);
  await assert.rejects(hfLfsCommit(inv,TOKEN,manifest(),refused.opts),new RegExp(`^Error: Hugging Face LFS unavailable: upload host not allowed: ${ACCEL.replaceAll('.','\\.')}$`));
  assert.equal(refused.calls.filter(c=>c.method==='PUT').length,0);
  assert.ok(HF_RELEASE_UPLOAD_HOSTS.includes(ACCEL));
  const allowed=protocolFixture(withAccel);
  await hfLfsCommit(inv,TOKEN,manifest(),{...allowed.opts,uploadHosts:HF_RELEASE_UPLOAD_HOSTS});
  assert.deepEqual(allowed.calls.filter(c=>c.method==='PUT').map(c=>new URL(c.url).hostname),[ACCEL,ACCEL]);
});

test('protocol: an HTTP refusal names the method, host, path and status but not the query',async()=>{
  const f=protocolFixture(v=>{v.objects[0].actions.upload.href='https://lfs-bucket.example.test/upload?X-Amz-Signature=secret-signature';return v;});
  const fetch=f.opts.fetch!;
  f.opts.fetch=(async(u:any,i:any)=>String(u).includes('X-Amz-Signature')?new Response('denied',{status:403}):fetch(u,i)) as typeof globalThis.fetch;
  await assert.rejects(hfLfsCommit(inv,TOKEN,manifest(),f.opts),(e:Error)=>/^Hugging Face LFS unavailable: PUT lfs-bucket\.example\.test\/upload returned HTTP 403$/.test(e.message)&&!e.message.includes('secret-signature'));
});
