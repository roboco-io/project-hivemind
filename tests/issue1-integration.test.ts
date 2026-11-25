// Integration of the issue #1 follow-ups (P1 stop, P2 audit scope, P3 S3, P4 large HF commits) into the shared packages.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {AutonomousEngine} from '../packages/core/src/autonomous.js';
import {createAutonomousStore} from '../packages/core/src/autonomous-store.ts';
import {ExternalBroker,externalParametersHash} from '../packages/core/src/autonomous-external.js';
import {createExternalSqlStore,type ExternalSqlPort} from '../packages/core/src/autonomous-external-sql.ts';
import {largeOwnerKey,largeStorageRef,externalLargeManifestDigest} from '../packages/core/src/autonomous-external-large.ts';
import {createExternalProviderTransport,externalArtifactDigest,type ExternalArtifact,type ExternalProviderCredential} from '../packages/adapters/src/autonomous-external.js';
import {createExternalLargeRecordPort} from '../packages/adapters/src/autonomous-external-large-sql.ts';
import {createExternalLargeStore,type ExternalLargeBucket} from '../packages/adapters/src/autonomous-external-large-store.ts';
import {externalS3Mark} from '../packages/core/src/autonomous-external-s3.ts';
import type {ExternalInvocation,ExternalProfile} from '../packages/contracts/src/autonomous-external.js';
import type {ExternalLargeManifest} from '../packages/contracts/src/autonomous-external-large.js';
import {DatabaseSync} from 'node:sqlite';

const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const blobStream=(b:Uint8Array)=>new Blob([Uint8Array.from(b)]).stream();

// ---------- P1 / P2: central autonomous engine ----------
function runningEngine(){
  const engine=new AutonomousEngine();
  const spec={requestId:'r',goal:'g',provider:'mock' as const,model:'mock',endsAt:100000,maxRunMs:1000,maxIterations:10,budgetMicros:100,tools:[],systems:[],credentialIds:[]};
  const task=engine.create(spec,0,'task');engine.approve(task.id,task.revision,'ok',0);
  const lease=engine.claim('task','worker','tok','run-1',10)!;
  return {engine,lease};
}
test('stopExternalBudget stops a running task with the budget stop and is a no-op afterwards',()=>{
  const {engine,lease}=runningEngine();
  const humans=engine.get('task').counts?.humanInterventions;
  const first=engine.stopExternalBudget('task','External cost exceeded',20);
  assert.match(first.stopReason!,/^budget_exceeded: External cost exceeded$/);assert.equal(first.status,'stopping');
  assert.equal(first.counts?.humanInterventions,humans,'a system stop is not a human intervention');
  const second=engine.stopExternalBudget('task','Other reason',30);
  assert.equal(second.stopReason,first.stopReason);
  engine.finish(lease,{outcome:'failed',costMicros:0,usage:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0}} as never,40);
  const done=engine.get('task');assert.equal(done.status,'budget_exceeded');
  assert.equal(engine.stopExternalBudget('task','again',50).status,'budget_exceeded');
  assert.throws(()=>engine.stopExternalBudget('missing','x',1));
});
test('stopExternalBudget on a ready task ends it as budget_exceeded',()=>{
  const engine=new AutonomousEngine();
  const t=engine.create({requestId:'r',goal:'g',provider:'mock',model:'mock',endsAt:100000,maxRunMs:1000,maxIterations:10,budgetMicros:100,tools:[],systems:[],credentialIds:[]},0,'t2');
  engine.approve(t.id,t.revision,'ok',0);
  assert.equal(engine.stopExternalBudget('t2','cost',5).status,'budget_exceeded');
  assert.equal(engine.claim('t2','w','x','r',6),null);
});
test('toolAuditScope validates the lease like authorize and never mutates the task',()=>{
  const {engine,lease}=runningEngine();
  const before=JSON.stringify(engine.snapshot());
  assert.deepEqual(engine.toolAuditScope(lease,11),{taskId:'task',runId:'run-1',iteration:1});
  assert.equal(JSON.stringify(engine.snapshot()),before);
  assert.throws(()=>engine.toolAuditScope({...lease,token:'wrong'},11),/Stale lease/);
  assert.throws(()=>engine.toolAuditScope({...lease,runId:'run-2'},11),/Stale lease/);
  assert.throws(()=>engine.toolAuditScope(lease,lease.expiresAt),/Stale lease/);
  assert.throws(()=>engine.toolAuditScope({...lease,extra:1} as never,11));
  // A stopping task still accepts audit reports of the run that is winding down.
  engine.stopExternalBudget('task','cost',12);
  assert.equal(engine.toolAuditScope(lease,13).runId,'run-1');
});
test('the durable store exposes stopExternalBudget and toolAuditScope and recovers them',()=>{
  const store=createAutonomousStore(':memory:');
  const t=store.create({requestId:'r',goal:'g',provider:'mock',model:'mock',endsAt:100000,maxRunMs:1000,maxIterations:10,budgetMicros:100,tools:[],systems:[],credentialIds:[]},0,'t3');
  store.approve(t.id,t.revision,'ok',0);const lease=store.claim('t3','w','tok','run',5)!;
  assert.equal(store.toolAuditScope(lease,6).iteration,1);
  assert.equal(store.stopExternalBudget('t3','cost',7).status,'stopping');
  store.close();
});

// ---------- P3 / P4 through the broker ----------
const NOW=1_700_000_000_000;
const s3Target={accountId:'123456789012',region:'ap-northeast-2',bucket:'hivemind-runs',prefix:'runs/',maxObjectBytes:1024*1024,retentionDays:30};
const s3Profile:ExternalProfile={id:'s3p',enabled:true,provider:'s3',target:s3Target,operations:['aws.s3.put','aws.s3.inspect'],credentialRef:'aws-s3',maxLifetimeMs:60000,upperBoundMicros:500,maxActiveActions:1};
const artifact:ExternalArtifact={files:[{path:'m.json',contentBase64:Buffer.from('{"ok":true}').toString('base64')}]};
const digest=externalArtifactDigest(artifact);
function brokerHarness(profile:ExternalProfile,transport:Record<string,unknown>){
  const state:any={version:1,approvals:{},actions:{}};let time=NOW;
  const calls:{execute:ExternalInvocation[];inspect:ExternalInvocation[]}={execute:[],inspect:[]};
  const broker=new ExternalBroker<unknown>({store:{transaction:fn=>fn(state)},registry:{get:()=>structuredClone(profile)},resolver:{withCredential:async(_r,_s,fn)=>fn({})},
    transport:{execute:async(i:ExternalInvocation)=>{calls.execute.push(i);return (transport.execute as (i:ExternalInvocation)=>never)(i);},inspect:async(i:ExternalInvocation)=>{calls.inspect.push(i);return (transport.inspect as (i:ExternalInvocation)=>never)(i);},async cleanup(){throw new Error('no');},async confirmAbsent(){return false;}} as never,now:()=>time});
  broker.serverApprove({taskId:'t1',revision:1,profileId:profile.id,endsAt:NOW+600000,budgetMicros:5000});
  return {broker,state,calls,setTime:(n:number)=>{time=n;}};
}
const receipt=(i:ExternalInvocation,over:Record<string,unknown>={})=>({ownershipToken:i.ownershipToken,idempotencyKey:i.idempotencyKey,evidenceId:'s3:e',outcome:'succeeded',effect:'retained',billing:{verifiedCostMicros:null,final:false},...over});
const putRequest=(requestId='put-1')=>({taskId:'t1',revision:1,profileId:'s3p',requestId,operation:'aws.s3.put' as const,parameters:{keySuffix:'t1/m.json',artifactDigest:digest}});

test('S3 put through the broker keeps the reservation while verified cost is null and never creates a resource',async()=>{
  const h=brokerHarness(s3Profile,{execute:(i:ExternalInvocation)=>receipt(i),inspect:()=>null});
  const a=await h.broker.execute(putRequest());
  assert.equal(a.status,'succeeded');assert.equal(a.effect,'retained');assert.equal(a.resource,undefined);assert.equal(a.cleanupStatus,'none');
  assert.equal(a.verifiedCostMicros,null);assert.equal(a.billingFinal,false);assert.equal(a.reservedMicros,500);
  assert.equal(a.parametersHash,externalParametersHash(s3Profile,'aws.s3.put',{keySuffix:'t1/m.json',artifactDigest:digest}));
  assert.equal(h.broker.listPending().length,1,'an unsettled S3 put stays pending until the operator settles billing');
});
test('S3 put rejects bucket-like extras, bad suffixes, a foreign operation and a disabled profile',async()=>{
  const h=brokerHarness(s3Profile,{execute:(i:ExternalInvocation)=>receipt(i),inspect:()=>null});
  await assert.rejects(h.broker.execute({...putRequest('a'),parameters:{keySuffix:'x',artifactDigest:digest,bucket:'other'}} as never));
  await assert.rejects(h.broker.execute({...putRequest('b'),parameters:{keySuffix:'../x',artifactDigest:digest}}));
  await assert.rejects(h.broker.execute({...putRequest('c'),operation:'aws.spot.start',parameters:{lifetimeMs:5}} as never),/Unapproved/);
  assert.equal(h.calls.execute.length,0);
  assert.throws(()=>new ExternalBroker({store:{transaction:fn=>fn({version:1,approvals:{},actions:{}})},registry:{get:()=>({...s3Profile,target:{...s3Target,bucket:'my.bucket'}})},resolver:{} as never,transport:{} as never}).serverApprove({taskId:'t',revision:1,profileId:'s3p',endsAt:5,budgetMicros:1}));
});
test('S3 inspect can only address an owned put of the same approval and passes that put to the transport',async()=>{
  const h=brokerHarness(s3Profile,{execute:(i:ExternalInvocation)=>receipt(i,i.operation==='aws.s3.inspect'?{effect:'none'}:{}),inspect:()=>null});
  const inspect=(putActionId:string,requestId='ins-1')=>({taskId:'t1',revision:1,profileId:'s3p',requestId,operation:'aws.s3.inspect' as const,parameters:{putActionId}});
  await assert.rejects(h.broker.execute(inspect('missing')),/owned put/i);
  const put=await h.broker.execute(putRequest());
  const ins=await h.broker.execute(inspect(put.id));
  assert.equal(ins.status,'succeeded');assert.equal(ins.effect,'none');
  const seen=h.calls.execute[1]!;
  assert.deepEqual(seen.ownedPut,{actionId:put.id,ownershipToken:put.ownershipToken,idempotencyKey:put.idempotencyKey,parametersHash:put.parametersHash,parameters:{keySuffix:'t1/m.json',artifactDigest:digest}});
  assert.notEqual(seen.ownershipToken,put.ownershipToken);
  // Inspect of an inspect is not an owned put.
  await assert.rejects(h.broker.execute(inspect(ins.id,'ins-2')),/owned put/i);
});
test('inspect has its own concurrency class: a put in flight does not block inspect, a second put is refused',async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  const h=brokerHarness(s3Profile,{execute:async(i:ExternalInvocation)=>{if(i.operation==='aws.s3.put')await gate;return receipt(i,i.operation==='aws.s3.inspect'?{effect:'none'}:{});},inspect:()=>null});
  const put1=h.broker.execute(putRequest('p1'));
  const putId=Object.keys(h.state.actions)[0]!;assert.equal(h.state.actions[putId].status,'dispatching');
  await assert.rejects(h.broker.execute(putRequest('p2')),/Active action ceiling/);
  const ins=await h.broker.execute({taskId:'t1',revision:1,profileId:'s3p',requestId:'i1',operation:'aws.s3.inspect',parameters:{putActionId:putId}});
  assert.equal(ins.status,'succeeded');
  release();assert.equal((await put1).status,'succeeded');
});

// ---------- P4 profile and parameters ----------
const hfBase={id:'hfp',enabled:true,provider:'hf' as const,credentialRef:'hf',maxLifetimeMs:1000,upperBoundMicros:10,maxActiveActions:1};
test('an HF profile without visibility keeps its previous profileHash',()=>{
  const profile:any={...hfBase,id:'hf1',target:{repository:'o/r',revision:'main'},operations:['hf.model.commit'],credentialRef:'c'};
  const state:any={version:1,approvals:{},actions:{}};
  const b=new ExternalBroker<unknown>({store:{transaction:fn=>fn(state)},registry:{get:()=>profile},resolver:{} as never,transport:{} as never,now:()=>1000});
  // Value computed with the code before the visibility field existed.
  assert.equal(b.serverApprove({taskId:'t',revision:1,profileId:'hf1',endsAt:5000,budgetMicros:100}).profileHash,'7b706d7c08beb836eca8d7cf6c2ba39d58beefa8c83c0105e54a17c44327a743');
});
test('HF visibility binds acknowledgement into the profile and denies public LFS without it',()=>{
  const approve=(profile:unknown)=>new ExternalBroker<unknown>({store:{transaction:fn=>fn({version:1,approvals:{},actions:{}} as never)},registry:{get:()=>profile as ExternalProfile},resolver:{} as never,transport:{} as never,now:()=>1000}).serverApprove({taskId:'t',revision:1,profileId:(profile as {id:string}).id,endsAt:5000,budgetMicros:100});
  const t={repository:'o/r',revision:'main'};
  const pub=approve({...hfBase,target:{...t,visibility:'public'},operations:['hf.model.commit']});
  const priv=approve({...hfBase,target:{...t,visibility:'private'},operations:['hf.model.commit']});
  assert.notEqual(pub.profileHash,priv.profileHash);
  for(const bad of ['Public','PRIVATE','',true,null,1])assert.throws(()=>approve({...hfBase,target:{...t,visibility:bad},operations:['hf.model.commit']}),Error,String(bad));
  assert.throws(()=>approve({...hfBase,target:{...t,visibility:'public'},operations:['hf.model.commit','hf.model.lfs_commit']}),/acknowledgement/);
  const publicLarge=approve({...hfBase,target:{...t,visibility:'public',allowPublicLarge:true},operations:['hf.model.commit','hf.model.lfs_commit']});
  const privateLarge=approve({...hfBase,target:{...t,visibility:'private'},operations:['hf.model.commit','hf.model.lfs_commit']});
  assert.notEqual(publicLarge.profileHash,privateLarge.profileHash);
  assert.equal((publicLarge.profile.target as {allowPublicLarge?:boolean}).allowPublicLarge,true);
  assert.throws(()=>approve({...hfBase,target:{...t,visibility:'public',allowPublicLarge:true},operations:['hf.model.commit']}),/Invalid public large acknowledgement/);
  assert.doesNotThrow(()=>approve({...hfBase,target:t,operations:['hf.model.commit','hf.model.lfs_commit']}));
  assert.doesNotThrow(()=>approve({...hfBase,target:{...t,visibility:'private'},operations:['hf.model.lfs_commit']}));
});
test('hf.model.lfs_commit parameters are exactly {manifestDigest,message}',async()=>{
  const profile:ExternalProfile={...hfBase,target:{repository:'o/r',revision:'main'},operations:['hf.model.lfs_commit']};
  const h=brokerHarness({...profile,id:'hfp'},{execute:(i:ExternalInvocation)=>receipt(i,{evidenceId:'hf:'+'b'.repeat(40)}),inspect:()=>null});
  const base={taskId:'t1',revision:1,profileId:'hfp',operation:'hf.model.lfs_commit' as const};
  for(const [n,parameters] of [['a',{manifestDigest:'x',message:'m'}],['b',{manifestDigest:'a'.repeat(64)}],['c',{manifestDigest:'a'.repeat(64),message:'m',extra:1}],['d',{artifactDigest:'a'.repeat(64),message:'m'}]] as const)
    await assert.rejects(h.broker.execute({...base,requestId:n,parameters} as never),Error,n);
  const ok=await h.broker.execute({...base,requestId:'ok',parameters:{manifestDigest:'a'.repeat(64),message:'weights'}});
  assert.equal(ok.status,'succeeded');assert.equal(ok.effect,'retained');
});

// ---------- SQL: journal validators, manifest grants, large upload ledger ----------
function sqlPort():ExternalSqlPort{
  const db=new DatabaseSync(':memory:');
  return {exec(q,...b){const s=db.prepare(q);if(s.columns().length)return s.iterate(...b) as never;s.run(...b);return [];},transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
}
test('the SQL journal accepts the new operations and rejects malformed parameters',()=>{
  const store=createExternalSqlStore(sqlPort());
  const entry=(requestId:string,operation:string,parameters:unknown,system:string)=>{
    const request={taskId:'t1',revision:1,profileId:'p',requestId,operation,parameters};
    const stable=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a<b?-1:a>b?1:0)):x);
    return {taskId:'t1',revision:1,requestId,requestHash:sha(stable(request)),mainRequestId:'external:'+sha(stable(request)),phase:'intent' as const,request,reservation:{tool:'mcp__hivemind__action',system,operation,estimatedCostMicros:1}};
  };
  const good:[string,string,unknown][]=[['aws.s3.put','s3',{keySuffix:'a/b.json',artifactDigest:'a'.repeat(64)}],['aws.s3.inspect','s3',{putActionId:'put-1'}],['hf.model.lfs_commit','hf',{manifestDigest:'a'.repeat(64),message:'m'}]];
  good.forEach(([op,system,p],n)=>assert.doesNotThrow(()=>store.putJournal(entry('r'+n,op,p,system) as never),op));
  assert.equal(store.listJournal('t1').length,3);
  for(const [op,system,p] of [['aws.s3.put','s3',{keySuffix:'../x',artifactDigest:'a'.repeat(64)}],['aws.s3.put','s3',{keySuffix:'x',artifactDigest:'a'.repeat(64),bucket:'b'}],['aws.s3.inspect','s3',{putActionId:''}],['hf.model.lfs_commit','hf',{manifestDigest:'nope',message:'m'}],['aws.s3.put','aws',{keySuffix:'x',artifactDigest:'a'.repeat(64)}]] as [string,string,unknown][])
    assert.throws(()=>store.putJournal(entry('bad',op,p,system) as never),Error,op+JSON.stringify(p));
});
test('manifest grants follow the artifact grant pattern: reserve, bind, immutability and quota',()=>{
  const store=createExternalSqlStore(sqlPort());
  const grant=(n:number)=>({taskId:'t1',revision:1,profileId:'p',manifestDigest:sha('m'+n),profileHash:sha('p'),configurationFingerprint:sha('c'),files:1,bytes:10});
  assert.equal(store.getManifestGrant('t1',1,'p',grant(0).manifestDigest),undefined);
  store.reserveManifestGrant(grant(0));
  assert.equal(store.getManifestGrant('t1',1,'p',grant(0).manifestDigest)?.published,false);
  store.reserveManifestGrant(grant(0));// idempotent
  assert.throws(()=>store.reserveManifestGrant({...grant(0),bytes:11}),/conflict/);
  assert.throws(()=>store.bindManifestGrant(grant(1)),/conflict/);
  store.bindManifestGrant(grant(0));assert.equal(store.getManifestGrant('t1',1,'p',grant(0).manifestDigest)?.published,true);
  for(let n=1;n<8;n++)store.reserveManifestGrant(grant(n));
  assert.throws(()=>store.reserveManifestGrant(grant(8)),/quota/);
  store.reserveManifestGrant({...grant(9),revision:2});// another revision has its own quota
  store.blockTask('t1',2);assert.throws(()=>store.reserveManifestGrant({...grant(10),revision:2}),/stopped/);
});
function memoryBucket():ExternalLargeBucket{
  const objects=new Map<string,Buffer>(),uploads=new Map<string,Map<number,Uint8Array>>();
  return {
    async createMultipartUpload(key){const id='u-'+uploads.size;uploads.set(key+'|'+id,new Map());return {uploadId:id};},
    resumeMultipartUpload(key,id){const parts=uploads.get(key+'|'+id)!;return {async uploadPart(n,data){parts.set(n,Uint8Array.from(data));return {etag:'e'+n};},async complete(list){objects.set(key,Buffer.concat(list.map(p=>parts.get(p.partNumber)!)));},async abort(){uploads.delete(key+'|'+id);}};},
    async get(key){const o=objects.get(key);return o?{size:o.byteLength,body:blobStream(o)}:null;},
    async delete(key){objects.delete(key);},
  };
}
test('the SQL upload ledger implements the store port: copies, resume, cancel and immutable identity',async()=>{
  const port=createExternalLargeRecordPort(sqlPort());
  const store=createExternalLargeStore({bucket:memoryBucket(),records:port,limits:{maxFileBytes:1024,maxTotalBytes:4096,maxFiles:4},partBytes:4,now:()=>1000});
  const owner={taskId:'t1',revision:1,profileId:'hfp'},bytes=Buffer.from('0123456789');
  const begin=await store.begin(owner,{path:'w.bin',size:10,sha256:sha(bytes)},5000);
  assert.equal(begin.parts.length,0);
  await store.part(begin.uploadId,1,bytes.subarray(0,4));
  const again=await store.begin(owner,{path:'w.bin',size:10,sha256:sha(bytes)},5000);
  assert.equal(again.uploadId,begin.uploadId);assert.deepEqual(again.parts.map(p=>({partNumber:p.partNumber,sha256:p.sha256})),[{partNumber:1,sha256:sha(bytes.subarray(0,4))}]);
  const record=await port.get(begin.uploadId);record!.parts['9']={etag:'x',size:1,sha256:'z'};
  assert.equal((await port.get(begin.uploadId))!.parts['9'],undefined,'get returns a copy');
  await assert.rejects(port.put({...(await port.get(begin.uploadId))!,size:11}));
  await store.part(begin.uploadId,2,bytes.subarray(4,8));await store.part(begin.uploadId,3,bytes.subarray(8));
  const file=await store.complete(begin.uploadId);assert.equal(file.sha256,sha(bytes));
  assert.deepEqual((await port.listTask('t1',1)).map(r=>r.status),['complete']);assert.deepEqual(await port.listTask('t1',2),[]);
  assert.equal(await port.isCancelled('t1',1),false);
  assert.equal(await store.abortOwner('t1',1),1);
  assert.equal(await port.isCancelled('t1',1),true);
  await assert.rejects(store.begin(owner,{path:'x.bin',size:2,sha256:sha('ab')},5000));
});

// ---------- adapters: S3 delegation and HF LFS ----------
const awsCredential:ExternalProviderCredential={provider:'aws',accessKeyId:'AKIDEXAMPLE0SYNTHETIC',secretAccessKey:'synthetic-secret-key-for-tests-only'};
const loader={async load(d:string){assert.equal(d,digest);return structuredClone(artifact);}};
function putInvocation(over:Partial<ExternalInvocation>={}):ExternalInvocation{
  const parameters={keySuffix:'t1/m.json',artifactDigest:digest};
  return {actionId:'a1',taskId:'t1',revision:1,profile:s3Profile,operation:'aws.s3.put',parameters,parametersHash:externalParametersHash(s3Profile,'aws.s3.put',parameters),ownershipToken:'owner',idempotencyKey:'idem',expiresAt:NOW+60000,...over};
}
function s3Fetch(handler:(url:string,init:RequestInit)=>Response){const calls:string[]=[];return {calls,f:(async(url:string|URL|Request,init?:RequestInit)=>{calls.push(String(url));return handler(String(url),init!);}) as typeof fetch};}
const canonical=JSON.stringify(artifact),checksum=Buffer.from(digest,'hex').toString('base64');
test('the provider transport delegates S3 put and inspect, and rejects cleanup and confirmAbsent for s3',async()=>{
  const put=putInvocation(),mark=externalS3Mark(put);
  const fake=s3Fetch((_u,init)=>init.method==='PUT'?new Response(null,{status:200}):new Response(null,{status:200,headers:{'x-amz-meta-hivemind-mark':mark,'x-amz-checksum-sha256':checksum,'content-length':String(Buffer.byteLength(canonical))}}));
  const transport=createExternalProviderTransport({enabled:true,s3:{enabled:true,target:s3Target},artifacts:loader,fetch:fake.f,now:()=>NOW});
  const done=await transport.execute(put,awsCredential);
  assert.equal(done.outcome,'succeeded');assert.equal(done.effect,'retained');assert.deepEqual(done.billing,{verifiedCostMicros:null,final:false});assert.equal(done.resource,undefined);
  const parameters={putActionId:'a1'};
  const inspect:ExternalInvocation={...put,actionId:'a2',operation:'aws.s3.inspect',parameters,parametersHash:externalParametersHash(s3Profile,'aws.s3.inspect',parameters),ownershipToken:'o2',idempotencyKey:'i2',
    ownedPut:{actionId:'a1',ownershipToken:put.ownershipToken,idempotencyKey:put.idempotencyKey,parametersHash:put.parametersHash,parameters:put.parameters as never}};
  const seen=await transport.inspect(inspect,awsCredential) as {outcome:string;effect:string};
  assert.deepEqual([seen.outcome,seen.effect],['succeeded','none']);
  await assert.rejects(transport.cleanup(put,{id:'i-12345678',cleanupRequired:true},awsCredential));
  assert.equal(await transport.confirmAbsent(put,{id:'i-12345678',cleanupRequired:true},awsCredential),false);
  const before=fake.calls.length;
  // Disabled s3 option, missing option and a non-aws credential all fail closed with no request.
  for(const t of [createExternalProviderTransport({enabled:true,s3:{enabled:false,target:s3Target},artifacts:loader,fetch:fake.f,now:()=>NOW}),createExternalProviderTransport({enabled:true,artifacts:loader,fetch:fake.f,now:()=>NOW})])
    await assert.rejects(t.execute(put,awsCredential));
  await assert.rejects(transport.execute(put,{provider:'hf',token:'t'.repeat(12)}));
  assert.equal(fake.calls.length,before);
});

const HF_PARENT='a'.repeat(40),HF_COMMIT='b'.repeat(40),lfsBytes=Buffer.from('large-file-content'),configBytes=Buffer.from('{"model_type":"fixture"}');
function lfsManifest():ExternalLargeManifest{
  const owner=largeOwnerKey('t1',1,'hfp'),oid=sha(lfsBytes);
  return {version:1,taskId:'t1',revision:1,profileId:'hfp',files:[{path:'models/a.bin',size:lfsBytes.byteLength,sha256:oid,storageRef:largeStorageRef(owner,oid)},{path:'config.json',size:configBytes.length,sha256:sha(configBytes),storageRef:largeStorageRef(owner,sha(configBytes))}]};
}
function hfFake(visibility:boolean=true){
  const calls:{url:string;method:string;auth?:string}[]=[];
  const st={committed:false,uploadedHash:'',uploadedSize:0,regularHash:'',preuploads:0,commits:0};
  const mark=(i:ExternalInvocation)=>'hivemind:'+sha(JSON.stringify([i.ownershipToken,i.idempotencyKey,i.parametersHash]));let current:ExternalInvocation|undefined;
  const f=(async(url:string|URL|Request,init:RequestInit={})=>{
    const u=String(url),method=init.method??'GET',headers:Record<string,string>={};
    new Headers(init.headers).forEach((value,key)=>{headers[key]=value;});
    calls.push({url:u,method,auth:headers.authorization});
    assert.equal(init.redirect,'manual');
    const chunks:Buffer[]=[];
    if(init.body&&typeof init.body==='object'&&'getReader' in init.body){
      for await(const c of init.body as unknown as AsyncIterable<Uint8Array>)chunks.push(Buffer.from(c));
    }else if(typeof init.body==='string')chunks.push(Buffer.from(init.body));
    const body=Buffer.concat(chunks),json=(v:unknown)=>new Response(JSON.stringify(v),{status:200});
    if(u.startsWith('https://huggingface.co/'))assert.equal(headers.authorization,`Bearer ${hfToken.token}`);
    if(u.endsWith('/commits/main'))return json(st.committed?[{id:HF_COMMIT,title:mark(current!)}]:[]);
    if(u.includes('/revision/main?'))return json({private:visibility,sha:HF_PARENT});
    if(u.includes(`/revision/${HF_COMMIT}?`))return json({private:visibility,sha:HF_COMMIT,siblings:[
      {rfilename:'models/a.bin',lfs:{sha256:st.uploadedHash,size:st.uploadedSize}},
      {rfilename:'config.json',size:configBytes.length,blobId:createHash('sha1').update(`blob ${configBytes.length}\0`).update(configBytes).digest('hex')},
    ]});
    if(u.endsWith('/preupload/main')){
      assert.equal(method,'POST');
      assert.deepEqual(JSON.parse(body.toString()),{files:lfsManifest().files.map(file=>({path:file.path,size:file.size,sample:(file.path==='config.json'?configBytes:lfsBytes).subarray(0,512).toString('base64')}))});
      st.preuploads++;
      return json({files:lfsManifest().files.map(file=>({path:file.path,uploadMode:file.path==='config.json'?'regular':'lfs',shouldIgnore:false}))});
    }
    if(u.endsWith('.git/info/lfs/objects/batch')){
      assert.deepEqual(JSON.parse(body.toString()),{operation:'upload',transfers:['basic','multipart'],hash_algo:'sha256',ref:{name:'main'},objects:[{oid:sha(lfsBytes),size:lfsBytes.length}]});
      return json({transfer:'basic',objects:[{oid:sha(lfsBytes),size:lfsBytes.byteLength,actions:{upload:{href:'https://lfs-bucket.example.test/up?signature=fixture',header:{'x-signed-fixture':'upload'}},verify:{href:'https://huggingface.co/o/r.git/info/lfs/verify'}}}]});
    }
    if(u==='https://lfs-bucket.example.test/up?signature=fixture'){
      assert.equal(method,'PUT');assert.equal(headers.authorization,undefined);assert.equal(headers['x-signed-fixture'],'upload');
      assert.equal(headers['content-length'],String(lfsBytes.length));
      st.uploadedHash=sha(body);st.uploadedSize=body.length;
      assert.equal(st.uploadedHash,sha(lfsBytes));assert.equal(st.uploadedSize,lfsBytes.length);
      return new Response(null,{status:200});
    }
    if(u.endsWith('.git/info/lfs/verify')){
      assert.deepEqual(JSON.parse(body.toString()),{oid:st.uploadedHash,size:st.uploadedSize});return new Response(null,{status:200});
    }
    if(u.endsWith('/commit/main')){
      assert.equal(method,'POST');assert.equal(headers['content-type'],'application/x-ndjson');assert.equal(st.preuploads,1);
      assert.equal(st.uploadedHash,sha(lfsBytes));
      const lines=body.toString().trimEnd().split('\n').map(line=>JSON.parse(line));
      assert.deepEqual(lines,[{key:'header',value:{summary:mark(current!),description:'weights',parentCommit:HF_PARENT}},
        {key:'lfsFile',value:{path:'models/a.bin',algo:'sha256',oid:sha(lfsBytes),size:lfsBytes.length}},
        {key:'file',value:{path:'config.json',encoding:'base64',content:configBytes.toString('base64')}}]);
      const encoded=lines[2]?.value.content;assert.ok(typeof encoded==='string');
      st.regularHash=sha(Buffer.from(encoded,'base64'));
      assert.equal(st.regularHash,sha(configBytes));st.commits++;st.committed=true;return json({commitOid:HF_COMMIT});
    }
    assert.fail(`unexpected fixture request: ${method} ${u}`);
  }) as typeof fetch;
  return {f,calls,st,use:(i:ExternalInvocation)=>{current=i;}};
}
const hfToken:ExternalProviderCredential&{provider:'hf';token:string}={provider:'hf',token:'TEST_ONLY_HF_TOKEN_CANARY_0001'};
function lfsInvocation(manifest:ExternalLargeManifest,visibility?:'private'|'public',allowPublicLarge?:true):ExternalInvocation{
  const profile:ExternalProfile={...hfBase,id:'hfp',target:{repository:'o/r',revision:'main',...(visibility?{visibility}:{}),...(allowPublicLarge?{allowPublicLarge}:{})},operations:['hf.model.commit','hf.model.lfs_commit']} as ExternalProfile;
  const parameters={manifestDigest:externalLargeManifestDigest(manifest),message:'weights'};
  return {actionId:'h1',taskId:'t1',revision:1,profile,operation:'hf.model.lfs_commit',parameters,parametersHash:externalParametersHash(profile,'hf.model.lfs_commit',parameters),ownershipToken:'ho',idempotencyKey:'hi',expiresAt:NOW+60000};
}
function lfsTransport(fake:ReturnType<typeof hfFake>,over:{manifest?:ExternalLargeManifest;visibility?:'private'|'public';forbiddenValues?:readonly string[]}={}){
  const loads:string[]=[];
  const transport=createExternalProviderTransport({enabled:true,forbiddenValues:over.forbiddenValues??['-----BEGIN PRIVATE KEY-----\n'+'A'.repeat(4096)+'\n-----END PRIVATE KEY-----'],hf:{enabled:true,repository:'o/r',revision:'main',...(over.visibility?{visibility:over.visibility}:{}),
    lfs:{uploadHosts:['lfs-bucket.example.test'],limits:{maxFileBytes:1024,maxTotalBytes:4096,maxFiles:4},loadManifest:async d=>{loads.push(d);return structuredClone(over.manifest??lfsManifest());},open:async file=>blobStream(file.path==='config.json'?configBytes:lfsBytes)}},
    artifacts:loader,fetch:fake.f,now:()=>NOW});
  return {transport,loads};
}
test('hf.model.lfs_commit runs through the provider transport with a manifest bound to the approved digest',async()=>{
  const fake=hfFake(),{transport,loads}=lfsTransport(fake),inv=lfsInvocation(lfsManifest());fake.use(inv);
  const r=await transport.execute(inv,hfToken);
  assert.deepEqual([r.outcome,r.effect,r.evidenceId],['succeeded','retained','hf:'+HF_COMMIT]);assert.deepEqual(loads,[(inv.parameters as {manifestDigest:string}).manifestDigest]);
  assert.deepEqual(r.billing,{verifiedCostMicros:null,final:false});
  assert.deepEqual(fake.st,{committed:true,uploadedHash:sha(lfsBytes),uploadedSize:lfsBytes.length,regularHash:sha(configBytes),preuploads:1,commits:1});
  assert.ok(fake.calls.filter(c=>new URL(c.url).origin==='https://lfs-bucket.example.test').every(c=>c.auth===undefined),'the token never reaches the upload host');
  const again=await transport.inspect(inv,hfToken) as {evidenceId:string};assert.equal(again.evidenceId,'hf:'+HF_COMMIT);
});
test('hf.model.lfs_commit refuses a manifest whose digest, owner or shape differs, before any request',async()=>{
  const fake=hfFake(),good=lfsManifest(),inv=lfsInvocation(good);fake.use(inv);
  const tampered={...good,files:[{...good.files[0]!,size:good.files[0]!.size+1}]};
  const otherProfile={...good,profileId:'other-profile'};
  const other={...good,taskId:'t2'};// digest differs and owner key no longer matches
  for(const manifest of [tampered,other,otherProfile,{...good,extra:1} as never]){
    const {transport}=lfsTransport(fake,{manifest});
    await assert.rejects(transport.execute(inv,hfToken));assert.equal(await transport.inspect(inv,hfToken),null);
  }
  assert.equal(fake.calls.length,0);
});
test('hf visibility defaults to private and rejects repository or server option mismatches',async()=>{
  const fake=hfFake(true),inv=lfsInvocation(lfsManifest());fake.use(inv);
  // The server option says public and the profile says nothing (private): mismatch.
  await assert.rejects(lfsTransport(fake,{visibility:'public'}).transport.execute(inv,hfToken));
  // The repository reports public although the profile is private: assertHfVisibility refuses before any write.
  const publicRepo=hfFake(false);publicRepo.use(inv);
  await assert.rejects(lfsTransport(publicRepo).transport.execute(inv,hfToken));
  assert.equal(publicRepo.calls.filter(c=>c.method!=='GET').length,0);
  assert.equal(fake.calls.length,0);
});
test('acknowledged public LFS uses the approved public profile and matching repository scope',async()=>{
  const fake=hfFake(false),inv=lfsInvocation(lfsManifest(),'public',true);fake.use(inv);
  const {transport}=lfsTransport(fake,{visibility:'public'});
  const result=await transport.execute(inv,hfToken);
  assert.equal(result.outcome,'succeeded');assert.deepEqual(result.billing,{verifiedCostMicros:null,final:false});
  assert.equal(fake.st.commits,1);
  const privateRepo=hfFake(true);privateRepo.use(inv);
  await assert.rejects(lfsTransport(privateRepo,{visibility:'public'}).transport.execute(inv,hfToken));
  assert.equal(privateRepo.calls.filter(c=>c.method!=='GET').length,0);
});
test('LFS secret preflight rejects matching manifest bytes before any provider request',async()=>{
  const fake=hfFake(),inv=lfsInvocation(lfsManifest());fake.use(inv);
  const {transport,loads}=lfsTransport(fake,{forbiddenValues:[lfsBytes.toString()]});
  await assert.rejects(transport.execute(inv,hfToken));
  assert.deepEqual(loads,[(inv.parameters as {manifestDigest:string}).manifestDigest]);
  assert.equal(fake.calls.length,0);assert.equal(fake.st.commits,0);
});
test('the SQL upload ledger bounds listTask and the store caps begin and abort cycles on it',async()=>{
  const port=createExternalLargeRecordPort(sqlPort());
  const store=createExternalLargeStore({bucket:memoryBucket(),records:port,limits:{maxFileBytes:1024,maxTotalBytes:4096,maxFiles:4},partBytes:4,now:()=>1000});
  const owner={taskId:'cap',revision:1,profileId:'hfp'};
  for(let i=0;i<64;i++){const b=Buffer.from('v'+i);const begun=await store.begin(owner,{path:'c'+i+'.bin',size:b.length,sha256:sha(b)},5000);await store.abort(begun.uploadId);}
  assert.equal((await port.listTask('cap',1)).length,64);
  await assert.rejects(store.begin(owner,{path:'over.bin',size:1,sha256:sha(Buffer.from('o'))},5000),(e:{statusCode?:number})=>e.statusCode===413);
  const template=(await port.listTask('cap',1))[0]!;
  for(let i=0;i<300;i++)await port.put({...template,uploadId:'extra-'+i,ownerKey:template.ownerKey});
  assert.equal((await port.listTask('cap',1)).length,256,'listTask never returns more than the ledger ceiling');
});
