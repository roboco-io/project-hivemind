import test from 'node:test';
import assert from 'node:assert/strict';
import {externalTaskExposure,listExternalCostStops} from '../packages/core/src/autonomous-external-exposure.ts';
import type {ExternalAction,ExternalApproval,ExternalState} from '../packages/contracts/src/autonomous-external.js';

type ActionSpec={verified:number|null;reserved:number;expiresAt?:number;resource?:boolean;cleaned?:boolean;approval?:string};
function state(o:{cap:number;actions:ActionSpec[];costStop?:boolean;taskId?:string}):ExternalState{
 const taskId=o.taskId??'t1';
 const approval={id:'a1',taskId,revision:1,budgetMicros:o.cap,...(o.costStop?{stoppedAt:1,stopReason:'cost_exceeded'}:{})} as unknown as ExternalApproval;
 const actions:Record<string,ExternalAction>={};
 o.actions.forEach((a,i)=>{actions['x'+i]={id:'x'+i,approvalId:'a1',expiresAt:a.expiresAt??10000,verifiedCostMicros:a.verified,reservedMicros:a.reserved,billingFinal:false,cleanupStatus:a.cleaned?'cleaned':a.resource?'pending':'none',...(a.resource?{resource:{id:'r',cleanupRequired:true}}:{})} as unknown as ExternalAction;});
 return {version:1,approvals:{a1:approval},actions};
}
test('exposure equal to cap does not stop',()=>{
 const e=externalTaskExposure(state({cap:100,actions:[{verified:null,reserved:100}]}),'t1')!;
 assert.equal(e.stop,null);assert.equal(e.exposureMicros,100);assert.equal(e.capMicros,100);assert.equal(e.revision,1);
 assert.deepEqual(listExternalCostStops(state({cap:100,actions:[{verified:null,reserved:100}]})),[]);
});
test('verified 60+40 reaches cap',()=>{
 const s=state({cap:100,actions:[{verified:60,reserved:0},{verified:40,reserved:0}]});
 assert.equal(externalTaskExposure(s,'t1')!.stop,'verified_reached_cap');
 assert.equal(listExternalCostStops(s).length,1);
});
test('broker cost_exceeded stops with exposure 130',()=>{
 const e=externalTaskExposure(state({cap:100,costStop:true,actions:[{verified:130,reserved:0}]}),'t1')!;
 assert.equal(e.stop,'broker_cost_exceeded');assert.equal(e.exposureMicros,130);assert.equal(e.brokerCostStop,true);
});
test('exposure over cap without verified reaching cap',()=>{
 const e=externalTaskExposure(state({cap:100,actions:[{verified:50,reserved:60}]}),'t1')!;
 assert.equal(e.stop,'exposure_over_cap');
});
test('unknown task is null; nextExpiryAt from live resources only',()=>{
 const s=state({cap:100,actions:[{verified:null,reserved:10,resource:true,expiresAt:5000},{verified:0,reserved:0,resource:true,cleaned:true,expiresAt:100},{verified:null,reserved:0,resource:true,expiresAt:7000}]});
 assert.equal(externalTaskExposure(s,'nope'),null);
 const e=externalTaskExposure(s,'t1')!;assert.equal(e.stop,null);assert.equal(e.nextExpiryAt,5000);
});
