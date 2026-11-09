import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Scheduler,validateJobSpec} from '../src/scheduler.ts';
import type {JobSpec,JobRecord} from '../src/contracts.ts';
const spec=(key='job',provider:'codex'|'claude'='codex',credentialId:string=provider):JobSpec=>({provider,credentialId,snapshotId:'a'.repeat(64),instructions:'Fix the code',checks:[{id:'test-a',argv:['node','--test'],timeoutMs:5000},{id:'test-b',argv:['node','--test','other.js'],timeoutMs:5000}],timeoutMs:20000,idempotencyKey:key});
function scheduler(){const s=new Scheduler();for(const provider of ['codex','claude']as const)s.registerCredential({id:provider,provider,generation:0,objectKey:`auth/${provider}/0`,quarantined:false});return s;}
const finish=(s:Scheduler,j:JobRecord,now=2000)=>s.agentFinished(j.id,j.attempt,{outputSnapshotId:'b'.repeat(64),authGeneration:j.credentialGeneration!+1,authObjectKey:`auth/${j.credentialId}/1`,containerStopped:true,success:true,resultKey:`result/${j.id}`},now);
const checkDone=(s:Scheduler,j:JobRecord,success=true)=>s.computeFinished(j.id,j.attempt,{success,sourceUnchanged:true,containerStopped:true,resultKey:`result/${j.id}`},3000);

test('submission validates inputs and copies all mutable check data',()=>{
 const s=scheduler(),input=spec();const j=s.submit(input,1000);input.checks[0]!.argv[0]='evil';input.instructions='changed';
 assert.equal(j.status,'QUEUED');assert.equal(j.startedAt,undefined);assert.equal(j.deadline,0);
 assert.equal(s.get(j.id).checks[0]!.argv[0],'node');assert.equal(s.get(j.id).instructions,'Fix the code');
 const result=s.get(j.id);result.checks[0]!.argv[0]='mutated';assert.equal(s.get(j.id).checks[0]!.argv[0],'node');
 for(const bad of [{...spec(),snapshotId:'bad'},{...spec(),checks:[]},{...spec(),provider:'other'},{...spec(),timeoutMs:0},{...spec(),instructions:' '},{...spec(),checks:[{id:'x',argv:['node','\0'],timeoutMs:1000}]}])assert.throws(()=>validateJobSpec(bad));
 assert.throws(()=>s.submit({...spec('missing'),credentialId:'absent'},1000),/credential/i);
 assert.throws(()=>s.submit({...spec('wrong'),credentialId:'claude'},1000),/provider|credential/i);
});
test('same idempotency key reuses one job but a different payload conflicts',()=>{
 const s=scheduler(),a=s.submit(spec(),1000),b=s.submit(spec(),1001);assert.equal(a.id,b.id);assert.equal(s.list().length,1);
 assert.throws(()=>s.submit({...spec(),instructions:'Other instructions'},1002),/idempotency/i);
});
test('each credential has one external stream and reservations survive restart',()=>{
 const s=scheduler();s.submit(spec('a'),1000);s.submit(spec('b'),1000);s.submit(spec('c','claude'),1000);
 const jobs=s.dispatch(1100);assert.equal(jobs.length,2);assert.deepEqual(new Set(jobs.map(j=>j.provider)),new Set(['codex','claude']));
 assert.ok(jobs.every(j=>j.status==='STARTING'&&!j.containerStopped&&j.startedAt===1100&&j.deadline===21100));
 const restored=new Scheduler(JSON.parse(JSON.stringify(s.state)));assert.equal(restored.dispatch(1200).length,0);
 const first=jobs.find(j=>j.provider==='codex')!;assert.equal(restored.running(first.id,first.attempt,1300).status,'RUNNING');assert.equal(restored.running(first.id,first.attempt,1400).status,'RUNNING');
 assert.throws(()=>restored.running(first.id,'wrong-attempt',1400),/attempt/i);
});
test('auth writeback and stop confirmation release lane before parallel verification',()=>{
 const s=scheduler();s.submit(spec('a'),1000);s.submit(spec('b'),1000);const [j]=s.dispatch(1100);finish(s,j!);
 const parent=s.get(j!.id);assert.equal(parent.status,'VERIFYING');assert.equal(parent.authSynced,true);assert.equal(parent.childIds.length,2);
 assert.equal(s.state.credentials.codex!.generation,1);assert.equal(s.state.credentials.codex!.activeJobId,undefined);
 const dispatched=s.dispatch(2100);assert.equal(dispatched.filter(x=>x.kind==='compute').length,2);assert.equal(dispatched.filter(x=>x.kind==='agent').length,1);
 const children=dispatched.filter(x=>x.kind==='compute');assert.ok(children.every(c=>c.snapshotId==='b'.repeat(64)));
 checkDone(s,children[0]!);assert.equal(s.get(j!.id).status,'VERIFYING');checkDone(s,children[1]!);assert.equal(s.get(j!.id).status,'SUCCEEDED');
});
test('separate resource pools enforce two agents and four compute reservations',()=>{
 const s=scheduler();s.registerCredential({id:'codex2',provider:'codex',generation:0,objectKey:'auth/codex2/0',quarantined:false});
 s.submit(spec('a'),1000);s.submit(spec('b','claude'),1000);s.submit(spec('c','codex','codex2'),1000);
 const agents=s.dispatch(1100);assert.equal(agents.length,2);for(const a of agents)finish(s,a);
 const four=s.dispatch(2100);assert.equal(four.filter(j=>j.kind==='compute').length,4);assert.equal(four.filter(j=>j.kind==='agent').length,1);
 assert.equal(s.dispatch(2200).length,0);
});
test('unconfirmed stop or missing auth generation quarantines the credential',()=>{
 for(const bad of [{containerStopped:false,authGeneration:1},{containerStopped:true,authGeneration:0}]){
  const s=scheduler(),j=s.submit(spec(),1000);s.dispatch(1100);
  const result=s.agentFinished(j.id,j.attempt,{...bad,success:true,authObjectKey:'auth/codex/1',outputSnapshotId:'b'.repeat(64)},1200);
  assert.equal(result.status,'AUTH_SYNC_FAILED');assert.equal(s.state.credentials.codex!.quarantined,true);assert.equal(s.state.credentials.codex!.activeJobId,j.id);
  assert.throws(()=>s.submit(spec('new'),1300),/quarantined|credential/i);
  assert.equal(s.dispatch(1400).length,0);
 }
});
test('credential replacement requires stopped old owner and monotonic generation',()=>{
 const s=scheduler(),j=s.submit(spec(),1000);s.dispatch(1100);
 assert.throws(()=>s.registerCredential({id:'codex',provider:'codex',generation:1,objectKey:'auth/codex/1',quarantined:false}),/busy|stop|active/i);
 s.quarantine(j.id,j.attempt,'LOST_CONTAINER',1500,false);
 assert.throws(()=>s.registerCredential({id:'codex',provider:'codex',generation:1,objectKey:'auth/codex/1',quarantined:false}),/busy|stop|active/i);
 s.quarantine(j.id,j.attempt,'LOST_CONTAINER',1600,true);
 s.registerCredential({id:'codex',provider:'codex',generation:1,objectKey:'auth/codex/1',quarantined:false});assert.equal(s.state.credentials.codex!.quarantined,false);
 assert.throws(()=>s.registerCredential({id:'codex',provider:'codex',generation:1,objectKey:'auth/codex/1',quarantined:false}),/generation/i);
});
test('failed or source-mutating checks cannot pass the parent',()=>{
 const s=scheduler(),j=s.submit(spec(),1000);s.dispatch(1100);finish(s,s.get(j.id));const children=s.dispatch(2100);
 s.computeFinished(children[0]!.id,children[0]!.attempt,{success:true,sourceUnchanged:false,containerStopped:true},2200);
 assert.equal(s.get(j.id).status,'VERIFYING');checkDone(s,children[1]!);assert.equal(s.get(j.id).status,'FAILED');
});
test('late attempts and conflicting duplicate completion cannot mutate state',()=>{
 const s=scheduler(),j=s.submit(spec(),1000);s.dispatch(1100);const a=s.get(j.id);const result=finish(s,a);assert.equal(finish(s,a).status,result.status);
 assert.throws(()=>s.agentFinished(j.id,'wrong',{success:true,containerStopped:true,authGeneration:1,authObjectKey:'auth/codex/1',outputSnapshotId:'b'.repeat(64)},2000),/attempt/i);
 assert.throws(()=>s.agentFinished(j.id,j.attempt,{success:false,containerStopped:true,authGeneration:1,authObjectKey:'auth/codex/1'},2000),/duplicate|conflict/i);
 const children=s.dispatch(2100);const c=children[0]!;checkDone(s,c);checkDone(s,c);
 assert.throws(()=>checkDone(s,c,false),/duplicate|conflict/i);
});
test('cancelled agent retains lane until auth and container close are acknowledged',()=>{
 const s=scheduler(),j=s.submit(spec('a'),1000);s.submit(spec('b'),1000);s.dispatch(1100);
 s.requestCancel(j.id,1200);assert.equal(s.get(j.id).status,'CANCELLING');assert.equal(s.dispatch(1300).length,0);
 finish(s,s.get(j.id),1400);assert.equal(s.get(j.id).status,'CANCELLED');assert.equal(s.get(j.id).childIds.length,0);assert.equal(s.dispatch(1500).length,1);
});
test('parent cancellation cascades and waits for running compute containers',()=>{
 const s=scheduler(),j=s.submit(spec(),1000);s.dispatch(1100);finish(s,s.get(j.id));const children=s.dispatch(2100);
 s.requestCancel(j.id,2200);assert.equal(s.get(j.id).status,'CANCELLING');assert.ok(children.every(c=>s.get(c.id).status==='CANCELLING'));
 checkDone(s,children[0]!);assert.equal(s.get(j.id).status,'CANCELLING');checkDone(s,children[1]!);assert.equal(s.get(j.id).status,'CANCELLED');
});
test('queued cancellation needs no resources and deadline expiry never reruns',()=>{
 const s=scheduler(),q=s.submit(spec('q'),1000);s.requestCancel(q.id,1001);assert.equal(s.get(q.id).status,'CANCELLED');
 const j=s.submit({...spec('run'),timeoutMs:1000},1000);s.dispatch(1100);assert.equal(s.expire(2101).length,1);assert.equal(s.get(j.id).status,'CANCELLING');
 finish(s,s.get(j.id),2200);assert.equal(s.get(j.id).status,'TIMED_OUT');assert.equal(s.dispatch(2300).length,0);
});

test('invalid completion fields fail without partial state mutation',()=>{
 const s=scheduler(),j=s.submit(spec(),1000);s.dispatch(1100);const before=JSON.stringify(s.state);
 assert.throws(()=>s.agentFinished(j.id,j.attempt,{success:true,containerStopped:true,authGeneration:1,authObjectKey:'auth/codex/1',outputSnapshotId:'b'.repeat(64),resultKey:'\0'},1500));
 assert.equal(JSON.stringify(s.state),before);
 finish(s,s.get(j.id));const [child]=s.dispatch(2100);const beforeCheck=JSON.stringify(s.state);
 assert.throws(()=>s.computeFinished(child!.id,child!.attempt,{success:true,containerStopped:true,sourceUnchanged:true,resultKey:'\0'},2200));
 assert.equal(JSON.stringify(s.state),beforeCheck);
});
test('unconfirmed compute close keeps reservation until a stopped callback arrives',()=>{
 const s=scheduler(),j=s.submit(spec(),1000);s.dispatch(1100);finish(s,s.get(j.id));const children=s.dispatch(2100);const c=children[0]!;
 const pending=s.computeFinished(c.id,c.attempt,{success:true,containerStopped:false,sourceUnchanged:true},2200);
 assert.equal(pending.status,'CANCELLING');assert.equal(pending.containerStopped,false);assert.equal(s.get(j.id).status,'VERIFYING');
 checkDone(s,c);checkDone(s,children[1]!);assert.equal(s.get(j.id).status,'SUCCEEDED');
});
test('completion replay fingerprints survive durable state reload',()=>{
 const s=scheduler(),j=s.submit(spec(),1000);s.dispatch(1100);const original=s.get(j.id);finish(s,original);
 const reopened=new Scheduler(JSON.parse(JSON.stringify(s.state)));assert.equal(finish(reopened,original).status,'VERIFYING');
 assert.throws(()=>reopened.agentFinished(j.id,j.attempt,{success:false,containerStopped:true,authGeneration:1,authObjectKey:'auth/codex/1'},2200),/duplicate|conflict/i);
});
test('cancel before check dispatch closes queued children without reserving containers',()=>{
 const s=scheduler(),j=s.submit(spec(),1000);s.dispatch(1100);finish(s,s.get(j.id));s.requestCancel(j.id,2100);
 assert.equal(s.get(j.id).status,'CANCELLED');assert.ok(s.get(j.id).childIds.every(id=>s.get(id).status==='CANCELLED'&&s.get(id).containerStopped));assert.equal(s.dispatch(2200).length,0);
});

test('authentication rejection quarantines stopped credentials until explicit reauthentication',()=>{
 const s=scheduler(),j=s.submit(spec('a'),1000);s.submit(spec('b'),1000);s.dispatch(1100);
 const result=s.agentFinished(j.id,j.attempt,{success:false,errorCode:'NEEDS_REAUTH',containerStopped:true,authGeneration:1,authObjectKey:'auth/codex/1'},1500);
 assert.equal(result.status,'NEEDS_REAUTH');assert.equal(result.authSynced,true);assert.equal(result.containerStopped,true);
 assert.equal(s.state.credentials.codex!.quarantined,true);assert.equal(s.dispatch(1600).length,0);
 s.registerCredential({id:'codex',provider:'codex',generation:2,objectKey:'auth/codex/2',quarantined:false});assert.equal(s.dispatch(1700).length,1);
});
test('runtime timeout remains a timeout when the overall deadline has not passed',()=>{
 const s=scheduler(),j=s.submit(spec(),1000);s.dispatch(1100);
 assert.equal(s.agentFinished(j.id,j.attempt,{success:false,errorCode:'TIMED_OUT',containerStopped:true,authGeneration:1,authObjectKey:'auth/codex/1'},1500).status,'TIMED_OUT');
});
