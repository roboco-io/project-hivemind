import {createExternalSqlStore} from '../packages/core/src/autonomous-external-sql.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const storeModule='../packages/core/src/autonomous-external-store.js';
test('external SQLite store durably commits, rolls back and rejects async callbacks without retaining references',async()=>{
 const {createExternalStore}=await import(storeModule);const dir=mkdtempSync(join(tmpdir(),'external-store-')),path=join(dir,'state.sqlite');let store=createExternalStore(path);
 try{
  let retained:any;
  store.transaction((state:any)=>{retained=state;state.version=1;});
  retained.version=2;
  assert.equal(store.transaction((state:any)=>state.version),1);
  assert.throws(()=>store.transaction((state:any)=>{state.version=2;throw Error('rollback');}),/rollback/);
  assert.throws(()=>store.transaction(async(state:any)=>{state.version=2;}),/synchronous/i);
  store.putJournal({taskId:'task',revision:1,requestId:'request',requestHash:'a'.repeat(64),mainRequestId:'external:a',phase:'intent'});
  store.close();store=createExternalStore(path);
  assert.equal(store.getJournal('task',1,'request').requestHash,'a'.repeat(64));
  assert.equal(store.transaction((state:any)=>state.version),1);
  const raw=new DatabaseSync(path);raw.exec("CREATE TRIGGER external_fail BEFORE INSERT ON external_chunks BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert.throws(()=>store.blockTask('task',1),/injected/);raw.exec('DROP TRIGGER external_fail');raw.close();assert.equal(store.isTaskBlocked('task',1),false);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
import {ExternalBroker} from '../packages/core/src/autonomous-external.js';
const apiModule='../apps/control-plane/src/autonomous-external-api.js';
async function bridgeHarness(path=':memory:'){
 const {createExternalStore}=await import(storeModule),{createAutonomousExternalService}=await import(apiModule);
 const store=createExternalStore(path),events:string[]=[];let final=false,absent=false,dispatches=0,crash=false;
 const profile={id:'profile',enabled:true,provider:'aws' as const,target:{accountId:'123456789012',region:'ap-northeast-2',workloadId:'test'},operations:['aws.spot.start' as const],credentialRef:'private-ref',maxLifetimeMs:10000,upperBoundMicros:10,maxActiveActions:1};
 const lease={taskId:'task',runId:'run',workerId:'worker',token:'private-lease',expiresAt:30000};
 const task:any={id:'task',revision:1,status:'running',approvedAt:1,spec:{externalProfiles:['profile'],endsAt:50000,budgetMicros:100},actions:[],resources:[],lease:{...lease}};
 const core={async execute(operation:string,input:any){
  events.push(operation);
  if(operation==='get')return structuredClone(task);
  if(operation==='nativeStart'){assert.deepEqual(input.lease,lease);assert.equal(input.runtimeId,'runtime');return {taskId:'task',spec:structuredClone(task.spec),deadline:30000};}
  if(operation==='reserve'){
   let a=task.actions.find((v:any)=>v.requestId===input.request.requestId);
   if(!a){a={...input.request,id:'reservation',status:'reserved'};task.actions.push(a);}
   if(crash){crash=false;throw Error('response lost after reserve commit');}return structuredClone(a);
  }
  if(operation==='acceptExternal'){const a=task.actions.find((v:any)=>v.id===input.actionId);a.status='accepted';if(input.resource&&!task.resources.some((r:any)=>r.id===input.resource.id))task.resources.push({...input.resource,status:'active',actionId:a.id});return structuredClone(a);}
  if(operation==='cleanedExternal'){const r=task.resources.find((r:any)=>r.id===input.resourceId);if(r)r.status='cleaned';return structuredClone(task);}
  if(operation==='settleExternal'||operation==='settle'||operation==='reconcile'){const a=task.actions.find((v:any)=>v.id===input.actionId);a.status='succeeded';a.actualCostMicros=input.actualCostMicros;return structuredClone(a);}
  throw Error('unexpected '+operation);
 }};
 const brokerOptions={store,registry:{get:()=>profile},now:()=>1000,resolver:{async withCredential(_r:string,_s:unknown,consume:(credential:string)=>Promise<any>){return consume('private-credential');}},transport:{
  async execute(inv:import('../packages/contracts/src/autonomous-external.js').ExternalInvocation){events.push('provider');dispatches++;return {ownershipToken:inv.ownershipToken,idempotencyKey:inv.idempotencyKey,evidenceId:'evidence',outcome:'succeeded',effect:'resource',resource:{id:'resource',cleanupRequired:true},billing:{verifiedCostMicros:final?3:null,final}};},
  async inspect(inv:import('../packages/contracts/src/autonomous-external.js').ExternalInvocation){return {ownershipToken:inv.ownershipToken,idempotencyKey:inv.idempotencyKey,evidenceId:'evidence',outcome:'succeeded',effect:'resource',resource:{id:'resource',cleanupRequired:true},billing:{verifiedCostMicros:final?3:null,final}};},
  async cleanup(){events.push('cleanup');},async confirmAbsent(){return absent;},
 }} satisfies import('../packages/contracts/src/autonomous-external.js').ExternalBrokerOptions<string>;
 const broker=new ExternalBroker(brokerOptions);
 const options={core,broker,store,registry:{get:()=>profile}};
 const service=createAutonomousExternalService(options);
 const body={lease,runtimeId:'runtime',request:{profileId:'profile',requestId:'request',operation:'aws.spot.start',parameters:{lifetimeMs:10000}}};
 return {store,events,task,profile,broker,brokerOptions,core,service,options,body,get dispatches(){return dispatches;},final:()=>{final=true;},absent:()=>{absent=true;},crash:()=>{crash=true;}};
}
test('bridge reserves before dispatch, retains unknown exposure and uses stable IDs after lost reservation response',async()=>{
 const h=await bridgeHarness();try{
  await approveBridge(h.service);h.crash();await assert.rejects(h.service.execute('task',h.body),/response lost/);assert.equal(h.dispatches,0);assert.equal(h.task.actions.length,1);
  const result=await h.service.execute('task',h.body);assert.equal(result.resourceId,'resource');assert.equal(result.upperBoundMicros,10);assert.equal(result.reservedMicros,10);assert.equal(h.dispatches,1);assert.equal(h.task.actions.length,1);assert.ok(h.events.indexOf('reserve')<h.events.indexOf('provider'));assert.equal(h.task.actions[0].status,'accepted');
  assert.doesNotMatch(JSON.stringify(result),/private|ownershipToken|idempotencyKey/);
  await Promise.all([h.service.execute('task',h.body),h.service.execute('task',h.body)]);assert.equal(h.dispatches,1);assert.equal(h.task.actions.length,1);
  await assert.rejects(h.service.execute('task',{...h.body,request:{...h.body.request,parameters:{lifetimeMs:9999}}}));assert.equal(h.dispatches,1);
 }finally{h.store.close();}
});
test('bridge cancellation blocks admission and holds central reservation until cleanup absence and final cost',async()=>{
 const h=await bridgeHarness();try{
  await approveBridge(h.service);await h.service.execute('task',h.body);await h.service.beforeCoreMutation('task','cancel');assert.equal(h.events.includes('cleanup'),false);
  await assert.rejects(h.service.execute('task',{...h.body,request:{...h.body.request,requestId:'another'}}));
  h.final();await h.service.reconcile('task','request');assert.equal(h.task.actions[0].status,'accepted');
  delete h.task.lease;
  await h.service.cleanup('task','request');assert.equal(h.task.actions[0].status,'accepted');
  h.absent();await h.service.cleanup('task','request');assert.equal(h.task.actions[0].actualCostMicros,3);assert.equal(h.task.actions[0].status,'succeeded');
 }finally{h.store.close();}
});
test('standalone HTTP bridge defaults disabled, authenticates before parsing and strictly validates worker request',async()=>{
 const {handleAutonomousExternalApi}=await import(apiModule),h=await bridgeHarness();
 const url='http://local/v1/autonomous-tasks/task/external-action';
 const request=(body:unknown,token='worker')=>new Request(url,{method:'POST',headers:{authorization:'Bearer '+token},body:typeof body==='string'?body:JSON.stringify(body)});
 const options={operatorToken:'operator',workerToken:'worker',service:h.service};
 try{
  assert.equal((await handleAutonomousExternalApi(request(h.body))).status,503);
  assert.equal((await handleAutonomousExternalApi(request('{','operator'),options)).status,401);
  await approveBridge(h.service);
  assert.equal((await handleAutonomousExternalApi(request({...h.body,secret:'bad'}),options)).status,400);
  assert.equal((await handleAutonomousExternalApi(request({...h.body,request:{...h.body.request,parameters:{lifetimeMs:1000,url:'https://bad'}}}),options)).status,400);
  assert.equal((await handleAutonomousExternalApi(request(h.body),options)).status,200);
  delete h.task.spec.externalProfiles;
  assert.equal((await handleAutonomousExternalApi(request(h.body),options)).status,503);
 }finally{h.store.close();}
});
test('worker cannot reserve until operator broker approval is bound to the current profile',async()=>{
 const h=await bridgeHarness();try{
  await assert.rejects(h.service.execute('task',h.body));assert.equal(h.task.actions.length,0);assert.equal(h.dispatches,0);
  await approveBridge(h.service);h.profile.upperBoundMicros=11;
  await assert.rejects(h.service.execute('task',h.body));assert.equal(h.task.actions.length,0);assert.equal(h.dispatches,0);
 }finally{h.store.close();}
});
test('external journal replay preserves durable action identity and monotonic completion',async()=>{
 const {createExternalStore}=await import(storeModule),store=createExternalStore(':memory:');
 try{
  const intent={taskId:'task',revision:1,requestId:'request',requestHash:'b'.repeat(64),mainRequestId:'external:b',phase:'intent'};
  store.putJournal(intent);store.putJournal({...intent,phase:'settled',mainReservationId:'main',brokerActionId:'broker'});
  store.putJournal({...intent,phase:'reserved',mainReservationId:'main'});
  assert.equal(store.getJournal('task',1,'request').phase,'settled');assert.equal(store.getJournal('task',1,'request').brokerActionId,'broker');
  assert.throws(()=>store.putJournal({...intent,mainReservationId:'different'}),/identity conflict/);
 }finally{store.close();}
});
test('SQLite restart recovers a broker result lost before journal linking without provider redispatch',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'external-bridge-')),path=join(dir,'state.sqlite');const h=await bridgeHarness(path);let reopened:any;
 try{
  await approveBridge(h.service);const put=h.store.putJournal.bind(h.store);let fail=true;
  h.store.putJournal=(entry:any)=>{if(fail&&entry.brokerActionId){fail=false;throw Error('lost journal result');}put(entry);};
  await assert.rejects(h.service.execute('task',h.body),/lost journal/);assert.equal(h.dispatches,1);assert.equal(h.task.actions[0].status,'reserved');h.store.close();
  const {createExternalStore}=await import(storeModule),{createAutonomousExternalService}=await import(apiModule);reopened=createExternalStore(path);
  const broker=new ExternalBroker({...h.brokerOptions,store:reopened}),service=createAutonomousExternalService({...h.options,broker,store:reopened});
  await service.recover();const list=await service.list('task');assert.equal(list.length,1);assert.ok(list[0].actionId);assert.equal(h.dispatches,1);assert.equal(h.task.actions.length,1);assert.equal(h.task.actions[0].status,'reserved');assert.doesNotMatch(JSON.stringify(list),/private|ownershipToken|idempotencyKey/);
 }finally{h.store.close();reopened?.close();rmSync(dir,{recursive:true,force:true});}
});
test('external store rejects orphaned chunks and rejects unrecognized journal fields',async()=>{
 const {createExternalStore}=await import(storeModule),dir=mkdtempSync(join(tmpdir(),'external-corrupt-')),path=join(dir,'state.sqlite'),store=createExternalStore(path);
 const raw=new DatabaseSync(path);
 try{
  assert.throws(()=>store.putJournal({taskId:'task',revision:1,requestId:'request',requestHash:'c'.repeat(64),mainRequestId:'external:c',phase:'intent',credential:'never-persist'}));
  raw.prepare('INSERT INTO external_chunks VALUES(0,?)').run('orphan');assert.throws(()=>store.transaction(()=>undefined),/Invalid external persisted state/);
 }finally{raw.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
test('actual canonical SQLite core denies external execution when externalProfiles is absent',async()=>{
 const {createAutonomousStore}=await import('../packages/core/src/autonomous-store.js');
 const {createAutonomousApiService}=await import('../apps/control-plane/src/autonomous-api.js');
 const {createAutonomousExternalService}=await import(apiModule),h=await bridgeHarness(),main=createAutonomousStore(':memory:');
 try{
  main.create({requestId:'canonical',goal:'local test',provider:'claude',model:'pinned',billingPolicy:{model:'subscription',budget:'external_actions'},endsAt:100000,budgetMicros:100,tools:[],systems:[],credentialIds:['shared'],maxRunMs:1000,maxIterations:3},1000,'task');main.approve('task',1,'approved',1000);
  const lease=main.claim('task','worker','test-only','run',1000)!;
  const service=createAutonomousExternalService({...h.options,core:createAutonomousApiService(main,()=>1000)});
  await assert.rejects(service.execute('task',{...h.body,lease}),(e:any)=>e.statusCode===503);assert.equal(h.dispatches,0);assert.equal(main.get('task').reservedMicros,0);
 }finally{main.close();h.store.close();}
});
test('portable SQL implementation imports directly from TypeScript without node:sqlite',async()=>{
 const {spawnSync}=await import('node:child_process');
 const result=spawnSync(process.execPath,['--input-type=module','-e',"import {registerHooks} from 'node:module';registerHooks({resolve(s,c,next){if(s==='node:sqlite')throw Error('SQLite import forbidden');return next(s,c);}});await import('./packages/core/src/autonomous-external-sql.ts');await import('./apps/control-plane/src/autonomous-external-api.ts');await import('./cloudflare/backend/src/autonomous-external.ts');"],{cwd:process.cwd(),encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
});
test('bridge rejects lifetime outside approved profile before reserving central budget',async()=>{
 const h=await bridgeHarness();try{await approveBridge(h.service);await assert.rejects(h.service.execute('task',{...h.body,request:{...h.body.request,parameters:{lifetimeMs:10001}}}));assert.equal(h.task.actions.length,0);assert.equal(h.dispatches,0);}finally{h.store.close();}
});
test('bridge approves AWS HF and GitHub under one task budget and rejects duplicate providers',async()=>{
 const h=await bridgeHarness();try{
  const hf={...h.profile,id:'hf',provider:'hf' as const,target:{repository:'owner/model',revision:'main'},operations:['hf.model.commit' as const]};
  const github={...h.profile,id:'github',provider:'github' as const,target:{repository:'owner/repo',branch:'work'},operations:['github.branch.push' as const]};
  const registry={get:(id:string)=>({profile:h.profile,hf,github} as Record<string,any>)[id]};
  h.task.spec.externalProfiles=['profile','hf','github'];const {createAutonomousExternalService}=await import(apiModule);
  const broker=new ExternalBroker({...h.brokerOptions,registry}),service=createAutonomousExternalService({...h.options,broker,registry});
  const approved=await approveBridge(service);assert.deepEqual(approved.profileIds,['profile','hf','github']);
  const approvals=h.store.transaction((s:any)=>Object.values(s.approvals));assert.equal(approvals.length,3);assert.ok(approvals.every((p:any)=>p.budgetMicros===100));
  h.task.spec.externalProfiles=['hf','hf'];await assert.rejects(service.approve('task'));
  h.task.spec.externalProfiles=['profile','second'];const duplicated={get:(id:string)=>id==='second'?{...h.profile,id:'second'}:h.profile};
  await assert.rejects(createAutonomousExternalService({...h.options,registry:duplicated}).approve('task'));
 }finally{h.store.close();}
});
test('actual SQLite core shares the broker reservation and cannot finalize until resource cleanup and billing',async()=>{
 const {createAutonomousStore}=await import('../packages/core/src/autonomous-store.js'),{createAutonomousApiService}=await import('../apps/control-plane/src/autonomous-api.js'),{createAutonomousExternalService}=await import(apiModule);
 const h=await bridgeHarness(),main=createAutonomousStore(':memory:');let now=1000;
 try{
  main.create({requestId:'canonical-external',goal:'synthetic broker bridge',provider:'claude',model:'pinned',billingPolicy:{model:'subscription',budget:'external_actions'},endsAt:100000,budgetMicros:100,tools:['Bash','mcp__hivemind__action'],systems:['aws'],externalProfiles:['profile'],credentialIds:['shared'],maxRunMs:120000,maxIterations:4,execution:{backend:'cloudflare',snapshotId:'a'.repeat(64),checks:[{id:'check',argv:['node'],timeoutMs:10000}]}},now,'task');main.approve('task',1,'synthetic approval',now);
  const lease=main.claimCloud('task','worker','test-lease','run',now)!;
  const service=createAutonomousExternalService({...h.options,core:createAutonomousApiService(main,()=>now)});
  await approveBridge(service);await service.execute('task',{...h.body,lease});
  assert.equal(main.get('task').reservedMicros,10);assert.equal(main.get('task').spentMicros,0);assert.equal(h.dispatches,1);
  assert.equal(main.get('task').actions[0]!.status,'accepted');
  const usage={inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0};main.recordNativeReceipt(lease,{runId:'run',runtimeId:'runtime',sessionId:'synthetic',model:'pinned',sequence:1,usage,stopped:true,outcome:'continue'},now);
  assert.equal(main.finishCloud(lease,{outcome:'continue',usage,costMicros:null,checkpoint:{sessionId:'synthetic',objectKey:'private',model:'pinned',sequence:1}},true,now).status,'ready');
  const next=main.claimCloud('task','worker','next-test','next-run',now)!;assert.ok(next);
  await service.beforeCoreMutation('task','cancel');assert.equal(main.cancel('task','synthetic cancellation',now).status,'stopping');
  now=next.expiresAt;main.tick(now);h.final();await service.reconcile('task','request');assert.equal(main.get('task').reservedMicros,10);
  h.absent();await service.cleanup('task','request');assert.equal(main.get('task').reservedMicros,0);assert.equal(main.get('task').spentMicros,3);
  assert.equal(main.get('task').status,'stopping');assert.equal(main.reconcileRun('task','next-run',0,'synthetic stopped process proof',now).status,'cancelled');
 }finally{main.close();h.store.close();}
});
test('fixed R2 external artifact loader verifies exact artifact digest and bounded JSON, never a snapshot or URL',async()=>{
 const {createExternalArtifactLoader}=await import('../cloudflare/backend/src/autonomous-external.ts');
 const {externalArtifactDigest}=await import('../packages/adapters/src/autonomous-external.js');
 const artifact={files:[{path:'model/data.txt',contentBase64:Buffer.from('data').toString('base64')}]},digest=externalArtifactDigest(artifact),keys:string[]=[];
 let raw=JSON.stringify(artifact);
 const bucket={async get(key:string){keys.push(key);return {size:Buffer.byteLength(raw),body:new Response(raw).body!};}};
 const loader:any=createExternalArtifactLoader(bucket);
 assert.deepEqual(await loader.load(digest),artifact);assert.deepEqual(keys,['external-artifacts/'+digest]);
 raw=JSON.stringify({files:[{path:'model/data.txt',contentBase64:Buffer.from('changed').toString('base64')}]});await assert.rejects(loader.load(digest));
 const before=keys.length;await assert.rejects(loader.load('https://untrusted/artifact'));assert.equal(keys.length,before);
 raw='x'.repeat(2*1024*1024+1);await assert.rejects(loader.load(digest));
});
test('backend factory defaults off and denies enabled configuration without concrete targets and TTL guards',async()=>{
 const {createAutonomousExternalRuntime}=await import('../cloudflare/backend/src/autonomous-external.ts');
 assert.equal(createAutonomousExternalRuntime({env:{}}),undefined);
 assert.throws(()=>createAutonomousExternalRuntime({env:{AUTONOMOUS_EXTERNAL_ENABLED:'true'}}));
 assert.throws(()=>createAutonomousExternalRuntime({env:{AUTONOMOUS_EXTERNAL_ENABLED:'true',AUTONOMOUS_EXTERNAL_CONFIG:JSON.stringify({version:1,profiles:[],providers:{},ttlGuard:{}})}}));
});
test('external journal pages freeze highwater, bind task scope and persist approval configuration fingerprints',async()=>{
 const {createExternalStore}=await import(storeModule),store=createExternalStore(':memory:');try{
  for(const requestId of ['one','two'])store.putJournal({taskId:'task',revision:1,requestId,requestHash:'a'.repeat(64),mainRequestId:'external:'+requestId,phase:'intent'});
  const first=store.pageJournal('task',{limit:1});assert.equal(first.items[0].requestId,'one');assert.ok(first.nextCursor);
  store.putJournal({taskId:'task',revision:1,requestId:'three',requestHash:'b'.repeat(64),mainRequestId:'external:three',phase:'intent'});
  assert.deepEqual(store.pageJournal('task',{cursor:first.nextCursor}).items.map((j:any)=>j.requestId),['two']);
  assert.throws(()=>store.pageJournal('other',{cursor:first.nextCursor}));assert.throws(()=>store.pageJournal('task',{limit:101}));
  store.bindApprovalFingerprint('task',1,'profile','f'.repeat(64));assert.equal(store.approvalFingerprint('task',1,'profile'),'f'.repeat(64));assert.throws(()=>store.bindApprovalFingerprint('task',1,'profile','e'.repeat(64)));
 }finally{store.close();}
});

async function approveBridge(service:any){const metadata=await service.profiles('task'),hashes=Object.fromEntries(metadata.map((p:any)=>[p.id,p.profileHash]));await service.assertApproval('task',1,hashes);return service.approve('task');}
test('profile approval hashes pin displayed target and reject changes before canonical approval',async()=>{
 const h=await bridgeHarness();try{
  const metadata=await h.service.profiles('task');assert.equal(metadata[0].credentialRef,'private-ref');assert.ok(/^[a-f0-9]{64}$/.test(metadata[0].profileHash));
  const hashes={profile:metadata[0].profileHash};h.profile.target.workloadId='changed';await assert.rejects(h.service.assertApproval('task',1,hashes));assert.equal(h.store.transaction((s:any)=>Object.keys(s.approvals).length),0);
 }finally{h.store.close();}
});
test('bridge rejects a journal pointing at another request before cleanup transport',async()=>{
 const h=await bridgeHarness();try{
  await approveBridge(h.service);await h.service.execute('task',h.body);await h.service.beforeCoreMutation('task','cancel');const original=h.store.getJournal('task',1,'request');
  assert.throws(()=>h.store.putJournal({...original,sequence:undefined,requestId:'foreign',requestHash:'d'.repeat(64),mainRequestId:'external:foreign',mainReservationId:'foreign-reservation'}),/Invalid external persisted state/);
  assert.equal(h.events.includes('cleanup'),false);
 }finally{h.store.close();}
});
function sqlFixture(){const db=new DatabaseSync(':memory:');return {db,sql:{exec(query:string,...bindings:(string|number|null)[]){const statement=db.prepare(query);if(statement.columns().length)return statement.all(...bindings);statement.run(...bindings);return [];},transactionSync<T>(fn:()=>T):T{db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}}}};}
test('concrete factory refresh preserves scope approvals while reconciliation backoff survives restart',async()=>{
 const {createAutonomousExternalRuntime}=await import('../cloudflare/backend/src/autonomous-external.ts');const {externalArtifactDigest}=await import('../packages/adapters/src/autonomous-external.js');const h=await bridgeHarness(),sql=sqlFixture();let now=1000,calls=0;
 const profile={id:'hf',enabled:true,provider:'hf',target:{repository:'owner/model',revision:'main'},operations:['hf.model.commit'],credentialRef:'hf-ref',maxLifetimeMs:10000,upperBoundMicros:10,maxActiveActions:1};
 const config={version:1,profiles:[profile],providers:{hf:{enabled:true,repository:'owner/model',revision:'main'}}},artifact={files:[{path:'model.txt',contentBase64:Buffer.from('fixture data').toString('base64')}]},raw=JSON.stringify(artifact);
 const env={AUTONOMOUS_EXTERNAL_ENABLED:'true',AUTONOMOUS_EXTERNAL_CONFIG:JSON.stringify(config),AUTONOMOUS_EXTERNAL_CREDENTIALS:JSON.stringify({'hf-ref':{provider:'hf',token:'fixture-hf-token'}})};
 const options={env,core:h.core,sql:sql.sql,artifacts:{async get(){return {size:Buffer.byteLength(raw),body:new Response(raw).body!};}},fetch:async()=>{calls++;throw Error('fixture network disabled');},now:()=>now};
 h.task.spec.externalProfiles=['hf'];
 try{
  const runtime=createAutonomousExternalRuntime(options)!;assert.equal(runtime.enabled,true);assert.deepEqual(runtime.configuredSecretValues(),['fixture-hf-token']);assert.equal(calls,0);await approveBridge(runtime.service);
  const metadata=await runtime.service.profiles('task');assert.doesNotMatch(JSON.stringify(metadata),/fixture-hf-token|ownershipToken/);
  const rotated=createAutonomousExternalRuntime({...options,env:{...env,AUTONOMOUS_EXTERNAL_CREDENTIALS:JSON.stringify({'hf-ref':{provider:'hf',token:'rotated-fixture-token'}})}})!;
  assert.equal(rotated.configurationFingerprint,runtime.configurationFingerprint);assert.equal((await rotated.service.profiles('task'))[0]!.profileHash,metadata[0]!.profileHash);await rotated.service.approve('task');assert.equal(h.task.actions.length,0);
  const body={...h.body,request:{profileId:'hf',requestId:'request',operation:'hf.model.commit' as const,parameters:{artifactDigest:externalArtifactDigest(artifact),message:'fixture'}}};
  seedArtifactGrant(createExternalSqlStore(sql.sql),'hf',body.request.parameters.artifactDigest);await runtime.service.execute('task',body);assert.equal(h.task.actions[0].status,'reserved');
  const first=await runtime.cleanupDue(1);assert.equal(first.visited,1);assert.equal(first.needsWork,true);assert.ok(first.nextWake!>=now+60000);
  const restarted=createAutonomousExternalRuntime(options)!;assert.equal((await restarted.cleanupDue(1)).visited,0);
  now=first.nextWake!;const second=await restarted.cleanupDue(1);assert.equal(second.visited,1);assert.ok(second.nextWake!>=now+120000);
  const disabled=createAutonomousExternalRuntime({...options,env:{...env,AUTONOMOUS_EXTERNAL_CREDENTIALS:undefined}})!;assert.equal(disabled.enabled,false);await assert.rejects(approveBridge(disabled.service));
 }finally{h.store.close();sql.db.close();}
});
test('private verified settlement recovers an unaccepted unknown action after the worker lease expires',async()=>{
 const {createAutonomousStore}=await import('../packages/core/src/autonomous-store.js'),{createAutonomousApiService}=await import('../apps/control-plane/src/autonomous-api.js'),{createAutonomousExternalService}=await import(apiModule);
 const h=await bridgeHarness(),main=createAutonomousStore(':memory:');let now=1000;
 try{
  main.create({requestId:'late-proof',goal:'synthetic lost result',provider:'claude',model:'pinned',billingPolicy:{model:'subscription',budget:'external_actions'},endsAt:100000,budgetMicros:100,tools:['Bash','mcp__hivemind__action'],systems:['aws'],externalProfiles:['profile'],credentialIds:['shared'],maxRunMs:120000,maxIterations:4,execution:{backend:'cloudflare',snapshotId:'a'.repeat(64),checks:[{id:'check',argv:['node'],timeoutMs:10000}]}},now,'task');main.approve('task',1,'synthetic approval',now);const lease=main.claimCloud('task','worker','test-only','run',now)!;
  const broker=new ExternalBroker({...h.brokerOptions,transport:{...h.brokerOptions.transport,async execute(){throw Error('synthetic lost provider response');}}}),service=createAutonomousExternalService({...h.options,broker,core:createAutonomousApiService(main,()=>now)});
  await approveBridge(service);await service.execute('task',{...h.body,lease});assert.equal(main.get('task').actions[0]!.status,'reserved');
  now=lease.expiresAt;main.tick(now);await service.beforeCoreMutation('task','cancel');main.cancel('task','synthetic cancel',now);h.final();h.absent();await service.reconcile('task','request');const cleaned=await service.cleanup('task','request');assert.equal(cleaned.resourceId,'resource');assert.equal(main.get('task').resources.length,0);
  assert.equal(main.get('task').reservedMicros,0);assert.equal(main.get('task').spentMicros,3);assert.equal(main.reconcileRun('task','run',0,'synthetic stopped proof',now).status,'cancelled');
 }finally{h.store.close();main.close();}
});
test('operator profiles and action pages expose only metadata with strict authenticated queries',async()=>{
 const {handleAutonomousExternalApi}=await import(apiModule),h=await bridgeHarness();const options={operatorToken:'operator',workerToken:'worker',service:h.service};
 const get=(path:string,token='operator')=>handleAutonomousExternalApi(new Request('http://local/v1/autonomous-tasks/task/'+path,{headers:{authorization:'Bearer '+token}}),options);
 try{
  for(let i=0;i<25;i++)h.store.putJournal({taskId:'task',revision:1,requestId:'request'+i,requestHash:'a'.repeat(64),mainRequestId:'external:'+i,phase:'intent'});
  assert.equal((await get('external-profiles','worker')).status,401);const profiles=await (await get('external-profiles')).json();assert.ok(profiles[0].profileHash);
  const first=await (await get('external-actions?limit=20')).json();assert.equal(first.items.length,20);assert.ok(first.nextCursor);assert.doesNotMatch(JSON.stringify(first),/mainReservationId|mainRequestId|requestHash|ownershipToken/);
  assert.equal((await (await get('external-actions?cursor='+encodeURIComponent(first.nextCursor))).json()).items.length,5);
  for(const query of ['limit=0','limit=101','limit=1&limit=2','cursor=bad','extra=1'])assert.equal((await get('external-actions?'+query)).status,400);
 }finally{h.store.close();}
});
test('concrete AWS profile stays disabled without an injected trusted TTL guard even with credentials',async()=>{
 const {createAutonomousExternalRuntime}=await import('../cloudflare/backend/src/autonomous-external.ts'),h=await bridgeHarness(),sql=sqlFixture();
 const config={version:1,profiles:[h.profile],providers:{aws:{enabled:true,billingPolicy:'reserved_ceiling_only',...h.profile.target,imageId:'ami-123abc',instanceType:'g5.xlarge',subnetId:'subnet-123abc',instanceProfileArn:'arn:aws:iam::123456789012:instance-profile/fixture',maxLifetimeMs:10000,credentialRef:h.profile.credentialRef,maxUpperBoundMicros:10}},ttlGuard:{guardArn:'arn:aws:events:ap-northeast-2:123456789012:rule/fixture-guard'}};
 try{
  const runtime=createAutonomousExternalRuntime({env:{AUTONOMOUS_EXTERNAL_ENABLED:'true',AUTONOMOUS_EXTERNAL_CONFIG:JSON.stringify(config),AUTONOMOUS_EXTERNAL_CREDENTIALS:JSON.stringify({[h.profile.credentialRef]:{provider:'aws',accessKeyId:'fixture-access-key',secretAccessKey:'fixture-private-key'}})},core:h.core,sql:sql.sql,artifacts:{async get(){return null;}},fetch:async()=>{assert.fail('No AWS request is authorized');}})!;
  assert.equal(runtime.enabled,false);assert.equal((await runtime.service.profiles('task'))[0]!.enabled,false);await assert.rejects(approveBridge(runtime.service));assert.equal(h.task.actions.length,0);
 }finally{h.store.close();sql.db.close();}
});
test('factory passes every configured provider and actor secret value to external artifact safety checks',async()=>{
 const {createAutonomousExternalRuntime}=await import('../cloudflare/backend/src/autonomous-external.ts'),{externalArtifactDigest}=await import('../packages/adapters/src/autonomous-external.js');
 for(const marker of ['opaque-github-fixture-value','opaque-root-control-fixture']){
  const h=await bridgeHarness(),sql=sqlFixture();let calls=0;
  const profile={id:'hf',enabled:true,provider:'hf',target:{repository:'owner/model',revision:'main'},operations:['hf.model.commit'],credentialRef:'hf-ref',maxLifetimeMs:10000,upperBoundMicros:10,maxActiveActions:1},artifact={files:[{path:'data.txt',contentBase64:Buffer.from(marker).toString('base64')}]},raw=JSON.stringify(artifact);
  const options:any={env:{AUTONOMOUS_EXTERNAL_ENABLED:'true',AUTONOMOUS_EXTERNAL_CONFIG:JSON.stringify({version:1,profiles:[profile],providers:{hf:{enabled:true,repository:'owner/model',revision:'main'}}}),AUTONOMOUS_EXTERNAL_CREDENTIALS:JSON.stringify({'hf-ref':{provider:'hf',token:'fixture-hf-token'},'gh-ref':{provider:'github',token:'opaque-github-fixture-value'}})},extraSecretValues:['opaque-root-control-fixture'],now:()=>1000,core:h.core,sql:sql.sql,artifacts:{async get(){return {size:Buffer.byteLength(raw),body:new Response(raw).body!};}},fetch:async()=>{calls++;throw Error('Fixture HTTP forbidden');}};
  h.task.spec.externalProfiles=['hf'];
  try{const runtime=createAutonomousExternalRuntime(options)!;await approveBridge(runtime.service);seedArtifactGrant(createExternalSqlStore(sql.sql),'hf',externalArtifactDigest(artifact));await runtime.service.execute('task',{...h.body,request:{profileId:'hf',requestId:'request',operation:'hf.model.commit',parameters:{artifactDigest:externalArtifactDigest(artifact),message:'fixture'}}});assert.equal(calls,0,marker);}
  finally{h.store.close();sql.db.close();}
 }
});
test('credential source refreshes each call without reapproval while target ref or policy changes reject displayed hashes',async()=>{
 const {createAutonomousExternalRuntime}=await import('../cloudflare/backend/src/autonomous-external.ts'),{externalArtifactDigest}=await import('../packages/adapters/src/autonomous-external.js'),h=await bridgeHarness(),sql=sqlFixture();let token='first-opaque-fixture',reads=0;const auth:string[]=[];
 const profile={id:'hf',enabled:true,provider:'hf',target:{repository:'owner/model',revision:'main'},operations:['hf.model.commit'],credentialRef:'hf-ref',maxLifetimeMs:10000,upperBoundMicros:10,maxActiveActions:1},config={version:1,profiles:[profile],providers:{hf:{enabled:true,repository:'owner/model',revision:'main'}}},artifact={files:[{path:'data.txt',contentBase64:Buffer.from('fixture data').toString('base64')}]},raw=JSON.stringify(artifact);
 const options:any={env:{AUTONOMOUS_EXTERNAL_ENABLED:'true',AUTONOMOUS_EXTERNAL_CONFIG:JSON.stringify(config),AUTONOMOUS_EXTERNAL_CREDENTIALS:JSON.stringify({'hf-ref':{provider:'hf',token:'static-fallback-must-not-win'}})},now:()=>1000,core:h.core,sql:sql.sql,secrets:{async get(ref:string){assert.equal(ref,'hf-ref');reads++;return JSON.stringify({provider:'hf',token});}},artifacts:{async get(){return {size:Buffer.byteLength(raw),body:new Response(raw).body!};}},fetch:async(_url:unknown,init:RequestInit)=>{auth.push(new Headers(init.headers).get('authorization')!);throw Error('fixture HTTP aborted');}};
 h.task.spec.externalProfiles=['hf'];
 try{
  const runtime=createAutonomousExternalRuntime(options)!,metadata=await runtime.service.profiles('task');await approveBridge(runtime.service);
  seedArtifactGrant(createExternalSqlStore(sql.sql),'hf',externalArtifactDigest(artifact));await runtime.service.execute('task',{...h.body,request:{profileId:'hf',requestId:'request',operation:'hf.model.commit',parameters:{artifactDigest:externalArtifactDigest(artifact),message:'fixture'}}});assert.ok(auth.includes('Bearer first-opaque-fixture'));
  token='second-opaque-fixture';await runtime.service.reconcile('task','request');assert.ok(auth.includes('Bearer second-opaque-fixture'));assert.ok(reads>=2);assert.ok(runtime.configuredSecretValues().includes(token));assert.equal((await runtime.service.profiles('task'))[0]!.profileHash,metadata[0]!.profileHash);
  for(const changed of [{...config,credentialPolicyRevision:'policy-v2'},{...config,profiles:[{...profile,credentialRef:'different-ref'}]},{...config,profiles:[{...profile,target:{repository:'owner/changed',revision:'main'}}],providers:{hf:{enabled:true,repository:'owner/changed',revision:'main'}}}]){
   const runtime2=createAutonomousExternalRuntime({...options,env:{...options.env,AUTONOMOUS_EXTERNAL_CONFIG:JSON.stringify(changed)}})!;await assert.rejects(runtime2.service.assertApproval('task',1,{hf:metadata[0]!.profileHash}),(e:any)=>e.statusCode===409);
  }
 }finally{h.store.close();sql.db.close();}
});
test('startup recovery marks durable broker state without performing provider reconciliation I/O',async()=>{
 const h=await bridgeHarness();try{await approveBridge(h.service);await h.service.execute('task',h.body);let inspected=0;const reconcile=h.broker.reconcile.bind(h.broker);h.broker.reconcile=async(id:string)=>{inspected++;return reconcile(id);};await h.service.recover();assert.equal(inspected,0);}finally{h.store.close();}
});
test('factory constructs the concrete AWS guard from strict explicit configuration without any AWS call',async()=>{
 const {createAutonomousExternalRuntime}=await import('../cloudflare/backend/src/autonomous-external.ts'),h=await bridgeHarness(),sql=sqlFixture();h.profile.maxLifetimeMs=60000;
 const aws={enabled:true,billingPolicy:'reserved_ceiling_only',...h.profile.target,imageId:'ami-123abc',instanceType:'g5.xlarge',subnetId:'subnet-123abc',instanceProfileArn:'arn:aws:iam::123456789012:instance-profile/fixture',maxLifetimeMs:60000,credentialRef:h.profile.credentialRef,maxUpperBoundMicros:10};
 const guardArn='arn:aws:events:ap-northeast-2:123456789012:rule/fixture-guard';
 const guard={accountId:'123456789012',region:'ap-northeast-2',guardArn,functionArn:'arn:aws:lambda:ap-northeast-2:123456789012:function:fixture-guard',scheduleGroupArn:'arn:aws:scheduler:ap-northeast-2:123456789012:schedule-group/fixture',schedulerRoleArn:'arn:aws:iam::123456789012:role/scheduler',expectedCodeSha256:Buffer.alloc(32).toString('base64'),credentialRef:'guard-ref',manifest:{schemaVersion:1,ownershipMode:'broker_uuid_registry_v1',registryTableArn:'arn:aws:dynamodb:ap-northeast-2:123456789012:table/fixture-registry',guardArn,validUntil:100000,profiles:[{workloadId:'test',configurationHash:'a'.repeat(64),parameterPolicy:'opaque_broker_sha256',instanceProfileArn:aws.instanceProfileArn,maxLifetimeMs:60000,launchHeadroomMs:1000,quote:{source:'fixture quote only',maxExposureMicros:10,validUntil:100000}}]},rolePolicies:['guard','scheduler','workload'].map(kind=>({kind,roleArn:'arn:aws:iam::123456789012:role/'+kind,boundaryArn:'arn:aws:iam::123456789012:policy/'+kind,inlinePolicyName:'fixture'}))};
 const options:any={env:{AUTONOMOUS_EXTERNAL_ENABLED:'true',AUTONOMOUS_EXTERNAL_CONFIG:JSON.stringify({version:1,profiles:[h.profile],providers:{aws},ttlGuard:{guardArn}}),AUTONOMOUS_EXTERNAL_CREDENTIALS:JSON.stringify({[h.profile.credentialRef]:{provider:'aws',accessKeyId:'fixture-workload-access',secretAccessKey:'fixture-workload-secret'},'guard-ref':{provider:'aws',accessKeyId:'fixture-guard-access',secretAccessKey:'fixture-guard-secret'}}),AUTONOMOUS_AWS_GUARD_CONFIG:JSON.stringify(guard)},now:()=>1000,core:h.core,sql:sql.sql,artifacts:{async get(){return null;}},fetch:async()=>{assert.fail('No real or fixture AWS call during composition');}};
 try{
  const runtime=createAutonomousExternalRuntime(options)!;assert.equal(runtime.enabled,true);assert.equal((await runtime.service.profiles('task'))[0]!.enabled,true);assert.ok(runtime.configuredSecretValues().includes('fixture-guard-secret'));
  assert.throws(()=>createAutonomousExternalRuntime({...options,env:{...options.env,AUTONOMOUS_AWS_GUARD_CONFIG:JSON.stringify({...guard,url:'https://untrusted/'})}}));
  assert.throws(()=>createAutonomousExternalRuntime({...options,env:{...options.env,AUTONOMOUS_AWS_GUARD_CONFIG:JSON.stringify({...guard,accountId:'999999999999'})}}));
 }finally{h.store.close();sql.db.close();}
});
test('verified cost policy requires a configured reader and composes SQL cache plus private billing ref without network',async()=>{
 const {createAutonomousExternalRuntime}=await import('../cloudflare/backend/src/autonomous-external.ts'),h=await bridgeHarness(),sql=sqlFixture();
 const aws={enabled:true,billingPolicy:'verified_cost_source',...h.profile.target,imageId:'ami-123abc',instanceType:'g5.xlarge',subnetId:'subnet-123abc',instanceProfileArn:'arn:aws:iam::123456789012:instance-profile/fixture',maxLifetimeMs:10000,credentialRef:h.profile.credentialRef,maxUpperBoundMicros:10},guardArn='arn:aws:events:ap-northeast-2:123456789012:rule/fixture';
 const cost={accountId:'123456789012',resourceRegion:'ap-northeast-2',workloadId:'test',queryUpperBoundMicros:1,maxQueryCount:2,resourceUpperBoundMicros:8,credentialRef:'billing-ref',tagActivation:{evidenceId:'fixture-only',activeSince:0,observedAt:0,validUntil:100000}};
 const options:any={env:{AUTONOMOUS_EXTERNAL_ENABLED:'true',AUTONOMOUS_EXTERNAL_CONFIG:JSON.stringify({version:1,profiles:[h.profile],providers:{aws},ttlGuard:{guardArn}}),AUTONOMOUS_EXTERNAL_CREDENTIALS:JSON.stringify({[h.profile.credentialRef]:{provider:'aws',accessKeyId:'fixture-access',secretAccessKey:'fixture-secret'},'billing-ref':{provider:'aws',accessKeyId:'billing-access',secretAccessKey:'billing-secret'}})},now:()=>1000,core:h.core,sql:sql.sql,artifacts:{async get(){return null;}},awsTtlGuard:{async attest(){throw Error('fixture only');},async arm(){throw Error('fixture only');}},fetch:async()=>assert.fail('No AWS request during cost reader composition')};
 try{
  assert.equal(createAutonomousExternalRuntime(options)!.enabled,false);
  const configured=createAutonomousExternalRuntime({...options,env:{...options.env,AUTONOMOUS_EXTERNAL_COST_CONFIG:JSON.stringify(cost)}})!;assert.equal(configured.enabled,true);assert.ok(sql.db.prepare("SELECT name FROM sqlite_master WHERE name='external_cost_cache'").get());assert.ok(configured.configuredSecretValues().includes('billing-secret'));
  assert.throws(()=>createAutonomousExternalRuntime({...options,env:{...options.env,AUTONOMOUS_EXTERNAL_COST_CONFIG:JSON.stringify({...cost,resourceUpperBoundMicros:11})}}));
 }finally{h.store.close();sql.db.close();}
});
test('local external SQL adapter streams chunk rows instead of materializing all selected chunks',async()=>{
 const {createExternalStore}=await import(storeModule),prepare=DatabaseSync.prototype.prepare;
 DatabaseSync.prototype.prepare=function(query:string){const statement=prepare.call(this,query);if(/FROM external_chunks/.test(query))Object.defineProperty(statement,'all',{value(){throw Error('Chunk rows materialized');}});return statement;};
 let store:any;
 try{store=createExternalStore(':memory:');store.transaction(()=>undefined);assert.equal(store.transaction((state:any)=>state.version),1);}
 finally{store?.close();DatabaseSync.prototype.prepare=prepare;}
});
test('lost committed reservation is fenced and settled as provably undispatched after SQLite reopen without a worker retry',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'orphan-reserve-')),path=join(dir,'external.sqlite'),h=await bridgeHarness(path),{createAutonomousStore}=await import('../packages/core/src/autonomous-store.js'),{createAutonomousApiService}=await import('../apps/control-plane/src/autonomous-api.js'),{createAutonomousExternalService}=await import(apiModule),main=createAutonomousStore(join(dir,'main.sqlite'));let now=1000,reopened:any;
 try{
  main.create({requestId:'orphan',goal:'synthetic orphan proof',provider:'claude',model:'pinned',billingPolicy:{model:'subscription',budget:'external_actions'},endsAt:100000,budgetMicros:100,tools:['Bash','mcp__hivemind__action'],systems:['aws'],externalProfiles:['profile'],credentialIds:['shared'],maxRunMs:120000,maxIterations:4,execution:{backend:'cloudflare',snapshotId:'a'.repeat(64),checks:[{id:'check',argv:['node'],timeoutMs:1000}]}},now,'task');main.approve('task',1,'fixture',now);const lease=main.claimCloud('task','worker','fixture','run',now)!,core=createAutonomousApiService(main,()=>now);let lose=true;
  const service=createAutonomousExternalService({...h.options,core:{async execute(op:any,input:any){const result=await core.execute(op,input);if(op==='reserve'&&lose){lose=false;throw Error('committed response lost');}return result;}}});await approveBridge(service);await assert.rejects(service.execute('task',{...h.body,lease}),/response lost/);assert.equal(main.get('task').reservedMicros,10);h.store.close();now=lease.expiresAt;main.tick(now);
  const {createExternalStore}=await import(storeModule);reopened=createExternalStore(path);const broker=new ExternalBroker({...h.brokerOptions,store:reopened}),restart=createAutonomousExternalService({...h.options,store:reopened,broker,core});await restart.recover();const result=await restart.reconcile('task','request');assert.equal(result.billingEvidence,'undispatched_intent');assert.equal(result.verifiedCostMicros,0);assert.equal(result.resourceId,undefined);assert.equal(main.get('task').reservedMicros,0);assert.equal(main.get('task').actions[0]!.status,'failed');assert.equal(h.dispatches,0);assert.equal(main.get('task').runs[0]!.usageUnavailable,true);
 }finally{main.close();h.store.close();reopened?.close();rmSync(dir,{recursive:true,force:true});}
});
test('orphan recovery fences a deferred reserve reply before zero settlement so the late worker never dispatches',async()=>{
 const h=await bridgeHarness(),{createAutonomousExternalService}=await import(apiModule);let pending:Promise<unknown>|undefined;let release!:()=>void,committed!:()=>void;const blocked=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{committed=r;});
 const service=createAutonomousExternalService({...h.options,core:{async execute(op:any,input:any){const result=await h.core.execute(op,input);if(op==='reserve'){committed();await blocked;}return result;}}});
 try{await approveBridge(service);pending=service.execute('task',h.body);await ready;const recovered=await service.reconcile('task','request');assert.equal(recovered.verifiedCostMicros,0);release();const late=await pending as import('../apps/control-plane/src/autonomous-external-api.js').ExternalPublicAction;assert.equal(late.billingEvidence,'undispatched_intent');assert.equal(h.dispatches,0);assert.equal(h.store.getJournal('task',1,'request').dispatchBlocked,true);}
 finally{release();await pending?.catch(()=>{});h.store.close();}
});
test('operator billing route authenticates before parsing and strictly bounds explicit evidence',async()=>{
 const {handleAutonomousExternalApi}=await import(apiModule),h=await bridgeHarness();const calls:unknown[]=[];
 const service={...h.service,async attestBilling(id:string,requestId:string,billing:unknown){calls.push({id,requestId,billing});return {revision:1,requestId,phase:'settled',billingSource:'operator_attested',evidenceRef:'invoice-fixture',attestedAt:1000};}};
 const post=(body:unknown,token='operator')=>handleAutonomousExternalApi(new Request('http://local/v1/autonomous-tasks/task/external-actions/request/billing',{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify(body)}),{operatorToken:'operator',workerToken:'worker',service});
 try{
  const denied=await handleAutonomousExternalApi(new Request('http://local/v1/autonomous-tasks/task/external-actions/request/billing',{method:'POST',headers:{authorization:'Bearer worker'},body:'not json'}),{operatorToken:'operator',workerToken:'worker',service});assert.equal(denied.status,401);
  const billing={actualCostMicros:3,evidenceRef:'invoice-fixture',reason:'Operator verified actual invoice'};
  assert.equal((await post(billing)).status,200);assert.deepEqual(calls,[{id:'task',requestId:'request',billing}]);
  for(const patch of [{actualCostMicros:0},{actualCostMicros:-1},{actualCostMicros:Number.MAX_SAFE_INTEGER+1},{evidenceRef:'https://invoice.example/a?secret=fixture'},{evidenceRef:'https://invoice.example/a'},{evidenceRef:''},{reason:'x'.repeat(1001)},{reason:'line\nbreak'},{reason:''},{extra:true}])assert.equal((await post({...billing,...patch})).status,400);
  assert.equal(calls.length,1);
 }finally{h.store.close();}
});
test('repeated request ID across revisions requires explicit journal revision and never prefers current',async()=>{
 const h=await bridgeHarness();try{
  await approveBridge(h.service);await h.service.execute('task',h.body);
  const first=h.store.getJournal('task',1,'request')!;h.task.revision=2;
  h.store.putJournal({...first,revision:2,requestHash:'b'.repeat(64),mainRequestId:'external:'+ 'b'.repeat(64),brokerActionId:undefined,mainReservationId:undefined,request:undefined,reservation:undefined,phase:'intent'});
  await assert.rejects(h.service.reconcile('task','request'),(e:any)=>e.statusCode===409);
  const service=h.service as typeof h.service & {reconcile(id:string,requestId:string,revision?:number):Promise<{revision:number}>};
  assert.equal((await service.reconcile('task','request',1)).revision,1);
 }finally{h.store.close();}
});
test('operator billing cannot replace ambiguous results or waive a live resource and preserves provider provenance',async()=>{
 const h=await bridgeHarness(),billing={actualCostMicros:3,evidenceRef:'invoice-fixture',reason:'Operator verified invoice',revision:1};
 try{
  await approveBridge(h.service);await h.service.execute('task',h.body);
  await assert.rejects(h.service.attestBilling('task','request',billing),(e:any)=>e.statusCode===409);
  assert.equal(h.task.actions[0].status,'accepted');await h.service.beforeCoreMutation('task','cancel');h.absent();await h.service.cleanup('task','request',1);
  const reviewed=await h.service.attestBilling('task','request',billing);assert.equal(reviewed.revision,1);assert.equal(reviewed.billingSource,'operator_attested');assert.equal(reviewed.evidenceRef,billing.evidenceRef);assert.equal(reviewed.attestedAt,1000);assert.equal(reviewed.verifiedCostMicros,3);
  const broker=h.store.transaction((s:any)=>Object.values(s.actions)[0] as any);assert.equal(broker.providerReceipt.billing.final,false);assert.equal(broker.providerReceipt.billing.verifiedCostMicros,null);assert.equal(broker.operatorBilling.reason,billing.reason);
  const again=await h.service.attestBilling('task','request',billing);assert.deepEqual(again,reviewed);await assert.rejects(h.service.attestBilling('task','request',{...billing,actualCostMicros:4}),(e:any)=>e.statusCode===409);
 }finally{h.store.close();}
 const ambiguous=await bridgeHarness();try{await approveBridge(ambiguous.service);const {createAutonomousExternalService}=await import(apiModule),broker=new ExternalBroker({...ambiguous.brokerOptions,transport:{...ambiguous.brokerOptions.transport,execute:async()=>{throw Error('Unknown provider result');}}});const service=createAutonomousExternalService({...ambiguous.options,broker});await service.execute('task',ambiguous.body);await assert.rejects(service.attestBilling('task','request',billing),(e:any)=>e.statusCode===409);assert.equal(ambiguous.task.actions[0].status,'reserved');}finally{ambiguous.store.close();}
});
test('actual canonical billing settlement records cash and exactly one operator reconciliation after real absence proof',async()=>{
 const h=await bridgeHarness(),{createAutonomousStore}=await import('../packages/core/src/autonomous-store.js'),{createAutonomousApiService}=await import('../apps/control-plane/src/autonomous-api.js'),{createAutonomousExternalService}=await import(apiModule),main=createAutonomousStore(':memory:');const now=1000;
 try{
  main.create({requestId:'billing-review',goal:'synthetic invoice closing',provider:'claude',model:'pinned',billingPolicy:{model:'subscription',budget:'external_actions'},endsAt:100000,budgetMicros:100,tools:['Bash','mcp__hivemind__action'],systems:['aws'],externalProfiles:['profile'],credentialIds:['shared'],maxRunMs:120000,maxIterations:4,execution:{backend:'cloudflare',snapshotId:'a'.repeat(64),checks:[{id:'check',argv:['node'],timeoutMs:1000}]}},now,'task');main.approve('task',1,'fixture',now);const lease=main.claimCloud('task','worker','fixture','run',now)!;
  const service=createAutonomousExternalService({...h.options,core:createAutonomousApiService(main,()=>now)});await approveBridge(service);await service.execute('task',{...h.body,lease});
  const usage={inputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:1};main.recordNativeReceipt(lease,{runId:'run',runtimeId:'runtime',sessionId:'synthetic-session',model:'pinned',sequence:1,usage,stopped:true,outcome:'complete'},now);
  await service.beforeCoreMutation('task','cancel');main.cancel('task','operator cancelled',now);main.finishCloud(lease,{outcome:'complete',usage,costMicros:null,checkpoint:{sessionId:'synthetic-session',model:'pinned',sequence:1,objectKey:'synthetic-private'}},true,now);
  h.absent();await service.cleanup('task','request',1);assert.equal(main.get('task').status,'stopping');
  const bill={actualCostMicros:3,evidenceRef:'invoice-fixture',reason:'Verified actual invoice',revision:1};await service.attestBilling('task','request',bill);
  const task=main.get('task');assert.equal(task.spentMicros,3);assert.equal(task.reservedMicros,0);assert.equal(task.status,'cancelled');assert.equal(task.interventions.filter(i=>i.kind==='reconciliation').length,1);
  assert.equal((task.actions[0] as any).operatorBillingEvidence.source,'operator_attested');await service.attestBilling('task','request',bill);assert.equal(main.get('task').interventions.filter(i=>i.kind==='reconciliation').length,1);
 }finally{main.close();h.store.close();}
});
test('historical action audit uses durable approved target and hash after the current registry changes',async()=>{
 const h=await bridgeHarness();try{
  await approveBridge(h.service);await h.service.execute('task',h.body);
  const approved=h.store.transaction((s:any)=>Object.values(s.approvals)[0] as any),target=structuredClone(approved.profile.target);
  h.profile.target.workloadId='new-workload';const prospective=await h.service.profiles('task');assert.equal((prospective[0].target as any).workloadId,'new-workload');
  const rows=await h.service.list('task',{limit:20}) as {items:any[]};assert.equal(rows.items[0].profileId,approved.profileId);assert.deepEqual(rows.items[0].approvedTarget,target);assert.equal(rows.items[0].approvedProfileHash,approved.profileHash);
  const single=await h.service.reconcile('task','request',1) as any;assert.deepEqual(single.approvedTarget,target);assert.equal(single.approvedProfileHash,approved.profileHash);
  assert.doesNotMatch(JSON.stringify(rows),/private-ref|ownershipToken|idempotencyKey|credentialRef|private-credential/);
 }finally{h.store.close();}
});
test('historical audit reads the broker approval and action snapshot once for a twenty-row page',async()=>{
 const h=await bridgeHarness();let resource=0;try{
  h.profile.maxActiveActions=30;h.task.spec.budgetMicros=1000;
  h.brokerOptions.transport.execute=async inv=>({ownershipToken:inv.ownershipToken,idempotencyKey:inv.idempotencyKey,evidenceId:'synthetic-owned-receipt',outcome:'succeeded',effect:'resource',resource:{id:'i-'+(++resource).toString(16).padStart(8,'0'),cleanupRequired:true},billing:{verifiedCostMicros:null,final:false}});
  await approveBridge(h.service);for(let i=0;i<20;i++)await h.service.execute('task',{...h.body,request:{...h.body.request,requestId:'audit'+i}});
  const transaction=h.store.transaction.bind(h.store);let reads=0;h.store.transaction=(fn:any)=>{reads++;return transaction(fn);};
  const page=await h.service.list('task',{limit:20}) as {items:any[]};assert.equal(page.items.length,20);assert.equal(reads,1);assert.ok(page.items.every(row=>row.profileId==='profile'&&row.approvedTarget.workloadId==='test'));
 }finally{h.store.close();}
});
test('historical HF and GitHub targets expose only their exact approved repository/ref fields',async()=>{
 for(const provider of ['hf','github'] as const){const h=await bridgeHarness();try{
  const profile={id:'profile',enabled:true,provider,target:provider==='hf'?{repository:'owner/model',revision:'main'}:{repository:'owner/repo',branch:'feature'},operations:[provider==='hf'?'hf.model.commit':'github.branch.push'],credentialRef:'private-ref',maxLifetimeMs:10000,upperBoundMicros:10,maxActiveActions:1} as import('../packages/contracts/src/autonomous-external.js').ExternalProfile;
  const broker=new ExternalBroker({...h.brokerOptions,registry:{get:()=>profile},transport:{...h.brokerOptions.transport,execute:async inv=>({ownershipToken:inv.ownershipToken,idempotencyKey:inv.idempotencyKey,evidenceId:'private-provider-evidence',outcome:'succeeded',effect:'retained',billing:{verifiedCostMicros:null,final:false}})}});
  const {createAutonomousExternalService}=await import(apiModule),service=createAutonomousExternalService({...h.options,broker,registry:{get:()=>profile}});await approveBridge(service);
  const operation=provider==='hf'?'hf.model.commit':'github.branch.push',parameters=provider==='hf'?{artifactDigest:'a'.repeat(64),message:'fixture'}:{artifactDigest:'a'.repeat(64),expectedHead:'b'.repeat(40)};
  seedArtifactGrant(h.store,'profile','a'.repeat(64));await service.execute('task',{...h.body,request:{profileId:'profile',requestId:'request',operation,parameters}} as any);const old=structuredClone(profile.target);if(profile.provider==='aws')assert.fail('Unexpected provider');profile.target.repository='owner/new-target';
  const rows=await service.list('task',{limit:20}) as {items:any[]};assert.deepEqual(rows.items[0].approvedTarget,old);assert.deepEqual(Object.keys(rows.items[0].approvedTarget).sort(),provider==='hf'?['repository','revision']:['branch','repository']);assert.doesNotMatch(JSON.stringify(rows),/private-ref|private-provider-evidence|ownershipToken|credentialRef/);
 }finally{h.store.close();}}
});
test('safe publication audit retains durable artifact digest and provider commit without echoing message or receipt',async()=>{
 for(const provider of ['hf','github'] as const){const h=await bridgeHarness();try{
  const profile={id:'profile',enabled:true,provider,target:provider==='hf'?{repository:'owner/model',revision:'main'}:{repository:'owner/repo',branch:'feature'},operations:[provider==='hf'?'hf.model.commit':'github.branch.push'],credentialRef:'private-ref',maxLifetimeMs:10000,upperBoundMicros:10,maxActiveActions:1} as import('../packages/contracts/src/autonomous-external.js').ExternalProfile;
  const oid='c'.repeat(provider==='hf'?40:64),evidenceId=provider+':'+oid;
  const broker=new ExternalBroker({...h.brokerOptions,registry:{get:()=>profile},transport:{...h.brokerOptions.transport,execute:async inv=>({ownershipToken:inv.ownershipToken,idempotencyKey:inv.idempotencyKey,evidenceId,outcome:'succeeded',effect:'retained',billing:{verifiedCostMicros:null,final:false}})}});
  const {createAutonomousExternalService}=await import(apiModule),service=createAutonomousExternalService({...h.options,broker,registry:{get:()=>profile}});await approveBridge(service);
  const parameters=provider==='hf'?{artifactDigest:'a'.repeat(64),message:'MESSAGE_NOT_FOR_AUDIT'}:{artifactDigest:'a'.repeat(64),expectedHead:'b'.repeat(40)};
  seedArtifactGrant(h.store,'profile','a'.repeat(64));const result=await service.execute('task',{...h.body,request:{profileId:'profile',requestId:'request',operation:provider==='hf'?'hf.model.commit':'github.branch.push',parameters}} as any) as any;
  const durable=h.store.transaction((s:any)=>Object.values(s.actions)[0] as any);
  assert.equal(result.parameterHash,durable.parametersHash);assert.deepEqual(result.parameters,provider==='hf'?{artifactDigest:'a'.repeat(64)}:{artifactDigest:'a'.repeat(64),expectedHead:'b'.repeat(40)});assert.deepEqual(result.providerResult,{kind:provider==='hf'?'hf_commit':'github_commit',oid});
  const page=await service.list('task',{limit:20}) as {items:any[]};assert.deepEqual(page.items[0].providerResult,result.providerResult);assert.equal(page.items[0].parameterHash,durable.parametersHash);
  assert.doesNotMatch(JSON.stringify(page),/MESSAGE_NOT_FOR_AUDIT|evidenceId|ownershipToken|private-ref|credentialRef/);assert.equal(JSON.stringify(page).includes(evidenceId),false);
 }finally{h.store.close();}}
});
test('AWS audit exposes only validated instance evidence while mixed provider or URL evidence stays absent',async()=>{
 for(const evidenceId of ['aws:i-123abcde','hf:'+ 'a'.repeat(40),'aws:https://example.com/instance','aws:i-invalid','private-provider-evidence']){const h=await bridgeHarness();try{
  h.brokerOptions.transport.execute=async inv=>({ownershipToken:inv.ownershipToken,idempotencyKey:inv.idempotencyKey,evidenceId,outcome:'succeeded',effect:'resource',resource:{id:'i-123abcde',cleanupRequired:true},billing:{verifiedCostMicros:null,final:false}});
  await approveBridge(h.service);const result=await h.service.execute('task',h.body) as any;
  assert.deepEqual(result.parameters,{lifetimeMs:10000});assert.equal(result.parameterHash,h.store.transaction((s:any)=>(Object.values(s.actions)[0] as any).parametersHash));
  assert.deepEqual(result.providerResult,evidenceId==='aws:i-123abcde'?{kind:'aws_instance',id:'i-123abcde'}:undefined);assert.equal(Object.hasOwn(result,'evidenceId'),false);
 }finally{h.store.close();}}
});

function seedArtifactGrant(store:import('../packages/core/src/autonomous-external-sql.ts').ExternalDurableStore,profileId:string,artifactDigest:string){
 const approval=store.transaction(s=>Object.values(s.approvals).find(p=>p.taskId==='task'&&p.revision===1&&p.profileId===profileId))!;
 const grant={taskId:'task',revision:1,profileId,artifactDigest,profileHash:approval.profileHash,configurationFingerprint:store.approvalFingerprint('task',1,profileId)!,bytes:0};store.reserveArtifactGrant(grant);store.bindArtifactGrant(grant);
}
