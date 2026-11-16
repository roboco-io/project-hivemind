import test from 'node:test';
import assert from 'node:assert/strict';
import {Scheduler,validateJobSpec} from '../src/scheduler.ts';
import {advanceComputeGroup,assignGroup,validateComputeGroupSpec,type ComputeGroupRecord} from '../src/compute-group.ts';
import {providerArgs} from '../src/runtime/providers.ts';

const checks=Array.from({length:4},(_,i)=>({id:'shard-'+i,argv:['node','run-shard.mjs',String(i)],timeoutMs:10000}));
const spec=validateComputeGroupSpec({snapshotId:'a'.repeat(64),idempotencyKey:'group',concurrency:2,instance:'standard-3',checks,integration:{id:'all',argv:['node','run-shard.mjs','all'],timeoutMs:10000}});
function prepared(concurrency:1|2|4){
 const scheduler=new Scheduler();
 const group:ComputeGroupRecord={id:'group',spec:{...spec,concurrency},status:'RUNNING',createdAt:0,approvedAt:0,deadline:100000};
 group.jobIds=checks.map(check=>{
  const job=scheduler.enqueueCompute(spec.snapshotId,check,0);
  assignGroup(scheduler.state.jobs[job.id]!,group.id,concurrency,spec.instance);
  return job.id;
 });
 scheduler.state.computeGroups={group};
 return {scheduler,group};
}
test('compute group limits are persistent, isolated, and integrate only after all checks finish',()=>{
 for(const concurrency of [1,2,4] as const){
  const initial=prepared(concurrency);
  let scheduler=new Scheduler(initial.scheduler.state);
  assert.equal(scheduler.dispatch(1).length,concurrency);
  const completed=new Set<string>();
  while(completed.size<4){
   const active=scheduler.list().filter(j=>j.status==='STARTING');
   for(const j of active){scheduler.computeFinished(j.id,j.attempt,{success:true,containerStopped:true,sourceUnchanged:true},2);completed.add(j.id);}
   const group=scheduler.state.computeGroups!.group!;
   advanceComputeGroup(group,scheduler,3);
   if(completed.size<4)assert.equal(group.integrationId,undefined);
   scheduler=new Scheduler(scheduler.state);
   scheduler.dispatch(4);
  }
  const group=scheduler.state.computeGroups!.group!;
  assert.equal(group.status,'INTEGRATING');
  const integration=scheduler.get(group.integrationId!);
  assert.equal(integration.executionGroup?.instance,'standard-3');
  scheduler.computeFinished(integration.id,integration.attempt,{success:true,containerStopped:true,sourceUnchanged:true},5);
  advanceComputeGroup(group,scheduler,6);
  assert.equal(group.status,'SUCCEEDED');assert.equal(group.finishedAt,6);
  advanceComputeGroup(group,scheduler,8);assert.equal(group.finishedAt,6);
 }
});
test('failed compute check prevents integration and timeout cancels queued work',()=>{
 const {scheduler,group}=prepared(1);
 scheduler.dispatch(1);
 const first=scheduler.get(group.jobIds![0]!);
 scheduler.computeFinished(first.id,first.attempt,{success:false,containerStopped:true,sourceUnchanged:true},2);
 group.cancellationRequested=true;
 advanceComputeGroup(group,scheduler,3);
 advanceComputeGroup(group,scheduler,4);
 assert.equal(group.status,'CANCELLED');
 assert.equal(group.integrationId,undefined);
});
test('model selections are paired and provider CLI flags preserve prior defaults',()=>{
 const raw={provider:'codex',credentialId:'c',snapshotId:'a'.repeat(64),instructions:'fixture',checks,timeoutMs:10000,idempotencyKey:'m'};
 assert.throws(()=>validateJobSpec({...raw,model:'gpt-6.1-terra'}));
 assert.throws(()=>validateJobSpec({...raw,provider:'claude',model:'claude-sonnet-4-6',effort:'xhigh'}));
 const job=validateJobSpec({...raw,model:'gpt-6.1-terra',effort:'medium'});
 const paths={home:'/home/node',privateDir:'/private',workspace:'/workspace',scriptRoot:'/scripts'};
 const args=providerArgs('codex','fixture',paths,undefined,job);
 assert.ok(args.includes('model="gpt-6.1-terra"'));
 assert.ok(args.includes('model_reasoning_effort="medium"'));
 const claude=providerArgs('claude','fixture',paths,undefined,{model:'claude-sonnet-4-6',effort:'medium'});
 assert.deepEqual(claude.slice(0,4),['--model','claude-sonnet-4-6','--effort','medium']);
 assert.equal(providerArgs('codex','fixture',paths)[0],'-a');
});
test('a sequential workflow waits through verification and never occupies another group lane',()=>{
 const scheduler=new Scheduler();
 for(const provider of ['codex','claude'] as const)scheduler.registerCredential({id:provider,provider,generation:0,objectKey:'fixture',quarantined:false});
 const ids=(['codex','claude'] as const).map(provider=>{
  const job=scheduler.submit({provider,credentialId:provider,snapshotId:'a'.repeat(64),instructions:'fixture',checks:[checks[0]!],timeoutMs:10000,idempotencyKey:provider},0);
  assignGroup(scheduler.state.jobs[job.id]!, 'workflow',1,'standard-3');return job.id;
 });
 assert.deepEqual(scheduler.dispatch(1).map(j=>j.id),[ids[0]]);
 Object.assign(scheduler.state.jobs[ids[0]!]!,{status:'VERIFYING',containerStopped:true,authSynced:true});
 assert.equal(scheduler.dispatch(2).filter(j=>j.kind==='agent').length,0);
 Object.assign(scheduler.state.jobs[ids[0]!]!,{status:'SUCCEEDED'});
 assert.deepEqual(scheduler.dispatch(3).map(j=>j.id),[ids[1]]);
});

test('single-check standard-4 pilot is accepted and stays under the global compute cap',()=>{
 const pilot=validateComputeGroupSpec({...spec,instance:'standard-4',checks:[checks[0]]});
 assert.equal(pilot.instance,'standard-4');assert.equal(pilot.checks.length,1);
 assert.throws(()=>validateComputeGroupSpec({...pilot,checks:[]}));
 assert.throws(()=>validateComputeGroupSpec({...pilot,checks:[...checks,{...checks[0],id:'fifth'}]}));
});
