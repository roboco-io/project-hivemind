import { test } from 'node:test';
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
