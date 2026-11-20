import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAutonomousStore} from '../packages/core/src/autonomous-store.js';
import type {AutonomousSpec,AutonomousLease,AutonomousRunResult} from '../packages/contracts/src/autonomous.js';

const spec:AutonomousSpec={requestId:'pinned-source',goal:'increment the approved counter',provider:'claude',model:'operator-pinned-model',billingPolicy:{model:'subscription',budget:'external_actions'},endsAt:500000,budgetMicros:10,tools:['Bash'],systems:[],credentialIds:['shared-legacy-native'],maxRunMs:120000,maxIterations:2,execution:{backend:'cloudflare',snapshotId:'a'.repeat(64),checks:[{id:'counter',argv:['node','check.mjs'],timeoutMs:10000}]}};
const usage={inputTokens:2,cacheReadTokens:1,cacheWriteTokens:0,outputTokens:1};
function result(sequence:number,outcome:'continue'|'complete'='complete'):AutonomousRunResult{return {outcome,costMicros:null,usage,checkpoint:{sessionId:'private-session',model:spec.model,sequence,objectKey:`encrypted/session-${sequence}`}};}

test('SQLite restart preserves pinned source, cloud lease and two receipt-backed session iterations',t=>{
 const directory=mkdtempSync(join(tmpdir(),'cloud-core-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const path=join(directory,'state.sqlite');let store=createAutonomousStore(path);t.after(()=>store.close());
 const task=store.create(spec,0,'cloud-task');store.approve(task.id,task.revision,'approved pinned fixture',1);
 for(let sequence=1;sequence<=2;sequence++){
  assert.equal(store.claim(task.id,'ordinary-worker','untrusted','ordinary-run',sequence*10),null);
  const lease=store.claimCloud(task.id,'cloud-driver',`token-${sequence}`,`run-${sequence}`,sequence*10)!;
  store.close();store=createAutonomousStore(path);
  assert.deepEqual(store.get(task.id).lease,{taskId:lease.taskId,runId:lease.runId,workerId:lease.workerId,expiresAt:lease.expiresAt});
  assert.equal(JSON.stringify(store.get(task.id)).includes(lease.token),false);
  assert.deepEqual(store.get(task.id).spec.execution,spec.execution);
  assert.deepEqual(store.claimCloud(task.id,lease.workerId,lease.token,lease.runId,sequence*10+1),lease);
  const outcome=sequence===1?'continue':'complete';
  store.nativeStart(lease,`runtime-${sequence}`,sequence*10+1);
  store.recordNativeReceipt(lease,{runId:lease.runId,runtimeId:`runtime-${sequence}`,sessionId:'private-session',model:spec.model,sequence,usage,stopped:true,outcome},sequence*10+2);
  const finished=store.finishCloud(lease,result(sequence,outcome),true,sequence*10+3);
  assert.equal(finished.status,sequence===1?'ready':'completed');
  assert.equal(finished.checkpoint?.sequence,sequence);
 }
 store.close();store=createAutonomousStore(path);
 const restored=store.get(task.id);assert.equal(restored.runs.length,2);
 assert.deepEqual(restored.runs.map(run=>run.billingEvidence),['subscription_runtime','subscription_runtime']);
 assert.throws(()=>store.revise(task.id,{...spec,execution:{...spec.execution!,snapshotId:'b'.repeat(64)}},'replace source',40));
});

for(const boundary of ['cancel','expiry'] as const)test(`persisted ${boundary} prevents late cloud success`,t=>{
 const directory=mkdtempSync(join(tmpdir(),'cloud-late-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const path=join(directory,'state.sqlite');let store=createAutonomousStore(path);t.after(()=>store.close());
 store.create(spec,0,'task');store.approve('task',1,'approved',1);
 const lease:AutonomousLease=store.claimCloud('task','driver','token','run',2)!;
 store.nativeStart(lease,'runtime',3);
 store.recordNativeReceipt(lease,{runId:lease.runId,runtimeId:'runtime',sessionId:'private-session',model:spec.model,sequence:1,usage,stopped:true,outcome:'complete'},4);
 if(boundary==='cancel')store.cancel('task','operator stop',5);else store.tick(lease.expiresAt+1);
 store.close();store=createAutonomousStore(path);
 if(boundary==='expiry')assert.throws(()=>store.finishCloud(lease,result(1),true,lease.expiresAt+2));
 else assert.equal(store.finishCloud(lease,result(1),true,6).status,'cancelled');
 assert.notEqual(store.get('task').status,'completed');
 assert.equal(store.claimCloud('task','driver','replacement','replacement',lease.expiresAt+3),null);
});

import {buildApp} from '../apps/control-plane/src/app.js';

test('HTTP callers cannot manufacture zero-cost unstarted cloud completion',async t=>{
 const app=buildApp({now:()=>1});t.after(()=>app.close());
 const created=await app.inject({method:'POST',url:'/v1/autonomous-tasks',headers:{authorization:'Bearer local-development-only'},payload:spec});
 assert.equal(created.statusCode,201);const task=created.json() as {id:string};
 for(const action of ['finish-unstarted-cloud','finishUnstartedCloud']){
  for(const token of ['local-development-only','local-worker-only']){
   const response=await app.inject({method:'POST',url:`/v1/autonomous-tasks/${task.id}/${action}`,headers:{authorization:'Bearer '+token},payload:{lease:{taskId:task.id,workerId:'forged',runId:'forged',token:'forged',expiresAt:1000},neverLaunched:true,stopped:true,costMicros:0}});
   assert.ok([401,403,404].includes(response.statusCode),`private proof route exposed: ${response.statusCode}`);
  }
 }
 const state=await app.inject({method:'GET',url:`/v1/autonomous-tasks/${task.id}`,headers:{authorization:'Bearer local-development-only'}});
 assert.equal(state.json().status,'awaiting_approval');assert.deepEqual(state.json().runs,[]);
});
