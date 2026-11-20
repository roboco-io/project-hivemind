import test from 'node:test';
import assert from 'node:assert/strict';
import * as artifacts from '../packages/adapters/src/autonomous-external.ts';
import {createExternalStore} from '../packages/core/src/autonomous-external-store.ts';
import {createAutonomousExternalService,handleAutonomousExternalApi} from '../apps/control-plane/src/autonomous-external-api.ts';

test('publication has a shared canonical validator and immutable publisher',()=>{
 assert.equal(typeof (artifacts as any).validateExternalArtifact,'function');
 assert.equal(typeof (artifacts as any).createExternalR2ArtifactPublisher,'function');
});
test('durable artifact grants reject binding collisions',()=>{
 const store=createExternalStore(':memory:') as any;
 try{assert.equal(typeof store.bindArtifactGrant,'function');const grant={taskId:'task',revision:1,profileId:'hf',artifactDigest:'a'.repeat(64),profileHash:'b'.repeat(64),configurationFingerprint:'c'.repeat(64),bytes:0};store.reserveArtifactGrant(grant);store.bindArtifactGrant(grant);store.bindArtifactGrant(grant);assert.deepEqual(store.getArtifactGrant('task',1,'hf',grant.artifactDigest),{...grant,published:true});assert.throws(()=>store.bindArtifactGrant({...grant,profileHash:'d'.repeat(64)}));}finally{store.close();}
});

test('service exposes worker artifact publication',()=>{
 const service=createAutonomousExternalService({core:{} as any,broker:{} as any,registry:{} as any,store:{} as any});
 assert.equal(typeof (service as any).publishArtifact,'function');
});
test('artifact route authenticates worker before reading its body',async()=>{
 const service={} as any;
 const response=await handleAutonomousExternalApi(new Request('http://local/v1/autonomous-tasks/task/external-artifact',{method:'POST',headers:{authorization:'Bearer operator'},body:'invalid'}),{operatorToken:'operator',workerToken:'worker',service});
 assert.equal(response.status,401);
});

function bucketFixture(){
 const objects=new Map<string,Buffer>();let puts=0;
 return {objects,get puts(){return puts;},async get(key:string){const b=objects.get(key);return b?{size:b.length,async arrayBuffer(){return new Uint8Array(b).buffer;}}:null;},async put(key:string,value:string,condition:{onlyIf:{etagDoesNotMatch:string}}){assert.deepEqual(condition,{onlyIf:{etagDoesNotMatch:'*'}});puts++;if(objects.has(key))return null;objects.set(key,Buffer.from(value));return {etag:'fixture'};}};
}
const artifact=(content='model data',path='model.bin')=>({files:[{path,contentBase64:Buffer.from(content).toString('base64')}]});
test('canonical validation accepts empty files and rejects bounds, unsafe paths and encoded secrets',()=>{
 assert.deepEqual(artifacts.validateExternalArtifact(artifact('')),artifact(''));
 const invalid:unknown[]=[{files:[]},artifact('','../model'),artifact('','credentials.json'),artifact('','nested/auth.json'),artifact('','id_rsa'),{files:[...artifact().files,...artifact().files]},artifact('x'.repeat(256*1024+1)),{files:Array.from({length:33},(_,i)=>artifact('',`f${i}`).files[0])},{files:Array.from({length:5},(_,i)=>artifact('x'.repeat(256*1024),`f${i}`).files[0])},{files:[{path:'file',contentBase64:'YR=='}]},artifact('hf_abcdefghijklmno'),artifact('Bearer hidden'),artifact(Buffer.from(Buffer.from('server-control-secret').toString('base64')).toString('base64')),artifact('server-control-secret')];
 for(const input of invalid)assert.throws(()=>artifacts.validateExternalArtifact(input,['server-control-secret']));
});
test('immutable publisher returns loader-compatible digest and fails closed on key collision',async()=>{
 const bucket=bucketFixture(),publisher=artifacts.createExternalR2ArtifactPublisher(bucket);let validations=0;
 const options={knownSecretValues:[],async beforeWrite(){validations++;}};
 const result=await publisher.publish(artifact(''),options);assert.equal(result.artifactDigest,artifacts.externalArtifactDigest(artifact('')));assert.deepEqual(await artifacts.createExternalR2ArtifactLoader(bucket).load(result.artifactDigest),artifact(''));
 assert.deepEqual(await publisher.publish(artifact(''),options),result);assert.equal(validations,2);assert.equal(bucket.objects.size,1);
 bucket.objects.set('external-artifacts/'+result.artifactDigest,Buffer.from('conflict'));await assert.rejects(publisher.publish(artifact(''),options));
 const before=bucket.puts;await assert.rejects(publisher.publish(artifact('private-secret'),{knownSecretValues:['private-secret'],async beforeWrite(){throw Error('must not reach');}}));assert.equal(bucket.puts,before);
 await assert.rejects(publisher.publish(artifact('new'),{knownSecretValues:[],async beforeWrite(){throw Error('cancelled');}}));assert.equal(bucket.puts,before);
});
function serviceFixture(){
 const store=createExternalStore(':memory:'),bucket=bucketFixture();
 const profile={id:'hf',enabled:true,provider:'hf' as const,target:{repository:'owner/model',revision:'main'},operations:['hf.model.commit' as const],credentialRef:'private-ref',maxLifetimeMs:10000,upperBoundMicros:10,maxActiveActions:2};
 const lease={taskId:'task',runId:'run',workerId:'worker',token:'native-lease-secret',expiresAt:30000};
 const task:any={id:'task',revision:1,status:'running',approvedAt:1,spec:{externalProfiles:['hf'],endsAt:50000,budgetMicros:100},actions:[],resources:[]};let nativeAllowed=true,dispatched=0;
 const broker:any={serverApprove(request:any){const p=structuredClone(profile),profileHash=hash(p);store.transaction(s=>{s.approvals['approval']={...request,id:'approval',profile:p,profileHash} as any;});},cancel(){},async execute(){dispatched++;throw Error('provider fixture boundary');}};
 const core:any={async execute(op:string,input:any){if(op==='get')return structuredClone(task);if(op==='nativeStart'){if(!nativeAllowed||input.lease.token!==lease.token||input.runtimeId!=='runtime')throw Error('native denied');return {taskId:'task',spec:structuredClone(task.spec)};}if(op==='reserve')return {id:'reservation',status:'reserved'};throw Error('unexpected '+op);}};
 const options={core,broker,store,registry:{get(id:string){return id===profile.id?profile:undefined;}},artifactPublisher:artifacts.createExternalR2ArtifactPublisher(bucket),knownSecretValues:()=>['server-control-secret']};
 const service=createAutonomousExternalService(options),body={lease,runtimeId:'runtime',profileId:'hf',artifact:artifact()};
 return {store,bucket,profile,task,options,service,body,denyNative(){nativeAllowed=false;},get dispatched(){return dispatched;},async approve(){const profiles=await service.profiles('task');await service.approve('task',Object.fromEntries(profiles.map(p=>[p.id,p.profileHash])));}};
}
import {createHash} from 'node:crypto';
const hash=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v)).digest('hex');
test('publication requires approval, native authority, current selected profile and admission',async()=>{
 for(const mutation of ['unapproved','native','cancel','revision','profile','foreign','fingerprint'] as const){const h=serviceFixture();try{
  if(mutation!=='unapproved')await h.approve();
  let body=h.body,service=h.service;
  if(mutation==='native')h.denyNative();if(mutation==='cancel')await h.service.beforeCoreMutation('task','cancel');if(mutation==='revision')h.task.revision++;if(mutation==='profile')h.profile.target.revision='other';if(mutation==='foreign')body={...body,profileId:'other'};if(mutation==='fingerprint')service=createAutonomousExternalService({...h.options,configurationFingerprint:'f'.repeat(64)});
  await assert.rejects(service.publishArtifact('task',body));assert.equal(h.bucket.puts,0);
 }finally{h.store.close();}}
});
test('publication creates bound grants; guessed digest and changed revision never reach broker',async()=>{
 const h=serviceFixture();try{await h.approve();const request={lease:h.body.lease,runtimeId:'runtime',request:{profileId:'hf',requestId:'request',operation:'hf.model.commit' as const,parameters:{artifactDigest:artifacts.externalArtifactDigest(artifact()),message:'publish'}}};
 await assert.rejects(h.service.execute('task',request));assert.equal(h.dispatched,0);
 const result=await h.service.publishArtifact('task',h.body);assert.equal(result.artifactDigest,request.request.parameters.artifactDigest);assert.equal(h.store.getArtifactGrant('task',1,'hf',result.artifactDigest)?.published,true);
 await assert.rejects(h.service.execute('task',request),/provider fixture boundary/);assert.equal(h.dispatched,1);
 h.task.revision++;await assert.rejects(h.service.execute('task',request));assert.equal(h.dispatched,1);
 }finally{h.store.close();}
});
test('publication rechecks cancellation after async storage and never grants late artifacts',async()=>{
 const h=serviceFixture();try{await h.approve();const real=h.options.artifactPublisher;
 const service=createAutonomousExternalService({...h.options,artifactPublisher:{async publish(a,options){const result=await real.publish(a,options);h.task.status='stopping';return result;}}});
 await assert.rejects(service.publishArtifact('task',h.body));const grant=h.store.getArtifactGrant('task',1,'hf',artifacts.externalArtifactDigest(h.body.artifact));assert.equal(grant?.published,false);
 }finally{h.store.close();}
});
test('task revision quota reserves at most 32 publications including failed uploads',async()=>{
 const h=serviceFixture();try{await h.approve();for(let i=0;i<32;i++)await h.service.publishArtifact('task',{...h.body,artifact:artifact('data'+i)});
 await assert.rejects(h.service.publishArtifact('task',{...h.body,artifact:artifact('overflow')}),/quota/);assert.equal(h.bucket.puts,32);await h.service.publishArtifact('task',{...h.body,artifact:artifact('data0')});assert.equal(h.bucket.objects.size,32);
 }finally{h.store.close();}
});

import {createAutonomousStore} from '../packages/core/src/autonomous-store.ts';
import {createAutonomousApiService} from '../apps/control-plane/src/autonomous-api.ts';
import {ExternalBroker} from '../packages/core/src/autonomous-external.ts';
test('real core publication through service execute loads immutable files into fake HF provider',async()=>{
 const h=serviceFixture(),main=createAutonomousStore(':memory:');let posted='';
 try{
  main.create({requestId:'artifact-core',goal:'fixture publication',provider:'claude',model:'pinned',billingPolicy:{model:'subscription',budget:'external_actions'},endsAt:100000,budgetMicros:100,tools:['Bash','mcp__hivemind__action'],systems:['hf'],externalProfiles:['hf'],credentialIds:['shared'],maxRunMs:120000,maxIterations:4,execution:{backend:'cloudflare',snapshotId:'a'.repeat(64),checks:[{id:'check',argv:['node'],timeoutMs:1000}]}},1000,'task');main.approve('task',1,'fixture',1000);const lease=main.claimCloud('task','worker','native-lease-secret','run',1000)!;
  const content=Buffer.from('model data'),blob=createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${content.length}\0`),content])).digest('hex'),parent='1'.repeat(40),commit='2'.repeat(40);
  const transport=artifacts.createExternalProviderTransport({enabled:true,hf:{enabled:true,repository:'owner/model',revision:'main'},artifacts:artifacts.createExternalR2ArtifactLoader(h.bucket),now:()=>1000,fetch:async(url,init)=>{
   const path=new URL(String(url)).pathname;
   if(init?.method==='POST'){posted=String(init.body);return Response.json({commitOid:commit});}
   if(path.includes('/commits/'))return Response.json(posted?[{id:commit,title:JSON.parse(posted.split('\n')[0]!).value.summary}]:[]);
   return Response.json({private:true,sha:path.endsWith(commit)?commit:parent,siblings:[{rfilename:'model.bin',blobId:blob}]});
  }});
  const broker=new ExternalBroker({store:h.store,registry:h.options.registry,now:()=>1000,resolver:{async withCredential(_r,_s,consume){return consume({provider:'hf' as const,token:'fixture-provider-token'});}},transport});
  const service=createAutonomousExternalService({...h.options,core:createAutonomousApiService(main,()=>1000),broker});
  const profiles=await service.profiles('task');await service.approve('task',{hf:profiles[0]!.profileHash});
  const body={...h.body,lease};const result=await service.publishArtifact('task',body);
  const action=await service.execute('task',{lease,runtimeId:'runtime',request:{profileId:'hf',requestId:'commit',operation:'hf.model.commit' as const,parameters:{artifactDigest:result.artifactDigest,message:'fixture'}}});
  assert.equal(action.status,'succeeded');assert.equal(action.verifiedCostMicros,null);assert.equal(JSON.parse(posted.split('\n')[1]!).value.content,h.body.artifact.files[0]!.contentBase64);
  await assert.rejects(service.publishArtifact('task',{...body,lease:{...lease,runId:'foreign'}}));
  await service.beforeCoreMutation('task','cancel');main.cancel('task','fixture cancel',1000);await assert.rejects(service.publishArtifact('task',body));
 }finally{main.close();h.store.close();}
});
