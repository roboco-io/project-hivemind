import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createToolAuditStore} from '../packages/core/src/autonomous-tool-audit-sql.ts';
import {handleToolAuditApi} from '../apps/control-plane/src/autonomous-tool-audit-api.ts';
import type {ToolAuditRecord} from '../packages/contracts/src/autonomous-tool-audit.js';

const OP = 'operator-token-canary', REP = 'reporter-token-canary';
const rec = (sequence: number): ToolAuditRecord => ({sequence, tool: 'Bash', inputDigest: 'a'.repeat(64), inputSummary: 'ls', inputTruncated: false, outcome: 'allowed', startedAt: 5, durationMs: 1});
const lease = (o: Record<string, unknown> = {}) => ({taskId: 't1', runId: 'r1', workerId: 'w', token: 'LEASE_SECRET', expiresAt: 9, ...o});
function harness() {
  const db = new DatabaseSync(':memory:');
  const store = createToolAuditStore({exec: (q, ...b) => db.prepare(q).all(...b) as Record<string, unknown>[], transactionSync: fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }}, 'k'.repeat(40));
  const o = {operatorToken: OP, reporterToken: REP, store, authorize: async (l: {runId: string; taskId: string}) => { if (l.runId !== 'r1') throw Object.assign(new Error('x'), {statusCode: 409}); return {taskId: l.taskId, runId: 'r1', iteration: 3}; }};
  const call = (method: string, path: string, token: string | null, body?: unknown) => handleToolAuditApi(new Request('http://x' + path, {method, headers: {...(token ? {authorization: 'Bearer ' + token} : {}), 'content-type': 'application/json'}, ...(body === undefined ? {} : {body: typeof body === 'string' ? body : JSON.stringify(body)})}), o);
  return {call, store};
}
const P = '/v1/autonomous-tasks/t1/tool-calls';
test('other paths return null', async () => {
  const h = harness();
  assert.equal(await h.call('GET', '/v1/autonomous-tasks/t1', OP), null);
  assert.equal(await h.call('GET', '/v1/autonomous-tasks', OP), null);
});
test('reporter POST stores, replay after lost response is idempotent', async () => {
  const h = harness(), body = {lease: lease(), records: [rec(1), rec(2)], droppedByWorker: 0};
  const a = await h.call('POST', P, REP, body); assert.equal(a!.status, 200); assert.deepEqual(await a!.json(), {recorded: true, nextSequence: 3});
  const b = await h.call('POST', P, REP, body); assert.equal(b!.status, 200); assert.deepEqual(await b!.json(), {recorded: true, nextSequence: 3});
  assert.equal(h.store.totals('t1').recorded, 2);
});
test('auth: operator token cannot POST, reporter cannot GET, none is 401', async () => {
  const h = harness(), body = {lease: lease(), records: [rec(1)], droppedByWorker: 0};
  assert.equal((await h.call('POST', P, OP, body))!.status, 401);
  assert.equal((await h.call('POST', P, null, body))!.status, 401);
  assert.equal((await h.call('GET', P, REP))!.status, 401);
  assert.equal((await h.call('GET', P, null))!.status, 401);
  assert.equal(h.store.totals('t1').recorded, 0);
});
test('lease mismatch is 409 and stores nothing; path task mismatch is 409', async () => {
  const h = harness();
  assert.equal((await h.call('POST', P, REP, {lease: lease({runId: 'other'}), records: [rec(1)], droppedByWorker: 0}))!.status, 409);
  assert.equal((await h.call('POST', P, REP, {lease: lease({taskId: 't2'}), records: [rec(1)], droppedByWorker: 0}))!.status, 409);
  assert.equal(h.store.totals('t1').recorded, 0);
});
test('sequence gap is 409 with expectedSequence', async () => {
  const h = harness(), r = await h.call('POST', P, REP, {lease: lease(), records: [rec(5)], droppedByWorker: 0});
  assert.equal(r!.status, 409); assert.equal(((await r!.json()) as any).expectedSequence, 1);
});
test('invalid bodies: 400, oversize 413', async () => {
  const h = harness();
  for (const bad of ['not json', {lease: lease(), records: [rec(1)]}, {lease: lease(), records: [rec(1)], droppedByWorker: 0, extra: 1}, {lease: {...lease(), extra: 1}, records: [], droppedByWorker: 0}, {lease: lease(), records: [{...rec(1), tool_response: 'x'}], droppedByWorker: 0}])
    assert.equal((await h.call('POST', P, REP, bad))!.status, 400);
  assert.equal((await h.call('POST', P, REP, {lease: lease(), records: [rec(1)], droppedByWorker: 0, pad: 'x'.repeat(70000)}))!.status, 413);
});
test('operator GET pages, hides lease data, rejects bad query and cursors', async () => {
  const h = harness();
  await h.call('POST', P, REP, {lease: lease(), records: Array.from({length: 25}, (_, i) => rec(i + 1)), droppedByWorker: 2}).then(r => assert.equal(r!.status, 200)).catch(() => { throw new Error('batch'); });
  const r1 = await h.call('GET', P + '?limit=20', OP), j1: any = await r1!.json();
  assert.equal(r1!.status, 200); assert.equal(j1.items.length, 20); assert.equal(j1.source, 'worker_report'); assert.equal(j1.totals.droppedByWorker, 2); assert.ok(!JSON.stringify(j1).includes('LEASE_SECRET'));
  const j2: any = await (await h.call('GET', P + '?limit=20&cursor=' + encodeURIComponent(j1.nextCursor), OP))!.json();
  assert.equal(j2.items.length, 5);
  assert.equal((await h.call('GET', P + '?limit=0', OP))!.status, 400);
  assert.equal((await h.call('GET', P + '?bogus=1', OP))!.status, 400);
  assert.equal((await h.call('GET', P + '?cursor=' + encodeURIComponent(j1.nextCursor.slice(0, -2) + '00'), OP))!.status, 400);
  assert.equal((await h.call('GET', '/v1/autonomous-tasks/t2/tool-calls?cursor=' + encodeURIComponent(j1.nextCursor), OP))!.status, 400);
});
test('reporter token unset or equal to operator token fails closed', async () => {
  const h = harness();
  const req = () => new Request('http://x' + P, {method: 'POST', headers: {authorization: 'Bearer ' + OP}, body: '{}'});
  const base = {operatorToken: OP, authorize: async () => ({taskId: 't1', runId: 'r1', iteration: 1}), store: h.store};
  assert.equal((await handleToolAuditApi(req(), base))!.status, 401);
  assert.equal((await handleToolAuditApi(req(), {...base, reporterToken: OP}))!.status, 401);
});
