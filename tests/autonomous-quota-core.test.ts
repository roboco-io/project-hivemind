import test from 'node:test';
import assert from 'node:assert/strict';
import {AutonomousEngine} from '../packages/core/src/autonomous.js';
import type {AutonomousSpec} from '../packages/contracts/src/autonomous.js';
const zero={inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0};
const quota={kind:'rejected' as const,resetsAt:100,evidence:'claude_rate_limit_event' as const};
function setup(){const e=new AutonomousEngine();const spec:AutonomousSpec={requestId:'quota',goal:'synthetic quota',provider:'claude',model:'model',endsAt:100000,budgetMicros:100,tools:['Bash'],systems:[],credentialIds:['credential'],maxRunMs:60000,maxIterations:10,billingPolicy:{model:'subscription',budget:'external_actions'}};e.create(spec,0,'task');e.approve('task',1,'approve',1);const l=e.claim('task','worker','token','run',2)!;e.nativeStart(l,'runtime',3);return {e,l};}
const receipt=()=>({runId:'run',runtimeId:'runtime',sessionId:'session',model:'model',sequence:1,usage:{...zero},stopped:true as const,outcome:'wait' as const,wakeAt:100,quota:{...quota},usageUnavailable:true as const});
const result=()=>({outcome:'wait' as const,wakeAt:100,costMicros:null,checkpoint:{sessionId:'session',model:'model',sequence:1,objectKey:'actual-collected-bundle'},usage:{...zero},quota:{...quota},usageUnavailable:true as const});
test('synthetic trusted quota pause preserves unknown usage and checkpoint across restore',()=>{const {e,l}=setup();e.recordNativeReceipt(l,receipt(),4);const t=e.finish(l,result(),5);assert.equal(t.status,'waiting');assert.equal(t.runs[0]!.billingEvidence,'subscription_runtime');assert.equal(t.runs[0]!.usageUnavailable,true);assert.deepEqual(t.runs[0]!.quota,quota);assert.equal(new AutonomousEngine(e.snapshot()).get('task').status,'waiting');});
test('quota finish requires exact trusted receipt and checkpoint',()=>{for(const patch of [{quota:{...quota,resetsAt:101}},{usageUnavailable:undefined},{checkpoint:undefined},{checkpoint:{...result().checkpoint,sessionId:'other'}},{usage:{...zero,inputTokens:1}},{outcome:'continue'},{wakeAt:101},{costMicros:0}]){const {e,l}=setup();e.recordNativeReceipt(l,receipt(),4);assert.throws(()=>e.finish(l,{...result(),...patch} as any,5));assert.equal(e.get('task').status,'running');}const {e,l}=setup();assert.throws(()=>e.finish(l,result(),5));});
test('quota receipt rejects malformed, stale, nonwait and unflagged measurement claims',()=>{for(const patch of [{quota:{...quota,resetsAt:3}},{quota:{...quota,private:'bad'}},{outcome:'failed'},{usageUnavailable:false},{usage:{...zero,outputTokens:1}},{sequence:2}]){const {e,l}=setup();assert.throws(()=>e.recordNativeReceipt(l,{...receipt(),...patch} as any,4));}});
test('restore rejects fabricated quota billing variants and keeps old lease-expired variant',()=>{const {e,l}=setup();e.recordNativeReceipt(l,receipt(),4);e.finish(l,result(),5);for(const mutate of [(r:any)=>delete r.billingEvidence,(r:any)=>delete r.checkpoint,(r:any)=>{r.usageUnavailable=false;},(r:any)=>{r.quota.resetsAt=5;}]){const s=e.snapshot();mutate(s.tasks.task!.runs[0]);assert.throws(()=>new AutonomousEngine(s));}const b=setup();b.e.tick(b.l.expiresAt);const old=b.e.get('task').runs[0]!;assert.equal(old.outcome,'failed');assert.equal(old.usageUnavailable,true);assert.equal(old.quota,undefined);assert.doesNotThrow(()=>new AutonomousEngine(b.e.snapshot()));});
test('P1 pending occurrence is canonical, consumed once and late history survives restart',()=>{
 const wake=Date.parse('2026-11-20T09:00:00Z');const s:AutonomousSpec={requestId:'daily',goal:'daily',provider:'mock',model:'model',endsAt:wake+3*86400000,budgetMicros:100,tools:[],systems:[],credentialIds:[],maxRunMs:60000,maxIterations:10,schedule:{kind:'daily',timeZone:'UTC',localTime:'09:00'}};
 const e=new AutonomousEngine();e.create(s,wake-1000,'daily');e.approve('daily',1,'approve',wake-999);e.tick(wake);const reopened=new AutonomousEngine(e.snapshot());const l=reopened.claim('daily','worker','token','run',wake+2000)!;assert.ok(l);assert.equal(reopened.claim('daily','other','other','other',wake+2001),null);
 const t=reopened.finish(l,{outcome:'continue',usage:zero,costMicros:0},wake+3000);assert.equal(t.runs[0]!.startedAt,wake+2000);assert.equal(t.runs[0]!.scheduledAt,wake);assert.equal(t.nextRunAt,wake+86400000);assert.doesNotThrow(()=>new AutonomousEngine(reopened.snapshot()));
 for(const mutate of [(state:any)=>{state.tasks.daily.runs[0].scheduledAt++;},(state:any)=>{state.tasks.daily.runs[0].startedAt=wake+300001;state.tasks.daily.runs[0].finishedAt=wake+300002;},(state:any)=>{state.tasks.daily.nextRunAt++;}]){const state=reopened.snapshot();mutate(state);assert.throws(()=>new AutonomousEngine(state));}
 const noCatchup=new AutonomousEngine();noCatchup.create(s,wake-1000,'daily');assert.equal(noCatchup.approve('daily',1,'late approval',wake+1).nextRunAt,wake+86400000);
});
test('quota daily reset proof remains original while next dispatch follows approved daily occurrence',()=>{
 const wake=Date.parse('2026-11-20T09:00:00Z'),reset=wake+3600000;
 const e=new AutonomousEngine();const base=setup().e.get('task').spec;
 e.create({...base,endsAt:wake+3*86400000,schedule:{kind:'daily',timeZone:'UTC',localTime:'09:00'}},wake-1000,'scheduled');
 e.approve('scheduled',1,'approve',wake-999);
 const l=e.claim('scheduled','worker','token','run',wake+2000)!;e.nativeStart(l,'runtime',wake+2001);
 const proof={...quota,resetsAt:reset};
 e.recordNativeReceipt(l,{...receipt(),quota:proof,wakeAt:reset},wake+2002);
 const task=e.finish(l,{...result(),quota:proof,wakeAt:reset},wake+2003);
 assert.equal(task.runs[0]!.scheduledAt,wake);assert.equal(task.runs[0]!.startedAt,wake+2000);
 assert.equal(task.runs[0]!.wakeAt,reset);assert.deepEqual(task.runs[0]!.quota,proof);
 assert.equal(task.nextRunAt,wake+86400000);
 const restored=new AutonomousEngine(e.snapshot());assert.equal(restored.claim('scheduled','worker','no','no',reset),null);
 const next=new AutonomousEngine(restored.snapshot());assert.ok(next.claim('scheduled','worker','next','next',wake+86400000+2000));
 assert.equal(next.claim('scheduled','other','other','other',wake+86400000+2001),null);
 assert.doesNotThrow(()=>new AutonomousEngine(next.snapshot()));
});

import {runAutonomousIteration} from '../packages/adapters/src/autonomous-runner.js';
import {handleAutonomousApi} from '../apps/control-plane/src/autonomous-api.js';
test('synthetic runner forwards quota flags after saving private checkpoint into trusted core receipt',async()=>{
 const {e,l}=setup();let collected:unknown;let forwarded:any;
 await runAutonomousIteration({taskId:'task',workerId:'worker',now:()=>5,nativeCapabilities:{approvedPolicyEnforced:true,privateSessionRestore:true},resolveCredentials:async()=>({}),
  sessions:{durable:true,load:async()=>undefined,save:async(_task,session)=>{collected=session.data;return {sessionId:session.sessionId,model:session.model,sequence:session.sequence,objectKey:'synthetic-private-checkpoint'};}},
  client:{claim:async()=>({task:e.get('task'),lease:l}),heartbeat:async lease=>lease,finish:async(lease,r)=>{forwarded=r;return e.finish(lease,r,5);},reserve:async()=>{throw Error();},settle:async()=>{throw Error();}},
  executor:async context=>{const session={...context.session,sequence:context.session.sequence+1,data:{synthetic:'actual collection represented by trusted test seam'}};e.recordNativeReceipt(l,{...receipt(),sessionId:session.sessionId},4);return {...result(),session,checkpoint:undefined} as any;}
 });
 assert.ok(collected);assert.equal(forwarded.usageUnavailable,true);assert.deepEqual(forwarded.quota,quota);assert.equal(e.get('task').runs[0]!.billingEvidence,'subscription_runtime');assert.equal(JSON.stringify(forwarded).includes('actual collection'),false);
});
test('main API accepts exact quota proof on result and reporter receipt without loosening auth',async()=>{
 let called=0;const options={operatorToken:'operator',workerToken:'worker',reporterToken:'reporter',service:{execute:async()=>{called++;return {recorded:true};}}};
 const post=(suffix:string,token:string,body:unknown)=>handleAutonomousApi(new Request('http://local/v1/autonomous-tasks/task/'+suffix,{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify(body)}),options);
 const lease=setup().l;
 assert.equal((await post('native-receipt','reporter',{lease,receipt:receipt()})).status,200);
 assert.equal((await post('finish','worker',{lease,result:result()})).status,200);
 assert.equal((await post('native-receipt','worker',{lease,receipt:receipt()})).status,401);
 assert.equal((await post('finish','worker',{lease,result:{...result(),usageUnavailable:false}})).status,400);
 assert.equal((await post('native-receipt','reporter',{lease,receipt:{...receipt(),quota:{...quota,private:'bad'}}})).status,400);assert.equal(called,2);
});
test('trusted quota receipt tolerates verifier latency past original reset and restores without inventing wake or usage',()=>{
 const {e,l}=setup();e.recordNativeReceipt(l,receipt(),4);const t=e.finish(l,result(),101);
 assert.equal(t.status,'waiting');assert.equal(t.nextRunAt,100);assert.equal(t.runs[0]!.finishedAt,101);assert.equal(t.runs[0]!.wakeAt,100);assert.deepEqual(t.runs[0]!.quota,quota);assert.equal(t.runs[0]!.usageUnavailable,true);assert.deepEqual(t.runs[0]!.usage,zero);assert.deepEqual(t.runs[0]!.checkpoint,result().checkpoint);
 const restored=new AutonomousEngine(e.snapshot());restored.tick(102);assert.equal(restored.get('task').status,'ready');assert.ok(restored.claim('task','worker','next','next',103));
 const bad=e.snapshot();bad.tasks.task!.runs[0]!.quota!.resetsAt=2;bad.tasks.task!.runs[0]!.wakeAt=2;assert.throws(()=>new AutonomousEngine(bad));
});
test('late quota finish still requires exact stopped receipt runtime binding and never admits ordinary past waits',()=>{
 const missing=setup();assert.throws(()=>missing.e.finish(missing.l,result(),101));
 const {e,l}=setup();e.recordNativeReceipt(l,receipt(),4);
 assert.throws(()=>e.finish(l,{...result(),quota:{...quota,resetsAt:99},wakeAt:99},101));
 assert.throws(()=>e.finish(l,{...result(),usage:{...zero,inputTokens:1}},101));
 const state=e.snapshot();state.tasks.task!.nativeRuntimeId='other-runtime';assert.throws(()=>new AutonomousEngine(state));
 // Delivery latency may cross reset; an unbound runtime still cannot attest it.
 const late=setup();assert.throws(()=>late.e.recordNativeReceipt(late.l,{...receipt(),runtimeId:'unbound-runtime'},101));
 const ordinary:import('../packages/contracts/src/autonomous.js').AutonomousRunResult={...result()};delete ordinary.quota;delete ordinary.usageUnavailable;assert.throws(()=>e.finish(l,ordinary,101));
});
test('late trusted quota completion preserves original reset while daily schedule selects next approved occurrence',()=>{
 const wake=Date.parse('2026-11-20T09:00:00Z'),reset=wake+5000,e=new AutonomousEngine(),base=setup().e.get('task').spec;
 e.create({...base,endsAt:wake+3*86400000,schedule:{kind:'daily',timeZone:'UTC',localTime:'09:00'}},wake-1000,'daily-late');e.approve('daily-late',1,'approved',wake-999);
 const l=e.claim('daily-late','worker','token','run',wake+2000)!;e.nativeStart(l,'runtime',wake+2001);
 const proof={...quota,resetsAt:reset};e.recordNativeReceipt(l,{...receipt(),quota:proof,wakeAt:reset},wake+2002);
 const t=e.finish(l,{...result(),quota:proof,wakeAt:reset},wake+6000);assert.equal(t.nextRunAt,wake+86400000);assert.equal(t.runs[0]!.wakeAt,reset);assert.equal(t.runs[0]!.scheduledAt,wake);
 const restored=new AutonomousEngine(e.snapshot());assert.equal(restored.claim('daily-late','worker','early','early',wake+7000),null);assert.ok(restored.claim('daily-late','worker','next','next',wake+86400000+2000));
});
