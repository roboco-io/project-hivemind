import test from 'node:test';
import assert from 'node:assert/strict';
import {createSnapshot,sha256} from '../src/snapshot.ts';
import {mergeWorkflowOutputs,validateWorkflowSpec} from '../src/workflow.ts';

const file=(path:string,contents:string)=>({path,content:Buffer.from(contents).toString('base64'),sha256:sha256(contents),executable:false});
const contract=file('contract.md','export add and multiply');
const a=file('add.mjs','old add');
const b=file('multiply.mjs','old multiply');
const base=createSnapshot([contract,a,b]);

test('merge binds each output to its approved write paths and preserves the common contract',()=>{
 const x=file(a.path,'new add'),y=file(b.path,'new multiply');
 const outputs=[createSnapshot([contract,x,b]),createSnapshot([contract,a,y])];
 assert.deepEqual(mergeWorkflowOutputs(base,outputs,[[a.path],[b.path]]),createSnapshot([contract,x,y]));
 assert.throws(()=>mergeWorkflowOutputs(base,[createSnapshot([file(contract.path,'changed'),x,b]),outputs[1]!],[[a.path],[b.path]]),/scope/i);
 assert.throws(()=>mergeWorkflowOutputs(base,[base,outputs[1]!],[[a.path],[b.path]]),/change/i);
});

test('workflow requires two distinct providers and disjoint declared paths',()=>{
 const check={id:'test',argv:['node','verify.mjs'],timeoutMs:10000};
 const raw={snapshotId:base.digest,contractPath:contract.path,contractHash:contract.sha256,idempotencyKey:'test',integration:check,
  workers:[{provider:'codex',credentialId:'codex',writes:[a.path],instructions:'Implement add',checks:[check],timeoutMs:60000},{provider:'claude',credentialId:'claude',writes:[b.path],instructions:'Implement multiply',checks:[check],timeoutMs:60000}]};
 assert.equal(validateWorkflowSpec(raw).workers.length,2);
 assert.throws(()=>validateWorkflowSpec({...raw,workers:[raw.workers[0],{...raw.workers[1],writes:[a.path]}]}));
 assert.throws(()=>validateWorkflowSpec({...raw,workers:[raw.workers[0],{...raw.workers[1],writes:[contract.path]}]}));
});

test('remote coordinator joins verified worker outputs once after scheduler reload', async()=>{
 const {Scheduler}=await import('../src/scheduler.ts');
 const {advanceWorkflow}=await import('../src/workflow.ts');
 const check={id:'test',argv:['node','verify.mjs'],timeoutMs:10000};
 const spec=validateWorkflowSpec({snapshotId:base.digest,contractPath:contract.path,contractHash:contract.sha256,
  idempotencyKey:'join',integration:check,workers:[
   {provider:'codex',credentialId:'codex',writes:[a.path],instructions:'Implement add',checks:[check],timeoutMs:60000},
   {provider:'claude',credentialId:'claude',writes:[b.path],instructions:'Implement multiply',checks:[check],timeoutMs:60000},
  ]});
 const scheduler=new Scheduler();
 const outputs=[createSnapshot([contract,file(a.path,'new add'),b]),createSnapshot([contract,a,file(b.path,'new multiply')])];
 const workers=spec.workers.map((worker,i)=>{
  scheduler.registerCredential({id:worker.credentialId,provider:worker.provider,generation:0,objectKey:'fixture',quarantined:false});
  const {writes:_,...job}=worker;
  const submitted=scheduler.submit({...job,snapshotId:base.digest,idempotencyKey:worker.provider},0);
  Object.assign(scheduler.state.jobs[submitted.id]!,{status:'SUCCEEDED',outputSnapshotId:outputs[i]!.digest,authSynced:true});
  return submitted.id;
 }) as [string,string];
 const workflow:import('../src/workflow.ts').WorkflowRecord={id:'fixture',spec,workerIds:workers,status:'RUNNING',createdAt:0};
 scheduler.state.workflows={fixture:workflow};
 const restored=new Scheduler(scheduler.state);
 const active=restored.state.workflows!.fixture!;
 const snapshots=new Map([base,...outputs].map(s=>[s.digest,s]));
 const artifacts={read:async(id:string)=>snapshots.get(id)!,write:async(snapshot:typeof base)=>{snapshots.set(snapshot.digest,snapshot);}};
 await advanceWorkflow(active,restored,artifacts,10);
 assert.equal(active.status,'INTEGRATING');
 const checkId=active.integrationId!;
 assert.equal(restored.dispatch(11)[0]?.id,checkId);
 await advanceWorkflow(active,restored,artifacts,12);
 assert.equal(restored.list().length,3);
 restored.computeFinished(checkId,restored.get(checkId).attempt,{success:true,containerStopped:true,sourceUnchanged:true},13);
 await advanceWorkflow(active,restored,artifacts,14);
 assert.equal(active.status,'SUCCEEDED');
 assert.equal(active.outputSnapshotId,createSnapshot([contract,file(a.path,'new add'),file(b.path,'new multiply')]).digest);
});
