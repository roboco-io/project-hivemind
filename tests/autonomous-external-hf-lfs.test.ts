import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {hfLfsCommit,hfLfsProof,lfsPointer,HF_LFS_MAX_FILE_BYTES,type HfLfsOptions,type HfLfsInvocation} from '../packages/adapters/src/autonomous-external-hf-lfs.ts';
import type {ExternalLargeManifest} from '../packages/contracts/src/autonomous-external-large.js';

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
    assert.equal(init.redirect,'error');
    let body:string|undefined;
    if(init.body&&typeof init.body==='object'&&'getReader' in init.body){const chunks:Buffer[]=[];for await(const c of init.body as unknown as AsyncIterable<Uint8Array>)chunks.push(Buffer.from(c));body='STREAM:'+sha(Buffer.concat(chunks));}
    else body=init.body as string|undefined;
    calls.push({url:u,method,headers,body});
    const json=(v:unknown)=>new Response(JSON.stringify(v),{status:200});
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
    assert.ok(!f.calls.some(c=>!c.url.startsWith('https://huggingface.co')&&JSON.stringify(c.headers).includes(TOKEN)));
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
