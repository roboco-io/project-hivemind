import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudControl, CloudEvidence, CloudPoll, CloudPort, CloudSubmission, CloudTask } from '../packages/contracts/src/cloudflare.js';
import { createCloudControl } from '../packages/core/src/cloudflare-store.js';
const policy = {id:'cloudflare',name:'고정 저장소',baseCommit:'a'.repeat(40),testProfile:'default',testCommand:['node','--test']};
const input = {title:'합계',instructions:'구현',provider:'codex' as const,runtime:'cloudflare' as const,budgetMicros:0,repositoryId:policy.id,baseCommit:policy.baseCommit,testProfile:policy.testProfile};
const process = {status:'passed' as const,exitCode:0,durationMs:1,stdout:'ok',stderr:'',truncated:false};
function evidence(): CloudEvidence { return {phase:'SUCCEEDED',jobId:'job-1',inputSnapshotId:'input-1',outputSnapshotId:'output-1',containerStopped:true,authSynced:true,agent:process,checks:[{id:'test',name:'tests',status:'SUCCEEDED',command:policy.testCommand,process,credentialsAbsent:true,sourceUnchanged:true}],errorCode:null}; }
function result(): CloudPoll { return {phase:'SUCCEEDED',terminal:true,success:true,cancelled:false,evidence:evidence(),summary:'완료',diff:'real diff',diffTruncated:false}; }
class Fake implements CloudPort {
  prepares = 0; submissions: CloudSubmission[] = []; cancels: string[] = []; polls = 0; connectionCalls = 0;
  available = true; lost = false; response = result(); submitGate: Promise<void> | null = null; pollGate: Promise<void> | null = null;
  async connection() { this.connectionCalls++; if (!this.available) throw new Error('Bearer PRIVATE-CONTROL-TOKEN'); return {status:'ready' as const,message:null,checkedAt:new Date().toISOString()}; }
  async prepare(task: CloudTask):Promise<CloudSubmission> { this.prepares++; return {snapshot:{files:[{path:'main.ts',data:'source'}]},spec:{idempotencyKey:'dashboard-'+task.id,provider:task.provider},worktreePath:'/review/'+task.id}; }
  async submit(submission: CloudSubmission) { this.submissions.push(structuredClone(submission)); await this.submitGate; if(this.lost) throw new Error('Bearer PRIVATE-CONTROL-TOKEN'); return 'job-1'; }
  async poll() { this.polls++; await this.pollGate; if (!this.available) throw new Error('Bearer PRIVATE-CONTROL-TOKEN'); return this.response; }
  async cancel(id: string) { this.cancels.push(id); }
}
function current(control: CloudControl) { return control.state().tasks[0]!; }
async function approved(control: CloudControl) { await control.tick(); const task=control.create(input); control.decision(task.id,'approve','실행 승인'); return task; }

test('approval gates remote dispatch; verified result requires a second decision',async()=>{
  const port=new Fake(), control=createCloudControl({dbPath:':memory:',policy,port});
  await control.tick(); const task=control.create(input); assert.match(task.id,/^cf-/); await control.tick(); assert.equal(port.prepares,0);
  control.decision(task.id,'approve','승인'); await control.tick(); assert.equal(current(control).status,'running'); assert.equal(current(control).remote.jobId,'job-1');
  await control.tick(); assert.equal(current(control).status,'awaiting_review'); assert.equal(current(control).diff,'real diff');
  assert.equal(control.decision(task.id,'approve','결과 수락').status,'completed'); await control.tick(); assert.equal(current(control).status,'completed');
  assert.equal(current(control).estimatedCostMicros,null); assert.equal(current(control).actualCostMicros,null); assert.equal(current(control).execution,null);
  assert.equal(control.state().events.filter(e=>e.type==='approval.decided').length,2); await control.close();
});

test('repository selection and unavailable connection fail closed',async()=>{
  const port=new Fake(), control=createCloudControl({dbPath:':memory:',policy,port});
  assert.throws(()=>control.create(input),/connection/i); await control.tick();
  for(const change of [{provider:'mock'}, {runtime:'local'}, {repositoryId:'other'}, {baseCommit:'b'.repeat(40)}, {testProfile:'other'}, {testCommand:['evil']}, {url:'https://evil.invalid'}]) assert.throws(()=>control.create({...input,...change} as typeof input));
  const task=control.create(input); assert.throws(()=>control.decision(task.id,'approve','')); await control.close();
});

test('lost submit restores the exact private submission and idempotency key after restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'hive-cloud-')), dbPath=join(dir,'state.sqlite'), port=new Fake();
  try {
    let control=createCloudControl({dbPath,policy,port}); await approved(control); port.lost=true; await control.tick();
    assert.equal(current(control).status,'running'); assert.equal(current(control).remote.jobId,null); assert.equal(port.prepares,1);
    assert.ok(!JSON.stringify(control.state()).includes('idempotencyKey')); assert.ok(!JSON.stringify(control.state()).includes('PRIVATE-CONTROL-TOKEN')); await control.close();
    assert.ok(!readFileSync(dbPath).includes(Buffer.from('PRIVATE-CONTROL-TOKEN')));
    control=createCloudControl({dbPath,policy,port}); port.lost=false; await control.tick(); assert.equal(port.prepares,1); assert.equal(port.submissions.length,2); assert.deepEqual(port.submissions[0],port.submissions[1]);
    assert.equal(current(control).remote.jobId,'job-1'); await control.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('cancel during ambiguous submit recovers the id then requests stop until confirmed',async()=>{
  const port=new Fake(), control=createCloudControl({dbPath:':memory:',policy,port}); const task=await approved(control);
  let release!:()=>void; port.submitGate=new Promise<void>(r=>{release=r;}); const pending=control.tick();
  while(port.submissions.length===0) await new Promise(r=>setImmediate(r));
  assert.equal(control.cancel(task.id,'중단').status,'running'); assert.equal(current(control).remote.phase,'CANCELLING'); release(); await pending;
  assert.deepEqual(port.cancels,['job-1']); assert.equal(current(control).status,'running');
  port.response={...result(),cancelled:true,success:false,evidence:{...evidence(),phase:'CANCELLED'}}; await control.tick(); assert.equal(current(control).status,'cancelled'); await control.close();
});

test('connection errors preserve cached task state and suppress raw errors',async()=>{
  const port=new Fake(), control=createCloudControl({dbPath:':memory:',policy,port}); await approved(control); await control.tick(); const before=current(control);
  port.available=false; await control.tick(); assert.deepEqual(current(control),before); assert.equal(control.state().connection.status,'unavailable');
  assert.ok(!JSON.stringify(control.state()).includes('PRIVATE-CONTROL-TOKEN')); await control.close();
});

test('failed or incomplete evidence cannot be accepted',async()=>{
  for(const response of [{...result(),success:false}, {...result(),evidence:{...evidence(),authSynced:false}}, {...result(),evidence:{...evidence(),checks:[]}}, {...result(),evidence:{...evidence(),containerStopped:false}}]) {
    const port=new Fake(), control=createCloudControl({dbPath:':memory:',policy,port}); const task=await approved(control); await control.tick(); port.response=response; await control.tick();
    assert.equal(current(control).status,'failed'); assert.throws(()=>control.decision(task.id,'approve','수락')); await control.close();
  }
});

test('overlapping ticks share work and close waits without cancelling the remote job',async()=>{
  const port=new Fake(), control=createCloudControl({dbPath:':memory:',policy,port,pollIntervalMs:5}); await approved(control); await control.tick();
  let release!:()=>void; port.pollGate=new Promise<void>(r=>{release=r;}); const first=control.tick(), second=control.tick();
  while(port.polls===0) await new Promise(r=>setImmediate(r)); let closed=false; const closing=control.close().then(()=>{closed=true;}); await new Promise(r=>setImmediate(r)); assert.equal(closed,false); assert.equal(port.polls,1);
  release(); await Promise.all([first,second,closing]); assert.deepEqual(port.cancels,[]);
});

test('unstarted tasks cancel immediately and decisions never reopen terminal tasks',async()=>{
  const port=new Fake(), control=createCloudControl({dbPath:':memory:',policy,port}); await control.tick(); const task=control.create(input);
  assert.equal(control.cancel(task.id,'중단').status,'cancelled'); assert.throws(()=>control.decision(task.id,'approve','실행')); await control.tick(); assert.equal(port.prepares,0); await control.close();
});

test('cancelling a verified result is an immediate human terminal decision',async()=>{
  const port=new Fake(), control=createCloudControl({dbPath:':memory:',policy,port}); const task=await approved(control); await control.tick(); await control.tick();
  assert.equal(current(control).status,'awaiting_review'); assert.equal(control.cancel(task.id,'결과 폐기').status,'cancelled');
  const snapshot=current(control); await control.tick(); assert.deepEqual(current(control),snapshot); assert.deepEqual(port.cancels,[]); await control.close();
});

test('a failed cancellation request still collects authoritative stop evidence',async()=>{
  const port=new Fake(), control=createCloudControl({dbPath:':memory:',policy,port}); const task=await approved(control); await control.tick();
  control.cancel(task.id,'중단'); port.cancel=async()=>{throw new Error('PRIVATE-CONTROL-TOKEN');};
  port.response={...result(),cancelled:true,success:false,evidence:{...evidence(),phase:'CANCELLED'}};
  await control.tick(); assert.equal(current(control).status,'cancelled'); assert.equal(port.polls,1); assert.ok(!JSON.stringify(control.state()).includes('PRIVATE-CONTROL-TOKEN')); await control.close();
});

test('permanent local preparation failure fails before any remote submission',async()=>{
  const port=new Fake(), control=createCloudControl({dbPath:':memory:',policy,port}); const task=await approved(control);
  port.prepare=async()=>{throw Object.assign(new Error('PRIVATE-CONTROL-TOKEN in local path'),{retryable:false});};
  await control.tick(); assert.equal(current(control).status,'failed'); assert.equal(current(control).summary,'Cloudflare source preparation failed'); assert.equal(port.submissions.length,0);
  assert.ok(!JSON.stringify(control.state()).includes('PRIVATE-CONTROL-TOKEN')); assert.throws(()=>control.decision(task.id,'approve','수락')); await control.close();
});

test('private submission rejects credential contents before durable storage',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'hive-cloud-secret-')),dbPath=join(dir,'state.sqlite'),port=new Fake();
  try {
    const control=createCloudControl({dbPath,policy,port}); await approved(control);
    port.prepare=async()=>({snapshot:{files:[]},spec:{controlToken:'PRIVATE-CONTROL-TOKEN'},worktreePath:'/review'});
    await control.tick(); assert.equal(current(control).status,'failed'); assert.equal(port.submissions.length,0); assert.ok(!JSON.stringify(control.state()).includes('PRIVATE-CONTROL-TOKEN')); await control.close();
    assert.ok(!readFileSync(dbPath).includes(Buffer.from('PRIVATE-CONTROL-TOKEN')));
  } finally {rmSync(dir,{recursive:true,force:true});}
});


test('idle ticks reuse ready connection verification for thirty seconds',async t=>{
  let now=1000; t.mock.method(Date,'now',()=>now);
  const port=new Fake(), control=createCloudControl({dbPath:':memory:',policy,port});
  try {
    await control.tick(); const checkedAt=control.state().connection.checkedAt;
    for (let n=0;n<20;n++) {now+=1000;await control.tick();}
    assert.equal(port.connectionCalls,1); assert.equal(control.state().connection.checkedAt,checkedAt);
    now=30999; await control.tick(); assert.equal(port.connectionCalls,1);
    now=31000; await control.tick(); assert.equal(port.connectionCalls,2);
  } finally {await control.close();}
});

test('restarting rechecks persisted ready connection before remote dispatch',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'hive-cloud-recheck-')),dbPath=join(dir,'state.sqlite'),port=new Fake();
  try {
    let control=createCloudControl({dbPath,policy,port}); await control.tick(); await control.close(); assert.equal(port.connectionCalls,1);
    port.available=false; control=createCloudControl({dbPath,policy,port}); await control.tick(); assert.equal(port.connectionCalls,2); assert.equal(control.state().connection.status,'unavailable');
    port.available=true; await control.tick(); assert.equal(port.connectionCalls,3); assert.equal(control.state().connection.status,'ready'); await control.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('active jobs poll every tick and poll failures force connection recheck immediately',async()=>{
  const port=new Fake(),control=createCloudControl({dbPath:':memory:',policy,port});
  try {
    await approved(control); await control.tick();
    port.response={...result(),phase:'RUNNING',terminal:false,success:false,evidence:{...evidence(),phase:'RUNNING',containerStopped:false}};
    for (let n=0;n<10;n++) await control.tick();
    assert.equal(port.connectionCalls,1); assert.equal(port.polls,10);
    const before=current(control);port.available=false;await control.tick();
    assert.deepEqual(current(control),before);assert.equal(control.state().connection.status,'unavailable');assert.equal(port.connectionCalls,1);
    port.available=true;await control.tick();assert.equal(port.connectionCalls,2);assert.equal(port.polls,12);
  } finally {await control.close();}
});

test('unavailable idle connections retry immediately instead of retaining ready TTL',async t=>{
  let now=1000;t.mock.method(Date,'now',()=>now);
  const port=new Fake(),control=createCloudControl({dbPath:':memory:',policy,port});
  try {
    await control.tick();now+=30000;port.available=false;await control.tick();
    assert.equal(port.connectionCalls,2);assert.equal(control.state().connection.status,'unavailable');
    port.available=true;await control.tick();assert.equal(port.connectionCalls,3);assert.equal(control.state().connection.status,'ready');
  } finally {await control.close();}
});

function scoped(dbPath:string,port:CloudPort,executionScope:string):CloudControl {
  const options={dbPath,policy,port,executionScope};return createCloudControl(options);
}
test('draft execution approval rejects changed private execution scope',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'hive-cloud-scope-draft-')),dbPath=join(dir,'state.sqlite'),port=new Fake();
  try {
    let control=scoped(dbPath,port,'scope-old');await control.tick();const task=control.create(input);await control.close();
    control=scoped(dbPath,port,'scope-new');assert.throws(()=>control.decision(task.id,'approve','실행'),(e:unknown)=>e instanceof Error && 'statusCode' in e && e.statusCode===409);
    assert.equal(current(control).status,'awaiting_execution_approval');assert.equal(control.decision(task.id,'reject','설정 변경').status,'rejected');
    assert.ok(!JSON.stringify(control.state()).includes('scope-old'));assert.ok(!JSON.stringify(control.state()).includes('executionScope'));await control.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('queued tasks fail locally when execution scope changes before preparation',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'hive-cloud-scope-queued-')),dbPath=join(dir,'state.sqlite'),port=new Fake();
  try {
    let control=scoped(dbPath,port,'scope-old');await approved(control);await control.close();
    control=scoped(dbPath,port,'scope-new');await control.tick();assert.equal(current(control).status,'failed');assert.equal(current(control).remote.errorCode,'CONFIGURATION_CHANGED');
    assert.equal(port.prepares,0);assert.equal(port.submissions.length,0);assert.equal(port.polls,0);assert.deepEqual(port.cancels,[]);await control.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('ambiguous submissions wait for their original scope then replay the same request and cancellation',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'hive-cloud-scope-ambiguous-')),dbPath=join(dir,'state.sqlite'),port=new Fake();
  try {
    let control=scoped(dbPath,port,'scope-old');const task=await approved(control);port.lost=true;await control.tick();assert.equal(port.submissions.length,1);const submitted=structuredClone(port.submissions[0]);await control.close();
    control=scoped(dbPath,port,'scope-new');port.lost=false;await control.tick();assert.equal(port.submissions.length,1);assert.equal(current(control).status,'running');assert.equal(current(control).remote.jobId,null);assert.equal(current(control).remote.errorCode,'CONFIGURATION_CHANGED');
    control.cancel(task.id,'중단 유지');await control.tick();assert.equal(current(control).status,'running');assert.equal(current(control).remote.phase,'CANCELLING');assert.equal(port.submissions.length,1);assert.deepEqual(port.cancels,[]);await control.close();
    control=scoped(dbPath,port,'scope-old');await control.tick();assert.equal(port.submissions.length,2);assert.deepEqual(port.submissions[1],submitted);assert.equal(port.prepares,1);assert.deepEqual(port.cancels,['job-1']);
    port.response={...result(),cancelled:true,success:false,evidence:{...evidence(),phase:'CANCELLED'}};await control.tick();assert.equal(current(control).status,'cancelled');await control.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('known jobs do not poll or cancel against a changed execution scope',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'hive-cloud-scope-running-')),dbPath=join(dir,'state.sqlite'),port=new Fake();
  try {
    let control=scoped(dbPath,port,'scope-old');const task=await approved(control);await control.tick();await control.close();
    control=scoped(dbPath,port,'scope-new');control.cancel(task.id,'중단');await control.tick();assert.equal(current(control).status,'running');assert.equal(current(control).remote.jobId,'job-1');assert.equal(current(control).remote.errorCode,'CONFIGURATION_CHANGED');assert.equal(port.polls,0);assert.deepEqual(port.cancels,[]);await control.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('verified historical review accepts locally after execution scope changes',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'hive-cloud-scope-review-')),dbPath=join(dir,'state.sqlite'),port=new Fake();
  try {
    let control=scoped(dbPath,port,'scope-old');const task=await approved(control);await control.tick();await control.tick();await control.close();
    const connectionCalls=port.connectionCalls,polls=port.polls,submissions=port.submissions.length;
    control=scoped(dbPath,port,'scope-new');assert.equal(control.decision(task.id,'approve','기록된 결과 수락').status,'completed');assert.equal(port.connectionCalls,connectionCalls);assert.equal(port.polls,polls);assert.equal(port.submissions.length,submissions);assert.deepEqual(port.cancels,[]);await control.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});


test('legacy rows migrate privately and keep verified review available without outbound calls',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'hive-cloud-scope-legacy-')),dbPath=join(dir,'state.sqlite'),port=new Fake();
  try {
    let control=scoped(dbPath,port,'scope-old');await control.tick();const draft=control.create(input);const reviewed=await approved(control);await control.tick();await control.tick();await control.close();
    const legacy=new DatabaseSync(dbPath);legacy.exec('ALTER TABLE cloud_tasks DROP COLUMN execution_scope');legacy.close();
    const connectionCalls=port.connectionCalls,polls=port.polls,submissions=port.submissions.length;
    control=scoped(dbPath,port,'scope-new');assert.equal(control.state().tasks.length,2);assert.throws(()=>control.decision(draft.id,'approve','실행'),/configuration changed/);
    assert.equal(control.decision(reviewed.id,'approve','이전 검증 결과 수락').status,'completed');assert.equal(port.connectionCalls,connectionCalls);assert.equal(port.polls,polls);assert.equal(port.submissions.length,submissions);await control.close();
    const migrated=new DatabaseSync(dbPath);assert.ok(migrated.prepare('PRAGMA table_info(cloud_tasks)').all().some(c=>c.name==='execution_scope'));assert.equal(migrated.prepare('SELECT execution_scope FROM cloud_tasks WHERE id=?').get(draft.id)!.execution_scope,null);migrated.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
