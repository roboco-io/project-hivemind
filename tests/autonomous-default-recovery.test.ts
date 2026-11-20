import test from 'node:test';
import assert from 'node:assert/strict';
import {AutonomousEngine} from '../packages/core/src/autonomous.js';
const spec={requestId:'default-recovery',goal:'work',provider:'mock' as const,model:'mock',endsAt:100000,budgetMicros:100,tools:[],systems:[],credentialIds:[],maxRunMs:1000,maxIterations:10};
function saturated(){const e=new AutonomousEngine();e.create(spec,0,'t');e.approve('t',1,'approved',1);for(let i=0;i<999;i++)e.message('t','note',2);assert.equal(e.get('t').interventions.length,1000);assert.throws(()=>e.message('t','over budget',2));return e;}
function reopen(e:AutonomousEngine){return new AutonomousEngine(e.snapshot());}
test('default saturation permits core cancellation and preserves history on reopen',()=>{
 const e=reopen(saturated());e.claim('t','worker','token','run',3);assert.equal(e.cancel('t','stop',4).status,'stopping');assert.equal(e.cancel('t','stop again',5).interventions.length,1001);e.tick(1003);e.reconcileRun('t','run',0,'verified',1004);const task=reopen(e).get('t');assert.equal(task.status,'cancelled');assert.equal(task.interventions.length,1002);assert.equal(task.interventions.filter(i=>i.kind==='message').length,999);
});
test('default expired lease at old saturation does not roll back another task in shared tick',()=>{
 const e=saturated();e.create({...spec,requestId:'other',endsAt:1000},0,'other');e.approve('other',1,'approved',1);e.claim('t','worker','token','run',3);const loaded=reopen(e);loaded.tick(1003);assert.equal(loaded.get('other').status,'expired');assert.equal(loaded.get('t').status,'awaiting_input');assert.equal(loaded.get('t').lease,undefined);assert.equal(loaded.get('t').interventions.length,1001);const next=reopen(loaded);next.reconcileRun('t','run',0,'verified',1004);assert.equal(next.cancel('t','stop',1005).status,'cancelled');assert.equal(reopen(next).get('t').interventions.length,1003);
});
test('default recovery envelope reserves reconciliation and cancellation and rejects unbounded history',()=>{
 const e=saturated();e.claim('t','worker','token','run',3);e.tick(1003);const state=e.snapshot(),t=state.tasks.t!;t.interventions.push(...Array.from({length:4000-t.interventions.length},()=>({kind:'reconciliation' as const,message:'prior review',at:1003,revision:1})));const loaded=new AutonomousEngine(state);loaded.reconcileRun('t','run',0,'verified',1004);assert.equal(loaded.cancel('t','stop',1005).status,'cancelled');assert.equal(reopen(loaded).get('t').interventions.length,4002);const invalid=loaded.snapshot();invalid.tasks.t!.interventions.push({kind:'reconciliation',message:'overflow',at:1006,revision:1});assert.throws(()=>new AutonomousEngine(invalid));
});
test('pilot old saturation permits expiry review and cancellation without expanding normal admission',()=>{
 const e=new AutonomousEngine(),pilot={...spec,provider:'claude' as const,model:'model-fixed',tools:['Bash'],credentialIds:['credential'],billingPolicy:{model:'subscription' as const,budget:'external_actions' as const},maxIterations:4,execution:{backend:'cloudflare' as const,snapshotId:'a'.repeat(64),checks:[{id:'check',argv:['node'],timeoutMs:1000}]}};e.create(pilot,0,'t');e.approve('t',1,'approved',1);for(let i=0;i<999;i++)e.message('t','note',2);assert.throws(()=>e.message('t','overflow',2));assert.ok(e.claimCloud('t','worker','token','run',3));const restored=reopen(e);restored.tick(1003);assert.equal(restored.get('t').status,'awaiting_input');restored.reconcileRun('t','run',0,'verified',1004);assert.equal(restored.cancel('t','stop',1005).status,'cancelled');assert.equal(reopen(restored).get('t').interventions.length,1003);
});
test('legacy saturated help history remains readable and recovery capacity cannot consume reserved slots',()=>{
 const e=saturated(),state=e.snapshot();for(const i of state.tasks.t!.interventions)if(i.kind==='message')i.kind='help';const legacy=new AutonomousEngine(state);assert.equal(legacy.cancel('t','stop',3).status,'cancelled');reopen(legacy);
 const running=saturated();running.claim('t','worker','token','run',3);running.tick(1003);const full=running.snapshot(),t=full.tasks.t!;t.interventions.push(...Array.from({length:4001-t.interventions.length},()=>({kind:'reconciliation' as const,message:'review',at:1003,revision:1})));assert.throws(()=>new AutonomousEngine(full));
});
