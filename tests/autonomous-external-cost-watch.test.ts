import test from 'node:test';
import assert from 'node:assert/strict';
import {createExternalCostWatch} from '../packages/core/src/autonomous-external-cost-watch.ts';
import type {ExternalState,ExternalTransactionalStore} from '../packages/contracts/src/autonomous-external.js';

function fixture(s:unknown){
 const state=s as ExternalState;
 const store:ExternalTransactionalStore={transaction:cb=>cb(structuredClone(state))};
 const stops:[string,string][]=[],cancels:[string,number][]=[];let fail=false;
 const watch=createExternalCostWatch({store,stopTask:async(t,r)=>{if(fail)throw new Error('boom');stops.push([t,r]);},cancelApprovals:(t,r)=>{cancels.push([t,r]);},now:()=>1});
 return {watch,stops,cancels,state,setFail(v:boolean){fail=v;}};
}
const over=(extra:object={})=>({version:1,approvals:{a1:{id:'a1',taskId:'t1',revision:1,budgetMicros:100,stoppedAt:1,stopReason:'cost_exceeded'}},actions:{x:{id:'x',approvalId:'a1',expiresAt:9000,verifiedCostMicros:130,reservedMicros:0,cleanupStatus:'none',...extra}}});
test('same state swept twice stops task once',async()=>{
 const f=fixture(over());
 assert.deepEqual(await f.watch.sweep(),{stopped:['t1'],failed:[]});
 assert.deepEqual(await f.watch.sweep(),{stopped:[],failed:[]});
 assert.equal(f.stops.length,1);assert.deepEqual(f.cancels,[['t1',1]]);
 assert.equal(f.stops[0]![1],'broker_cost_exceeded');
});
test('stopTask failure is reported and retried on next sweep',async()=>{
 const f=fixture(over());f.setFail(true);
 assert.deepEqual((await f.watch.sweep()).failed,['t1']);
 f.setFail(false);
 assert.deepEqual(await f.watch.sweep(),{stopped:['t1'],failed:[]});
 assert.equal(f.stops.length,1);
});
test('no stop and resource expiry 5000 gives nextExpiryAt',async()=>{
 const f=fixture({version:1,approvals:{a1:{id:'a1',taskId:'t1',revision:1,budgetMicros:100}},actions:{x:{id:'x',approvalId:'a1',expiresAt:5000,verifiedCostMicros:null,reservedMicros:10,cleanupStatus:'pending',resource:{id:'r',cleanupRequired:true}}}});
 assert.deepEqual(await f.watch.sweep(),{stopped:[],failed:[],nextExpiryAt:5000});
 assert.equal(f.stops.length,0);
});
test('limit bounds stops per sweep',async()=>{
 const approvals:Record<string,unknown>={},actions:Record<string,unknown>={};
 for(const t of ['a','b','c']){approvals['p'+t]={id:'p'+t,taskId:t,revision:1,budgetMicros:10};actions['x'+t]={id:'x'+t,approvalId:'p'+t,expiresAt:9,verifiedCostMicros:10,reservedMicros:0,cleanupStatus:'none'};}
 const f=fixture({version:1,approvals,actions});
 assert.deepEqual((await f.watch.sweep(2)).stopped,['a','b']);
 assert.deepEqual((await f.watch.sweep(2)).stopped,['c']);
});
test('failed stop is retried even if the stop rule no longer holds',async()=>{
 const f=fixture(over());f.setFail(true);
 assert.deepEqual((await f.watch.sweep()).failed,['t1']);
 // Settlement lowered the cost below the cap and the approval no longer carries cost_exceeded.
 const s=f.state as any;s.approvals.a1={id:'a1',taskId:'t1',revision:1,budgetMicros:100,stoppedAt:1,stopReason:'cancelled'};s.actions.x.verifiedCostMicros=10;
 f.setFail(false);
 assert.deepEqual(await f.watch.sweep(),{stopped:['t1'],failed:[]});
 assert.equal(f.stops.length,1);
});
test('stops beyond the per-sweep limit ask for a wake instead of being forgotten',async()=>{
 const approvals:Record<string,unknown>={},actions:Record<string,unknown>={};
 for(const t of ['a','b']){approvals['p'+t]={id:'p'+t,taskId:t,revision:1,budgetMicros:10};actions['x'+t]={id:'x'+t,approvalId:'p'+t,expiresAt:9,verifiedCostMicros:10,reservedMicros:0,cleanupStatus:'none'};}
 const f=fixture({version:1,approvals,actions});
 assert.deepEqual(await f.watch.sweep(1),{stopped:['a'],failed:[],nextExpiryAt:1});
 assert.deepEqual(await f.watch.sweep(1),{stopped:['b'],failed:[]});
});
