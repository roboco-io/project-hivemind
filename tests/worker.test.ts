import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAdapter } from '../packages/adapters/src/index.js';
import { runOnce } from '../apps/worker/src/worker.js';
import type { Task, AgentAdapter } from '../packages/contracts/src/index.js';

const task: Task = {
  id: 'task-demo', title: 'Demo change', instructions: 'Write a demonstration',
  budgetMicros: 10000, provider: 'mock', runtime: 'local', status: 'running',
  createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z',
  runId: 'run-demo', workerId: 'test-worker', leaseExpiresAt: Date.now() + 30000,
  estimatedCostMicros: 1000, actualCostMicros: 0, diff: null, summary: null,
};

test('mock adapter returns a labelled synthetic patch and measured demo cost', async () => {
  const result = await getAdapter('mock').execute(task, new AbortController().signal);
  assert.match(result.summary, /mock|모의/i);
  assert.match(result.diff, /diff --git/);
  assert.match(result.diff, /synthetic|모의/i);
  assert.equal(result.actualCostMicros, 1000);
});

test('mock adapter stops on cancellation', async () => {
  const controller = new AbortController();
  const result = getAdapter('mock').execute(task, controller.signal);
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
});

test('unconfigured Codex and Claude fail instead of silently using mock', () => {
  assert.throws(() => getAdapter('codex'), /requires.*configuration/i);
  assert.throws(() => getAdapter('claude'), /requires.*configuration/i);
});

test('worker registers, claims and submits result using worker credentials', async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer test-token');
    const path = new URL(String(input)).pathname;
    calls.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return Response.json(path.endsWith('/claim') ? { task, leaseToken: 'lease-secret' } : { ok: true });
  };
  const adapter: AgentAdapter = { provider: 'mock', execute: async () => ({ summary: 'mock', diff: 'patch', actualCostMicros: 1000 }) };
  assert.equal(await runOnce({ apiUrl: 'http://localhost:4310', workerId: 'test-worker', workerToken: 'test-token', fetchImpl, adapter }), true);
  assert.deepEqual(calls.map(call => call.path), ['/api/workers/register', '/api/workers/claim', '/api/tasks/task-demo/result']);
  assert.equal(calls[2]?.body.leaseToken, 'lease-secret');
  assert.equal(calls[2]?.body.actualCostMicros, 1000);
});

test('idle worker makes no result request', async () => {
  let requests = 0;
  const fetchImpl: typeof fetch = async (_input, _init) => Response.json(++requests === 1 ? { ok: true } : null);
  assert.equal(await runOnce({ apiUrl: 'http://localhost', workerId: 'w', workerToken: 't', fetchImpl }), false);
  assert.equal(requests, 2);
});

for (const provider of ['codex','claude'] as const) test(`${provider} worker advertises repository capability and preserves unknown cost`, async () => {
  const calls: Array<Record<string,unknown>> = [];
  const fetchImpl: typeof fetch = async (input,init) => {
    const path = new URL(String(input)).pathname;
    calls.push(JSON.parse(String(init?.body)) as Record<string,unknown>);
    return Response.json(path.endsWith('/claim') ? {task:{...task,provider,repositoryId:'local'},leaseToken:'secret'} : {ok:true});
  };
  const adapter: AgentAdapter = {provider,execute:async()=>({summary:'actual',diff:'',actualCostMicros:null})};
  assert.equal(await runOnce({apiUrl:'http://localhost',workerId:provider+'-1',workerToken:'t',adapter,fetchImpl,provider,repositoryId:'local'}),true);
  assert.equal(calls[0]!.provider,provider);
  assert.equal(calls[0]!.repositoryId,'local');
  assert.equal(calls.at(-1)!.actualCostMicros,null);
});

test('a rejected heartbeat aborts execution and prevents result submission', async () => {
  const paths: string[] = [];
  let aborted = false;
  const fetchImpl: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (path.endsWith('/claim')) return Response.json({ task, leaseToken: 'lease-secret' });
    if (path.endsWith('/heartbeat')) return Response.json({ error: 'cancelled' }, { status: 409 });
    return Response.json({ ok: true });
  };
  const adapter: AgentAdapter = { provider: 'mock', execute: async (_task, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  }) };
  await assert.rejects(runOnce({ apiUrl: 'http://localhost', workerId: 'w', workerToken: 't', fetchImpl, adapter, heartbeatMs: 5 }), /heartbeat/);
  assert.equal(aborted, true);
  assert.equal(paths.some(path => path.endsWith('/result')), false);
});

test('adapter failures are reported through the fail endpoint', async () => {
  let failure: Record<string, unknown> | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/claim')) return Response.json({ task, leaseToken: 'lease-secret' });
    if (path.endsWith('/fail')) failure = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ ok: true });
  };
  const adapter: AgentAdapter = { provider: 'mock', execute: async () => { throw new Error('adapter broke'); } };
  await assert.rejects(runOnce({ apiUrl: 'http://localhost', workerId: 'w', workerToken: 't', fetchImpl, adapter }), /adapter broke/);
  assert.equal(failure?.message, 'adapter broke');
});
