import test from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../apps/control-plane/src/app.js';
import {handleAutonomousApi,type AutonomousApiService} from '../apps/control-plane/src/autonomous-api.js';
import {createAutonomousCloudProxy} from '../apps/control-plane/src/autonomous-cloud-proxy.js';
import {createAutonomousExternalService,handleAutonomousExternalApi,type AutonomousExternalService} from '../apps/control-plane/src/autonomous-external-api.js';

const spec={requestId:'r',goal:'goal',provider:'claude',model:'m',endsAt:100000,budgetMicros:100,tools:[],systems:[],credentialIds:[],maxRunMs:1000,maxIterations:3};
const prefix='/v1/autonomous-tasks';
const record=(sequence:number)=>({sequence,tool:'Bash',inputDigest:'a'.repeat(64),inputSummary:'ls',inputTruncated:false,outcome:'allowed',startedAt:5,durationMs:1});

test('stopExternalBudget and toolAuditScope are reachable by no HTTP route', async () => {
  const calls:string[]=[];
  const service:AutonomousApiService={async execute(operation){calls.push(operation);return {id:'task'};}};
  const options={operatorToken:'operator',workerToken:'worker',reporterToken:'reporter',service};
  const lease={taskId:'task',runId:'run',workerId:'w',token:'t',expiresAt:5};
  const names=['stopExternalBudget','stop-external-budget','toolAuditScope','tool-audit-scope','stop-external','budget-stop'];
  for (const token of ['operator','worker','reporter']) for (const name of names) for (const method of ['GET','POST']) {
    const response=await handleAutonomousApi(new Request('http://local'+prefix+'/task/'+name,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(method==='POST'?{body:JSON.stringify({reason:'x',lease})}:{})}),options);
    assert.ok([401,404,503].includes(response.status),name+' '+method+' '+token+' '+response.status);
  }
  assert.deepEqual(calls,[]);
});

test('stopExternalBudget stops a task and toolAuditScope validates the lease through the service', async () => {
  const {createAutonomousStore}=await import('../packages/core/src/autonomous-store.js');
  const {createAutonomousApiService}=await import('../apps/control-plane/src/autonomous-api.js');
  const store=createAutonomousStore(':memory:');
  try {
    const service=createAutonomousApiService(store,()=>1000);
    const created=await service.execute('create',{spec}) as {id:string};
    await service.execute('approve',{id:created.id,revision:1,reason:'ok'});
    const claimed=await service.execute('claim',{id:created.id,workerId:'w'}) as {lease:{taskId:string;runId:string;workerId:string;token:string;expiresAt:number}};
    const scope=await service.execute('toolAuditScope',{id:created.id,lease:claimed.lease}) as {taskId:string;runId:string;iteration:number};
    assert.equal(scope.taskId,created.id);assert.equal(scope.runId,claimed.lease.runId);
    await assert.rejects(service.execute('toolAuditScope',{id:created.id,lease:{...claimed.lease,token:'wrong'}}));
    const stopped=await service.execute('stopExternalBudget',{id:created.id,reason:'cost_exceeded'}) as {status:string;stopReason?:string};
    assert.match(String(stopped.stopReason),/budget_exceeded/);
    const again=await service.execute('stopExternalBudget',{id:created.id,reason:'cost_exceeded'}) as {stopReason?:string};
    assert.equal(again.stopReason,stopped.stopReason);
  } finally { store.close(); }
});

test('local app: reporter ships tool calls, operator reads them, others are refused', async () => {
  const app=buildApp({operatorToken:'operator',workerToken:'worker',nativeReporterToken:'reporter',now:()=>1000});
  const send=(method:'GET'|'POST',url:string,token:string,payload?:unknown)=>app.inject({method,url:prefix+url,headers:{authorization:'Bearer '+token},...(payload===undefined?{}:{payload:payload as Record<string,unknown>})});
  try {
    const task=(await send('POST','','operator',spec)).json();
    await send('POST','/'+task.id+'/approve','operator',{revision:1,reason:'ok'});
    const {lease}=(await send('POST','/'+task.id+'/claim','worker',{workerId:'w'})).json();
    const path='/'+task.id+'/tool-calls';
    assert.equal((await send('POST',path,'operator',{lease,records:[record(1)],droppedByWorker:0})).statusCode,401);
    assert.equal((await send('POST',path,'worker',{lease,records:[record(1)],droppedByWorker:0})).statusCode,401);
    assert.equal((await send('GET',path,'reporter')).statusCode,401);
    assert.equal((await send('POST',path,'reporter',{lease:{...lease,token:'wrong'},records:[record(1)],droppedByWorker:0})).statusCode,409);
    const stored=await send('POST',path,'reporter',{lease,records:[record(1),record(2)],droppedByWorker:3});
    assert.equal(stored.statusCode,200);assert.deepEqual(stored.json(),{recorded:true,nextSequence:3});
    const page=(await send('GET',path,'operator')).json();
    assert.equal(page.source,'worker_report');assert.equal(page.items.length,2);assert.equal(page.totals.droppedByWorker,3);
    assert.equal(JSON.stringify(page).includes(lease.token),false);
  } finally { await app.close(); }
});

test('cloud proxy forwards operator tool-call pages and never the reporter POST', async () => {
  const calls:{url:string;method:string}[]=[];
  const page={source:'worker_report',items:[{...record(1),runId:'r',iteration:1,receivedAt:9,source:'worker_report',secretExtra:'x'}],totals:{recorded:1,denied:0,errors:0,droppedByWorker:2,droppedByStore:0},nextCursor:'c.1'};
  const proxy=createAutonomousCloudProxy({baseUrl:'https://fixed.example/',controlToken:'remote-secret'},{fetch:(async(url:string|URL,init?:RequestInit)=>{calls.push({url:String(url),method:String(init?.method)});return Response.json(page);}) as typeof fetch});
  const ok=await proxy.forward(new Request('http://local/api/cloudflare/autonomous-tasks/task/tool-calls?limit=20&cursor=c.0'));
  assert.equal(ok.status,200);assert.equal(calls[0]?.url,'https://fixed.example/v1/autonomous-tasks/task/tool-calls?limit=20&cursor=c.0');
  const body=await ok.json();assert.equal(body.totals.droppedByWorker,2);assert.equal(body.items[0].secretExtra,undefined);assert.equal(body.source,'worker_report');
  for (const bad of [new Request('http://local/api/cloudflare/autonomous-tasks/task/tool-calls',{method:'POST',body:'{}'}),new Request('http://local/api/cloudflare/autonomous-tasks/task/tool-calls?kind=runs'),new Request('http://local/api/cloudflare/autonomous-tasks/task/tool-calls?limit=0')]) assert.ok([400,404].includes((await proxy.forward(bad)).status));
  assert.equal(calls.length,1);
});

test('cloud proxy keeps counts.workerToolCalls and displays s3 and public Hugging Face targets', async () => {
  const task={id:'t',status:'running',spec,revision:1,counts:{humanInterventions:0,helpRequests:0,toolCalls:2,workerToolCalls:7}};
  const respond=(value:unknown)=>createAutonomousCloudProxy({baseUrl:'https://fixed.example/',controlToken:'remote-secret'},{fetch:async()=>Response.json(value)});
  const got=await (await respond(task).forward(new Request('http://local/api/cloudflare/autonomous-tasks/t'))).json();
  assert.equal(got.counts.workerToolCalls,7);
  const action=(approvedTarget:unknown,extra:Record<string,unknown>={})=>({revision:1,requestId:'q',phase:'broker',approvedTarget,...extra});
  const s3=await (await respond(action({accountId:'123456789012',region:'ap-northeast-2',bucket:'my-bucket',prefix:'runs/'},{parameters:{keySuffix:'t/m.json',artifactDigest:'a'.repeat(64)}})).forward(new Request('http://local/api/cloudflare/autonomous-tasks/t/external-actions'))).json();
  assert.deepEqual(s3.approvedTarget,{accountId:'123456789012',region:'ap-northeast-2',bucket:'my-bucket',prefix:'runs/'});assert.equal(s3.parameters.keySuffix,'t/m.json');
  const hf=await (await respond(action({repository:'o/m',revision:'main',visibility:'public'})).forward(new Request('http://local/api/cloudflare/autonomous-tasks/t/external-actions'))).json();
  assert.equal(hf.approvedTarget.visibility,'public');
  const bad=await respond(action({repository:'o/m',revision:'main',visibility:'Public'})).forward(new Request('http://local/api/cloudflare/autonomous-tasks/t/external-actions'));
  assert.equal(bad.status,503);
  const lfs=await (await respond(action({repository:'o/m',revision:'main'},{parameters:{manifestDigest:'b'.repeat(64)}})).forward(new Request('http://local/api/cloudflare/autonomous-tasks/t/external-actions'))).json();
  assert.equal(lfs.parameters.manifestDigest,'b'.repeat(64));
});

// Bridge tests below use a recording fake service so no broker or provider is involved.
function fakeService(overrides:Partial<AutonomousExternalService>={}):AutonomousExternalService {
  const deny=async()=>{throw new Error('unexpected');};
  return {publishArtifact:deny,profiles:deny,assertApproval:deny,execute:deny,approve:deny,list:deny,reconcile:deny,cleanup:deny,attestBilling:deny,beforeCoreMutation:deny,recover:async()=>{},...overrides} as AutonomousExternalService;
}
const lease={taskId:'task',runId:'run',workerId:'w',token:'lease-secret',expiresAt:5};
const post=(path:string,token:string,body:unknown)=>new Request('http://local'+prefix+'/task/'+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});

test('external-large routes are delegated with the bridge authority and saved manifest', async () => {
  const seen:string[]=[];
  const service=fakeService({
    largeAuthority:async(id,body)=>{seen.push('authorize:'+id+':'+body.profileId);return {taskId:id,revision:1,profileId:body.profileId};},
    saveLargeManifest:async(manifest,digest)=>{seen.push('save:'+manifest.files.length+':'+digest.length);},
  });
  const large={store:{begin:async()=>({uploadId:'u'}),part:async()=>({}),complete:async()=>({}),abort:async()=>({status:'aborted' as const}),open:async()=>({body:new ReadableStream({start(c){c.close();}}),size:1})} as never,limits:{maxFileBytes:100,maxTotalBytes:1000,maxFiles:3}};
  const options={operatorToken:'operator',workerToken:'worker',service,large};
  const begin={lease,runtimeId:'rt',profileId:'hf',file:{path:'a.bin',size:3,sha256:'a'.repeat(64)}};
  assert.equal((await handleAutonomousExternalApi(post('external-large/begin','operator',begin),options)).status,401);
  const ok=await handleAutonomousExternalApi(post('external-large/begin','worker',begin),options);
  assert.equal(ok.status,200);assert.deepEqual(await ok.json(),{uploadId:'u'});
  assert.deepEqual(seen,['authorize:task:hf']);
  const manifest=await handleAutonomousExternalApi(post('external-large/manifest','worker',{lease,runtimeId:'rt',profileId:'hf',files:[{path:'a.bin',size:3,sha256:'a'.repeat(64)}]}),options);
  assert.equal(manifest.status,200);assert.match(seen.at(-1)!,/^save:1:64$/);
  // Without large wiring or bridge support the route fails closed.
  assert.equal((await handleAutonomousExternalApi(post('external-large/begin','worker',begin),{operatorToken:'operator',workerToken:'worker',service})).status,503);
  assert.equal((await handleAutonomousExternalApi(post('external-large/begin','worker',begin),undefined)).status,503);
});

test('worker body validation accepts s3 and lfs operations and rejects extra or unsafe fields', async () => {
  const bodies:unknown[]=[];
  const service=fakeService({execute:async(_id,body)=>{bodies.push(body);return {revision:1,requestId:'q',phase:'intent'};}});
  const options={operatorToken:'operator',workerToken:'worker',service};
  const run=(operation:string,parameters:unknown)=>handleAutonomousExternalApi(post('external-action','worker',{lease,runtimeId:'rt',request:{profileId:'p',requestId:'q',operation,parameters}}),options);
  const digest='c'.repeat(64);
  assert.equal((await run('aws.s3.put',{keySuffix:'t1/m.json',artifactDigest:digest})).status,200);
  assert.equal((await run('aws.s3.inspect',{putActionId:'action-1'})).status,200);
  assert.equal((await run('hf.model.lfs_commit',{manifestDigest:digest,message:'add weights'})).status,200);
  assert.equal(bodies.length,3);
  for (const [operation,parameters] of [['aws.s3.put',{keySuffix:'../x',artifactDigest:digest}],['aws.s3.put',{keySuffix:'a//b',artifactDigest:digest}],['aws.s3.put',{keySuffix:'a/',artifactDigest:digest}],['aws.s3.put',{keySuffix:'a',artifactDigest:digest,bucket:'other'}],['aws.s3.inspect',{putActionId:'a',key:'k'}],['aws.s3.inspect',{}],['hf.model.lfs_commit',{manifestDigest:'zz',message:'m'}],['hf.model.lfs_commit',{manifestDigest:digest}],['hf.model.lfs_commit',{manifestDigest:digest,message:'m',url:'https://x'}]] as const) {
    assert.equal((await run(operation,parameters)).status,400,operation+JSON.stringify(parameters));
  }
  assert.equal(bodies.length,3);
});

test('createAutonomousExternalService requires a manifest store and shows no manifest content', async () => {
  // Constructing the bridge with only core fakes is enough to check the closed default.
  const service=createAutonomousExternalService({core:{async execute(){throw new Error('unused');}},broker:{} as never,registry:{get:()=>undefined},store:{} as never});
  await assert.rejects(service.saveLargeManifest!({version:1,taskId:'t',revision:1,profileId:'p',files:[]},'d'.repeat(64)));
});

// Bridge harness: real durable store and broker, fake core and fake provider transport. No network.
import {createExternalStore} from '../packages/core/src/autonomous-external-store.js';
import {ExternalBroker} from '../packages/core/src/autonomous-external.js';
import type {ExternalInvocation,ExternalProfile} from '../packages/contracts/src/autonomous-external.js';
const s3Target={accountId:'123456789012',region:'ap-northeast-2',bucket:'my-bucket',prefix:'runs/',maxObjectBytes:1024,retentionDays:30};
function bridge(profile:ExternalProfile,extra:{manifestSaved?:string[];aborted?:[string,number][]}={}) {
  const store=createExternalStore(':memory:'),dispatched:string[]=[];
  const task:any={id:'task',revision:1,status:'running',approvedAt:1,spec:{externalProfiles:[profile.id],endsAt:50000,budgetMicros:1000},actions:[],resources:[],lease:{...lease}};
  const core={async execute(operation:string,input:any){
    if(operation==='get')return structuredClone(task);
    if(operation==='nativeStart')return {taskId:'task',spec:structuredClone(task.spec),deadline:30000};
    if(operation==='reserve'){let a=task.actions.find((v:any)=>v.requestId===input.request.requestId);if(!a){a={...input.request,id:'reservation',status:'reserved'};task.actions.push(a);}return structuredClone(a);}
    if(operation==='acceptExternal'){const a=task.actions.find((v:any)=>v.id===input.actionId);a.status='accepted';return structuredClone(a);}
    if(operation==='settleExternal'){const a=task.actions.find((v:any)=>v.id===input.actionId);a.status='succeeded';a.actualCostMicros=input.actualCostMicros;return structuredClone(a);}
    throw new Error('unexpected '+operation);
  }};
  const receipt=(inv:ExternalInvocation)=>({ownershipToken:inv.ownershipToken,idempotencyKey:inv.idempotencyKey,evidenceId:inv.operation==='aws.s3.put'?'s3:'+'e'.repeat(32):'hf:'+'d'.repeat(40),outcome:'succeeded' as const,effect:'retained' as const,billing:{verifiedCostMicros:null,final:false}});
  const broker=new ExternalBroker({store,registry:{get:()=>profile},now:()=>1000,resolver:{async withCredential(_r:string,_s:unknown,consume:(c:string)=>Promise<any>){return consume('private-credential');}},transport:{
    async execute(inv:ExternalInvocation){dispatched.push(inv.operation);return receipt(inv);},
    async inspect(inv:ExternalInvocation){return receipt(inv);},async cleanup(){},async confirmAbsent(){return false;},
  }} as never);
  const service=createAutonomousExternalService({core:core as never,broker,store,registry:{get:()=>profile},
    manifestStore:{async save(_m:unknown,d:string){extra.manifestSaved?.push(d);}},largeStore:{async abortOwner(taskId:string,revision:number){extra.aborted?.push([taskId,revision]);return 0;}},allowPreseededArtifacts:true} as never);
  return {store,service,task,dispatched};
}
const approve=async(service:AutonomousExternalService)=>{const metadata=await service.profiles('task');await service.assertApproval('task',1,Object.fromEntries(metadata.map(p=>[p.id,p.profileHash])));return service.approve('task');};
const hfProfile=(visibility?:'private'|'public',operations:('hf.model.commit'|'hf.model.lfs_commit')[]=['hf.model.lfs_commit']):ExternalProfile=>({id:'hf',enabled:true,provider:'hf',target:{repository:'owner/model',revision:'main',...(visibility?{visibility}:{})},operations,credentialRef:'ref',maxLifetimeMs:1000,upperBoundMicros:10,maxActiveActions:1});

test('profile metadata makes a public Hugging Face commit explicit and treats omitted visibility as private', async () => {
  const pub=bridge(hfProfile('public',['hf.model.commit'])),priv=bridge(hfProfile()),prv=bridge(hfProfile('private'));
  try {
    const [a]=await pub.service.profiles('task'),[b]=await priv.service.profiles('task'),[c]=await prv.service.profiles('task');
    assert.equal(a!.hfVisibilityDisplay!.visibility,'public');assert.equal(a!.hfVisibilityDisplay!.publicEffect,true);assert.match(a!.hfVisibilityDisplay!.notice,/공개/);
    assert.equal(b!.hfVisibilityDisplay!.publicEffect,false);assert.equal(b!.hfVisibilityDisplay!.visibility,'private');
    assert.equal(c!.hfVisibilityDisplay!.publicEffect,false);
    // Adding visibility changes the approval hash: the operator approves the exact visibility.
    assert.notEqual(a!.profileHash,b!.profileHash);
  } finally { pub.store.close();priv.store.close();prv.store.close(); }
});

test('approved target shows hf visibility and the s3 bucket and prefix', async () => {
  const hf=bridge(hfProfile('public',['hf.model.commit'])),s3=bridge({id:'s3',enabled:true,provider:'s3',target:s3Target,operations:['aws.s3.put','aws.s3.inspect'],credentialRef:'ref',maxLifetimeMs:1000,upperBoundMicros:10,maxActiveActions:2});
  try {
    await approve(hf.service);
    await hf.service.execute('task',{lease,runtimeId:'rt',request:{profileId:'hf',requestId:'q1',operation:'hf.model.commit',parameters:{artifactDigest:'a'.repeat(64),message:'m'}}});
    const listed=await hf.service.list('task') as {approvedTarget:Record<string,unknown>}[];
    assert.deepEqual(listed[0]!.approvedTarget,{repository:'owner/model',revision:'main',visibility:'public'});
    await approve(s3.service);
    const put=await s3.service.execute('task',{lease,runtimeId:'rt',request:{profileId:'s3',requestId:'p1',operation:'aws.s3.put',parameters:{keySuffix:'t1/m.json',artifactDigest:'b'.repeat(64)}}});
    assert.deepEqual(put.approvedTarget,{accountId:'123456789012',region:'ap-northeast-2',bucket:'my-bucket',prefix:'runs/'});
    assert.deepEqual(put.parameters,{keySuffix:'t1/m.json',artifactDigest:'b'.repeat(64)});
    assert.deepEqual(s3.dispatched,['aws.s3.put']);
    assert.equal(JSON.stringify(put).includes('maxObjectBytes'),false);
  } finally { hf.store.close();s3.store.close(); }
});

test('lfs commit needs a bound manifest grant; cancel aborts every large upload of the task', async () => {
  const saved:string[]=[],aborted:[string,number][]=[],h=bridge(hfProfile(),{manifestSaved:saved,aborted});
  const digest='f'.repeat(64),manifest={version:1 as const,taskId:'task',revision:1,profileId:'hf',files:[{path:'w.bin',size:5,sha256:'1'.repeat(64),storageRef:'external-large/'+'2'.repeat(64)+'/'+'1'.repeat(64)}]};
  const lfs={lease,runtimeId:'rt',request:{profileId:'hf',requestId:'l1',operation:'hf.model.lfs_commit',parameters:{manifestDigest:digest,message:'weights'}}};
  try {
    // Not approved yet: no authority, no manifest.
    await assert.rejects(h.service.largeAuthority!('task',{lease,runtimeId:'rt',profileId:'hf'}));
    await approve(h.service);
    assert.deepEqual(await h.service.largeAuthority!('task',{lease,runtimeId:'rt',profileId:'hf'}),{taskId:'task',revision:1,profileId:'hf'});
    // No grant: the action is refused before any reservation or provider call.
    await assert.rejects(h.service.execute('task',lfs as never),(e:any)=>e.statusCode===403);
    assert.equal(h.task.actions.length,0);assert.deepEqual(h.dispatched,[]);
    // Manifest for another profile or revision is refused.
    await assert.rejects(h.service.saveLargeManifest!({...manifest,revision:2},digest));
    await h.service.saveLargeManifest!(manifest,digest);assert.deepEqual(saved,[digest]);
    const result=await h.service.execute('task',lfs as never);
    assert.deepEqual(result.parameters,{manifestDigest:digest});assert.deepEqual(h.dispatched,['hf.model.lfs_commit']);
    // A different manifest digest has no grant.
    await assert.rejects(h.service.execute('task',{...lfs,request:{...lfs.request,requestId:'l2',parameters:{manifestDigest:'9'.repeat(64),message:'x'}}} as never),(e:any)=>e.statusCode===403);
    await h.service.beforeCoreMutation('task','cancel');
    assert.ok(aborted.some(([id,revision])=>id==='task'&&revision===1),JSON.stringify(aborted));
    await assert.rejects(h.service.largeAuthority!('task',{lease,runtimeId:'rt',profileId:'hf'}));
  } finally { h.store.close(); }
});

test('lfs authority is refused for a public profile and for a profile without the operation', async () => {
  const pub=bridge(hfProfile('public',['hf.model.commit'])),plain=bridge(hfProfile(undefined,['hf.model.commit']));
  try {
    for (const h of [pub,plain]) { await approve(h.service);await assert.rejects(h.service.largeAuthority!('task',{lease,runtimeId:'rt',profileId:'hf'}),(e:any)=>e.statusCode===403); }
  } finally { pub.store.close();plain.store.close(); }
});
