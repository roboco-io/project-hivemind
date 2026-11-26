import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {ExternalBroker} from '../../../packages/core/src/autonomous-external.ts';
import {createExternalSqlStore} from '../../../packages/core/src/autonomous-external-sql.ts';
import {AutonomousService} from '../src/autonomous-service.ts';
import {createSnapshot} from '../src/snapshot.ts';
import type {AutonomousSpec,AutonomousTask} from '../../../packages/contracts/src/autonomous.ts';
registerHooks({resolve(specifier,context,next){if(specifier==='cloudflare:workers')return {url:'data:text/javascript,'+encodeURIComponent('export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}} export class WorkerEntrypoint {}'),shortCircuit:true};return next(specifier,context);}});
const snapshot=createSnapshot([]);
async function fixture(enabled='true'){
 const db=new DatabaseSync(':memory:'),rows=new Map<string,unknown>();let alarm:number|null=null,runnerCalls=0;
 const sql={exec(query:string,...bindings:(string|number|null)[]){const statement=db.prepare(query);const result=statement.columns().length?statement.all(...bindings):(statement.run(...bindings),[]);return Object.assign(result,{toArray(){return [...result];}});}};
 const storage={sql,transactionSync<T>(fn:()=>T){db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value;}catch(e){db.exec('ROLLBACK');throw e;}},async transaction<T>(fn:(tx:any)=>Promise<T>){const before=structuredClone(rows);try{return await fn(storage);}catch(e){rows.clear();for(const [k,v] of before)rows.set(k,v);throw e;}},async get<T>(key:string){return structuredClone(rows.get(key)) as T|undefined;},async put(key:string,value:unknown){rows.set(key,structuredClone(value));},async delete(key:string){return rows.delete(key);},async getAlarm(){return alarm;},async setAlarm(value:number){alarm=value;}};
 const profile={id:'hf',enabled:true,provider:'hf',target:{repository:'fixture/model',revision:'main'},operations:['hf.model.commit'],credentialRef:'fixture-hf',maxLifetimeMs:60000,upperBoundMicros:10,maxActiveActions:1};
 const env={AUTONOMOUS_EXTERNAL_ENABLED:enabled,AUTONOMOUS_EXTERNAL_CONFIG:JSON.stringify({version:1,profiles:[profile],providers:{hf:{enabled:true,repository:'fixture/model',revision:'main'}}}),AUTONOMOUS_EXTERNAL_CREDENTIALS:JSON.stringify({'fixture-hf':{provider:'hf',token:'opaque-fixture-credential'}}),AUTONOMOUS_CLOUD_ENABLED:'true',AUTONOMOUS_CONTROL_ORIGIN:'https://control.example',AUTONOMOUS_SESSION_KEY:Buffer.alloc(32,2).toString('base64'),AUTONOMOUS_WORKER_TOKEN:'fixture-worker',AUTONOMOUS_REPORTER_TOKEN:'fixture-reporter',CONTROL_TOKEN:'fixture-operator',AUTH_STORAGE_KEY:'fixture-storage',AUTH_RETURN_PUBLIC_KEY:'fixture-public',AUTH_RETURN_PRIVATE_KEY:'fixture-private',CLAUDE_NESTED_APPROVED:'true',ARTIFACTS:{async get(key:string){if(key==='snapshots/'+snapshot.digest+'.json')return {async json(){return snapshot;}};return null;}},CREDENTIALS:{async get(){return null;}},RUNNER:{getByName(){runnerCalls++;throw Error('Native/model execution forbidden in actor fixture');}},SCHEDULER:{getByName(){return {fetch:(request:Request)=>actor.fetch(request)};}}};
 const {SchedulerDO,default:worker}=await import('../src/cloudflare/worker.ts');let actor:InstanceType<typeof SchedulerDO>;
 async function restart(){const pending:Promise<unknown>[]=[];const ctx={storage,blockConcurrencyWhile(fn:()=>Promise<unknown>){const p=fn();pending.push(p);return p;}};actor=new SchedulerDO(ctx as never,env as never);await Promise.all(pending);return actor;}
 await restart();const service=new AutonomousService(storage);
 const spec:AutonomousSpec={requestId:'external-fixture',goal:'synthetic external actor',provider:'claude',model:'pinned',billingPolicy:{model:'subscription',budget:'external_actions'},endsAt:Date.now()+500000,budgetMicros:100,tools:['Bash','mcp__hivemind__action'],systems:['hf'],externalProfiles:['hf'],credentialIds:['shared'],maxRunMs:120000,maxIterations:4,execution:{backend:'cloudflare',snapshotId:snapshot.digest,checks:[{id:'check',argv:['node'],timeoutMs:1000}]}};
 const task=await service.execute('create',{spec}) as AutonomousTask;
 const call=(suffix:string,body?:unknown,token='fixture-operator')=>worker.fetch(new Request('https://control.example/v1/autonomous-tasks/'+task.id+'/'+suffix,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})}),env as never);
 return {db,rows,storage,env,task,service,call,restart,get actor(){return actor;},get alarm(){return alarm;},clearAlarm(){alarm=null;},get runnerCalls(){return runnerCalls;}};
}
test('Worker and actor external routes authenticate before body parsing and expose configured profile hashes',async()=>{
 const f=await fixture();try{
  assert.equal((await f.call('external-action','{','fixture-operator')).status,401);
  assert.equal((await f.call('external-profiles',undefined,'fixture-worker')).status,401);
  const response=await f.call('external-profiles');assert.equal(response.status,200);const profiles=await response.json() as any[];assert.equal(profiles[0].id,'hf');assert.match(profiles[0].profileHash,/^[a-f0-9]{64}$/);assert.doesNotMatch(JSON.stringify(profiles),/opaque-fixture-credential|secretAccessKey/);
 }finally{f.db.close();}
});
test('actor binds displayed profile hashes before canonical approval and refuses silent target changes',async()=>{
 const f=await fixture();try{
  const response=await f.call('external-profiles');assert.equal(response.status,200);const profiles=await response.json() as any[];
  assert.equal((await f.call('approve',{revision:1,reason:'fixture approval'})).status,400);assert.equal((await f.service.execute('get',{id:f.task.id}) as AutonomousTask).status,'awaiting_approval');
  const approval=await f.call('approve',{revision:1,reason:'fixture approval',externalProfileHashes:{hf:profiles[0].profileHash}});assert.equal(approval.status,200,await approval.text());
  const encoded=JSON.stringify(f.rows.get('autonomous-cloud-approval:'+f.task.id));assert.doesNotMatch(encoded,/opaque-fixture-credential/);assert.equal(f.runnerCalls,0);
 }finally{f.db.close();}
});
test('global feature false denies external approval without starting a model',async()=>{
 const f=await fixture('false');try{
  const result=await f.call('approve',{revision:1,reason:'fixture',externalProfileHashes:{hf:'a'.repeat(64)}});assert.equal(result.status,503);assert.equal(f.runnerCalls,0);
 }finally{f.db.close();}
});
test('external credential refresh preserves native approval fingerprint while changed target revokes readiness',async()=>{
 const f=await fixture();try{
  const metadata=await (await f.call('external-profiles')).json() as any[];assert.equal((await f.call('approve',{revision:1,reason:'fixture',externalProfileHashes:{hf:metadata[0].profileHash}})).status,200);
  const saved=f.rows.get('autonomous-cloud-approval:'+f.task.id) as {fingerprint:string};
  f.env.AUTONOMOUS_EXTERNAL_CREDENTIALS=JSON.stringify({'fixture-hf':{provider:'hf',token:'refreshed-opaque-fixture'}});await f.restart();
  assert.equal((f.actor as any).nativeConfigurationFingerprint(),saved.fingerprint);
  assert.throws(()=>(f.actor as any).assertNativeModelDataSafe('refreshed-opaque-fixture',null,undefined,'subscription-fixture','lease-fixture'),/rejected/);
  const config=JSON.parse(f.env.AUTONOMOUS_EXTERNAL_CONFIG);config.profiles[0].target.repository='fixture/changed';config.providers.hf.repository='fixture/changed';f.env.AUTONOMOUS_EXTERNAL_CONFIG=JSON.stringify(config);await f.restart();
  assert.equal(await (f.actor as any).nativeApprovalReady(await f.service.execute('get',{id:f.task.id})),false);assert.equal(f.runnerCalls,0);
 }finally{f.db.close();}
});
test('external pending cleanup alarms back off without invoking native runner',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:Date.now()});const f=await fixture();try{
  const metadata=await (await f.call('external-profiles')).json() as any[];assert.equal((await f.call('approve',{revision:1,reason:'fixture',externalProfileHashes:{hf:metadata[0].profileHash}})).status,200);
  const lease=await f.service.execute('claimCloud',{id:f.task.id,workerId:'fixture-worker-id',token:'fixture-lease',runId:'fixture-run'}) as any;
  seedArtifactGrant(f);
  const response=await f.call('external-action',{lease,runtimeId:'fixture-runtime',request:{profileId:'hf',requestId:'request',operation:'hf.model.commit',parameters:{artifactDigest:'a'.repeat(64),message:'fixture'}}},'fixture-worker');assert.equal(response.status,200,await response.text());
  assert.equal((await f.service.execute('get',{id:f.task.id}) as AutonomousTask).reservedMicros,10);
  assert.equal((await f.call('cancel',{reason:'fixture cancellation'})).status,200);
  t.mock.timers.setTime(lease.expiresAt);f.clearAlarm();await f.actor.alarm();assert.equal(f.runnerCalls,0);assert.ok(f.alarm!>=Date.now()+60000);
  await f.restart();f.clearAlarm();await f.actor.alarm();assert.equal(f.runnerCalls,0);assert.ok(f.alarm!>=Date.now()+60000);assert.equal((await f.service.execute('get',{id:f.task.id}) as AutonomousTask).reservedMicros,10);
 }finally{f.db.close();}
});
test('startup recovery runs only at actor construction and never reclassifies an active call on metadata reads',async()=>{
 const f=await fixture(),store=createExternalSqlStore({exec:(q,...b)=>f.storage.sql.exec(q,...b),transactionSync:fn=>f.storage.transactionSync(fn)});
 let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});
 const profile={id:'hf',enabled:true,provider:'hf' as const,target:{repository:'fixture/model',revision:'main'},operations:['hf.model.commit' as const],credentialRef:'fixture-hf',maxLifetimeMs:60000,upperBoundMicros:10,maxActiveActions:1};
 const broker=new ExternalBroker({store,registry:{get:()=>profile},resolver:{async withCredential(_r,_s,consume){await blocked;return consume('fixture');}},transport:{async execute(inv){return {ownershipToken:inv.ownershipToken,idempotencyKey:inv.idempotencyKey,evidenceId:'fixture-evidence',outcome:'succeeded',effect:'retained',billing:{verifiedCostMicros:null,final:false}};},async inspect(){throw Error('No provider reconciliation in startup barrier');},async cleanup(){throw Error('No resources');},async confirmAbsent(){return false;}}});
 try{
  broker.serverApprove({taskId:f.task.id,revision:1,profileId:'hf',endsAt:f.task.spec.endsAt,budgetMicros:100});const pending=broker.execute({taskId:f.task.id,revision:1,profileId:'hf',requestId:'fixture',operation:'hf.model.commit',parameters:{artifactDigest:'a'.repeat(64),message:'fixture'}});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(store.transaction(s=>Object.values(s.actions)[0]!.status),'dispatching');assert.equal((await f.call('external-profiles')).status,200);assert.equal(store.transaction(s=>Object.values(s.actions)[0]!.status),'dispatching');release();await pending;
  store.transaction(s=>{const a=Object.values(s.actions)[0]!;a.status='dispatching';a.effect='unknown';delete a.evidenceId;delete a.providerReceipt;delete a.billingSource;delete a.operatorBilling;});
  await f.restart();assert.equal(store.transaction(s=>Object.values(s.actions)[0]!.status),'ambiguous');assert.equal(f.runnerCalls,0);
 }finally{release();f.db.close();}
});
test('unstarted terminal native failure stops broker admission before canonical finish',async()=>{
 const f=await fixture();try{
  const metadata=await (await f.call('external-profiles')).json() as any[];assert.equal((await f.call('approve',{revision:1,reason:'fixture',externalProfileHashes:{hf:metadata[0].profileHash}})).status,200);
  const lease=await f.service.execute('claimCloud',{id:f.task.id,workerId:'worker',token:'test-lease',runId:'never-started'});
  await (f.actor as any).executeAutonomous('finishUnstartedCloud',{lease});
  const store=createExternalSqlStore({exec:(q,...b)=>f.storage.sql.exec(q,...b),transactionSync:fn=>f.storage.transactionSync(fn)});
  assert.ok(store.transaction(s=>Object.values(s.approvals)[0]!.stoppedAt)!>0);assert.equal((await f.service.execute('get',{id:f.task.id}) as AutonomousTask).status,'failed');assert.equal(f.runnerCalls,0);
 }finally{f.db.close();}
});
test('cold startup restores an external cleanup alarm even if prior wake publication was lost',async()=>{
 const f=await fixture();try{
  const metadata=await (await f.call('external-profiles')).json() as any[];assert.equal((await f.call('approve',{revision:1,reason:'fixture',externalProfileHashes:{hf:metadata[0].profileHash}})).status,200);
  const lease=await f.service.execute('claimCloud',{id:f.task.id,workerId:'worker',token:'test-lease',runId:'run'});
  seedArtifactGrant(f);
  assert.equal((await f.call('external-action',{lease,runtimeId:'runtime',request:{profileId:'hf',requestId:'request',operation:'hf.model.commit',parameters:{artifactDigest:'a'.repeat(64),message:'fixture'}}},'fixture-worker')).status,200);
  f.rows.delete('externalCleanupWake');f.clearAlarm();await f.restart();assert.ok(f.alarm!==null);assert.ok(f.alarm!>Date.now());assert.equal(f.runnerCalls,0);
 }finally{f.db.close();}
});
test('native private row stores only immutable authorization while multi-megabyte core history stays intact',async()=>{
 const {AutonomousEngine}=await import('../../../packages/core/src/autonomous.ts'),{Scheduler}=await import('../src/scheduler.ts'),{LegacyAutonomousCloudPorts,nativeJobKey}=await import('../src/cloudflare/autonomous-ports.ts'),f=await fixture();
 try{
  const created=Date.now()-10000,e=new AutonomousEngine();e.create({requestId:'private-long',goal:'fixture authorization',provider:'claude',model:'pinned',billingPolicy:{model:'subscription',budget:'external_actions'},endsAt:created+56*86400000,budgetMicros:100,tools:['Bash'],systems:[],credentialIds:['shared'],maxRunMs:120000,maxIterations:65536,execution:{backend:'cloudflare',mode:'long_running',snapshotId:snapshot.digest,checks:[{id:'check',argv:['node'],timeoutMs:1000}]}},created,'private-task');e.approve('private-task',1,'fixture approval',created+1);
  const state=e.snapshot(),t=state.tasks['private-task']!;t.iteration=1001;t.runs=Array.from({length:1001},(_,i)=>({runId:'r'+i,workerId:'worker',startedAt:created+2+i,finishedAt:created+3+i,outcome:'failed',costMicros:0,message:'가'.repeat(1000),usage:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0}}));const engine=new AutonomousEngine(state),lease=engine.claimCloud('private-task','worker','test-lease','current-run',Date.now())!,task=engine.get('private-task'),before=JSON.stringify(task);assert.ok(Buffer.byteLength(before)>2*1024*1024);
  const scheduler=new Scheduler();scheduler.registerCredential({id:'shared',provider:'claude',generation:1,objectKey:'fixture',quarantined:false});
  const storage={...f.storage,async put(key:string,value:unknown){if(key.startsWith('autonomous-native:'))assert.ok(Buffer.byteLength(JSON.stringify(value))<=128*1024,'DO private value limit');return f.storage.put(key,value);}};
  const ports=new LegacyAutonomousCloudPorts({scheduler,storage,enabled:()=>true,configurationReady:async()=>true,sourceReady:async()=>true,save:async()=>{}});
  await ports.submit({task,lease,jobId:'native-large-history',idempotencyKey:'native-large-history',snapshotId:snapshot.digest});const row=f.rows.get(nativeJobKey('native-large-history')) as any;assert.deepEqual(Object.keys(row.task).sort(),['id','revision','spec']);assert.equal(JSON.stringify(task),before);assert.equal(engine.get('private-task').runs.length,1001);
  const oversize={...task,spec:{...task.spec,goal:'a'.repeat(16000),execution:{...task.spec.execution!,checks:Array.from({length:4},(_,i)=>({id:'c'+i,argv:['node',...Array.from({length:31},()=> 'x'.repeat(1000))],timeoutMs:1000}))}}};
  assert.doesNotThrow(()=>new AutonomousEngine({version:1,tasks:{'private-task':{...state.tasks['private-task']!,spec:oversize.spec}}})); // The spec is valid core input; private row is separately bounded.
  const secondScheduler=new Scheduler();secondScheduler.registerCredential({id:'shared',provider:'claude',generation:1,objectKey:'fixture',quarantined:false});const secondPorts=new LegacyAutonomousCloudPorts({scheduler:secondScheduler,storage,enabled:()=>true,configurationReady:async()=>true,sourceReady:async()=>true,save:async()=>{}});
  await assert.rejects(secondPorts.submit({task:oversize,lease,jobId:'native-oversized-spec',idempotencyKey:'native-oversized-spec',snapshotId:snapshot.digest}),/capacity|size|limit/i);assert.equal(secondScheduler.list().length,0);assert.equal(f.rows.has(nativeJobKey('native-oversized-spec')),false);assert.equal(f.runnerCalls,0);
 }finally{f.db.close();}
});
test('public native quota artifact preserves unavailable usage and safe quota proof without private session material',async()=>{
 const {generateKeyPairSync,randomBytes,randomUUID}=await import('node:crypto'),{sealAuth}=await import('../../scripts/phase0/auth-envelope.ts'),{Scheduler}=await import('../src/scheduler.ts'),{nativeJobKey}=await import('../src/cloudflare/autonomous-ports.ts'),f=await fixture();
 try{
  const pair=generateKeyPairSync('rsa',{modulusLength:2048}),publicKey=pair.publicKey.export({format:'pem',type:'spki'}).toString(),privateKey=pair.privateKey.export({format:'pem',type:'pkcs8'}).toString(),artifacts=new Map<string,string>();
  Object.assign(f.env,{AUTH_RETURN_PUBLIC_KEY:publicKey,AUTH_RETURN_PRIVATE_KEY:privateKey,AUTH_STORAGE_KEY:randomBytes(32).toString('base64'),AUTONOMOUS_QUOTA_PAUSE_ENABLED:'true'});
  Object.assign(f.env.CREDENTIALS,{async put(){return {etag:'fixture'};}});Object.assign(f.env.ARTIFACTS,{async put(key:string,value:string){artifacts.set(key,value);return {};}});Object.assign(f.env.RUNNER,{getByName(){return {async stop(){return true;}};}});
  const scheduler=new Scheduler();scheduler.registerCredential({id:'shared',provider:'claude',generation:1,objectKey:'fixture',quarantined:false});const job=scheduler.submit({provider:'claude',credentialId:'shared',snapshotId:snapshot.digest,instructions:'synthetic quota',checks:[{id:'check',argv:['node'],timeoutMs:1000}],timeoutMs:120000,idempotencyKey:'quota-artifact'},Date.now(),'quota-artifact');scheduler.state.jobs[job.id]!.autonomous={taskId:f.task.id,runId:'quota-run'};scheduler.dispatch(Date.now());(f.actor as any).scheduler=scheduler;
  const sessionId=randomUUID(),resetsAt=Date.now()+60000,quota={kind:'rejected',resetsAt,evidence:'claude_rate_limit_event'},lease={taskId:f.task.id,runId:'quota-run',workerId:'worker',token:'lease-fixture',expiresAt:Date.now()+30000};f.rows.set(nativeJobKey(job.id),{task:f.task,lease,runtimeId:randomUUID(),sessionId});
  const response={version:1,session:{sessionId,model:'pinned',sequence:1,data:{version:1,sessionId,model:'pinned',workspacePath:'/workspace',snapshot,transcripts:[{path:sessionId+'.jsonl',content:'{"type":"result"}\n'}]}},usage:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0},outcome:'wait',wakeAt:resetsAt,quota,usageUnavailable:true,boundary:{platform:'linux',verified:true,noNewPrivs:1,capabilitiesDropped:true}};
  await (f.actor as any).completeNative(scheduler.get(job.id),{version:1,jobId:job.id,attempt:job.attempt,ok:true,response,authReturn:sealAuth('sk-ant-oat01-fixture12345678',publicKey)});
  const record=JSON.parse([...artifacts.entries()].find(([key])=>key.startsWith('results/'))![1]);assert.equal(record.usageUnavailable,true);assert.deepEqual(record.quota,quota);assert.doesNotMatch(JSON.stringify(record),new RegExp(sessionId+'|transcripts|authReturn|checkpoint|lease-fixture|sk-ant-'));
  assert.deepEqual(Object.keys((f.rows.get(nativeJobKey(job.id)) as any).task).sort(),['id','revision','spec']);
 }finally{f.db.close();}
});
test('known external credential values remain excluded from native material when the feature is disabled',async()=>{
 const f=await fixture('false');try{delete (f.env as any).AUTONOMOUS_EXTERNAL_CONFIG;await f.restart();assert.throws(()=>(f.actor as any).assertNativeModelDataSafe('opaque-fixture-credential',null,undefined,'subscription-fixture','lease-fixture'),/rejected/);assert.equal(f.runnerCalls,0);}finally{f.db.close();}
});
test('shared SQL enforces immutable typed reservation tuples and monotonic dispatch fences',async()=>{
 const {createHash}=await import('node:crypto'),f=await fixture(),store=createExternalSqlStore({exec:(q,...b)=>f.storage.sql.exec(q,...b),transactionSync:fn=>f.storage.transactionSync(fn)});
 const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a<b?-1:1)):x)).digest('hex');
 try{
  const request={taskId:f.task.id,revision:1,profileId:'hf',requestId:'intent',operation:'hf.model.commit' as const,parameters:{artifactDigest:'a'.repeat(64),message:'fixture'}},requestHash=hash(request),entry={taskId:f.task.id,revision:1,requestId:'intent',requestHash,mainRequestId:'external:'+requestHash,phase:'intent' as const,request,reservation:{tool:'mcp__hivemind__action',system:'hf',operation:'hf.model.commit',estimatedCostMicros:10}};
  store.putJournal(entry);store.putJournal({...entry,dispatchBlocked:true});store.putJournal({...entry,dispatchBlocked:undefined});assert.equal(store.getJournal(f.task.id,1,'intent')!.dispatchBlocked,true);
  store.putJournal({...entry,mainReservationId:'main',brokerActionId:'broker',resourceId:'owned',phase:'broker'});store.putJournal({...entry,request:undefined,reservation:undefined,mainReservationId:undefined,brokerActionId:undefined,resourceId:undefined});const retained=store.getJournal(f.task.id,1,'intent')!;assert.equal(retained.mainReservationId,'main');assert.equal(retained.brokerActionId,'broker');assert.ok(retained.request);assert.ok(retained.reservation);
  assert.throws(()=>store.putJournal({...entry,dispatchBlocked:false} as never));assert.throws(()=>store.putJournal({...entry,reservation:{...entry.reservation,estimatedCostMicros:9}}));assert.throws(()=>store.putJournal({...entry,request:{...request,parameters:{...request.parameters,message:'changed'}}}));
  const policy={version:1,profileHash:'b'.repeat(64),configurationFingerprint:'c'.repeat(64),config:JSON.parse(f.env.AUTONOMOUS_EXTERNAL_CONFIG)};store.bindProviderPolicy(f.task.id,1,'hf',policy);assert.deepEqual(store.getProviderPolicy(f.task.id,1,'hf'),policy);assert.throws(()=>store.bindProviderPolicy(f.task.id,1,'hf',{...policy,profileHash:'d'.repeat(64)}));
 }finally{f.db.close();}
});
test('historical owned AWS cleanup and budget-stop cleanup preserve approved scope',async(t)=>{
 const {createAutonomousExternalRuntime}=await import('../src/autonomous-external.ts'),{createHash}=await import('node:crypto');const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
 for(const [keepOldRef,budgetMode] of [[true,false],[false,false],[true,true]]){
  const f=await fixture(),store=createExternalSqlStore({exec:(q,...b)=>f.storage.sql.exec(q,...b),transactionSync:fn=>f.storage.transactionSync(fn)});let terminated=false,creates=0,deletes=0;const auth:string[]=[],tags=new Map<string,string>();
  const oldAccount='123456789012',oldRef='old-ref',profile={id:'aws',enabled:true,provider:'aws',target:{accountId:oldAccount,region:'ap-northeast-2',workloadId:'old-workload'},operations:['aws.spot.start'],credentialRef:oldRef,maxLifetimeMs:60000,upperBoundMicros:10,maxActiveActions:1};
  const config=(account:string,ref:string,workload:string)=>({version:1,profiles:[{...profile,credentialRef:ref,target:{accountId:account,region:'ap-northeast-2',workloadId:workload}}],providers:{aws:{enabled:true,billingPolicy:'reserved_ceiling_only',accountId:account,region:'ap-northeast-2',workloadId:workload,imageId:'ami-123abc',instanceType:'g5.xlarge',subnetId:'subnet-123abc',instanceProfileArn:'arn:aws:iam::'+account+':instance-profile/fixture',maxLifetimeMs:60000,credentialRef:ref,maxUpperBoundMicros:10}},ttlGuard:{guardArn:'arn:aws:events:ap-northeast-2:'+account+':rule/fixture'}});
  const guard={async attest(r:any){return {kind:'preexisting_termination_guard',guardArn:'arn:aws:events:ap-northeast-2:'+r.accountId+':rule/fixture',evidenceId:'fixture',bindingHash:sha(JSON.stringify(r)),installedAt:Date.now()-1000,observedAt:Date.now(),validUntil:r.expiresAt+1000,maxExposureMicros:r.maxExposureMicros};},async arm(r:any,g:any){return {kind:'owned_expiry_timer',guardArn:g.guardArn,timerArn:'arn:aws:scheduler:ap-northeast-2:'+r.accountId+':schedule/fixture/hm-'+sha(JSON.stringify(r)).slice(0,48),evidenceId:'fixture',bindingHash:sha(JSON.stringify(r)),expiresAt:r.expiresAt};}};
  const fetcher=async(_url:unknown,init?:RequestInit)=>{
   const authorization=new Headers(init?.headers).get('authorization')??'';auth.push(authorization);assert.ok(authorization.includes('old-access'),'must never substitute the new credential');const body=new URLSearchParams(String(init?.body)),action=body.get('Action')!;
   const xml=(text:string)=>new Response('<'+action+'Response><requestId>fixture-proof</requestId>'+text+'</'+action+'Response>');
   if(action==='GetCallerIdentity')return xml('<GetCallerIdentityResult><Account>'+oldAccount+'</Account><Arn>arn:aws:iam::'+oldAccount+':user/fixture</Arn></GetCallerIdentityResult>');
   if(action==='RunInstances'){creates++;for(let i=1;i<=7;i++)tags.set(body.get('TagSpecification.1.Tag.'+i+'.Key')!,body.get('TagSpecification.1.Tag.'+i+'.Value')!);return xml('');}
   if(action==='DescribeInstances'){const a=store.transaction(s=>Object.values(s.actions).find(a=>a.operation==='aws.spot.start')!);return xml('<reservationSet><item><ownerId>'+oldAccount+'</ownerId><instancesSet><item><instanceId>i-0123456789abcdef0</instanceId><placement><availabilityZone>ap-northeast-2a</availabilityZone></placement><clientToken>'+sha(a.idempotencyKey)+'</clientToken><instanceState><name>'+(terminated?'terminated':'running')+'</name></instanceState><tagSet>'+[...tags].map(([k,v])=>'<item><key>'+k+'</key><value>'+v+'</value></item>').join('')+'</tagSet></item></instancesSet></item></reservationSet>');}
   if(action==='TerminateInstances'){deletes++;assert.equal(body.get('InstanceId.1'),'i-0123456789abcdef0');terminated=true;return xml('');}
   if(action==='DescribeVolumes')return xml('<volumeSet/>');throw Error('Unexpected fixture action');
  };
  try{
   const oldSecrets={[oldRef]:{provider:'aws',accessKeyId:'old-access',secretAccessKey:'old-secret'}},env={AUTONOMOUS_EXTERNAL_ENABLED:'true',AUTONOMOUS_EXTERNAL_CONFIG:JSON.stringify(config(oldAccount,oldRef,'old-workload')),AUTONOMOUS_EXTERNAL_CREDENTIALS:JSON.stringify(oldSecrets)};
   const options:any={env,core:f.service,sql:{exec:(q:string,...b:(string|number|null)[])=>f.storage.sql.exec(q,...b),transactionSync:<T>(fn:()=>T)=>f.storage.transactionSync(fn)},artifacts:f.env.ARTIFACTS,awsTtlGuard:guard,fetch:fetcher};
   const runtime=createAutonomousExternalRuntime(options)!,task=await f.service.execute('create',{spec:{...f.task.spec,requestId:'historic-aws',systems:['aws'],externalProfiles:['aws']}}) as AutonomousTask,metadata=await runtime.service.profiles(task.id);await runtime.service.assertApproval(task.id,1,{aws:metadata[0]!.profileHash});await f.service.execute('approve',{id:task.id,revision:1,reason:'fixture'});await runtime.service.approve(task.id);const lease=await f.service.execute('claimCloud',{id:task.id,workerId:'worker',token:'test-lease',runId:'run'});
   const body={lease,runtimeId:'fixture-runtime',request:{profileId:'aws',requestId:'resource',operation:'aws.spot.start' as const,parameters:{lifetimeMs:60000}}};const started=await runtime.service.execute(task.id,body as never);assert.equal(started.resourceId,'i-0123456789abcdef0');assert.equal(creates,1);
   if(budgetMode){
    Object.assign(f.env,env);t.mock.method(globalThis,'fetch',fetcher as typeof fetch);await f.restart();t.mock.timers.enable({apis:['Date'],now:Date.now()});
    const reserve=(token:string,amount:number)=>f.actor.fetch(new Request('https://control.example/v1/autonomous-tasks/'+task.id+'/reserve',{method:'POST',headers:{authorization:'Bearer fixture-worker','content-type':'application/json'},body:JSON.stringify({lease:{...(lease as any),token},request:{requestId:'budget-denial',tool:'mcp__hivemind__action',system:'aws',operation:'aws.spot.start',estimatedCostMicros:amount}})}));
    assert.equal((await reserve('stale-lease',1000)).status,409);assert.equal(store.transaction(s=>Object.values(s.approvals)[0]!.stoppedAt),undefined);
    assert.ok([409,422].includes((await reserve((lease as any).token,1000)).status));assert.ok(store.transaction(s=>Object.values(s.approvals)[0]!.stoppedAt)!>0);assert.ok(f.alarm!<=Date.now()+2000);assert.equal(creates,1);
    t.mock.timers.setTime(Date.now()+2000);f.clearAlarm();await f.actor.alarm();assert.equal(deletes,1);const stopped=await f.service.execute('get',{id:task.id}) as AutonomousTask;assert.equal(stopped.status,'stopping');assert.equal(stopped.reservedMicros,10);assert.equal(stopped.spentMicros,0);assert.equal(f.runnerCalls,0);continue;
   }
   const currentSecrets:any={'new-ref':{provider:'aws',accessKeyId:'new-access',secretAccessKey:'new-secret'},...(keepOldRef?oldSecrets:{})};const changed=createAutonomousExternalRuntime({...options,env:{...env,AUTONOMOUS_EXTERNAL_CONFIG:JSON.stringify(config('999999999999','new-ref','new-workload')),AUTONOMOUS_EXTERNAL_CREDENTIALS:JSON.stringify(currentSecrets)}})!;
   await assert.rejects(changed.service.execute(task.id,{...body,request:{...body.request,requestId:'must-not-launch-history'}} as never));assert.equal(creates,1);
   if(keepOldRef){
    const usage={inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0};await f.service.execute('recordNativeReceipt',{lease,receipt:{runId:'run',runtimeId:'fixture-runtime',sessionId:'fixture-session',model:'pinned',sequence:1,usage,stopped:true,outcome:'continue'}});await f.service.execute('finishCloud',{lease,result:{outcome:'continue',usage,costMicros:null,checkpoint:{sessionId:'fixture-session',model:'pinned',sequence:1,objectKey:'fixture-checkpoint'}},checksPassed:true});
    await changed.service.beforeCoreMutation(task.id,'revise');await f.service.execute('revise',{id:task.id,spec:{...task.spec,goal:'second revision'},reason:'fixture new revision'});const shown=await changed.service.profiles(task.id);await changed.service.assertApproval(task.id,2,{aws:shown[0]!.profileHash});await f.service.execute('approve',{id:task.id,revision:2,reason:'fixture'});await changed.service.approve(task.id);
    const secondLease=await f.service.execute('claimCloud',{id:task.id,workerId:'worker',token:'second-lease',runId:'second-run'});await assert.rejects(changed.service.execute(task.id,{...body,lease:secondLease,runtimeId:'second-runtime'} as never));assert.equal(creates,1);
    assert.equal(store.listJournal(task.id).filter(j=>j.requestId==='resource').length,2);await assert.rejects(changed.service.cleanup(task.id,'resource'),(error:any)=>error.statusCode===409);
   }
   await changed.service.beforeCoreMutation(task.id,'cancel');await f.service.execute('cancel',{id:task.id,reason:'fixture'});
   if(keepOldRef){await changed.cleanupDue(1);const restarted=createAutonomousExternalRuntime({...options,env:{...env,AUTONOMOUS_EXTERNAL_CONFIG:JSON.stringify(config('999999999999','new-ref','new-workload')),AUTONOMOUS_EXTERNAL_CREDENTIALS:JSON.stringify(currentSecrets)}})!;await restarted.recover();await restarted.cleanupDue(1);}
   const result=await changed.service.cleanup(task.id,'resource',1);
   if(keepOldRef){assert.equal(deletes,1);assert.equal(result.cleanupStatus,'cleaned');assert.equal(result.resourceId,'i-0123456789abcdef0');}else{assert.equal(deletes,0);assert.equal(result.cleanupStatus,'pending');assert.equal(result.recoveryIssue,'historical_credential_unavailable');const restored=createAutonomousExternalRuntime({...options,env:{...env,AUTONOMOUS_EXTERNAL_CONFIG:JSON.stringify(config('999999999999','new-ref','new-workload')),AUTONOMOUS_EXTERNAL_CREDENTIALS:JSON.stringify({...currentSecrets,...oldSecrets})}})!;const retried=await restored.service.cleanup(task.id,'resource',1);assert.equal(retried.cleanupStatus,'cleaned');assert.equal(retried.recoveryIssue,undefined);assert.equal(deletes,1);}
   assert.equal(creates,1);assert.ok(auth.every(v=>v.includes('old-access')));
  }finally{f.db.close();}
 }
});
test('cleanup batches forward exact journal revision for reused request IDs and preserve backoff across restart',async()=>{
 const {createAutonomousExternalRuntime}=await import('../src/autonomous-external.ts'),f=await fixture(),store=createExternalSqlStore({exec:(q,...b)=>f.storage.sql.exec(q,...b),transactionSync:fn=>f.storage.transactionSync(fn)});const visited:unknown[][]=[];let now=Date.now();
 const options={env:f.env,core:f.service,sql:{exec:(q:string,...b:(string|number|null)[])=>f.storage.sql.exec(q,...b),transactionSync:<T>(fn:()=>T)=>f.storage.transactionSync(fn)},artifacts:f.env.ARTIFACTS as never,now:()=>now};
 try{
  for(const revision of [1,2])store.putJournal({taskId:f.task.id,revision,requestId:'same-request',requestHash:'a'.repeat(64),mainRequestId:'external:'+revision,phase:'intent'});
  const attach=(runtime:any)=>{runtime.service.reconcile=async(id:string,requestId:string,revision:number)=>{visited.push(['reconcile',id,requestId,revision]);return {requestId,phase:'broker'};};runtime.service.cleanup=async(id:string,requestId:string,revision:number)=>{visited.push(['cleanup',id,requestId,revision]);return {requestId,phase:'broker'};};return runtime;};
  const runtime=attach(createAutonomousExternalRuntime(options)!);assert.equal((await runtime.cleanupDue(2)).visited,2);assert.deepEqual(visited.map(v=>[v[0],v[3]]),[['reconcile',1],['cleanup',1],['reconcile',2],['cleanup',2]]);
  const restarted=attach(createAutonomousExternalRuntime(options)!);assert.equal((await restarted.cleanupDue(2)).visited,0);now+=60000;assert.equal((await restarted.cleanupDue(2)).visited,2);assert.ok(visited.every(v=>v[3]===1||v[3]===2));
 }finally{f.db.close();}
});
test('operator credential preflight reads 3952 pooled jobs without cloning or mutating the live state and rejects before R2',async()=>{
 const {Scheduler}=await import('../src/scheduler.ts'),{createHash}=await import('node:crypto'),f=await fixture(),scheduler=new Scheduler(undefined,{exclusiveOwnership:true});let touched=0,cloned=0;const clone=globalThis.structuredClone;
 const hash=()=>{const h=createHash('sha256');h.update('{');let first=true;for(const [key,value]of Object.entries(scheduler.state)){if(!first)h.update(',');first=false;h.update(JSON.stringify(key)+':');if(key==='jobs'){h.update('{');let initial=true;for(const [id,job]of Object.entries(scheduler.state.jobs)){if(!initial)h.update(',');initial=false;h.update(JSON.stringify(id)+':'+JSON.stringify(job));}h.update('}');}else h.update(JSON.stringify(value));}h.update('}');return h.digest('hex');};
 try{
  scheduler.registerCredential({id:'credential',provider:'claude',generation:1,objectKey:'fixture',quarantined:false});const goal='x'.repeat(16000);
  for(let i=0;i<3952;i++){const job=scheduler.submit({provider:'claude',credentialId:'credential',snapshotId:snapshot.digest,instructions:Buffer.from(goal).toString(),checks:[{id:'check',argv:['node'],timeoutMs:1000}],timeoutMs:60000,idempotencyKey:'key'+i},1000,'done'+i);Object.assign(scheduler.state.jobs[job.id]!,{status:'SUCCEEDED',authSynced:true,finishedAt:2000});}
  scheduler.submit({provider:'claude',credentialId:'credential',snapshotId:snapshot.digest,instructions:goal,checks:[{id:'check',argv:['node'],timeoutMs:1000}],timeoutMs:60000,idempotencyKey:'active'},Date.now(),'active');scheduler.dispatch(Date.now());(f.actor as any).scheduler=scheduler;const before=hash();
  Object.assign(f.env.CREDENTIALS,{async head(){touched++;return null;},async put(){touched++;return {etag:'fixture'};}});
  globalThis.structuredClone=((value:any,options?:any)=>{if(value===scheduler.state){cloned++;throw Error('Full scheduler state clone forbidden');}return clone(value,options);}) as typeof structuredClone;
  await assert.rejects(f.actor.registerCredential('credential','claude','fixture'),/active container|busy/i);await assert.rejects(f.actor.registerCredential('credential','codex','fixture'),/provider/i);
  (f.actor as any).preflightCredential({id:'new-ready',provider:'claude',generation:1,objectKey:'fixture/new',quarantined:false});
  assert.equal(cloned,0);assert.equal(touched,0);assert.equal(hash(),before);assert.equal(scheduler.state.credentials.credential!.generation,1);assert.equal(scheduler.state.credentials['new-ready'],undefined);
 }finally{globalThis.structuredClone=clone;f.db.close();}
});

function seedArtifactGrant(f:any){
 const store=createExternalSqlStore({exec:(q,...b)=>f.storage.sql.exec(q,...b),transactionSync:fn=>f.storage.transactionSync(fn)}),approval=store.transaction(s=>Object.values(s.approvals).find(p=>p.taskId===f.task.id&&p.revision===1&&p.profileId==='hf'))!;
 const grant={taskId:f.task.id,revision:1,profileId:'hf',artifactDigest:'a'.repeat(64),profileHash:approval.profileHash,configurationFingerprint:store.approvalFingerprint(f.task.id,1,'hf')!,bytes:0};store.reserveArtifactGrant(grant);store.bindArtifactGrant(grant);
}
