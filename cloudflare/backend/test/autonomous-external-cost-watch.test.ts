import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createExternalSqlStore} from '../../../packages/core/src/autonomous-external-sql.ts';
import {AutonomousService} from '../src/autonomous-service.ts';
import {createAutonomousExternalRuntime} from '../src/autonomous-external.ts';
import {createSnapshot} from '../src/snapshot.ts';
import type {AutonomousSpec,AutonomousTask} from '../../../packages/contracts/src/autonomous.ts';

const snapshot=createSnapshot([]),sha=(s:string)=>createHash('sha256').update(s).digest('hex'),account='123456789012';
// Local SQL, synthetic clock and fake AWS HTTP only. No provider call, no model iteration.
async function fixture(){
 const db=new DatabaseSync(':memory:'),rows=new Map<string,unknown>();let terminated=false;const tags=new Map<string,string>();
 const sql={exec(query:string,...bindings:(string|number|null)[]){const st=db.prepare(query);const result=st.columns().length?st.all(...bindings):(st.run(...bindings),[]);return Object.assign(result,{toArray(){return [...result];}});}};
 const storage={sql,transactionSync<T>(fn:()=>T){db.exec('BEGIN IMMEDIATE');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}},async transaction<T>(fn:(tx:any)=>Promise<T>){const before=structuredClone(rows);try{return await fn(storage);}catch(e){rows.clear();for(const [k,v] of before)rows.set(k,v);throw e;}},async get<T>(key:string){return structuredClone(rows.get(key)) as T|undefined;},async put(key:string,value:unknown){rows.set(key,structuredClone(value));},async delete(key:string){return rows.delete(key);}};
 const sqlPort={exec:(q:string,...b:(string|number|null)[])=>sql.exec(q,...b),transactionSync:<T>(fn:()=>T)=>storage.transactionSync(fn)};
 const service=new AutonomousService(storage),store=createExternalSqlStore(sqlPort);
 const config={version:1,profiles:[{id:'aws',enabled:true,provider:'aws',target:{accountId:account,region:'ap-northeast-2',workloadId:'w'},operations:['aws.spot.start'],credentialRef:'ref',maxLifetimeMs:60000,upperBoundMicros:10,maxActiveActions:1}],providers:{aws:{enabled:true,billingPolicy:'reserved_ceiling_only',accountId:account,region:'ap-northeast-2',workloadId:'w',imageId:'ami-123abc',instanceType:'g5.xlarge',subnetId:'subnet-123abc',instanceProfileArn:'arn:aws:iam::'+account+':instance-profile/fixture',maxLifetimeMs:60000,credentialRef:'ref',maxUpperBoundMicros:10}},ttlGuard:{guardArn:'arn:aws:events:ap-northeast-2:'+account+':rule/fixture'}};
 const guard={async attest(r:any){return {kind:'preexisting_termination_guard',guardArn:config.ttlGuard.guardArn,evidenceId:'fixture',bindingHash:sha(JSON.stringify(r)),installedAt:Date.now()-1000,observedAt:Date.now(),validUntil:r.expiresAt+1000,maxExposureMicros:r.maxExposureMicros};},async arm(r:any,g:any){return {kind:'owned_expiry_timer',guardArn:g.guardArn,timerArn:'arn:aws:scheduler:ap-northeast-2:'+account+':schedule/fixture/hm-'+sha(JSON.stringify(r)).slice(0,48),evidenceId:'fixture',bindingHash:sha(JSON.stringify(r)),expiresAt:r.expiresAt};}};
 const fetcher=async(_u:unknown,init?:RequestInit)=>{
  const body=new URLSearchParams(String(init?.body)),action=body.get('Action')!;const xml=(t:string)=>new Response('<'+action+'Response><requestId>fixture</requestId>'+t+'</'+action+'Response>');
  if(action==='GetCallerIdentity')return xml('<GetCallerIdentityResult><Account>'+account+'</Account><Arn>arn:aws:iam::'+account+':user/fixture</Arn></GetCallerIdentityResult>');
  if(action==='RunInstances'){for(let i=1;i<=7;i++)tags.set(body.get('TagSpecification.1.Tag.'+i+'.Key')!,body.get('TagSpecification.1.Tag.'+i+'.Value')!);return xml('');}
  if(action==='DescribeInstances'){const a=store.transaction(s=>Object.values(s.actions).find(a=>a.operation==='aws.spot.start')!);return xml('<reservationSet><item><ownerId>'+account+'</ownerId><instancesSet><item><instanceId>i-0123456789abcdef0</instanceId><clientToken>'+sha(a.idempotencyKey)+'</clientToken><instanceState><name>'+(terminated?'terminated':'running')+'</name></instanceState><tagSet>'+[...tags].map(([k,v])=>'<item><key>'+k+'</key><value>'+v+'</value></item>').join('')+'</tagSet></item></instancesSet></item></reservationSet>');}
  if(action==='TerminateInstances'){terminated=true;return xml('');}
  if(action==='DescribeVolumes')return xml('<volumeSet/>');throw Error('Unexpected fixture action');
 };
 let offset=0;const now=()=>Date.now()+offset;
 const env={AUTONOMOUS_EXTERNAL_ENABLED:'true',AUTONOMOUS_EXTERNAL_CONFIG:JSON.stringify(config),AUTONOMOUS_EXTERNAL_CREDENTIALS:JSON.stringify({ref:{provider:'aws',accessKeyId:'fixture-access',secretAccessKey:'fixture-secret'}})};
 const runtime=createAutonomousExternalRuntime({env,core:service,sql:sqlPort,artifacts:{async get(){return null;}},awsTtlGuard:guard as never,fetch:fetcher as never,now})!;
 const spec:AutonomousSpec={requestId:'cost-watch',goal:'synthetic cost watch',provider:'claude',model:'pinned',billingPolicy:{model:'subscription',budget:'external_actions'},endsAt:Date.now()+500000,budgetMicros:100,tools:['Bash','mcp__hivemind__action'],systems:['aws'],externalProfiles:['aws'],credentialIds:['shared'],maxRunMs:120000,maxIterations:4,execution:{backend:'cloudflare',snapshotId:snapshot.digest,checks:[{id:'check',argv:['node'],timeoutMs:1000}]}};
 const task=await service.execute('create',{spec}) as AutonomousTask,metadata=await runtime.service.profiles(task.id);
 await runtime.service.assertApproval(task.id,1,{aws:metadata[0]!.profileHash});await service.execute('approve',{id:task.id,revision:1,reason:'fixture'});await runtime.service.approve(task.id);
 const lease=await service.execute('claimCloud',{id:task.id,workerId:'worker',token:'test-lease',runId:'run'});
 const started=await runtime.service.execute(task.id,{lease,runtimeId:'fixture-runtime',request:{profileId:'aws',requestId:'resource',operation:'aws.spot.start',parameters:{lifetimeMs:60000}}} as never);
 return {db,service,store,runtime,task,started,lease,clock:{now}};
}
test('nextWake wakes at action expiry even when journal retry is an hour away',async()=>{
 const f=await fixture();try{
  assert.equal(f.started.resourceId,'i-0123456789abcdef0');
  const expiresAt=f.store.transaction(s=>Object.values(s.actions)[0]!.expiresAt);
  const j=f.store.listJournal(f.task.id)[0]!;f.store.putJournal({...j,retryAt:f.clock.now()+3600000});
  const result=await f.runtime.cleanupDue();
  assert.equal(result.needsWork,true);assert.ok(result.nextWake!<=expiresAt+60000,`nextWake ${result.nextWake} expiresAt ${expiresAt}`);
 }finally{f.db.close();}
});
test('nextWake honours an action expiry under 60 s but keeps the 60 s floor for retries',async()=>{
 const f=await fixture();try{
  const at=f.clock.now(),expiresAt=at+10000;
  f.store.transaction(s=>{Object.values(s.actions)[0]!.expiresAt=expiresAt;});
  const j=f.store.listJournal(f.task.id)[0]!;f.store.putJournal({...j,retryAt:at+3600000});
  const result=await f.runtime.cleanupDue();
  assert.equal(result.needsWork,true);
  assert.ok(result.nextWake!>=expiresAt&&result.nextWake!<=expiresAt+1500,`nextWake ${result.nextWake! - at} ms out, expiry 10000 ms out`);
  // A retry due in 5 s with nothing else expiring soon must not wake sooner than 60 s.
  f.store.transaction(s=>{Object.values(s.actions)[0]!.expiresAt=at+600000;});
  const j2=f.store.listJournal(f.task.id)[0]!;f.store.putJournal({...j2,retryAt:f.clock.now()+5000});
  const before=f.clock.now(),floored=await f.runtime.cleanupDue();
  assert.ok(floored.nextWake!>=before+60000,`floored wake ${floored.nextWake! - before} ms out`);
 }finally{f.db.close();}
});
test('broker cost stop reaches the canonical task during cleanupDue without a model iteration',async()=>{
 const f=await fixture();try{
  // Simulates the broker recording a cost overrun (verified 130 against the action upper bound 10).
  f.store.transaction(s=>{const a=Object.values(s.actions)[0]!;a.verifiedCostMicros=130;for(const p of Object.values(s.approvals)){p.stoppedAt??=f.clock.now();p.stopReason='cost_exceeded';}});
  await f.runtime.cleanupDue();
  const task=await f.service.execute('get',{id:f.task.id}) as AutonomousTask;
  assert.equal(task.status,'stopping');assert.match(task.stopReason??'',/^budget_exceeded/);
  assert.ok(task.resources.some(r=>r.status==='cleanup_pending'));
  await f.runtime.cleanupDue();
  assert.equal(((await f.service.execute('get',{id:f.task.id})) as AutonomousTask).status,'stopping');
 }finally{f.db.close();}
});
