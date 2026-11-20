import test from 'node:test';
import assert from 'node:assert/strict';
// Source execution also works before the normal emitted build exists.
import { AutonomousEngine } from '../packages/core/src/autonomous.js';
import type { AutonomousSpec, AutonomousRunResult } from '../packages/contracts/src/autonomous.js';
const spec: AutonomousSpec = {requestId:'req',goal:'goal',provider:'mock',model:'mock-v1',endsAt:100000,budgetMicros:100,tools:['deploy'],systems:['aws'],credentialIds:[],maxRunMs:1000,maxIterations:3};
const result = (outcome: AutonomousRunResult['outcome']='continue'): AutonomousRunResult => ({outcome,usage:{inputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:1},costMicros:1,checkpoint:{sessionId:'session',objectKey:'private-ref',model:'mock-v1',sequence:1}});
function ready(s: Partial<AutonomousSpec>={}) { const e=new AutonomousEngine(); e.create({...spec,...s},0,'t'); e.approve('t',1,'approved',1); return e; }
function claimed(s: Partial<AutonomousSpec>={}) { const e=ready(s); const l=e.claim('t','w','secret','run',2)!; return {e,l}; }
test('approval, claim exclusivity, public redaction and defensive copies',()=>{const e=new AutonomousEngine(); e.create(spec,0,'t'); assert.equal(e.claim('t','w','s','r',1),null); assert.throws(()=>e.approve('t',2,'yes',1)); e.approve('t',1,'yes',1); const l=e.claim('t','w','secret','r',2)!; assert.equal(e.claim('t','w2','s2','r2',3),null); assert.ok(!JSON.stringify(e.get('t')).includes('secret')); assert.ok(!JSON.stringify(e.list()).includes('secret')); const snapshot=e.snapshot(); snapshot.tasks.t!.spec.goal='changed'; assert.equal(e.get('t').spec.goal,'goal'); assert.equal(new AutonomousEngine(e.snapshot()).heartbeat(l,3).runId,'r'); });
test('wait has exact wake boundary and per-run accounting',()=>{const {e,l}=claimed(); e.finish(l,{...result('wait'),wakeAt:2000},3); e.tick(1999); assert.equal(e.get('t').status,'waiting'); e.tick(2000); assert.equal(e.get('t').status,'ready'); assert.equal(e.get('t').spentMicros,1); assert.equal(e.get('t').runs.length,1);});
test('stale lease, model mismatch, invalid wake and overflow rejected atomically',()=>{const {e,l}=claimed(); for(const r of [{...result(),checkpoint:{...result().checkpoint!,model:'other'}},{...result('wait')},{...result(),costMicros:Number.MAX_SAFE_INTEGER+1}]) assert.throws(()=>e.finish(l,r,3)); assert.equal(e.get('t').runs.length,0); assert.throws(()=>e.heartbeat({...l,token:'bad'},3)); assert.throws(()=>e.finish(l,result(),1002));});
test('cancel waits for lease and resource cleanup; late finish cannot revive',()=>{const {e,l}=claimed(); const a=e.reserve(l,{requestId:'a',tool:'deploy',system:'aws',operation:'create',estimatedCostMicros:10},3); e.settle(l,a.id,8,true,{id:'res',system:'aws',cleanupOperation:'delete'},4); e.cancel('t','cancel',5); assert.equal(e.get('t').status,'stopping'); e.cleaned('t','res',6); assert.equal(e.get('t').status,'stopping'); e.finish(l,result('continue'),7); assert.equal(e.get('t').status,'cancelled'); assert.throws(()=>e.finish(l,result(),8));});
test('reservation replay, settlement replay, budget and scope suspension',()=>{const {e,l}=claimed(); const req={requestId:'a',tool:'deploy',system:'aws',operation:'create',estimatedCostMicros:10}; const a=e.reserve(l,req,3); assert.deepEqual(e.reserve(l,req,4),a); e.settle(l,a.id,8,true,undefined,5); e.settle(l,a.id,8,true,undefined,6); assert.equal(e.get('t').spentMicros,8); assert.throws(()=>e.reserve(l,{...req,requestId:'b',tool:'shell'},7)); assert.equal(e.get('t').status,'awaiting_input'); assert.equal(e.get('t').interventions.length,2);});
test('unknown action blocks recovery and completion',()=>{const {e,l}=claimed(); e.reserve(l,{requestId:'a',tool:'deploy',system:'aws',operation:'create',estimatedCostMicros:10},3); e.tick(1002); assert.equal(e.get('t').actions[0]!.status,'unknown'); assert.equal(e.claim('t','w','x','r2',1003),null); assert.notEqual(e.get('t').status,'completed');});
test('timeout restores committed checkpoint, never repeats blind first run',()=>{const {e,l}=claimed(); e.finish(l,result(),3); const l2=e.claim('t','w','next','run2',4)!; e.tick(l2.expiresAt); assert.equal(e.get('t').status,'awaiting_input'); e.reconcileRun('t','run2',0,'invoice verified',1005); e.resume('t',1,'resume checkpoint',1006); assert.equal(new AutonomousEngine(e.snapshot()).get('t').checkpoint!.sessionId,'session'); const first=claimed(); first.e.tick(first.l.expiresAt); assert.equal(first.e.get('t').status,'awaiting_input');});
test('deadline, unknown cost, iteration cap and heartbeat ceiling',()=>{const a=claimed({endsAt:20}); assert.equal(a.e.heartbeat(a.l,10).expiresAt,20); a.e.tick(20); assert.equal(a.e.get('t').status,'stopping'); a.e.reconcileRun('t','run',0,'invoice checked',21); assert.equal(new AutonomousEngine(a.e.snapshot()).get('t').status,'expired'); const b=claimed(); b.e.finish(b.l,{...result(),costMicros:null},3); assert.equal(b.e.get('t').status,'awaiting_input'); const c=claimed({maxIterations:1}); c.e.finish(c.l,result(),3); assert.equal(c.e.get('t').status,'completed');});
test('revise invalidates approval and redacts intervention text',()=>{const e=ready(); e.revise('t',{...spec,goal:'new'},'Bearer abcdef',2); assert.equal(e.get('t').revision,2); assert.equal(e.get('t').status,'awaiting_approval'); assert.throws(()=>e.approve('t',1,'yes',3)); assert.ok(!JSON.stringify(e.get('t')).includes('abcdef')); assert.throws(()=>e.revise('t',{...spec,model:'new'},'no',4));});
test('persisted state and bounded input are validated',()=>{assert.throws(()=>new AutonomousEngine({version:2,tasks:{}} as never)); const e=ready(); const s=e.snapshot(); s.tasks.t!.spentMicros=-1; assert.throws(()=>new AutonomousEngine(s)); assert.throws(()=>new AutonomousEngine().create({...spec,goal:'x'.repeat(17000)},0,'x'));});
test('heartbeat renews within absolute run limit and preserves true start time',()=>{const {e,l}=claimed({maxRunMs:90000}); assert.equal(l.expiresAt,30002); const renewed=e.heartbeat(l,20000); assert.equal(renewed.expiresAt,50000); const restored=new AutonomousEngine(e.snapshot()); assert.equal(restored.heartbeat(renewed,49000).expiresAt,79000); const last=restored.heartbeat(renewed,78000); assert.equal(last.expiresAt,90002); restored.finish(last,result('complete'),80000); assert.equal(restored.get('t').runs[0]!.startedAt,2); assert.equal(restored.get('t').activeRunStartedAt,undefined);});
test('unknown run cost requires reconciliation before resume or final cancellation',()=>{const {e,l}=claimed(); e.finish(l,{...result(),costMicros:null},3); e.message('t','continue please',4); assert.equal(e.get('t').status,'awaiting_input'); assert.throws(()=>e.resume('t',1,'resume',5)); e.reconcileRun('t','run',7,'invoice checked',6); assert.equal(e.get('t').runs[0]!.costMicros,null); assert.equal(e.get('t').runs[0]!.reconciledCostMicros,7); assert.equal(e.get('t').spentMicros,7); e.reconcileRun('t','run',7,'replay',7); assert.equal(e.get('t').spentMicros,7); e.resume('t',1,'same policy',8); assert.equal(e.get('t').status,'ready'); assert.equal(new AutonomousEngine(e.snapshot()).get('t').spentMicros,7);});
test('committed denials survive snapshot restart; ordinary errors are atomic',()=>{const {e,l}=claimed(); const before=e.snapshot(); assert.throws(()=>e.reserve(l,{requestId:'x',tool:'deploy',system:'aws',operation:'create',estimatedCostMicros:-1},3),(err:unknown)=>{assert.equal((err as {commitState:boolean}).commitState,false); return true;}); assert.deepEqual(e.snapshot(),before); assert.throws(()=>e.reserve(l,{requestId:'x',tool:'shell',system:'aws',operation:'create',estimatedCostMicros:1},3),(err:unknown)=>{assert.equal((err as {commitState:boolean}).commitState,true); return true;}); const restarted=new AutonomousEngine(e.snapshot()); assert.equal(restarted.get('t').status,'awaiting_input'); restarted.finish(l,result('input'),4); restarted.resume('t',1,'same approved scope',5); const next=restarted.claim('t','w','new','r2',6)!; assert.throws(()=>restarted.reserve(next,{requestId:'y',tool:'shell',system:'aws',operation:'create',estimatedCostMicros:1},7));});
test('operator reconciles abandoned action and cleanup before cancellation',()=>{const {e,l}=claimed(); const a=e.reserve(l,{requestId:'x',tool:'deploy',system:'aws',operation:'create',estimatedCostMicros:10},3); assert.throws(()=>e.reconcile('t',a.id,6,true,undefined,'evidence',4)); e.cancel('t','stop',5); e.tick(l.expiresAt); assert.equal(e.get('t').status,'stopping'); e.reconcile('t',a.id,6,true,{id:'res',system:'aws',cleanupOperation:'delete'},'resource inventory checked',1003); assert.equal(e.get('t').resources[0]!.status,'cleanup_pending'); e.cleaned('t','res',1004); assert.equal(e.get('t').status,'stopping'); e.reconcileRun('t','run',0,'invoice checked',1005); assert.equal(e.get('t').status,'cancelled'); assert.equal(new AutonomousEngine(e.snapshot()).get('t').spentMicros,6);});
test('public counts separate agent help from human intervention and never persist',()=>{const {e,l}=claimed(); assert.throws(()=>e.reserve(l,{requestId:'x',tool:'shell',system:'aws',operation:'create',estimatedCostMicros:1},3)); const task=e.get('t'); assert.deepEqual(task.counts,{humanInterventions:1,helpRequests:1,toolCalls:0}); assert.equal(e.snapshot().tasks.t!.counts,undefined);});
test('forged state cannot bless costs, leases, statuses or checkpoints',()=>{const {e,l}=claimed(); e.finish(l,result(),3); const base=e.snapshot(); for(const corrupt of [(s:typeof base)=>{s.tasks.t!.spentMicros=0;},(s:typeof base)=>{s.tasks.t!.status='running';},(s:typeof base)=>{s.tasks.t!.checkpoint!.objectKey='forged';},(s:typeof base)=>{s.tasks.t!.runs[0]!.usage.inputTokens=-1;}]) {const state=structuredClone(base); corrupt(state); assert.throws(()=>new AutonomousEngine(state));}});
test('result timestamp before claim is rejected without mutation',()=>{const {e,l}=claimed(); const before=e.snapshot(); assert.throws(()=>e.finish(l,result(),1)); assert.deepEqual(e.snapshot(),before);});
test('budget denial commits stopping state and cannot renew authority',()=>{const {e,l}=claimed(); assert.throws(()=>e.reserve(l,{requestId:'big',tool:'deploy',system:'aws',operation:'create',estimatedCostMicros:101},3)); const restart=new AutonomousEngine(e.snapshot()); assert.equal(restart.get('t').status,'stopping'); assert.throws(()=>restart.heartbeat(l,4)); restart.finish(l,result(),5); assert.equal(restart.get('t').status,'budget_exceeded');});
test('revised scope retains historical action permissions and remains restorable',()=>{const {e,l}=claimed(); const a=e.reserve(l,{requestId:'a',tool:'deploy',system:'aws',operation:'create',estimatedCostMicros:10},3); e.settle(l,a.id,5,true,undefined,4); e.finish(l,result('input'),5); const before=e.snapshot(); assert.throws(()=>e.revise('t',{...spec,tools:[]},'remove used tool',6)); assert.deepEqual(e.snapshot(),before); e.revise('t',{...spec,tools:['deploy','read']},'expand reviewed scope',6); assert.equal(new AutonomousEngine(e.snapshot()).get('t').revision,2);});
test('settlement conflict and overflow cannot modify money or resources',()=>{const {e,l}=claimed({budgetMicros:Number.MAX_SAFE_INTEGER}); const a=e.reserve(l,{requestId:'a',tool:'deploy',system:'aws',operation:'create',estimatedCostMicros:1},3); e.settle(l,a.id,Number.MAX_SAFE_INTEGER-1,true,undefined,4); const b=e.reserve(l,{requestId:'b',tool:'deploy',system:'aws',operation:'create',estimatedCostMicros:1},5); const before=e.snapshot(); assert.throws(()=>e.settle(l,b.id,2,true,undefined,6)); assert.deepEqual(e.snapshot(),before); assert.throws(()=>e.settle(l,a.id,1,true,undefined,6)); assert.deepEqual(e.snapshot(),before);});
test('pending cleanup cannot be bypassed by revision and reapproval after reload',()=>{
  let {e,l}=claimed(); const a=e.reserve(l,{requestId:'a',tool:'deploy',system:'aws',operation:'create',estimatedCostMicros:10},3);
  e=new AutonomousEngine(e.snapshot()); e.settle(l,a.id,2,true,{id:'res',system:'aws',cleanupOperation:'delete'},4);
  e=new AutonomousEngine(e.snapshot()); e.finish(l,result('input'),5);
  e=new AutonomousEngine(e.snapshot()); assert.throws(()=>e.revise('t',{...spec,goal:'revised'},'review',6));
  e.cleaned('t','res',7); e=new AutonomousEngine(e.snapshot()); e.revise('t',{...spec,goal:'revised'},'review',8);
  e=new AutonomousEngine(e.snapshot()); e.approve('t',2,'approved',9); assert.ok(new AutonomousEngine(e.snapshot()).claim('t','w','s2','r2',10));
});
test('revision cannot invalidate historical wait deadline on reload',()=>{
  let {e,l}=claimed(); e.finish(l,{...result('wait'),wakeAt:5000},3);
  e=new AutonomousEngine(e.snapshot()); const before=e.snapshot();
  assert.throws(()=>e.revise('t',{...spec,endsAt:4000},'shorten deadline',4)); assert.deepEqual(e.snapshot(),before);
  e.revise('t',{...spec,endsAt:6000},'valid deadline',4); assert.equal(new AutonomousEngine(e.snapshot()).get('t').revision,2);
});
test('settlement cannot overflow total exposure across reload',()=>{
  let {e,l}=claimed({budgetMicros:Number.MAX_SAFE_INTEGER});
  const a=e.reserve(l,{requestId:'a',tool:'deploy',system:'aws',operation:'create',estimatedCostMicros:1},3);
  e=new AutonomousEngine(e.snapshot()); e.reserve(l,{requestId:'b',tool:'deploy',system:'aws',operation:'create',estimatedCostMicros:2},4);
  e=new AutonomousEngine(e.snapshot()); const before=e.snapshot();
  assert.throws(()=>e.settle(l,a.id,Number.MAX_SAFE_INTEGER,true,undefined,5)); assert.deepEqual(e.snapshot(),before);
});
test('restore rejects runnable cleanup and impossible approval or stop states',()=>{
  const e=ready(); const base=e.snapshot();
  for(const mutate of [(s:typeof base)=>{s.tasks.t!.interventions=[];},(s:typeof base)=>{s.tasks.t!.status='awaiting_approval';},(s:typeof base)=>{s.tasks.t!.status='stopping';}]) {
    const s=structuredClone(base); mutate(s); assert.throws(()=>new AutonomousEngine(s));
  }
});
test('lost lease preserves unknown billing until operator reconciliation after reload',()=>{
  let {e,l}=claimed(); e=new AutonomousEngine(e.snapshot()); e.cancel('t','stop',3);
  e=new AutonomousEngine(e.snapshot()); e.tick(l.expiresAt); e=new AutonomousEngine(e.snapshot());
  assert.equal(e.get('t').status,'stopping'); assert.equal(e.get('t').runs[0]!.costMicros,null);
  assert.throws(()=>e.finish(l,result('complete'),l.expiresAt+1));
  e.reconcileRun('t','run',7,'invoice verified',l.expiresAt+2);
  assert.equal(new AutonomousEngine(e.snapshot()).get('t').status,'cancelled');
});
test('lost lease usage marker survives restore and reconciliation and is internal only',()=>{
  let {e,l}=claimed();
  assert.throws(()=>e.finish(l,{...result(),usageUnavailable:true} as AutonomousRunResult,3));
  e.tick(l.expiresAt); e=new AutonomousEngine(e.snapshot());
  assert.equal(e.get('t').runs[0]!.usageUnavailable,true);
  e.reconcileRun('t','run',7,'invoice verified',1003); e=new AutonomousEngine(e.snapshot());
  assert.equal(e.get('t').runs[0]!.usageUnavailable,true);
  assert.equal(e.get('t').runs[0]!.reconciledCostMicros,7);
  const base=e.snapshot();
  for(const mutate of [(s:typeof base)=>{s.tasks.t!.runs[0]!.usageUnavailable=false as never;},(s:typeof base)=>{s.tasks.t!.runs[0]!.usage.inputTokens=1;},(s:typeof base)=>{s.tasks.t!.runs[0]!.costMicros=7;},(s:typeof base)=>{s.tasks.t!.runs[0]!.outcome='complete';}]) {
    const s=structuredClone(base); mutate(s); assert.throws(()=>new AutonomousEngine(s));
  }
});

for(const phase of ['active','stopping','unknown','abandoned'] as const) test(`native credential lane blocks ${phase} owners across restart until reconciliation`,()=>{
 let e=new AutonomousEngine();
 for(const [id,ids] of [['owner',['shared']],['overlap',['other','shared']],['independent',['other-only']]] as const){
  const task=e.create({...spec,requestId:id,provider:'claude',credentialIds:[...ids]},0,id);e.approve(id,task.revision,'approved',1);
 }
 const lease=e.claim('owner','w','private','first',2)!;
 if(phase==='stopping')e.cancel('owner','stop',3);
 if(phase==='unknown')e.finish(lease,{...result(),costMicros:null},3);
 if(phase==='abandoned')e.tick(lease.expiresAt);
 e=new AutonomousEngine(e.snapshot());
 const now=phase==='abandoned'?lease.expiresAt+1:4;
 const before=e.snapshot();assert.equal(e.claim('overlap','w2','private2','second',now),null);assert.deepEqual(e.snapshot(),before);
 assert.ok(e.claim('independent','w3','private3','third',now));
 if(phase==='active'||phase==='stopping')e.finish(lease,result(),now);
 else e.reconcileRun('owner','first',0,'usage checked; owner stopped',now);
 assert.ok(new AutonomousEngine(e.snapshot()).claim('overlap','w2','private2','second',now+1));
});
test('expired owner without prior tick still blocks intersecting native claim',()=>{
 const e=ready({provider:'claude',credentialIds:['shared']});const task=e.create({...spec,requestId:'other',provider:'codex',credentialIds:['shared']},0,'other');e.approve(task.id,1,'approved',1);
 const lease=e.claim('t','w','secret','run',2)!;
 assert.equal(e.claim('other','w2','secret2','run2',lease.expiresAt+1),null);
});
test('mock tasks do not acquire native credential lanes',()=>{
 const e=ready({credentialIds:['shared']});const task=e.create({...spec,requestId:'native',provider:'claude',credentialIds:['shared']},0,'native');e.approve(task.id,1,'approved',1);
 assert.ok(e.claim('t','w','secret','run',2));assert.ok(e.claim('native','w2','secret2','run2',3));
});

test('native start binds canonical authority once, survives reload and rejects forged or stopped leases',()=>{
 const {e,l}=claimed({provider:'claude',endsAt:900,maxRunMs:1000});
 const start=(engine:AutonomousEngine,lease=l,runtime='native')=>(engine as AutonomousEngine & {nativeStart: (l:typeof lease,r:string,n:number)=>{taskId:string;spec:AutonomousSpec;deadline:number}}).nativeStart(lease,runtime,3);
 assert.throws(()=>start(e,{...l,token:'forged'}));
 const auth=start(e); assert.equal(auth.taskId,'t'); assert.equal(auth.deadline,900);assert.equal(auth.spec.provider,'claude');
 auth.spec.tools.push('forged');assert.deepEqual(start(e).spec.tools,['deploy']);
 const restored=new AutonomousEngine(e.snapshot());assert.deepEqual(start(restored),start(e));assert.throws(()=>start(restored,l,'other'),{statusCode:409});
 assert.equal(restored.get('t').nativeRuntimeId,undefined);
 restored.cancel('t','stop',4);assert.throws(()=>restored.nativeStart(l,'native',5),{statusCode:409});
 e.tick(l.expiresAt);assert.throws(()=>e.nativeStart(l,'native',l.expiresAt),{statusCode:409});assert.equal(e.snapshot().tasks.t!.nativeRuntimeId,undefined);
 const mock=claimed();assert.throws(()=>mock.e.nativeStart(mock.l,'native',3),{statusCode:409});
});

test('native snapshot binding coherence and finish cleanup',()=>{
 const {e,l}=claimed({provider:'claude'});e.nativeStart(l,'native',3);
 const state=e.snapshot();
 for(const corrupt of [(s:typeof state)=>{s.tasks.t!.spec.provider='mock';},(s:typeof state)=>{delete s.tasks.t!.lease;delete s.tasks.t!.activeRunStartedAt;s.tasks.t!.status='ready';},(s:typeof state)=>{s.tasks.t!.nativeRuntimeId='';}]){const bad=structuredClone(state);corrupt(bad);assert.throws(()=>new AutonomousEngine(bad));}
 e.finish(l,result(),4);assert.equal(e.snapshot().tasks.t!.nativeRuntimeId,undefined);
 const l2=e.claim('t','w','second','run2',5)!;const auth=e.nativeStart(l2,'next',6);assert.equal(auth.checkpoint!.objectKey,'private-ref');auth.checkpoint!.objectKey='mutated';assert.equal(e.nativeStart(l2,'next',7).checkpoint!.objectKey,'private-ref');
});

test('SQLite nativeStart facade persists binding across reopening',async()=>{
 const {createAutonomousStore}=await import('../packages/core/src/autonomous-store.js');
 const store=createAutonomousStore(':memory:');try{store.create({...spec,provider:'claude'},0,'t');store.approve('t',1,'approved',1);const l=store.claim('t','w','secret','run',2)!;assert.equal(store.nativeStart(l,'native',3).taskId,'t');assert.throws(()=>store.nativeStart(l,'other',4),{statusCode:409});assert.equal(store.get('t').nativeRuntimeId,undefined);}finally{store.close();}
});

for(const outcome of ['complete','failed'] as const)test(`terminal ${outcome} with unknown billing finalizes after reconciliation without resume`,()=>{
 let {e,l}=claimed({provider:'claude'});e.nativeStart(l,'runtime',3);
 const stopped=e.finish(l,{...result(outcome),costMicros:null},4);
 assert.equal(stopped.status,'stopping');assert.equal(stopped.lease,undefined);assert.equal(stopped.nativeRuntimeId,undefined);
 assert.equal(e.snapshot().tasks.t!.nativeRuntimeId,undefined);
 e=new AutonomousEngine(e.snapshot());assert.equal(e.claim('t','other','token','extra',5),null);
 assert.equal(e.reconcileRun('t','run',2,'billing evidence',6).status,outcome==='complete'?'completed':'failed');
 assert.equal(e.get('t').iteration,1);assert.equal(e.get('t').runs[0]!.costMicros,null);
 assert.throws(()=>e.resume('t',1,'must not rerun terminal result',7));
});
test('terminal unknown billing preserves cancellation precedence',()=>{
 const {e,l}=claimed();e.cancel('t','operator cancelled',3);e.finish(l,{...result('complete'),costMicros:null},4);
 assert.equal(e.get('t').status,'stopping');assert.equal(e.reconcileRun('t','run',1,'billing checked',5).status,'cancelled');
});
test('terminal unknown billing waits for action reconciliation and pending cleanup',()=>{
 let {e,l}=claimed();const a=e.reserve(l,{requestId:'a',tool:'deploy',system:'aws',operation:'create',estimatedCostMicros:2},3);
 e.finish(l,{...result('complete'),costMicros:null},4);assert.equal(e.get('t').status,'stopping');
 e=new AutonomousEngine(e.snapshot());e.reconcileRun('t','run',1,'billing checked',5);assert.equal(e.get('t').status,'stopping');
 e.reconcile('t',a.id,1,true,{id:'resource',system:'aws',cleanupOperation:'delete'},'inventory checked',6);
 assert.equal(e.get('t').status,'stopping');assert.equal(e.get('t').resources[0]!.status,'cleanup_pending');
 assert.equal(new AutonomousEngine(e.snapshot()).cleaned('t','resource',7).status,'completed');
});
for(const outcome of ['complete','failed'] as const)test(`scope suspension cannot gain ${outcome} intent from unknown-cost finish`,()=>{
 const {e,l}=claimed();assert.throws(()=>e.reserve(l,{requestId:'outside',tool:'unapproved',system:'aws',operation:'create',estimatedCostMicros:0},3));
 assert.equal(e.finish(l,{...result(outcome),costMicros:null},4).status,'awaiting_input');
 assert.equal(e.reconcileRun('t','run',1,'billing checked',5).status,'awaiting_input');assert.equal(e.get('t').stopReason,undefined);
});
test('terminal intent retains budget precedence when the reported run cost is unknown',()=>{
 const {e,l}=claimed({budgetMicros:2});const a=e.reserve(l,{requestId:'a',tool:'deploy',system:'aws',operation:'create',estimatedCostMicros:2},3);
 e.settle(l,a.id,2,true,undefined,4);e.finish(l,{...result('complete'),costMicros:null},5);
 assert.equal(e.get('t').status,'stopping');assert.equal(e.reconcileRun('t','run',0,'billing checked',6).status,'budget_exceeded');
});
