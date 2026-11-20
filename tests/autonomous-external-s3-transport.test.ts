import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {createExternalS3Transport,signExternalS3Request} from '../packages/adapters/src/autonomous-external-s3.ts';
import {createExternalR2ArtifactLoader,externalArtifactDigest,type ExternalArtifact,type ExternalProviderCredential} from '../packages/adapters/src/autonomous-external.ts';
import {externalS3Mark} from '../packages/core/src/autonomous-external-s3.ts';
import type {ExternalS3Target} from '../packages/contracts/src/autonomous-external-s3.js';
import type {ExternalInvocation} from '../packages/contracts/src/autonomous-external.js';
type ExternalS3Invocation=ExternalInvocation;

const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const credential:ExternalProviderCredential={provider:'aws',accessKeyId:'AKIDEXAMPLE0SYNTHETIC',secretAccessKey:'synthetic-secret-key-for-tests-only'};
const target:ExternalS3Target={accountId:'123456789012',region:'ap-northeast-2',bucket:'hivemind-runs',prefix:'runs/',maxObjectBytes:1024*1024,retentionDays:30};
const artifact:ExternalArtifact={files:[{path:'m.json',contentBase64:Buffer.from('{"ok":true}').toString('base64')}]};
const digest=externalArtifactDigest(artifact),canonical=JSON.stringify(artifact),checksum=Buffer.from(digest,'hex').toString('base64');
const NOW=1_700_000_000_000;
function invocation(over:Partial<ExternalS3Invocation>={},t:ExternalS3Target=target):ExternalS3Invocation{
  const parameters={keySuffix:'t1/m.json',artifactDigest:digest},operation='aws.s3.put' as const;
  return {actionId:'a1',taskId:'t1',revision:1,
    profile:{id:'p',enabled:true,provider:'s3',credentialRef:'ref',maxLifetimeMs:60000,upperBoundMicros:1000,maxActiveActions:1,target:t,operations:['aws.s3.put','aws.s3.inspect']},
    operation,parameters,parametersHash:sha(JSON.stringify({operation,parameters:{artifactDigest:digest,keySuffix:'t1/m.json'}})),ownershipToken:'owner',idempotencyKey:'idem',expiresAt:NOW+60000,...over};
}
const mark=externalS3Mark(invocation());
type Handler=(url:string,init:RequestInit)=>Response|Promise<Response>;
function fakeFetch(handler:Handler){const calls:{url:string;init:RequestInit}[]=[];const f=(async(url:string|URL|Request,init?:RequestInit)=>{calls.push({url:String(url),init:init!});return handler(String(url),init!);}) as typeof fetch;return {f,calls};}
const headResponse=(over:Record<string,string>={})=>new Response(null,{status:200,headers:{'x-amz-meta-hivemind-mark':mark,'x-amz-checksum-sha256':checksum,'content-length':String(Buffer.byteLength(canonical)),...over}});
// Swappable producer: fake by default, the real R2 artifact loader when SUPERLITE_REAL=1.
async function loadFiles():Promise<ExternalArtifact["files"]>{
  if(process.env.SUPERLITE_REAL!=='1')return structuredClone(artifact.files);
  const bytes=Buffer.from(canonical);
  return (await createExternalR2ArtifactLoader({get:async()=>({size:bytes.length,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length) as ArrayBuffer})}).load(digest)).files;
}
function make(handler:Handler,over:{target?:ExternalS3Target;files?:ExternalArtifact['files'];now?:number}={}){
  const f=fakeFetch(handler);
  return {...f,transport:createExternalS3Transport({enabled:true,target:over.target??target,loadFiles:async()=>over.files??await loadFiles(),fetch:f.f,now:()=>over.now??NOW})};
}
const header=(init:RequestInit,name:string)=>(init.headers as Record<string,string>)[name];

test('digest check: S3 body is the canonical artifact JSON and checksum is base64 of the digest bytes',()=>{
  assert.equal(sha(canonical),digest);
  assert.equal(checksum,createHash('sha256').update(canonical).digest('base64'));
});
test('PUT sends conditional, checksummed, owner-bound headers and returns retained receipt',async()=>{
  const {transport,calls}=make(()=>new Response(null,{status:200,headers:{'x-amz-checksum-sha256':checksum}}));
  const r=await transport.execute(invocation(),credential);
  assert.equal(r.outcome,'succeeded');assert.equal(r.effect,'retained');assert.deepEqual(r.billing,{verifiedCostMicros:null,final:false});assert.equal(r.resource,undefined);
  const [call]=calls;assert.equal(calls.length,1);
  assert.equal(call!.url,'https://hivemind-runs.s3.ap-northeast-2.amazonaws.com/runs/t1/m.json');
  assert.equal(call!.init.method,'PUT');assert.equal(call!.init.redirect,'error');
  assert.equal(header(call!.init,'if-none-match'),'*');assert.equal(header(call!.init,'x-amz-checksum-sha256'),checksum);
  assert.equal(header(call!.init,'x-amz-expected-bucket-owner'),'123456789012');assert.equal(header(call!.init,'x-amz-meta-hivemind-mark'),mark);
  assert.equal(header(call!.init,'x-amz-server-side-encryption'),undefined);
  assert.equal(Buffer.from(call!.init.body as Uint8Array).toString(),canonical);
  assert.ok(!JSON.stringify(r).includes(credential.secretAccessKey));
});
test('PUT sends SSE-KMS headers when kmsKeyId is configured',async()=>{
  const t={...target,kmsKeyId:'alias/hivemind'};
  const {transport,calls}=make(()=>new Response(null,{status:200}),{target:t});
  await transport.execute(invocation({},t),credential);
  assert.equal(header(calls[0]!.init,'x-amz-server-side-encryption'),'aws:kms');assert.equal(header(calls[0]!.init,'x-amz-server-side-encryption-aws-kms-key-id'),'alias/hivemind');
});
test('PUT 412 with another mark fails with no effect; same mark and checksum succeeds',async()=>{
  const other=make((_u,init)=>init.method==='PUT'?new Response(null,{status:412}):headResponse({'x-amz-meta-hivemind-mark':'f'.repeat(64)}));
  const a=await other.transport.execute(invocation(),credential);assert.equal(a.outcome,'failed');assert.equal(a.effect,'none');
  const same=make((_u,init)=>init.method==='PUT'?new Response(null,{status:412}):headResponse());
  const b=await same.transport.execute(invocation(),credential);assert.equal(b.outcome,'succeeded');assert.equal(b.effect,'retained');
  assert.equal(header(same.calls[1]!.init,'x-amz-checksum-mode'),'ENABLED');
  const diff=make((_u,init)=>init.method==='PUT'?new Response(null,{status:412}):headResponse({'x-amz-checksum-sha256':'AAAA'}));
  assert.equal((await diff.transport.execute(invocation(),credential)).outcome,'unknown');
});
test('PUT 5xx and thrown fetch reject; no redirect following',async()=>{
  await assert.rejects(make(()=>new Response(null,{status:500})).transport.execute(invocation(),credential));
  await assert.rejects(make(()=>{throw new Error('net');}).transport.execute(invocation(),credential));
  const redirected=Object.defineProperty(new Response(null,{status:200}),'redirected',{value:true});
  await assert.rejects(make(()=>redirected).transport.execute(invocation(),credential));
});
test('digest mismatch is rejected before any fetch',async()=>{
  const files=[{path:'m.json',contentBase64:Buffer.from('other').toString('base64')}];
  const {transport,calls}=make(()=>new Response(null,{status:200}),{files});
  await assert.rejects(transport.execute(invocation(),credential));assert.equal(calls.length,0);
});
test('expired authority and bad parameters make no fetch',async()=>{
  const m=make(()=>new Response(null,{status:200}),{now:NOW+60000});
  await assert.rejects(m.transport.execute(invocation(),credential));
  const ok=make(()=>new Response(null,{status:200}));
  await assert.rejects(ok.transport.execute(invocation({parameters:{keySuffix:'../x',artifactDigest:digest}}),credential));
  await assert.rejects(ok.transport.execute(invocation({parameters:{keySuffix:'a/../b',artifactDigest:digest}}),credential));
  await assert.rejects(ok.transport.execute(invocation({parameters:{keySuffix:'t1/m.json',artifactDigest:digest,bucket:'x'} as never}),credential));
  await assert.rejects(ok.transport.execute(invocation({parametersHash:'b'.repeat(64)}),credential));
  await assert.rejects(ok.transport.execute(invocation({operation:'aws.s3.inspect'}),credential));
  await assert.rejects(ok.transport.execute(invocation({},{...target,bucket:'other-bucket'}),credential));
  await assert.rejects(ok.transport.execute(invocation(),{provider:'hf',token:'x'.repeat(10)}));
  assert.equal(ok.calls.length+m.calls.length,0);
});
test('disabled transport and oversized object make no PUT',async()=>{
  const f=fakeFetch(()=>new Response(null,{status:200}));
  const off=createExternalS3Transport({enabled:false,target,loadFiles:async()=>artifact.files,fetch:f.f,now:()=>NOW});
  await assert.rejects(off.execute(invocation(),credential));
  const small={...target,maxObjectBytes:1024};
  const big=[{path:'b.bin',contentBase64:Buffer.alloc(1025,7).toString('base64')}];
  const bigDigest=externalArtifactDigest({files:big});
  const parameters={keySuffix:'big',artifactDigest:bigDigest};
  const inv=invocation({parameters,parametersHash:sha(JSON.stringify({operation:'aws.s3.put',parameters:{artifactDigest:bigDigest,keySuffix:'big'}}))},small);
  const m=make(()=>new Response(null,{status:200}),{target:small,files:big});
  await assert.rejects(m.transport.execute(inv,credential));assert.equal(f.calls.length+m.calls.length,0);
});
test('inspect after a thrown PUT: HEAD 200 match succeeds, 404 and network errors are unresolved',async()=>{
  const ok=await make(()=>headResponse()).transport.inspect(invocation(),credential);
  assert.equal(ok?.outcome,'succeeded');assert.equal(ok?.effect,'retained');
  assert.equal(await make(()=>new Response(null,{status:404})).transport.inspect(invocation(),credential),null);
  assert.equal(await make(()=>{throw new Error('net');}).transport.inspect(invocation(),credential),null);
  assert.equal(await make(()=>new Response(null,{status:403})).transport.inspect(invocation(),credential),null);
  const other=await make(()=>headResponse({'x-amz-meta-hivemind-mark':'0'.repeat(64)})).transport.inspect(invocation(),credential);
  assert.equal(other?.outcome,'failed');assert.equal(other?.effect,'none');
  const wrongSize=await make(()=>headResponse({'content-length':'1'})).transport.inspect(invocation(),credential);assert.equal(wrongSize?.outcome,'unknown');
});
function inspectOf(over:Partial<ExternalS3Invocation>={}):ExternalS3Invocation{
  const put=invocation(),parameters={putActionId:'put1'};
  return invocation({operation:'aws.s3.inspect',parameters,parametersHash:sha(JSON.stringify({operation:'aws.s3.inspect',parameters})),ownershipToken:'inspect-owner',idempotencyKey:'inspect-idem',
    ownedPut:{actionId:'put1',ownershipToken:put.ownershipToken,idempotencyKey:put.idempotencyKey,parametersHash:put.parametersHash,parameters:put.parameters as {keySuffix:string;artifactDigest:string}},...over});
}
test('inspect checks the owning put mark, works after expiry and leaves no retained effect',async()=>{
  const inv=inspectOf();
  const r=await make(()=>headResponse(),{now:NOW+10*60000}).transport.inspect(inv,credential);
  assert.equal(r?.outcome,'succeeded');assert.equal(r?.effect,'none');assert.equal(r?.ownershipToken,'inspect-owner');
  const bad=await make(()=>headResponse({'x-amz-checksum-sha256':'AAAA'})).transport.inspect(inv,credential);
  assert.equal(bad?.outcome,'failed');assert.equal(bad?.effect,'none');
});
test('inspect cannot adopt a foreign object: a different mark never succeeds, even with matching content',async()=>{
  const foreign=await make(()=>headResponse({'x-amz-meta-hivemind-mark':'9'.repeat(64)})).transport.inspect(inspectOf(),credential);
  assert.equal(foreign?.outcome,'failed');assert.equal(foreign?.effect,'none');
  const own=make(()=>headResponse());
  assert.equal((await own.transport.inspect(inspectOf(),credential))?.outcome,'succeeded');
  assert.equal(own.calls[0]!.url,'https://hivemind-runs.s3.ap-northeast-2.amazonaws.com/runs/t1/m.json');
});
test('inspect without an owned put, or with another put id, is rejected before any request',async()=>{
  const m=make(()=>headResponse());
  await assert.rejects(m.transport.inspect(inspectOf({ownedPut:undefined}),credential));
  await assert.rejects(m.transport.inspect(inspectOf({parameters:{putActionId:'other'},parametersHash:sha(JSON.stringify({operation:'aws.s3.inspect',parameters:{putActionId:'other'}}))}),credential));
  assert.equal(m.calls.length,0);
});
test('inspect requires the configured KMS key',async()=>{
  const t={...target,kmsKeyId:'11111111-2222-3333-4444-555555555555'};
  const arn='arn:aws:kms:ap-northeast-2:123456789012:key/'+t.kmsKeyId;
  const good=await make(()=>headResponse({'x-amz-server-side-encryption':'aws:kms','x-amz-server-side-encryption-aws-kms-key-id':arn}),{target:t}).transport.inspect(invocation({},t),credential);
  assert.equal(good?.outcome,'succeeded');
  const bad=await make(()=>headResponse(),{target:t}).transport.inspect(invocation({},t),credential);assert.equal(bad?.outcome,'unknown');
});
test('signer matches an independent SigV4 computation and rejects unsafe input',()=>{
  const payload=sha(''),s=signExternalS3Request({method:'HEAD',target:{region:'ap-northeast-2',bucket:'hivemind-runs'},key:'runs/a b.json'.replace(' ','_'),headers:{'X-Amz-Checksum-Mode':'ENABLED'},payloadSha256:payload,credential:{...credential,sessionToken:'synthetic-session-token'},now:NOW});
  assert.equal(s.url,'https://hivemind-runs.s3.ap-northeast-2.amazonaws.com/runs/a_b.json');assert.equal(s.headers.host,undefined);
  const date='20231114T221320Z',day='20231114',hm=(k:string|Buffer,v:string)=>createHmac('sha256',k).update(v).digest();
  const hs:Record<string,string>={host:'hivemind-runs.s3.ap-northeast-2.amazonaws.com','x-amz-checksum-mode':'ENABLED','x-amz-content-sha256':payload,'x-amz-date':date,'x-amz-security-token':'synthetic-session-token'};
  const names=Object.keys(hs).sort(),creq=`HEAD\n/runs/a_b.json\n\n${names.map(k=>`${k}:${hs[k]}\n`).join('')}\n${names.join(';')}\n${payload}`;
  const scope=`${day}/ap-northeast-2/s3/aws4_request`,k=hm(hm(hm(hm('AWS4'+credential.secretAccessKey,day),'ap-northeast-2'),'s3'),'aws4_request');
  const sig=hm(k,`AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha(creq)}`).toString('hex');
  assert.equal(s.headers.authorization,`AWS4-HMAC-SHA256 Credential=${credential.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}`);
  const base={method:'PUT' as const,target:{region:'ap-northeast-2',bucket:'b-ucket'},key:'k',headers:{},payloadSha256:payload,credential,now:NOW};
  assert.throws(()=>signExternalS3Request({...base,target:{region:'ap-northeast-2',bucket:'a.b'}}));
  assert.throws(()=>signExternalS3Request({...base,headers:{host:'evil.example'}}));
  assert.throws(()=>signExternalS3Request({...base,key:'../k'}));
});
