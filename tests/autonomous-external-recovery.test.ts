import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createAutonomousStore} from '../packages/core/src/autonomous-store.ts';
import {createExternalStore} from '../packages/core/src/autonomous-external-store.ts';
import {createAutonomousApiService,type AutonomousApiService} from '../apps/control-plane/src/autonomous-api.ts';
import {createAutonomousExternalService} from '../apps/control-plane/src/autonomous-external-api.ts';
import {ExternalBroker} from '../packages/core/src/autonomous-external.ts';
import type {ExternalProfile,ExternalInvocation,ExternalProviderReceipt} from '../packages/contracts/src/autonomous-external.ts';
import type {ExternalJournal} from '../packages/core/src/autonomous-external-sql.ts';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
function fixture(options:{budgetMicros?:number}={}){
 const directory=mkdtempSync(join(tmpdir(),'external-recovery-')),mainPath=join(directory,'main.sqlite'),brokerPath=join(directory,'broker.sqlite');
 let main=createAutonomousStore(mainPath),store=createExternalStore(brokerPath),now=1000,dispatches=0,inspects=0,settlements=0;
 let loseReserve=false,loseSettlement=false,holdReserve=false,holdBeforeReserve=false,holdProvider=false,absence=false,cleanups=0;
 const reserveReady=deferred(),reserveRelease=deferred(),providerReady=deferred(),providerRelease=deferred();
 const profile:ExternalProfile={id:'profile',enabled:true,provider:'aws',target:{accountId:'123456789012',region:'ap-northeast-2',workloadId:'fixture'},operations:['aws.spot.start'],credentialRef:'private-ref',maxLifetimeMs:10000,upperBoundMicros:10,maxActiveActions:2};
 main.create({requestId:'recovery',goal:'synthetic external recovery',provider:'claude',model:'pinned',billingPolicy:{model:'subscription',budget:'external_actions'},endsAt:100000,budgetMicros:options.budgetMicros??100,tools:['Bash','mcp__hivemind__action'],systems:['aws'],externalProfiles:['profile'],credentialIds:['subscription'],maxRunMs:120000,maxIterations:4,execution:{backend:'cloudflare',snapshotId:'a'.repeat(64),checks:[{id:'check',argv:['node'],timeoutMs:1000}]}},now,'task');main.approve('task',1,'synthetic approval',now);
 const lease=main.claimCloud('task','worker','synthetic-lease','run',now)!;
 const core:AutonomousApiService={async execute(operation,input){
  if(operation==='reserve'&&holdBeforeReserve){holdBeforeReserve=false;reserveReady.resolve();await reserveRelease.promise;}
  const result=await createAutonomousApiService(main,()=>now).execute(operation,input);
  if(operation==='settleExternal'){settlements++;if(loseSettlement){loseSettlement=false;throw Error('Synthetic settlement committed reply lost');}}
  if(operation==='reserve'){
   if(loseReserve){loseReserve=false;throw Error('Synthetic reserve committed reply lost');}
   if(holdReserve){holdReserve=false;reserveReady.resolve();await reserveRelease.promise;}
  }
  return result;
 }};
 function receipt(i:ExternalInvocation):ExternalProviderReceipt{return {ownershipToken:i.ownershipToken,idempotencyKey:i.idempotencyKey,evidenceId:'synthetic-owned-receipt',outcome:'succeeded',effect:'resource',resource:{id:i.revision===1?'i-11111111':'i-22222222',cleanupRequired:true},billing:{verifiedCostMicros:null,final:false}};}
 function broker(){return new ExternalBroker({store,registry:{get:id=>id===profile.id?profile:undefined},now:()=>now,resolver:{async withCredential(_reference,_scope,consume){return consume('synthetic-provider-credential');}},transport:{async execute(i){dispatches++;if(holdProvider){providerReady.resolve();await providerRelease.promise;}return receipt(i);},async inspect(){inspects++;return null;},async cleanup(){cleanups++;absence=true;},async confirmAbsent(){return absence;}}});}
 const service=()=>createAutonomousExternalService({core,store,broker:broker(),registry:{get:id=>id===profile.id?profile:undefined}});
 const body={lease,runtimeId:'12345678-1234-4234-8234-123456789abc',request:{profileId:'profile',requestId:'request',operation:'aws.spot.start' as const,parameters:{lifetimeMs:10000}}};
 async function approve(revision=1){const s=service(),metadata=await s.profiles('task');await s.assertApproval('task',revision,{profile:metadata[0]!.profileHash});await s.approve('task');}
 function reopen(){main.close();store.close();main=createAutonomousStore(mainPath);store=createExternalStore(brokerPath);}
 return {core,profile,get main(){return main;},get store(){return store;},get dispatches(){return dispatches;},get inspects(){return inspects;},get settlements(){return settlements;},get cleanups(){return cleanups;},lease,body,service,approve,reopen,
  loseNextReserve(){loseReserve=true;},loseNextSettlement(){loseSettlement=true;},deferReserve(){holdReserve=true;},deferBeforeReserve(){holdBeforeReserve=true;},deferProvider(){holdProvider=true;},reserveReady:reserveReady.promise,providerReady:providerReady.promise,releaseReserve:reserveRelease.resolve,releaseProvider:providerRelease.resolve,
  expire(){now=lease.expiresAt;main.tick(now);},close(){reserveRelease.resolve();providerRelease.resolve();main.close();store.close();rmSync(directory,{recursive:true,force:true});}};
}
test('actual SQLite orphan resolves after lease expiry and reopening without client retry or fake model usage',async()=>{
 const f=fixture();try{
  await f.approve();f.loseNextReserve();await assert.rejects(f.service().execute('task',f.body),/reply lost/);
  assert.equal(f.store.getJournal('task',1,'request')!.mainReservationId,undefined);assert.equal(f.main.get('task').reservedMicros,10);
  f.expire();f.reopen();await f.service().recover();assert.equal(f.dispatches,0);assert.equal(f.inspects,0);assert.equal(f.main.get('task').reservedMicros,10);
  const recovered=await f.service().reconcile('task','request');assert.equal(recovered.phase,'settled');assert.equal(recovered.verifiedCostMicros,0);assert.equal(f.dispatches,0);
  const task=f.main.get('task');assert.equal(task.reservedMicros,0);assert.equal(task.spentMicros,0);assert.equal(task.actions[0]!.status,'failed');assert.equal(task.runs[0]!.costMicros,null);assert.equal(task.runs[0]!.usageUnavailable,true);assert.equal(task.resources.length,0);
  const count=f.settlements;f.reopen();await f.service().cleanup('task','request');await f.service().reconcile('task','request');assert.equal(f.settlements,count);assert.equal(f.main.get('task').reservedMicros,0);assert.equal(f.store.getJournal('task',1,'request')!.dispatchBlocked,true);
 }finally{f.close();}
});
test('live lease recovery fences a committed deferred reserve reply before the late worker resumes',async()=>{
 const f=fixture();let pending:Promise<unknown>|undefined;try{
  await f.approve();f.deferReserve();pending=f.service().execute('task',f.body);await f.reserveReady;
  await f.service().reconcile('task','request');assert.equal(f.main.get('task').reservedMicros,0);assert.equal(f.main.get('task').status,'running');assert.equal(f.main.get('task').runs.length,0);
  f.releaseReserve();await pending;assert.equal(f.dispatches,0);assert.equal(f.main.get('task').actions[0]!.actualCostMicros,0);assert.equal(f.store.getJournal('task',1,'request')!.dispatchBlocked,true);assert.equal(f.store.getJournal('task',1,'request')!.phase,'settled');
 }finally{f.releaseReserve();await pending?.catch(()=>{});f.close();}
});
test('an already persisted broker intent is never waived while its provider result is pending',async()=>{
 const f=fixture();let pending:Promise<unknown>|undefined;try{
  await f.approve();f.deferProvider();pending=f.service().execute('task',f.body);await f.providerReady;
  assert.equal(f.store.transaction(s=>Object.keys(s.actions).length),1);
  await f.service().reconcile('task','request');assert.equal(f.settlements,0);assert.equal(f.main.get('task').reservedMicros,10);assert.equal(f.main.get('task').actions[0]!.actualCostMicros,undefined);
  f.releaseProvider();await pending;assert.equal(f.dispatches,1);assert.equal(f.main.get('task').actions[0]!.status,'accepted');assert.equal(f.main.get('task').reservedMicros,10);assert.equal(f.settlements,0);
 }finally{f.releaseProvider();await pending?.catch(()=>{});f.close();}
});
test('tampered recovery reservation tuples cannot discharge a canonical reservation',async()=>{
 const changes:Array<(journal:ExternalJournal)=>void>=[j=>{j.reservation!.tool='Bash';},j=>{j.reservation!.system='github';},j=>{j.reservation!.operation='aws.spot.inspect';},j=>{j.reservation!.estimatedCostMicros=0;},j=>{j.request!.taskId='other';},j=>{j.request!.revision=2;}];
 for(const change of changes){const f=fixture();try{
  await f.approve();f.loseNextReserve();await assert.rejects(f.service().execute('task',f.body));
  const read=f.store.getJournal.bind(f.store);f.store.getJournal=(...args)=>{const j=read(...args);if(j)change(j);return j;};
  await assert.rejects(f.service().reconcile('task','request'));assert.equal(f.main.get('task').reservedMicros,10);assert.equal(f.settlements,0);assert.equal(f.dispatches,0);
 }finally{f.close();}}
});

test('legacy journal without the pre-reserve tuple stays unknown and is never retroactively waived',async()=>{
 const f=fixture();try{
  await f.approve();await f.core.execute('nativeStart',{id:'task',lease:f.lease,runtimeId:f.body.runtimeId});
  const request={...f.body.request,taskId:'task',revision:1};
  const canonical=(value:unknown):string=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
  const requestHash=createHash('sha256').update(canonical(request)).digest('hex'),mainRequestId='external:'+requestHash;
  const main=await f.core.execute('reserve',{id:'task',lease:f.lease,request:{requestId:mainRequestId,tool:'mcp__hivemind__action',system:'aws',operation:'aws.spot.start',estimatedCostMicros:10}}) as {id:string};
  f.store.putJournal({taskId:'task',revision:1,requestId:'request',requestHash,mainRequestId,mainReservationId:main.id,phase:'reserved'});
  f.expire();f.reopen();await assert.rejects(f.service().reconcile('task','request'),(error:unknown)=>(error as {statusCode:number}).statusCode===409);
  assert.equal(f.main.get('task').reservedMicros,10);assert.equal(f.settlements,0);assert.equal(f.dispatches,0);assert.equal(f.store.getJournal('task',1,'request')!.undispatched,undefined);
 }finally{f.close();}
});
test('lost zero settlement reply remains idempotent when the durable journal has not yet marked completion',async()=>{
 const f=fixture();try{
  await f.approve();f.loseNextReserve();await assert.rejects(f.service().execute('task',f.body));f.expire();f.loseNextSettlement();
  await assert.rejects(f.service().reconcile('task','request'),/settlement committed reply lost/);
  assert.equal(f.main.get('task').reservedMicros,0);assert.equal(f.store.getJournal('task',1,'request')!.undispatched,undefined);
  f.reopen();const result=await f.service().cleanup('task','request');assert.equal(result.phase,'settled');assert.equal(result.verifiedCostMicros,0);assert.equal(f.main.get('task').spentMicros,0);assert.equal(f.dispatches,0);assert.equal(f.main.get('task').runs[0]!.costMicros,null);
  assert.equal(f.store.getJournal('task',1,'request')!.undispatched,true);
 }finally{f.close();}
});

test('committed central budget denial revokes old broker admission and makes owned VM cleanup eligible before TTL',async()=>{
 const f=fixture({budgetMicros:15});try{
  await f.approve();await f.service().execute('task',f.body);assert.equal(f.main.get('task').reservedMicros,10);
  await assert.rejects(f.service().execute('task',{...f.body,request:{...f.body.request,requestId:'over-budget'}}));
  const stopped=f.main.get('task');assert.equal(stopped.status,'stopping');assert.ok(stopped.stopReason?.startsWith('budget_exceeded:'));assert.throws(()=>f.main.heartbeat(f.lease,1001));
  assert.equal(f.dispatches,1);assert.equal(f.cleanups,0,'error catch must never call a provider');
  const state=f.store.transaction(s=>s);assert.equal(Object.keys(state.actions).length,1);assert.ok(Object.values(state.approvals).every(a=>a.stoppedAt!==undefined));assert.equal(Object.values(state.actions)[0]!.cleanupStatus,'pending');assert.ok(Object.values(state.actions)[0]!.expiresAt>1000);
  await f.service().cleanup('task','request',1);assert.equal(f.cleanups,1);assert.equal(f.main.get('task').resources[0]!.status,'cleaned');assert.equal(f.main.get('task').status,'stopping');assert.equal(f.main.get('task').reservedMicros,10);assert.equal(f.main.get('task').actions[0]!.actualCostMicros,undefined);
 }finally{f.close();}
});
test('wrong lease cannot revoke an unrelated valid task or initiate resource cleanup',async()=>{
 const f=fixture();try{await f.approve();await f.service().execute('task',f.body);await assert.rejects(f.service().execute('task',{...f.body,lease:{...f.lease,token:'wrong'},request:{...f.body.request,requestId:'bad'}}));assert.equal(f.main.get('task').status,'running');assert.ok(f.store.transaction(s=>Object.values(s.approvals).every(a=>a.stoppedAt===undefined)));assert.equal(f.store.isTaskBlocked('task',1),false);assert.equal(f.cleanups,0);assert.equal(f.dispatches,1);}finally{f.close();}
});

test('actual two-revision cleanup and billing bind the historical journal even when request IDs repeat',async()=>{
 const f=fixture();try{
  await f.approve();await f.service().execute('task',f.body);
  await f.service().beforeCoreMutation('task','revise');await f.service().cleanup('task','request',1);
  const bill={revision:1,actualCostMicros:3,evidenceRef:'invoice-old',reason:'Reviewed historical invoice'};
  const put=f.store.putJournal.bind(f.store);let lose=true;f.store.putJournal=entry=>{if(lose&&entry.phase==='cleaned'){lose=false;throw Error('Synthetic final journal publication lost');}put(entry);};
  await assert.rejects(f.service().attestBilling('task','request',bill),/publication lost/);f.store.putJournal=put;
  assert.equal(f.main.get('task').spentMicros,3);assert.equal(f.store.getJournal('task',1,'request')!.phase,'broker');
  const usage={inputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:1};
  f.main.recordNativeReceipt(f.lease,{runId:'run',runtimeId:f.body.runtimeId,sessionId:'synthetic-session',model:'pinned',sequence:1,usage,stopped:true,outcome:'continue'},1000);
  f.main.finishCloud(f.lease,{outcome:'continue',usage,costMicros:null,checkpoint:{sessionId:'synthetic-session',model:'pinned',sequence:1,objectKey:'synthetic-private'}},true,1000);
  f.main.revise('task',f.main.get('task').spec,'same scope next revision',1000);f.main.approve('task',2,'approved next revision',1000);await f.approve(2);
  const lease=f.main.claimCloud('task','worker','second-lease','run2',1000)!;await f.service().execute('task',{...f.body,lease,runtimeId:'87654321-1234-4234-8234-123456789abc'});
  assert.equal(f.dispatches,2);assert.equal(f.main.get('task').reservedMicros,10);
  await assert.rejects(f.service().cleanup('task','request'),(e:unknown)=>(e as {statusCode:number}).statusCode===409);
  await assert.rejects(f.service().attestBilling('task','request',{actualCostMicros:3,evidenceRef:'invoice-old',reason:'Reviewed historical invoice'}),(e:unknown)=>(e as {statusCode:number}).statusCode===409);
  const cleaned=await f.service().cleanup('task','request',1);assert.equal(cleaned.revision,1);assert.equal(f.cleanups,1);
  const reviewed=await f.service().attestBilling('task','request',bill);assert.equal(reviewed.revision,1);
  const task=f.main.get('task');assert.equal(task.actions[0]!.actualCostMicros,3);assert.equal(task.actions[1]!.actualCostMicros,undefined);assert.equal(task.resources[0]!.status,'cleaned');assert.equal(task.resources[1]!.status,'active');assert.equal(task.spentMicros,3);assert.equal(task.reservedMicros,10);assert.equal(task.status,'running');
  assert.equal((await f.service().list('task') as {revision:number}[]).filter(row=>row.revision===1).length,1);
 }finally{f.close();}
});
test('canonical stop observed on metadata reads revokes admission without resetting established cleanup backoff',async()=>{
 const f=fixture();try{
  await f.approve();await f.service().execute('task',f.body);f.main.cancel('task','canonical cancellation',1000);
  assert.equal(f.store.isTaskBlocked('task',1),false);await f.service().profiles('task');assert.equal(f.store.isTaskBlocked('task',1),true);assert.ok(f.store.transaction(s=>Object.values(s.approvals).every(a=>a.stoppedAt!==undefined)));
  const j=f.store.getJournal('task',1,'request')!;f.store.putJournal({...j,retryAt:50000,retryAttempts:3});await f.service().profiles('task');
  assert.equal(f.store.getJournal('task',1,'request')!.retryAt,50000);assert.equal(f.cleanups,0);assert.equal(f.dispatches,1);
 }finally{f.close();}
});

test('stopped budget-denied typed intent with no canonical reservation closes without phantom cleanup work',async()=>{
 const f=fixture({budgetMicros:15});try{
  await f.approve();await f.service().execute('task',f.body);await assert.rejects(f.service().execute('task',{...f.body,request:{...f.body.request,requestId:'budget-denied'}}));
  assert.equal(f.main.get('task').actions.length,1);assert.equal(f.store.getJournal('task',1,'budget-denied')!.phase,'intent');
  const settled=await f.service().cleanup('task','budget-denied',1);assert.equal(settled.phase,'settled');assert.equal(settled.verifiedCostMicros,0);assert.equal(f.settlements,0);assert.equal(f.main.get('task').actions.length,1);assert.equal(f.main.get('task').reservedMicros,10);assert.equal(f.dispatches,1);
  assert.equal(f.store.listJournal('task').filter(j=>j.requestId==='budget-denied'&&!['settled','cleaned'].includes(j.phase)).length,0);
 }finally{f.close();}
});
test('live no-main intent cannot be waived before a deferred canonical reserve has committed',async()=>{
 const f=fixture();let pending:Promise<unknown>|undefined;try{
  await f.approve();f.deferBeforeReserve();pending=f.service().execute('task',f.body);await f.reserveReady;
  assert.equal(f.main.get('task').actions.length,0);await assert.rejects(f.service().reconcile('task','request',1),(e:unknown)=>(e as {statusCode:number}).statusCode===409);assert.equal(f.store.getJournal('task',1,'request')!.undispatched,undefined);
  f.releaseReserve();await pending;assert.equal(f.dispatches,0);assert.equal(f.main.get('task').reservedMicros,0);assert.equal(f.main.get('task').actions.length,1);assert.equal(f.main.get('task').actions[0]!.status,'failed');
 }finally{f.releaseReserve();await pending?.catch(()=>{});f.close();}
});
