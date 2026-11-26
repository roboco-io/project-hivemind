import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createExternalProviderTransport} from '../packages/adapters/src/autonomous-external.js';
import {createExternalStore} from '../packages/core/src/autonomous-external-store.ts';

import {ExternalBroker as Broker,externalParametersHash} from '../packages/core/src/autonomous-external.js';

function harness(overrides: Record<string, unknown> = {}) {
  assert.equal(typeof Broker, 'function', 'trusted external broker must be implemented');
  let state: any = {version: 1, approvals: {}, actions: {}};
  let time = 1000;
  let calls = 0, resolutions = 0, deletes = 0, absent = false;
  let execute: any;
  let inspection: any = null;
  const profile: any = {id:'spot', enabled:true, provider:'aws', target:{accountId:'123456789012',region:'ap-northeast-2',workloadId:'bounded-job'}, operations:['aws.spot.start','aws.spot.inspect'], credentialRef:'aws-worker', maxLifetimeMs:1000, upperBoundMicros:100, maxActiveActions:1};
  const store = {transaction<T>(fn:(s:any)=>T):T {const copy=structuredClone(state);const result=fn(copy);state=copy;return structuredClone(result);}};
  const receipt = (inv:any, extra:any={}) => ({ownershipToken:inv.ownershipToken,idempotencyKey:inv.idempotencyKey,evidenceId:'provider-receipt-1',outcome:'succeeded',effect:'resource',resource:{id:'spot-1',cleanupRequired:true},billing:{verifiedCostMicros:null,final:false},...extra});
  const transport = {
    async execute(inv:any, credential:unknown) {calls++;assert.deepEqual(credential,{opaque:true});const saved=store.transaction(s=>s.actions[inv.actionId]);assert.equal(saved.status,'dispatching');assert.equal(saved.reservedMicros,inv.profile.upperBoundMicros);assert.equal(saved.parametersHash,inv.parametersHash);return execute?execute(inv):receipt(inv);},
    async inspect(inv:any) {return typeof inspection==='function'?inspection(inv):inspection;},
    async cleanup() {deletes++;},
    async confirmAbsent() {return absent;},
  };
  const options = {store,registry:{get:()=>structuredClone(profile)},resolver:{async withCredential(_ref:any,_scope:any,fn:any) {resolutions++;return fn({opaque:true});}},transport,now:()=>time,...overrides};
  const broker = new Broker(options);
  const approval = {taskId:'task',revision:1,profileId:'spot',endsAt:3000,budgetMicros:200};
  const request = {taskId:'task',revision:1,profileId:'spot',requestId:'request-1',operation:'aws.spot.start' as const,parameters:{lifetimeMs:500}};
  return {broker,profile,store,options,approval,request,receipt,setTime:(n:number)=>{time=n;},setExecute:(fn:any)=>{execute=fn;},setInspection:(v:any)=>{inspection=v;},setAbsent:(v:boolean)=>{absent=v;},counts:()=>({calls,resolutions,deletes,modelCalls:0})};
}

test('disabled and omitted-enabled profiles cannot approve or call providers', async()=>{
  const h=harness(); delete h.profile.enabled;
  assert.throws(()=>h.broker.serverApprove(h.approval),/disabled/i);
  h.profile.enabled=false; assert.throws(()=>h.broker.serverApprove(h.approval),/disabled/i);
  assert.equal(h.counts().calls,0);
});

test('approval is immutable and live registry changes deny dispatch',async()=>{
  const h=harness();h.broker.serverApprove(h.approval);
  assert.throws(()=>h.broker.serverApprove({...h.approval,budgetMicros:300}),/immutable/i);
  h.profile.target.workloadId='other';await assert.rejects(()=>h.broker.execute(h.request),/profile/i);
  assert.equal(h.counts().resolutions,0);
});

test('intent and upper-bound reservation commit before transport; duplicate never redispatches',async()=>{
  const h=harness();h.broker.serverApprove(h.approval);
  const a=await h.broker.execute(h.request);
  assert.equal(a.status,'succeeded');assert.equal(a.verifiedCostMicros,null);assert.equal(a.reservedMicros,100);
  assert.deepEqual(await h.broker.execute({...h.request,parameters:{lifetimeMs:500}}),a);
  assert.equal(h.counts().calls,1);assert.equal(h.counts().modelCalls,0);
  await assert.rejects(()=>h.broker.execute({...h.request,parameters:{lifetimeMs:501}}),/conflict/i);
});

test('strict parameters and operation scope reject arbitrary URL, command and lifetime',async()=>{
  const h=harness();h.broker.serverApprove(h.approval);
  for(const parameters of [{lifetimeMs:1001},{lifetimeMs:100,url:'https://example.invalid'},{lifetimeMs:100,command:'shell'}]) await assert.rejects(()=>h.broker.execute({...h.request,parameters}),/parameter|lifetime/i);
  await assert.rejects(()=>h.broker.execute({...h.request,operation:'github.branch.push',parameters:{artifactDigest:'a'.repeat(64),expectedHead:'b'.repeat(40)}}),/operation/i);
  assert.equal(h.counts().calls,0);
});

test('simultaneous identical requests produce one provider call',async()=>{
  const h=harness();h.broker.serverApprove(h.approval);
  let release:()=>void=()=>{};const waiting=new Promise<void>(r=>{release=r;});
  h.setExecute(async(inv:any)=>{await waiting;return h.receipt(inv);});
  const first=h.broker.execute(h.request);await Promise.resolve();await Promise.resolve();
  const second=await h.broker.execute(h.request);assert.equal(second.status,'dispatching');
  release();await first;assert.equal(h.counts().calls,1);
});

test('reservation prevents excess budget and active-action concurrency',async()=>{
  const h=harness();h.broker.serverApprove({...h.approval,budgetMicros:100});await h.broker.execute(h.request);
  await assert.rejects(()=>h.broker.execute({...h.request,requestId:'next'}),/budget|active/i);
  assert.equal(h.counts().calls,1);
});

test('lost outcome stays ambiguous across restart; reconciliation only inspects',async()=>{
  const h=harness();h.broker.serverApprove(h.approval);h.setExecute(()=>{throw Error('private provider failure');});
  const a=await h.broker.execute(h.request);assert.equal(a.status,'ambiguous');assert.equal(a.verifiedCostMicros,null);
  const restarted=new Broker(h.options);restarted.recover();await restarted.execute(h.request);
  assert.equal(h.counts().calls,1);
  h.setInspection((inv:any)=>h.receipt(inv));const fixed=await restarted.reconcile(a.id);
  assert.equal(fixed.resource!.id,'spot-1');assert.equal(h.counts().calls,1);
});

test('restart converts persisted dispatch intent to ambiguous without replay',async()=>{
  const h=harness();h.broker.serverApprove(h.approval);const a=await h.broker.execute(h.request);
  h.store.transaction(s=>{Object.assign(s.actions[a.id],{status:'dispatching',effect:'unknown',resource:undefined,evidenceId:undefined,verifiedCostMicros:null,billingFinal:false,cleanupStatus:'none',providerReceipt:undefined,billingSource:undefined});});
  const restarted=new Broker(h.options);restarted.recover();
  assert.equal((await restarted.execute(h.request)).status,'ambiguous');assert.equal(h.counts().calls,1);
});

test('cancel during provider call preserves late resource and cleanup authority',async()=>{
  const h=harness();h.broker.serverApprove(h.approval);
  h.setExecute((inv:any)=>{h.broker.cancel('task',1,'operator');return h.receipt(inv);});
  const a=await h.broker.execute(h.request);assert.equal(a.cleanupStatus,'pending');
  await assert.rejects(()=>h.broker.execute({...h.request,requestId:'next'}),/stopped/i);
  h.setAbsent(true);const cleaned=await h.broker.cleanup(a.id);assert.equal(cleaned.cleanupStatus,'cleaned');
  assert.equal(cleaned.verifiedCostMicros,null);assert.equal(cleaned.reservedMicros,100);
});

test('expiry denies new effects and resource lifetime triggers independent cleanup',async()=>{
  const h=harness();h.broker.serverApprove(h.approval);const a=await h.broker.execute(h.request);
  h.setTime(1500);h.broker.recover();h.setAbsent(true);
  assert.equal((await h.broker.cleanup(a.id)).cleanupStatus,'cleaned');
  h.setTime(3000);await assert.rejects(()=>h.broker.execute({...h.request,requestId:'late'}),/expired|stopped/i);
});

test('deletion success without actual absence stays pending and retries safely',async()=>{
  const h=harness();h.broker.serverApprove(h.approval);const a=await h.broker.execute(h.request);h.broker.cancel('task',1,'stop');
  assert.equal((await h.broker.cleanup(a.id)).cleanupStatus,'pending');assert.equal(h.counts().deletes,1);
  h.setAbsent(true);assert.equal((await new Broker(h.options).cleanup(a.id)).cleanupStatus,'cleaned');
  assert.equal(h.counts().deletes,1);
});

test('ownership mismatch cannot authorize cleanup or manufacture verified billing',async()=>{
  const h=harness();h.broker.serverApprove(h.approval);h.setExecute((inv:any)=>h.receipt(inv,{ownershipToken:'foreign'}));
  const a=await h.broker.execute(h.request);assert.equal(a.status,'ambiguous');assert.equal(a.resource,undefined);
  h.broker.cancel('task',1,'stop');await h.broker.cleanup(a.id);assert.equal(h.counts().deletes,0);
});

test('verified final cost releases reservation only after resource absence',async()=>{
  const h=harness();h.broker.serverApprove(h.approval);
  h.setExecute((inv:any)=>h.receipt(inv,{billing:{verifiedCostMicros:40,final:true}}));
  const a=await h.broker.execute(h.request);assert.equal(a.verifiedCostMicros,40);assert.equal(a.reservedMicros,60);
  h.broker.cancel('task',1,'stop');h.setAbsent(true);const b=await h.broker.cleanup(a.id);assert.equal(b.reservedMicros,0);
});

test('over-ceiling verified cost stops approval while retaining actual charge',async()=>{
  const h=harness();h.broker.serverApprove(h.approval);
  h.setExecute((inv:any)=>h.receipt(inv,{billing:{verifiedCostMicros:120,final:true}}));
  const a=await h.broker.execute(h.request);assert.equal(a.verifiedCostMicros,120);assert.equal(a.cleanupStatus,'pending');
  await assert.rejects(()=>h.broker.execute({...h.request,requestId:'next'}),/stopped/i);
});

test('HF and GitHub writes require fixed digest/head and retain completed effects',async()=>{
  for(const provider of ['hf','github']) {
    const h=harness();Object.assign(h.profile,{provider,target:provider==='hf'?{repository:'owner/private-model',revision:'main'}:{repository:'owner/repo',branch:'hivemind/task'},operations:[provider==='hf'?'hf.model.commit':'github.branch.push']});
    h.broker.serverApprove(h.approval);h.setExecute((inv:any)=>h.receipt(inv,{effect:'retained',resource:undefined,billing:{verifiedCostMicros:0,final:true}}));
    const request=provider==='hf'?{...h.request,operation:'hf.model.commit' as const,parameters:{artifactDigest:'a'.repeat(64),message:'bounded upload'}}:{...h.request,operation:'github.branch.push' as const,parameters:{artifactDigest:'a'.repeat(64),expectedHead:'b'.repeat(40)}};
    const a=await h.broker.execute(request);assert.equal(a.effect,'retained');assert.equal(a.reservedMicros,0);
    h.broker.cancel('task',1,'stop');await h.broker.cleanup(a.id);assert.equal(h.counts().deletes,0);
  }
});

test('owned Spot inspect remains available with one active resource and carries original ownership',async()=>{
  const h=harness();h.broker.serverApprove(h.approval);const start=await h.broker.execute(h.request);
  h.setExecute((inv:any)=>{assert.equal(inv.ownedResource.actionId,start.id);assert.equal(inv.ownedResource.ownershipToken,start.ownershipToken);return h.receipt(inv,{effect:'none',resource:undefined,billing:{verifiedCostMicros:0,final:true}});});
  const inspected=await h.broker.execute({...h.request,requestId:'inspect',operation:'aws.spot.inspect',parameters:{startActionId:start.id}});
  assert.equal(inspected.status,'succeeded');assert.equal(h.counts().calls,2);
});

test('unknown effect cannot release reserved exposure through a final zero receipt',async()=>{
  const h=harness();h.broker.serverApprove(h.approval);
  h.setExecute((inv:any)=>h.receipt(inv,{effect:'unknown',resource:undefined,billing:{verifiedCostMicros:0,final:true}}));
  const a=await h.broker.execute(h.request);assert.equal(a.status,'ambiguous');assert.equal(a.verifiedCostMicros,null);assert.equal(a.reservedMicros,100);
});

test('startup resolves persisted undispatched intent as provable zero without provider replay',async()=>{
  const h=harness();h.broker.serverApprove(h.approval);const a=await h.broker.execute(h.request);
  h.store.transaction(s=>{Object.assign(s.actions[a.id],{status:'intent',effect:'unknown',resource:undefined,evidenceId:undefined,verifiedCostMicros:null,billingFinal:false,cleanupStatus:'none',providerReceipt:undefined,billingSource:undefined});});
  new Broker(h.options).recover();
  const recovered=await h.broker.execute(h.request);assert.equal(recovered.status,'cancelled');assert.equal(recovered.verifiedCostMicros,0);assert.equal(recovered.reservedMicros,0);assert.equal(h.counts().calls,1);
});

test('cancellation while credential issuance waits prevents transport and proves zero execution',async()=>{
  let release:()=>void=()=>{};const wait=new Promise<void>(r=>{release=r;});
  const h=harness({resolver:{async withCredential(_r:any,_s:any,consume:any){await wait;return consume({opaque:true});}}});
  h.broker.serverApprove(h.approval);const pending=h.broker.execute(h.request);h.broker.cancel('task',1,'stop');release();
  const a=await pending;assert.equal(a.status,'cancelled');assert.equal(a.verifiedCostMicros,0);assert.equal(h.counts().calls,0);
});

test('pending work query discovers ambiguous billing and expired resource cleanup after restart',async()=>{
  const h=harness();h.broker.serverApprove(h.approval);const a=await h.broker.execute(h.request);h.setTime(1500);
  const restarted=new Broker(h.options);assert.equal(restarted.getAction(a.id).cleanupStatus,'pending');
  assert.equal(restarted.listPending().length,1);assert.equal(restarted.listPending()[0]!.id,a.id);
});

test('another profile of the same provider cannot expand targets under the same revision',async()=>{
  const h=harness();h.broker.serverApprove({...h.approval,budgetMicros:100});await h.broker.execute(h.request);
  Object.assign(h.profile,{id:'other',target:{...h.profile.target,workloadId:'other'}});
  assert.throws(()=>h.broker.serverApprove({...h.approval,profileId:'other',budgetMicros:100}),/provider|immutable/i);
  assert.equal(h.counts().calls,1);
});

test('concurrent cleanup cannot regress confirmed absence to pending',async()=>{
  const h=harness();h.broker.serverApprove(h.approval);const a=await h.broker.execute(h.request);h.broker.cancel('task',1,'stop');
  let release:(value:boolean)=>void=()=>{};const delayed=new Promise<boolean>(r=>{release=r;});let confirmations=0;
  const transport={...h.options.transport,async confirmAbsent(){confirmations++;return confirmations===1?delayed:confirmations===2;}};
  const broker=new Broker({...h.options,transport});const first=broker.cleanup(a.id);
  await Promise.resolve();await Promise.resolve();
  assert.equal((await broker.cleanup(a.id)).cleanupStatus,'cleaned');
  release(false);await first;
  assert.equal(broker.getAction(a.id).cleanupStatus,'cleaned');
});

test('canonical key order preserves GitHub request identity and expected-head binding',async()=>{
  const h=harness();Object.assign(h.profile,{provider:'github',target:{repository:'owner/repo',branch:'hivemind/task'},operations:['github.branch.push']});h.broker.serverApprove(h.approval);
  h.setExecute((inv:any)=>h.receipt(inv,{effect:'retained',resource:undefined,billing:{verifiedCostMicros:0,final:true}}));
  const request={...h.request,operation:'github.branch.push' as const,parameters:{artifactDigest:'a'.repeat(64),expectedHead:'b'.repeat(40)}};
  const first=await h.broker.execute(request);
  const second=await h.broker.execute({...request,parameters:{expectedHead:'b'.repeat(40),artifactDigest:'a'.repeat(64)}});
  assert.equal(first.parametersHash,second.parametersHash);assert.equal(h.counts().calls,1);
  await assert.rejects(()=>h.broker.execute({...request,parameters:{...request.parameters,expectedHead:'c'.repeat(40)}}),/conflict/i);
});

test('failed durable intent commit prevents credential resolution and provider call',async()=>{
  const h=harness();h.broker.serverApprove(h.approval);
  const broken=new Broker({...h.options,store:{transaction(){throw Error('durable write failed');}}});
  await assert.rejects(()=>broken.execute(h.request),/durable write failed/);
  assert.equal(h.counts().resolutions,0);assert.equal(h.counts().calls,0);
});

test('partial verified cost keeps remaining upper-bound exposure; stale billing cannot regress it',async()=>{
  const h=harness();h.broker.serverApprove(h.approval);
  h.setExecute((inv:any)=>h.receipt(inv,{billing:{verifiedCostMicros:30,final:false}}));
  const a=await h.broker.execute(h.request);assert.equal(a.reservedMicros,70);
  h.setInspection((inv:any)=>h.receipt(inv,{billing:{verifiedCostMicros:null,final:false}}));
  assert.equal((await h.broker.reconcile(a.id)).verifiedCostMicros,30);
  h.broker.cancel('task',1,'stop');h.setAbsent(true);assert.equal((await h.broker.cleanup(a.id)).reservedMicros,70);
  h.setInspection((inv:any)=>h.receipt(inv,{billing:{verifiedCostMicros:40,final:true}}));
  const b=await h.broker.reconcile(a.id);assert.equal(b.reservedMicros,0);assert.equal(b.cleanupStatus,'cleaned');
});

test('foreign resource discovery and cleanup errors retain pending owned resource',async()=>{
  const h=harness();h.broker.serverApprove(h.approval);const a=await h.broker.execute(h.request);h.broker.cancel('task',1,'stop');
  h.setInspection((inv:any)=>h.receipt(inv,{resource:{id:'foreign',cleanupRequired:true}}));
  assert.equal((await h.broker.reconcile(a.id)).resource!.id,'spot-1');
  const broken=new Broker({...h.options,transport:{...h.options.transport,async cleanup(){throw Error('delete failed');}}});
  assert.equal((await broken.cleanup(a.id)).cleanupStatus,'pending');
});

test('settled prior revision cost still consumes the task budget in a new profile revision',async()=>{
  const h=harness();Object.assign(h.profile,{provider:'github',target:{repository:'owner/repo',branch:'hivemind/task'},operations:['github.branch.push']});
  h.broker.serverApprove({...h.approval,budgetMicros:100});
  h.setExecute((inv:any)=>h.receipt(inv,{effect:'retained',resource:undefined,billing:{verifiedCostMicros:60,final:true}}));
  await h.broker.execute({...h.request,operation:'github.branch.push',parameters:{artifactDigest:'a'.repeat(64),expectedHead:'b'.repeat(40)}});
  Object.assign(h.profile,{id:'hf',provider:'hf',target:{repository:'owner/model',revision:'main'},operations:['hf.model.commit']});
  h.broker.serverApprove({...h.approval,revision:2,profileId:'hf',budgetMicros:100});
  await assert.rejects(()=>h.broker.execute({...h.request,revision:2,profileId:'hf',operation:'hf.model.commit',parameters:{artifactDigest:'a'.repeat(64),message:'upload'}}),/budget/i);
  assert.equal(h.counts().calls,1);
});

test('the same revision cannot increase its approved budget',()=>{
  const h=harness();h.broker.serverApprove({...h.approval,budgetMicros:100});
  assert.throws(()=>h.broker.serverApprove({...h.approval,budgetMicros:200}),/immutable|budget|ceiling/i);
});
test('trusted new revision can expand budget while all historical known spend still counts',async()=>{
 const h=harness();Object.assign(h.profile,{provider:'github',target:{repository:'owner/repo',branch:'work'},operations:['github.branch.push']});
 const request={...h.request,operation:'github.branch.push' as const,parameters:{artifactDigest:'a'.repeat(64),expectedHead:'b'.repeat(40)}};
 h.broker.serverApprove({...h.approval,budgetMicros:100});h.setExecute((inv:any)=>h.receipt(inv,{effect:'retained',resource:undefined,billing:{verifiedCostMicros:60,final:true}}));
 await h.broker.execute(request);h.broker.serverApprove({...h.approval,revision:2,budgetMicros:200});
 assert.equal((await h.broker.execute({...request,revision:2,requestId:'second'})).status,'succeeded');
 await assert.rejects(h.broker.execute({...request,revision:2,requestId:'third'}),/budget/i);
 assert.equal(h.counts().calls,2);
 await assert.rejects(h.broker.execute({...request,requestId:'stale'}),/stale|revision/i);assert.equal(h.counts().calls,2);
});
test('expanded new revision still waits for old resource cleanup and final billing',async()=>{
 const h=harness();h.broker.serverApprove({...h.approval,budgetMicros:100});const a=await h.broker.execute(h.request);
 h.broker.serverApprove({...h.approval,revision:2,budgetMicros:300});
 await assert.rejects(h.broker.execute({...h.request,revision:2}),/revision unresolved/i);
 await assert.rejects(h.broker.execute({...h.request,requestId:'old-new'}),/stale|revision/i);
 h.broker.cancel('task',1,'retire old revision');h.setAbsent(true);await h.broker.cleanup(a.id);
 await assert.rejects(h.broker.execute({...h.request,revision:2}),/revision unresolved/i);
 h.setInspection((inv:any)=>h.receipt(inv,{billing:{verifiedCostMicros:40,final:true}}));await h.broker.reconcile(a.id);
 h.setExecute((inv:any)=>h.receipt(inv,{resource:{id:'spot-2',cleanupRequired:true}}));
 assert.equal((await h.broker.execute({...h.request,revision:2})).status,'succeeded');
});
test('profiles of the current revision must share one exact budget; stale approvals cannot add profiles',()=>{
 const h=harness();h.broker.serverApprove(h.approval);h.broker.serverApprove({...h.approval,revision:2,budgetMicros:300});
 Object.assign(h.profile,{id:'hf',provider:'hf',target:{repository:'owner/model',revision:'main'},operations:['hf.model.commit']});
 assert.throws(()=>h.broker.serverApprove({...h.approval,profileId:'hf',revision:2,budgetMicros:299}),/budget|immutable/i);
 assert.throws(()=>h.broker.serverApprove({...h.approval,profileId:'hf'}),/stale|revision/i);
 assert.equal(h.broker.serverApprove({...h.approval,profileId:'hf',revision:2,budgetMicros:300}).budgetMicros,300);
});

test('revision cancellation does not cancel another approved revision',async()=>{
  const h=harness();h.broker.serverApprove(h.approval);h.broker.serverApprove({...h.approval,revision:2});h.broker.cancel('task',1,'old revision');
  await assert.rejects(()=>h.broker.execute(h.request),/stopped/i);
  assert.equal((await h.broker.execute({...h.request,revision:2})).status,'succeeded');
});
test('same revision permits one profile per provider under one global task budget',async()=>{
 const h=harness();h.profile.upperBoundMicros=50;h.broker.serverApprove(h.approval);await h.broker.execute(h.request);
 Object.assign(h.profile,{id:'hf',provider:'hf',target:{repository:'owner/model',revision:'main'},operations:['hf.model.commit']});
 h.broker.serverApprove({...h.approval,profileId:'hf'});h.setExecute((inv:any)=>h.receipt(inv,{effect:'retained',resource:undefined}));
 const r=await h.broker.execute({...h.request,profileId:'hf',operation:'hf.model.commit',parameters:{artifactDigest:'a'.repeat(64),message:'artifact'}});
 assert.equal(r.status,'succeeded');
 Object.assign(h.profile,{id:'hf2'});assert.throws(()=>h.broker.serverApprove({...h.approval,profileId:'hf2'}),/provider|immutable/i);
});
test('different revision still blocks unresolved effects from another profile',async()=>{
 const h=harness();h.broker.serverApprove(h.approval);await h.broker.execute(h.request);
 Object.assign(h.profile,{id:'hf',provider:'hf',target:{repository:'owner/model',revision:'main'},operations:['hf.model.commit']});
 h.broker.serverApprove({...h.approval,profileId:'hf',revision:2});
 await assert.rejects(h.broker.execute({...h.request,profileId:'hf',revision:2,operation:'hf.model.commit',parameters:{artifactDigest:'a'.repeat(64),message:'artifact'}}),/revision unresolved/i);
});
test('same revision cross-profile actions cannot open separate budget wallets',async()=>{
 const h=harness();h.broker.serverApprove({...h.approval,budgetMicros:100});await h.broker.execute(h.request);
 Object.assign(h.profile,{id:'hf',provider:'hf',target:{repository:'owner/model',revision:'main'},operations:['hf.model.commit']});
 h.broker.serverApprove({...h.approval,profileId:'hf',budgetMicros:100});
 await assert.rejects(h.broker.execute({...h.request,profileId:'hf',operation:'hf.model.commit',parameters:{artifactDigest:'a'.repeat(64),message:'artifact'}}),/budget/i);
});
test('dispatch authority observes cancellation during transport preparation without inventing zero',async()=>{
 const h=harness();h.broker.serverApprove(h.approval);let authority:any;let release:()=>void=()=>{};
 const wait=new Promise<void>(r=>{release=r;});let started:()=>void=()=>{};const ready=new Promise<void>(r=>{started=r;});
 const broker=new Broker({...h.options,transport:{...h.options.transport,async execute(inv:any,_c:any,guard?:any){authority=guard;started();await wait;guard.assertActive();return h.receipt(inv);}}});
 const pending=broker.execute(h.request);await ready;broker.cancel('task',1,'cancel');release();const action=await pending;
 assert.ok(authority);assert.equal(authority.signal.aborted,true);assert.equal(action.status,'ambiguous');assert.equal(action.verifiedCostMicros,null);assert.equal(action.reservedMicros,100);
});
test('actual AWS adapter reconciles a cancelled lost create and cleans only the late owned resource',async()=>{
 const h=harness(),guardArn='arn:aws:events:ap-northeast-2:123456789012:rule/hivemind-ttl';let broker:any;
 let tags=new Map<string,string>(),clientToken='',terminated=false,creates=0,deletes=0;
 const digest=(r:unknown)=>createHash('sha256').update(JSON.stringify(r)).digest('hex');
 const awsTtlGuard={guardArn,port:{
  async attest(r:any){return {kind:'preexisting_termination_guard' as const,guardArn,evidenceId:'synthetic-guard',bindingHash:digest(r),installedAt:0,observedAt:1000,validUntil:r.expiresAt,maxExposureMicros:r.maxExposureMicros};},
  async arm(r:any){return {kind:'owned_expiry_timer' as const,guardArn,timerArn:'arn:aws:scheduler:ap-northeast-2:123456789012:schedule/hivemind/hm-'+digest(r).slice(0,48),evidenceId:'synthetic-timer',bindingHash:digest(r),expiresAt:r.expiresAt};}
 }};
 const transport=createExternalProviderTransport({enabled:true,aws:{enabled:true,...h.profile.target,imageId:'ami-1234',instanceType:'t3.micro',subnetId:'subnet-1234',instanceProfileArn:'arn:aws:iam::123456789012:instance-profile/worker',maxLifetimeMs:1000,credentialRef:'aws-worker',maxUpperBoundMicros:100,billingPolicy:'reserved_ceiling_only'},awsTtlGuard,artifacts:{async load(){throw Error('not an artifact operation');}},now:()=>1000,fetch:async(_url,init)=>{
  const p=new URLSearchParams(String(init?.body)),action=p.get('Action');
  if(action==='GetCallerIdentity')return new Response('<GetCallerIdentityResponse><GetCallerIdentityResult><Account>123456789012</Account><Arn>arn:aws:iam::123456789012:user/test</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>');
  if(action==='RunInstances'){
   creates++;clientToken=p.get('ClientToken')!;tags=new Map();for(let n=1;p.has(`TagSpecification.1.Tag.${n}.Key`);n++)tags.set(p.get(`TagSpecification.1.Tag.${n}.Key`)!,p.get(`TagSpecification.1.Tag.${n}.Value`)!);
   broker.cancel('task',1,'cancel after send');throw Error('synthetic lost response');
  }
  if(action==='TerminateInstances'){assert.equal(p.get('InstanceId.1'),'i-1234abcd');deletes++;terminated=true;return new Response('<TerminateInstancesResponse><requestId>delete-1</requestId></TerminateInstancesResponse>');}
  if(action==='DescribeVolumes')return new Response('<DescribeVolumesResponse><requestId>vol-1</requestId><volumeSet></volumeSet></DescribeVolumesResponse>');
  assert.equal(action,'DescribeInstances');
  const tagXml=[...tags].map(([key,value])=>`<item><key>${key}</key><value>${value}</value></item>`).join('');
  return new Response(`<DescribeInstancesResponse><requestId>read-1</requestId><reservationSet><item><ownerId>123456789012</ownerId><instancesSet><item><instanceId>i-1234abcd</instanceId><placement><availabilityZone>ap-northeast-2a</availabilityZone></placement><clientToken>${clientToken}</clientToken><instanceState><name>${terminated?'terminated':'running'}</name></instanceState><tagSet>${tagXml}</tagSet></item></instancesSet></item></reservationSet></DescribeInstancesResponse>`);
 }});
 broker=new Broker({...h.options,transport,resolver:{async withCredential(_r:any,_s:any,consume:any){return consume({provider:'aws',accessKeyId:'SYNTHETIC',secretAccessKey:'not-real'});}}});
 broker.serverApprove(h.approval);const unknown=await broker.execute(h.request);assert.equal(unknown.status,'ambiguous');assert.equal(unknown.verifiedCostMicros,null);assert.equal(unknown.resource,undefined);
 const late=await broker.reconcile(unknown.id);assert.equal(late.resource.id,'i-1234abcd');assert.equal(late.cleanupStatus,'pending');
 const cleaned=await broker.cleanup(unknown.id);assert.equal(cleaned.cleanupStatus,'cleaned');assert.equal(cleaned.verifiedCostMicros,null);assert.equal(cleaned.reservedMicros,100);assert.equal(creates,1);assert.equal(deletes,1);
});
test('valid-codec SQL state with malformed broker semantics fails before credential/provider access',async()=>{
 const h=harness();h.broker.serverApprove(h.approval);const action=await h.broker.execute(h.request);
 const valid=h.store.transaction(s=>s);
 const corruptions:[string,(s:any)=>void][]=[
  ['negative cost',s=>s.actions[action.id].verifiedCostMicros=-1],
  ['negative reservation',s=>s.actions[action.id].reservedMicros=-1],
  ['reservation mismatch',s=>s.actions[action.id].reservedMicros=0],
  ['dangling approval',s=>s.actions[action.id].approvalId='0'.repeat(64)],
  ['profile target changed',s=>s.approvals[action.approvalId].profile.target.workloadId='foreign'],
  ['action pin changed',s=>s.actions[action.id].profileHash='0'.repeat(64)],
  ['parameters changed',s=>s.actions[action.id].parameters.lifetimeMs=501],
  ['impossible cleanup',s=>{delete s.actions[action.id].resource;s.actions[action.id].cleanupStatus='cleaned';}],
  ['impossible status',s=>s.actions[action.id].status='invented'],
  ['ownership changed',s=>s.actions[action.id].idempotencyKey='0'.repeat(64)],
  ['future lifetime',s=>s.actions[action.id].expiresAt=999999],
  ['unknown field',s=>s.actions[action.id].taskId='foreign'],
  ['duplicate resource ownership',s=>{
   const a=structuredClone(s.actions[action.id]);a.id='second-action';a.requestId='second-request';a.ownershipToken='00000000-0000-4000-8000-000000000000';a.idempotencyKey=createHash('sha256').update(JSON.stringify([a.approvalId,a.id,a.parametersHash])).digest('hex');s.actions[a.id]=a;
  }],
 ];
 for(const [name,mutate] of corruptions){
  const store=createExternalStore(':memory:');try{
   store.transaction(s=>Object.assign(s,structuredClone(valid)));store.transaction(s=>mutate(s));let calls=0;
   const broker=new Broker({...h.options,store,resolver:{async withCredential(){calls++;throw Error('must not resolve');}},transport:{...h.options.transport,async execute(){calls++;throw Error('must not call');}}});
   assert.throws(()=>broker.getAction(action.id),/Invalid external persisted state/,name);
   await assert.rejects(broker.execute({...h.request,requestId:'new'}),/Invalid external persisted state/,name);assert.equal(calls,0,name);
  }finally{store.close();}
 }
});
test('semantic restore accepts unknown billing, registry revocation, late cleanup and SQL reopen',async()=>{
 const h=harness();h.broker.serverApprove(h.approval);const a=await h.broker.execute(h.request);h.broker.cancel('task',1,'stop');
 const store=createExternalStore(':memory:');try{
  store.transaction(s=>Object.assign(s,h.store.transaction(s=>s)));h.profile.enabled=false;h.setAbsent(true);
  const restored=new Broker({...h.options,store});const cleaned=await restored.cleanup(a.id);
  assert.equal(cleaned.cleanupStatus,'cleaned');assert.equal(cleaned.verifiedCostMicros,null);assert.equal(cleaned.reservedMicros,100);
  assert.equal(new Broker({...h.options,store}).getAction(a.id).cleanupStatus,'cleaned');
 }finally{store.close();}
});
test('SQL restore rejects a cross-task inspection reference even when its hashes are recomputed',async()=>{
 const h=harness();h.broker.serverApprove(h.approval);h.broker.serverApprove({...h.approval,taskId:'other'});
 h.setExecute((inv:any)=>h.receipt(inv,{resource:{id:'spot-'+inv.taskId,cleanupRequired:true}}));
 const own=await h.broker.execute(h.request),foreign=await h.broker.execute({...h.request,taskId:'other'});
 h.setExecute((inv:any)=>h.receipt(inv,{effect:'none',resource:undefined}));
 const read=await h.broker.execute({...h.request,requestId:'inspect',operation:'aws.spot.inspect',parameters:{startActionId:own.id}});
 const store=createExternalStore(':memory:');try{
  store.transaction(s=>Object.assign(s,h.store.transaction(s=>s)));
  store.transaction(s=>{const a=s.actions[read.id]!,p=s.approvals[a.approvalId]!;a.parameters={startActionId:foreign.id};a.parametersHash=externalParametersHash(p.profile,a.operation,a.parameters);a.idempotencyKey=createHash('sha256').update(JSON.stringify([a.approvalId,a.id,a.parametersHash])).digest('hex');});
  const restored=new Broker({...h.options,store});assert.throws(()=>restored.getAction(read.id),/Invalid external persisted state/);
 }finally{store.close();}
});
test('trusted billing review settles HF/GH unknown fees with explicit human provenance and exact idempotence',async()=>{
 for(const provider of ['hf','github']){
  const h=harness();Object.assign(h.profile,{provider,target:provider==='hf'?{repository:'owner/model',revision:'main'}:{repository:'owner/repo',branch:'work'},operations:[provider==='hf'?'hf.model.commit':'github.branch.push']});
  h.broker.serverApprove(h.approval);h.setExecute((i:any)=>h.receipt(i,{effect:'retained',resource:undefined}));
  const request=provider==='hf'?{...h.request,operation:'hf.model.commit' as const,parameters:{artifactDigest:'a'.repeat(64),message:'artifact'}}:{...h.request,operation:'github.branch.push' as const,parameters:{artifactDigest:'a'.repeat(64),expectedHead:'b'.repeat(40)}};
  const action=await h.broker.execute(request),reviewed=(h.broker as any).serverAttestBilling(action.id,37,'invoice-20261120-1','Verified complete invoice');
  assert.equal(reviewed.billingFinal,true);assert.equal(reviewed.verifiedCostMicros,37);assert.equal(reviewed.reservedMicros,0);assert.equal(reviewed.billingSource,'operator_attested');
  assert.deepEqual(reviewed.operatorBilling,{actualCostMicros:37,evidenceRef:'invoice-20261120-1',reason:'Verified complete invoice',at:1000});
  assert.equal(reviewed.providerReceipt.billing.verifiedCostMicros,null);assert.equal(reviewed.providerReceipt.billing.final,false);
  assert.equal(reviewed.evidenceId,action.evidenceId);h.setTime(1100);
  assert.deepEqual((h.broker as any).serverAttestBilling(action.id,37,'invoice-20261120-1','Verified complete invoice'),reviewed);
  for(const [amount,evidence,reason] of [[38,'invoice-20261120-1','Verified complete invoice'],[37,'other-invoice','Verified complete invoice'],[37,'invoice-20261120-1','Different review']] as const)assert.throws(()=>(h.broker as any).serverAttestBilling(action.id,amount,evidence,reason),{statusCode:409});
  h.setInspection((i:any)=>h.receipt(i,{effect:'retained',resource:undefined,billing:{verifiedCostMicros:0,final:true}}));
  assert.deepEqual(await h.broker.reconcile(action.id),reviewed);
 }
});
test('billing attestation cannot waive live/unknown resources, ambiguous execution or provider final cost',async()=>{
 const h=harness();h.broker.serverApprove(h.approval);const a=await h.broker.execute(h.request);
 assert.throws(()=>(h.broker as any).serverAttestBilling(a.id,0,'invoice-1','Checked invoice'),{statusCode:409});assert.equal(h.broker.getAction(a.id).cleanupStatus,'none');
 h.broker.cancel('task',1,'stop');assert.throws(()=>(h.broker as any).serverAttestBilling(a.id,0,'invoice-1','Checked invoice'),{statusCode:409});
 h.setAbsent(true);await h.broker.cleanup(a.id);
 const final=(h.broker as any).serverAttestBilling(a.id,41,'invoice-1','Checked complete invoice');assert.equal(final.cleanupStatus,'cleaned');assert.equal(final.billingSource,'operator_attested');assert.equal(final.reservedMicros,0);
 const unknown=harness();unknown.broker.serverApprove(unknown.approval);unknown.setExecute(()=>{throw Error('unknown');});const lost=await unknown.broker.execute(unknown.request);
 assert.throws(()=>(unknown.broker as any).serverAttestBilling(lost.id,0,'invoice-1','Checked invoice'),{statusCode:409});assert.equal(unknown.broker.getAction(lost.id).verifiedCostMicros,null);
 const verified=harness();verified.broker.serverApprove(verified.approval);verified.setExecute((i:any)=>verified.receipt(i,{billing:{verifiedCostMicros:23,final:true}}));const provider=await verified.broker.execute(verified.request);verified.broker.cancel('task',1,'stop');verified.setAbsent(true);await verified.broker.cleanup(provider.id);
 assert.throws(()=>(verified.broker as any).serverAttestBilling(provider.id,0,'invoice-1','Checked invoice'),{statusCode:409});assert.equal(verified.broker.getAction(provider.id).verifiedCostMicros,23);
});
test('operator invoice overcost stops task approvals and requests cleanup of other live resources',async()=>{
 const h=harness();h.broker.serverApprove(h.approval);const live=await h.broker.execute(h.request);
 Object.assign(h.profile,{id:'hf',provider:'hf',target:{repository:'owner/model',revision:'main'},operations:['hf.model.commit']});h.broker.serverApprove({...h.approval,profileId:'hf'});h.setExecute((i:any)=>h.receipt(i,{effect:'retained',resource:undefined}));
 const upload=await h.broker.execute({...h.request,profileId:'hf',operation:'hf.model.commit',parameters:{artifactDigest:'a'.repeat(64),message:'artifact'}});
 const reviewed=(h.broker as any).serverAttestBilling(upload.id,120,'invoice-overcost','Verified excess charge');assert.equal(reviewed.verifiedCostMicros,120);assert.equal(reviewed.billingSource,'operator_attested');assert.equal(h.broker.getAction(live.id).cleanupStatus,'pending');
 await assert.rejects(h.broker.execute({...h.request,profileId:'hf',requestId:'next',operation:'hf.model.commit',parameters:{artifactDigest:'a'.repeat(64),message:'artifact'}}),/stopped/i);
});
test('billing evidence is a bounded reference, not a URL/secret, and review survives SQL restore',async()=>{
 const h=harness();Object.assign(h.profile,{provider:'github',target:{repository:'owner/repo',branch:'work'},operations:['github.branch.push']});h.broker.serverApprove(h.approval);h.setExecute((i:any)=>h.receipt(i,{effect:'retained',resource:undefined}));
 const a=await h.broker.execute({...h.request,operation:'github.branch.push',parameters:{artifactDigest:'a'.repeat(64),expectedHead:'b'.repeat(40)}});
 for(const ref of ['https://invoice.invalid/?token=secret','invoice?secret','ghs_privatecredentialvalue','a'.repeat(129)])assert.throws(()=>(h.broker as any).serverAttestBilling(a.id,1,ref,'Invoice checked'));
 for(const reason of ['','x'.repeat(2001),'Bearer PRIVATEVALUE','line\nbreak'])assert.throws(()=>(h.broker as any).serverAttestBilling(a.id,1,'invoice-1',reason));
 const reviewed=(h.broker as any).serverAttestBilling(a.id,11,'invoice-1','Invoice checked');const store=createExternalStore(':memory:');try{store.transaction(s=>Object.assign(s,h.store.transaction(s=>s)));assert.deepEqual(new Broker({...h.options,store}).getAction(a.id),reviewed);}finally{store.close();}
});

test('HF public large opt-in is approved, preserved in metadata and bound to the current profile hash',async()=>{
 const h=harness();Object.assign(h.profile,{provider:'hf',target:{repository:'org/model',revision:'main',visibility:'public',allowPublicLarge:true},operations:['hf.model.lfs_commit']});
 const approved=h.broker.serverApprove(h.approval);
 assert.deepEqual(approved.profile.target,h.profile.target);
 assert.equal((approved.profile.target as any).allowPublicLarge,true);
 h.profile.target={repository:'org/model',revision:'main'};
 await assert.rejects(()=>h.broker.execute({...h.request,operation:'hf.model.lfs_commit',parameters:{manifestDigest:'a'.repeat(64),message:'model'}}),/profile/i);
 assert.equal(h.counts().resolutions,0);
});
test('HF profile rejects missing public large acknowledgement and malformed or private flags',()=>{
 for(const target of [{visibility:'public'},{visibility:'public',allowPublicLarge:false},{visibility:'public',allowPublicLarge:'true'},{allowPublicLarge:true},{visibility:'private',allowPublicLarge:true}]){
  const h=harness();Object.assign(h.profile,{provider:'hf',target:{repository:'org/model',revision:'main',...target},operations:['hf.model.lfs_commit']});
  assert.throws(()=>h.broker.serverApprove(h.approval));
 }
});
test('HF legacy private target is not normalized during approval',()=>{
 const h=harness();Object.assign(h.profile,{provider:'hf',target:{repository:'org/model',revision:'main'},operations:['hf.model.lfs_commit']});
 const approved=h.broker.serverApprove(h.approval);
 assert.deepEqual(approved.profile,h.profile);
 const canonical=(v:any):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
 assert.equal(approved.profileHash,createHash('sha256').update(canonical(h.profile)).digest('hex'));
});

test('HF public large consent requires an approved large operation',()=>{
 const h=harness();Object.assign(h.profile,{provider:'hf',target:{repository:'org/model',revision:'main',visibility:'public',allowPublicLarge:true},operations:['hf.model.commit']});
 assert.throws(()=>h.broker.serverApprove(h.approval));
});
