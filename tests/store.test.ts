import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HiveStore } from '../packages/core/src/store.js';
const input = { title: '첫 작업', instructions: 'README 개선', budgetMicros: 5000, provider: 'mock' as const, runtime: 'local' as const };

test('execution and result require separate human decisions and preserve events', () => {
  const s = new HiveStore();
  const t = s.create(input);
  s.register('worker-1');
  assert.equal(t.status, 'awaiting_execution_approval');
  assert.equal(s.claim('worker-1'), null);
  s.decision(t.id, 'approve', '실행 허용');
  const lease = s.claim('worker-1')!;
  assert.equal(lease.task.status, 'running');
  const result = s.result(t.id, 'worker-1', lease.leaseToken, {summary:'모의 결과',diff:'diff --git a/a b/a',actualCostMicros:1000});
  assert.equal(result.status, 'awaiting_review');
  assert.equal(s.decision(t.id, 'approve', '결과 수락').status, 'completed');
  assert.equal(s.state().events.filter((e: { type: string }) => e.type === 'approval.decided').length, 2);
  assert.ok(!JSON.stringify(s.state()).includes(lease.leaseToken));
  s.close();
});

test('a task is claimed once and stale or cancelled results are rejected', () => {
  let now = 1000;
  const s = new HiveStore(':memory:', () => now);
  s.register('a'); s.register('b');
  const t = s.create(input); s.decision(t.id, 'approve', 'ok');
  const lease = s.claim('a')!;
  assert.equal(s.claim('b'), null);
  assert.throws(() => s.heartbeat(t.id, 'b', lease.leaseToken), /lease/i);
  now += 30001;
  assert.throws(() => s.result(t.id, 'a', lease.leaseToken, {summary:'x',diff:'x',actualCostMicros:1000}), /lease|running/i);
  assert.equal(s.state().tasks[0]!.status, 'failed');
  const next = s.create(input); s.decision(next.id, 'approve', 'ok');
  const second = s.claim('a')!; s.cancel(next.id, '중단');
  assert.throws(() => s.result(next.id,'a',second.leaseToken,{summary:'x',diff:'x',actualCostMicros:1000}), /lease|running/i);
  assert.equal(s.state().tasks[0]!.status, 'cancelled');
  s.close();
});

test('budget and unsupported adapters fail closed; overrun remains recorded', () => {
  const s = new HiveStore();
  assert.throws(() => s.create({...input,provider:'codex'}), /supported|implemented/i);
  assert.throws(() => s.create({...input,runtime:'ecs'}), /supported|implemented/i);
  assert.throws(() => s.create({...input,budgetMicros:1}), /budget/i);
  assert.throws(() => s.create({...input,budgetMicros:NaN}), /budget/i);
  s.register('a'); const t = s.create(input); s.decision(t.id,'approve','ok');
  const lease = s.claim('a')!;
  const result = s.result(t.id,'a',lease.leaseToken,{summary:'over',diff:'patch',actualCostMicros:6000});
  assert.equal(result.status,'failed'); assert.equal(result.actualCostMicros,6000);
  assert.throws(() => s.decision(t.id,'approve','ok'), /state|approval/i);
  s.close();
});

test('state, cost, diff and approvals survive reopening the database', () => {
  const dir = mkdtempSync(join(tmpdir(),'hivemind-')); const path = join(dir,'state.sqlite');
  try {
    const s = new HiveStore(path); s.register('a'); const t = s.create(input);
    s.decision(t.id,'approve','許可'); const lease = s.claim('a')!;
    s.result(t.id,'a',lease.leaseToken,{summary:'지속성',diff:'patch',actualCostMicros:1000}); s.close();
    const restored = new HiveStore(path);
    assert.equal(restored.state().tasks[0]!.diff,'patch');
    assert.equal(restored.state().tasks[0]!.actualCostMicros,1000);
    assert.ok(restored.state().events.some((e: { type: string })=>e.type==='approval.decided'));
    restored.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('lease expiry between the sweep and transaction validation rejects heartbeat and result', () => {
  for (const action of ['heartbeat','result'] as const) {
    let armed = false, reads = 0;
    // The initial sweep sees an active lease. Waiting for the accepting transaction
    // crosses its deadline; validation must check time again inside that transaction.
    const s = new HiveStore(':memory:',() => !armed || reads++ === 0 ? 1000 : 40000);
    s.register('a'); const t = s.create(input); s.decision(t.id,'approve','ok');
    const lease = s.claim('a')!;
    armed = true;
    assert.throws(() => action === 'heartbeat'
      ? s.heartbeat(t.id,'a',lease.leaseToken)
      : s.result(t.id,'a',lease.leaseToken,{summary:'late',diff:'patch',actualCostMicros:1000}), /expired|lease/i);
    assert.equal(s.state().tasks[0]!.status,'failed');
    s.close();
  }
});

const repository = {id:'local',name:'fixture',baseCommit:'a'.repeat(40),testProfile:'default',testCommand:['node','--test']};
const codexInput = {...input,provider:'codex' as const,repositoryId:'local',baseCommit:repository.baseCommit,testProfile:'default'};
function execution() {
  return {repositoryId:'local',baseCommit:repository.baseCommit,headCommit:repository.baseCommit,worktreePath:'/tmp/hivemind/run-1',diffTruncated:false,status:'succeeded' as const,
    tests:{command:['node','--test'],status:'passed' as const,exitCode:0,durationMs:25,stdout:'1 passed',stderr:'',truncated:false},
    codex:{status:'passed' as const,exitCode:0,threadId:'thread-1',model:null,usage:{inputTokens:10,cachedInputTokens:0,outputTokens:5},stderr:''}};
}

test('configured Codex tasks pin repository policy and require matching workers', () => {
  const s = new HiveStore(':memory:',Date.now,repository);
  assert.throws(()=>s.create({...codexInput,baseCommit:'b'.repeat(40)}),/repository|base/i);
  assert.throws(()=>s.create({...codexInput,repositoryId:'elsewhere'}),/repository/i);
  assert.throws(()=>s.create({...codexInput,testProfile:'arbitrary'}),/profile/i);
  const task=s.create(codexInput);
  assert.equal(task.estimatedCostMicros,null); assert.equal(task.actualCostMicros,null);
  s.decision(task.id,'approve','Codex approved'); s.register('mock'); s.register('codex','codex','local','local');
  assert.equal(s.claim('mock'),null);
  const lease=s.claim('codex')!; assert.equal(lease.task.id,task.id);
  s.heartbeat(task.id,'codex',lease.leaseToken);
  assert.equal(s.state().workers.find(w=>w.id==='codex')!.provider,'codex');
  s.close();
});

test('Codex results retain real evidence, unknown cost and an empty actual diff', () => {
  const s = new HiveStore(':memory:',Date.now,repository);
  const task=s.create(codexInput); s.decision(task.id,'approve','run'); s.register('codex','codex','local','local');
  const lease=s.claim('codex')!;
  assert.throws(()=>s.result(task.id,'codex',lease.leaseToken,{summary:'x',diff:'',actualCostMicros:0,execution:execution()}),/cost/i);
  assert.throws(()=>s.result(task.id,'codex',lease.leaseToken,{summary:'x',diff:'',actualCostMicros:null,execution:{...execution(),baseCommit:'b'.repeat(40)}}),/base|repository/i);
  const result=s.result(task.id,'codex',lease.leaseToken,{summary:'No changes needed',diff:'',actualCostMicros:null,execution:execution()});
  assert.equal(result.status,'awaiting_review'); assert.equal(result.actualCostMicros,null); assert.equal(result.diff,'');
  assert.equal(result.execution!.tests.stdout,'1 passed');
  assert.equal(s.state().events.at(-1)!.data.synthetic,false);
  assert.equal(s.decision(task.id,'approve','passed').status,'completed');
  s.close();
});

test('failed Codex tests remain inspectable and cannot be approved', () => {
  const s = new HiveStore(':memory:',Date.now,repository);
  const task=s.create(codexInput); s.decision(task.id,'approve','run'); s.register('codex','codex','local','local');
  const lease=s.claim('codex')!;
  const failed={...execution(),status:'failed' as const,tests:{...execution().tests,status:'failed' as const,exitCode:1,stdout:'assertion failed'}};
  const result=s.result(task.id,'codex',lease.leaseToken,{summary:'Tests failed',diff:'real patch',actualCostMicros:null,execution:failed});
  assert.equal(result.status,'failed'); assert.equal(result.execution!.tests.exitCode,1); assert.equal(result.diff,'real patch');
  assert.throws(()=>s.decision(task.id,'approve','ignore failure'),/approval|state/i);
  s.close();
});

test('Codex evidence and null costs survive reopening', () => {
  const dir=mkdtempSync(join(tmpdir(),'hivemind-codex-')); const path=join(dir,'state.sqlite');
  try {
    const s=new HiveStore(path,Date.now,repository); const task=s.create(codexInput); s.decision(task.id,'approve','run'); s.register('codex','codex','local','local');
    const lease=s.claim('codex')!; s.result(task.id,'codex',lease.leaseToken,{summary:'done',diff:'patch',actualCostMicros:null,execution:execution()}); s.close();
    const reopened=new HiveStore(path,Date.now,repository); const restored=reopened.state().tasks[0]!;
    assert.equal(restored.execution!.baseCommit,repository.baseCommit); assert.equal(restored.execution!.tests.exitCode,0); assert.equal(restored.actualCostMicros,null); reopened.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('test evidence preserves exact argv including intentional surrounding spaces',()=>{
 const policy={...repository,testCommand:['node','test file with spaces ']};
 const s=new HiveStore(':memory:',Date.now,policy); const task=s.create(codexInput); s.decision(task.id,'approve','run'); s.register('c','codex','local','local');
 const lease=s.claim('c')!; const evidence={...execution(),tests:{...execution().tests,command:policy.testCommand}};
 const result=s.result(task.id,'c',lease.leaseToken,{summary:'done',diff:'patch',actualCostMicros:null,execution:evidence});
 assert.deepEqual(result.execution!.tests.command,policy.testCommand); s.close();
});


test('Codex test command snapshot is copied at creation and survives policy changes',()=>{
 const policy={...repository,testCommand:['node','--test']};
 const s=new HiveStore(':memory:',Date.now,policy); const task=s.create(codexInput);
 assert.deepEqual(task.testCommand,['node','--test']);
 policy.testCommand[0]='different';
 assert.deepEqual(task.testCommand,['node','--test']);
 assert.deepEqual(s.state().tasks[0]!.testCommand,['node','--test']); s.close();
});

test('persisted approved command governs results after restart with another server profile',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hivemind-profile-')); const path=join(dir,'state.sqlite');
 try {
  const s=new HiveStore(path,Date.now,repository); const task=s.create(codexInput); s.decision(task.id,'approve','original command approved'); s.register('c','codex','local','local');
  const lease=s.claim('c')!; s.close();
  const changed={...repository,testCommand:['node','other-test.js']};
  const reopened=new HiveStore(path,Date.now,changed);
  const changedEvidence={...execution(),tests:{...execution().tests,command:changed.testCommand}};
  assert.throws(()=>reopened.result(task.id,'c',lease.leaseToken,{summary:'wrong profile',diff:'patch',actualCostMicros:null,execution:changedEvidence}),/command|profile/i);
  const result=reopened.result(task.id,'c',lease.leaseToken,{summary:'original profile',diff:'patch',actualCostMicros:null,execution:execution()});
  assert.equal(result.status,'awaiting_review'); assert.deepEqual(result.execution!.tests.command,repository.testCommand); reopened.close();
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test('legacy Codex records without command snapshots require resubmission',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hivemind-legacy-profile-')); const path=join(dir,'state.sqlite');
 try {
  const s=new HiveStore(path,Date.now,repository); const task=s.create(codexInput); s.decision(task.id,'approve','run'); s.register('c','codex','local','local');
  const lease=s.claim('c')!; s.close();
  const db=new DatabaseSync(path); const row=db.prepare('SELECT data FROM tasks WHERE id=?').get(task.id)!;
  const legacy=JSON.parse(row.data as string); delete legacy.testCommand;
  db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify(legacy),task.id); db.close();
  const reopened=new HiveStore(path,Date.now,repository);
  assert.throws(()=>reopened.result(task.id,'c',lease.leaseToken,{summary:'unproven profile',diff:'patch',actualCostMicros:null,execution:execution()}),/snapshot|command/i);
  reopened.close();
 } finally {rmSync(dir,{recursive:true,force:true});}
});

const claudeInput={...codexInput,provider:'claude' as const};
function claudeExecution() {
 const {codex,...common}=execution();
 return {...common,claude:{...codex,threadId:'claude-session',model:'claude-fixture'}};
}

test('Claude tasks remain separate from mock and Codex workers',()=>{
 const s=new HiveStore(':memory:',Date.now,repository);
 const task=s.create(claudeInput); assert.equal(task.actualCostMicros,null); assert.deepEqual(task.testCommand,repository.testCommand);
 s.register('m');s.register('c','codex','local','local');s.register('a','claude','local','local');
 assert.equal(s.claim('a'),null);s.decision(task.id,'approve','Claude approved');
 assert.equal(s.claim('m'),null);assert.equal(s.claim('c'),null);
 const lease=s.claim('a')!;assert.equal(lease.task.id,task.id);
 s.heartbeat(task.id,'a',lease.leaseToken);assert.equal(s.state().workers.find(w=>w.id==='a')!.provider,'claude');
 const result=s.result(task.id,'a',lease.leaseToken,{summary:'Claude complete',diff:'',actualCostMicros:null,execution:claudeExecution()});
 assert.equal(result.status,'awaiting_review');assert.equal(result.actualCostMicros,null);assert.equal(result.execution!.codex,undefined);
 assert.equal(result.execution!.claude!.threadId,'claude-session');assert.equal(s.decision(task.id,'approve','passed').status,'completed');
 const codex=s.create(codexInput);s.decision(codex.id,'approve','Codex only');assert.equal(s.claim('a'),null);assert.equal(s.claim('c')!.task.id,codex.id);
 const mock=s.create(input);s.decision(mock.id,'approve','mock only');assert.equal(s.claim('a'),null);assert.equal(s.claim('m')!.task.id,mock.id);s.close();
});

test('real result metadata must belong to exactly the assigned provider',()=>{
 const s=new HiveStore(':memory:',Date.now,repository);
 s.register('a','claude','local','local');const task=s.create(claudeInput);s.decision(task.id,'approve','run');const lease=s.claim('a')!;
 const report=(e:unknown)=>s.result(task.id,'a',lease.leaseToken,{summary:'result',diff:'patch',actualCostMicros:null,execution:e as ReturnType<typeof claudeExecution>});
 assert.throws(()=>report(execution()),/provider|Claude|claude|metadata/i);
 assert.throws(()=>report({...claudeExecution(),codex:execution().codex}),/provider|metadata/i);
 assert.throws(()=>report({...claudeExecution(),claude:undefined}),/evidence|provider|metadata/i);
 assert.throws(()=>report({...claudeExecution(),claude:{...claudeExecution().claude,status:'error',exitCode:null}}),/success|evidence/i);
 assert.throws(()=>s.result(task.id,'a',lease.leaseToken,{summary:'result',diff:'',actualCostMicros:0,execution:claudeExecution()}),/cost/i);
 s.result(task.id,'a',lease.leaseToken,{summary:'valid',diff:'patch',actualCostMicros:null,execution:claudeExecution()});
 const old=s.create(codexInput);s.decision(old.id,'approve','run');s.register('c','codex','local','local');const c=s.claim('c')!;
 assert.throws(()=>s.result(old.id,'c',c.leaseToken,{summary:'wrong agent',diff:'',actualCostMicros:null,execution:claudeExecution()}),/provider|metadata/i);
 assert.equal(s.result(old.id,'c',c.leaseToken,{summary:'old Codex format',diff:'',actualCostMicros:null,execution:execution()}).status,'awaiting_review');s.close();
});

test('failed Claude tests preserve diff and survive restart without dummy Codex metadata',()=>{
 const dir=mkdtempSync(join(tmpdir(),'hivemind-claude-'));const path=join(dir,'state.sqlite');
 try {
  const s=new HiveStore(path,Date.now,repository);const task=s.create(claudeInput);s.decision(task.id,'approve','run');s.register('a','claude','local','local');const lease=s.claim('a')!;
  const evidence={...claudeExecution(),status:'failed' as const,tests:{...claudeExecution().tests,status:'failed' as const,exitCode:1,stderr:'actual assertion failed'}};
  const result=s.result(task.id,'a',lease.leaseToken,{summary:'tests failed',diff:'real Claude patch',actualCostMicros:null,execution:evidence});
  assert.equal(result.status,'failed');assert.equal(result.execution!.tests.exitCode,1);assert.equal(result.diff,'real Claude patch');s.close();
  const reopened=new HiveStore(path,Date.now,repository);const restored=reopened.state().tasks[0]!;
  assert.equal(restored.actualCostMicros,null);assert.equal(restored.execution!.claude!.model,'claude-fixture');assert.equal(restored.execution!.codex,undefined);
  assert.equal(restored.execution!.tests.stderr,'actual assertion failed');assert.throws(()=>reopened.decision(task.id,'approve','ignore failure'),/approval|state/i);reopened.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
