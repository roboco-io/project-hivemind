import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createToolAuditStore} from '../packages/core/src/autonomous-tool-audit-sql.ts';
import type {ExternalSqlPort} from '../packages/core/src/autonomous-external-sql.ts';
import type {ToolAuditRecord} from '../packages/contracts/src/autonomous-tool-audit.js';

export function sqlPort(): ExternalSqlPort & {db: DatabaseSync} {
  const db = new DatabaseSync(':memory:');
  return {
    db,
    exec: (q, ...b) => db.prepare(q).all(...b) as Record<string, unknown>[],
    transactionSync<T>(fn: () => T): T { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }
  };
}
const secret = 's'.repeat(40);
const scope = {taskId: 't1', runId: 'r1', iteration: 2};
const rec = (sequence: number, extra: Partial<ToolAuditRecord> = {}): ToolAuditRecord => ({sequence, tool: 'Bash', inputDigest: 'a'.repeat(64), inputSummary: 'ls', inputTruncated: false, outcome: 'allowed', startedAt: 1000 + sequence, durationMs: 5, ...extra});
const rows = (p: ReturnType<typeof sqlPort>) => Number((p.exec('SELECT COUNT(*) AS n FROM tool_audit_records')[Symbol.iterator]().next().value as {n: number}).n);

test('replaying sequence 1..3 is idempotent', () => {
  const p = sqlPort(), s = createToolAuditStore(p, secret), batch = {records: [rec(1), rec(2), rec(3)], droppedByWorker: 0};
  assert.deepEqual(s.append(scope, batch, 10), {recorded: true, nextSequence: 4});
  assert.deepEqual(s.append(scope, batch, 20), {recorded: true, nextSequence: 4});
  assert.equal(s.totals('t1').recorded, 3);
  assert.equal(rows(p), 3);
  assert.equal(s.append(scope, {records: [rec(4)], droppedByWorker: 0}, 30).nextSequence, 5);
});
test('sequence gap returns 409 with expectedSequence and stores nothing', () => {
  const p = sqlPort(), s = createToolAuditStore(p, secret);
  assert.throws(() => s.append(scope, {records: [rec(5), rec(6)], droppedByWorker: 0}, 1), (e: any) => e.statusCode === 409 && e.expectedSequence === 1);
  assert.equal(rows(p), 0);
});
test('store limit drops excess and counts droppedByStore', () => {
  const s = createToolAuditStore(sqlPort(), secret, {taskRecords: 2});
  const r = s.append(scope, {records: [rec(1), rec(2), rec(3)], droppedByWorker: 0}, 1);
  assert.equal(r.nextSequence, 4);
  assert.deepEqual(s.totals('t1'), {recorded: 2, denied: 0, errors: 0, droppedByWorker: 0, droppedByStore: 1});
});
test('byte limit drops records and totals count outcomes and worker drops once per run', () => {
  const s = createToolAuditStore(sqlPort(), secret, {taskBytes: 400});
  s.append(scope, {records: [rec(1, {outcome: 'denied', durationMs: null}), rec(2, {outcome: 'error'}), rec(3), rec(4)], droppedByWorker: 7}, 1);
  s.append(scope, {records: [rec(1)], droppedByWorker: 7}, 2);
  const t = s.totals('t1');
  assert.equal(t.droppedByWorker, 7);
  assert.ok(t.droppedByStore >= 1 && t.recorded + t.droppedByStore === 4);
  assert.equal(t.denied, 1);
});
test('page: 45 rows limit 20 gives 20,20,5; tampered and foreign cursors are 400', () => {
  const s = createToolAuditStore(sqlPort(), secret);
  for (let i = 0; i < 45; i += 32) s.append(scope, {records: Array.from({length: Math.min(32, 45 - i)}, (_, k) => rec(i + k + 1)), droppedByWorker: 0}, 9);
  s.append({taskId: 't2', runId: 'r9', iteration: 1}, {records: [rec(1)], droppedByWorker: 0}, 9);
  const p1 = s.page('t1', {limit: 20}), p2 = s.page('t1', {limit: 20, cursor: p1.nextCursor}), p3 = s.page('t1', {limit: 20, cursor: p2.nextCursor});
  assert.deepEqual([p1.items.length, p2.items.length, p3.items.length], [20, 20, 5]);
  assert.equal(p3.nextCursor, undefined);
  assert.equal(p3.items[4]!.sequence, 45);
  assert.equal(p1.items[0]!.source, 'worker_report');
  assert.equal(p1.items[0]!.iteration, 2);
  assert.equal(p1.items[0]!.receivedAt, 9);
  assert.equal(p1.totals.recorded, 45);
  const bad = (cursor: string, task = 't1') => assert.throws(() => s.page(task, {cursor}), (e: any) => e.statusCode === 400);
  bad(p1.nextCursor!.slice(0, -2) + '00');
  bad(p1.nextCursor!, 't2');
  bad('garbage');
  assert.throws(() => s.page('t1', {limit: 0}), (e: any) => e.statusCode === 400);
});
test('invalid records are rejected with 400 and nothing is stored', () => {
  const p = sqlPort(), s = createToolAuditStore(p, secret);
  for (const bad of [rec(1, {inputSummary: 'x'.repeat(513)}), {...rec(1), extra: 1} as any, rec(1, {inputDigest: 'zz'}), rec(1, {outcome: 'x' as any})])
    assert.throws(() => s.append(scope, {records: [rec(1), bad], droppedByWorker: 0}, 1), (e: any) => e.statusCode === 400);
  assert.throws(() => s.append(scope, {records: Array.from({length: 33}, (_, i) => rec(i + 1)), droppedByWorker: 0}, 1), (e: any) => e.statusCode === 400);
  assert.equal(rows(p), 0);
});
