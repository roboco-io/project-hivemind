import test from 'node:test';
import assert from 'node:assert/strict';
import {AutonomousEngine} from '../packages/core/src/autonomous.js';
import type {AutonomousSpec, AutonomousState} from '../packages/contracts/src/autonomous.js';
const duration=56*24*60*60*1000;
function spec():AutonomousSpec { return {requestId:'long',goal:'work',provider:'claude',model:'pinned',subagentModel:'child',billingPolicy:{model:'subscription',budget:'external_actions'},endsAt:duration,budgetMicros:100,tools:['Bash'],systems:[],credentialIds:['credential'],maxRunMs:120000,maxIterations:65536,execution:{backend:'cloudflare',snapshotId:'a'.repeat(64),checks:[{id:'check',argv:['node','check.mjs'],timeoutMs:10000}],...{mode:'long_running'}}}; }
function history(count:number):AutonomousState { const e=new AutonomousEngine(); e.create(spec(),0,'task'); e.approve('task',1,'approved',1); const state=e.snapshot(),t=state.tasks.task!; t.iteration=count; t.runs=Array.from({length:count},(_,i)=>({runId:`run${i}`,workerId:'worker',startedAt:2+i,finishedAt:3+i,outcome:'failed',costMicros:0,usage:{inputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:0}})); return state; }
test('long profile accepts 56 days and 65536 iterations and restores',()=>{const e=new AutonomousEngine();assert.equal(e.create(spec(),0,'task').spec.maxIterations,65536);assert.equal(new AutonomousEngine(e.snapshot()).get('task').spec.endsAt,duration);});
test('long profile enforces create revise and restore boundaries',()=>{for(const patch of [{endsAt:duration+1},{maxIterations:65537},{maxIterations:Number.MAX_SAFE_INTEGER},{maxIterations:1.5},{maxRunMs:120001}]){assert.throws(()=>new AutonomousEngine().create({...spec(),...patch},0,'task'));const e=new AutonomousEngine();e.create(spec(),0,'task');assert.throws(()=>e.revise('task',{...spec(),...patch},'revise',1));const state=e.snapshot();Object.assign(state.tasks.task!.spec,patch);assert.throws(()=>new AutonomousEngine(state));}});
test('omitted and explicit pilot retain four iterations and ten minutes',()=>{for(const mode of [undefined,'pilot'] as const){const s=spec();s.execution={...s.execution!,...{mode}};s.endsAt=600000;s.maxIterations=4;const e=new AutonomousEngine();e.create(s,0,'task');new AutonomousEngine(e.snapshot());assert.throws(()=>new AutonomousEngine().create({...s,maxIterations:5},0,'bad'));assert.throws(()=>new AutonomousEngine().create({...s,endsAt:600001},0,'bad'));}});
test('long full history at 1001 and 65536 survives restore and cancellation',()=>{for(const count of [1001,65536]){const e=new AutonomousEngine(history(count));assert.equal(e.get('task').runs.length,count);assert.equal(e.cancel('task','stop',count+5).status,'cancelled');assert.equal(new AutonomousEngine(e.snapshot()).get('task').runs.length,count);}});
test('long restore validates every history item and rejects overflow',()=>{const state=history(1001);state.tasks.task!.runs[1000]!.usage.inputTokens=-1;assert.throws(()=>new AutonomousEngine(state));assert.throws(()=>new AutonomousEngine(history(65537)));});
test('long intervention saturation preserves recovery and cancellation headroom',()=>{const state=history(1),t=state.tasks.task!;t.interventions.push(...Array.from({length:65535},()=>({kind:'message' as const,message:'note',at:2,revision:1})));const e=new AutonomousEngine(state);assert.throws(()=>e.message('task','full',4));const l=e.claimCloud('task','worker','token','next',4)!;e.tick(l.expiresAt);assert.equal(e.get('task').status,'awaiting_input');e.cancel('task','stop',l.expiresAt+1);e.reconcileRun('task','next',0,'stopped proof',l.expiresAt+2);const restored=new AutonomousEngine(e.snapshot()).get('task');assert.equal(restored.status,'cancelled');assert.equal(restored.interventions.length,65539);});
test('long historical credential quarantine blocks another cloud claim',()=>{const state=history(1001),t=state.tasks.task!;t.runs[1000]!.costMicros=null;t.runs[1000]!.usageUnavailable=true;t.status='awaiting_input';const e=new AutonomousEngine(state);e.create({...spec(),requestId:'second'},0,'second');e.approve('second',1,'approve',1);assert.equal(e.claimCloud('second','worker','token','next',2000),null);});
test('model source checks and mode stay immutable after first claim',()=>{const e=new AutonomousEngine(history(1));for(const patch of [{model:'other'},{subagentModel:'other'},{execution:{...spec().execution!,snapshotId:'b'.repeat(64)}},{execution:{...spec().execution!,checks:[{id:'new',argv:['node'],timeoutMs:1000}]}},{execution:{...spec().execution!,...{mode:'pilot' as const}},endsAt:600000,maxIterations:4}]){assert.throws(()=>e.revise('task',{...spec(),...patch},'change',10));}assert.equal(e.revise('task',{...spec(),goal:'updated'},'same identity',10).revision,2);});
test('restore reserves final cancellation slot even when recovery records saturate',()=>{const state=history(1),t=state.tasks.task!;t.interventions=Array.from({length:131073},(_,i)=>({kind:i===0?'approval':'help',message:'recovery',at:i===0?1:2,revision:1}));const e=new AutonomousEngine(state);assert.equal(e.cancel('task','stop',4).interventions.length,131074);new AutonomousEngine(e.snapshot());t.interventions.push({kind:'help',message:'overflow',at:2,revision:1});assert.throws(()=>new AutonomousEngine(state));});
test('long cloud finish appends beyond 1000 without truncating',()=>{const e=new AutonomousEngine(history(1000)),l=e.claimCloud('task','worker','token','next',2000)!;const usage={inputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:1};e.nativeStart(l,'runtime',2001);e.recordNativeReceipt(l,{runId:'next',runtimeId:'runtime',sessionId:'session',model:'pinned',sequence:1,usage,stopped:true,outcome:'continue'},2002);const t=e.finishCloud(l,{outcome:'continue',usage,costMicros:null,checkpoint:{sessionId:'session',objectKey:'private',model:'pinned',sequence:1}},true,2003);assert.equal(t.runs.length,1001);assert.equal(t.runs[0]!.runId,'run0');assert.equal(new AutonomousEngine(e.snapshot()).get('task').runs[1000]!.runId,'next');});
test('long recovery slot validation rejects invalid mode and malformed tail',()=>{const s=spec();Object.assign(s.execution!,{mode:'other'});assert.throws(()=>new AutonomousEngine().create(s,0,'task'));const state=history(1001);state.tasks.task!.interventions.push({kind:'help',message:'tail',at:-1,revision:1});assert.throws(()=>new AutonomousEngine(state));});
test('pilot restore still rejects more than 1000 history items',()=>{const state=history(1001),t=state.tasks.task!;delete t.spec.execution;t.spec.maxIterations=1000;assert.throws(()=>new AutonomousEngine(state));});
test('P1 saturated recovery retains cancel and stopped-run reconciliation across reopen',()=>{
 const state=history(1),t=state.tasks.task!;
 t.runs[0]!.costMicros=null;t.runs[0]!.usageUnavailable=true;t.status='awaiting_input';
 t.interventions=Array.from({length:131073},(_,i)=>({kind:i===0?'approval':'help',message:'recovery',at:i===0?1:2,revision:1}));
 let e=new AutonomousEngine(state);
 e.create({...spec(),requestId:'second'},0,'second');e.approve('second',1,'approved',1);
 assert.equal(e.claimCloud('second','w','s','next',5),null);
 e.cancel('task','stop',6);e=new AutonomousEngine(e.snapshot());
 assert.equal(e.get('task').status,'stopping');
 e.reconcileRun('task','run0',0,'stopped proof',7);e=new AutonomousEngine(e.snapshot());
 assert.equal(e.get('task').status,'cancelled');assert.equal(e.get('task').interventions.length,131075);
 assert.ok(e.claimCloud('second','w','s','next',8));
});
test('P1 saturated recovery permits reconciliation before cancellation',()=>{
 const state=history(1),t=state.tasks.task!;
 t.runs[0]!.costMicros=null;t.runs[0]!.usageUnavailable=true;t.status='awaiting_input';
 t.interventions=Array.from({length:131073},(_,i)=>({kind:i===0?'approval':'help',message:'recovery',at:i===0?1:2,revision:1}));
 const e=new AutonomousEngine(state);e.reconcileRun('task','run0',0,'stopped proof',5);e.cancel('task','stop',6);
 assert.equal(new AutonomousEngine(e.snapshot()).get('task').status,'cancelled');
});
test('P1 restore rejects exhausted reserve while unresolved run remains',()=>{
 const state=history(1),t=state.tasks.task!;t.runs[0]!.costMicros=null;t.runs[0]!.usageUnavailable=true;t.status='awaiting_input';
 t.interventions=Array.from({length:262145},(_,i)=>({kind:i===0?'approval':'reconciliation',message:'recovery',at:i===0?1:2,revision:1}));
 assert.throws(()=>new AutonomousEngine(state));
});
