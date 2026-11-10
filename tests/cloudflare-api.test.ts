import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../apps/control-plane/src/app.js';
import type { CloudControl, CloudTask } from '../packages/contracts/src/cloudflare.js';

const operator = { authorization: 'Bearer local-development-only' };
const worker = { authorization: 'Bearer local-worker-only' };
const repository = { id: 'cloudflare', name: 'fixture', baseCommit: 'a'.repeat(40), testProfile: 'default', testCommand: ['node', '--test'] };
const connection = { status: 'ready' as const, message: null, checkedAt: null };
const input = { title: 'remote goal', instructions: 'change fixture', provider: 'codex', runtime: 'cloudflare', budgetMicros: 0, repositoryId: repository.id, baseCommit: repository.baseCommit, testProfile: repository.testProfile };
function control() {
  const calls: unknown[][] = []; let starts = 0, closes = 0;
  const task = { ...input, id: 'cf-api-task', status: 'awaiting_execution_approval', execution: null, actualCostMicros: null, remote: { phase: 'AWAITING_APPROVAL' } } as unknown as CloudTask;
  const value: CloudControl = {
    capabilities: () => ({ providers: ['codex', 'claude'], repository, connection }),
    state: () => ({ tasks: [task], events: [], connection }),
    create: body => { calls.push(['create', body]); return task; },
    decision: (id, decision, reason) => { calls.push(['decision', id, decision, reason]); return task; },
    cancel: (id, reason) => { calls.push(['cancel', id, reason]); return task; },
    tick: async () => {}, start: () => { starts++; }, close: async () => { closes++; }
  };
  return { value, task, calls, starts: () => starts, closes: () => closes };
}

test('health names the configured Cloudflare bridge or hybrid while preserving existing local modes', async () => {
  for (const [options, mode] of [
    [{}, 'mock-local'],
    [{ repository }, 'local-workers'],
    [{ cloudflare: control().value }, 'cloudflare-bridge'],
    [{ repository, cloudflare: control().value }, 'hybrid-workers']
  ] as const) {
    const app = buildApp(options);
    try { assert.deepEqual((await app.inject('/health')).json(), { status: 'ok', mode }); }
    finally { await app.close(); }
  }
});

test('optional remote state/capabilities preserve local contracts and start/close the remote controller', async () => {
  const cf = control(); const app = buildApp({ cloudflare: cf.value });
  assert.equal(cf.starts(), 0); await app.ready(); assert.equal(cf.starts(), 1);
  const capabilities = (await app.inject({ url: '/api/capabilities', headers: operator })).json();
  assert.deepEqual(capabilities.providers, ['mock']); assert.equal(capabilities.repository, null);
  assert.deepEqual(capabilities.cloudflare, cf.value.capabilities());
  const state = (await app.inject({ url: '/api/state', headers: operator })).json();
  assert.deepEqual(state.tasks, []); assert.deepEqual(state.cloudflare.tasks, [cf.task]);
  await app.close(); assert.equal(cf.closes(), 1); assert.deepEqual(cf.calls, []);
  const local = buildApp();
  try {
    assert.equal('cloudflare' in (await local.inject({ url: '/api/state', headers: operator })).json(), false);
    assert.deepEqual((await local.inject({ url: '/api/capabilities', headers: operator })).json(), { providers: ['mock'], repository: null });
    assert.equal((await local.inject({ method: 'POST', url: '/api/cloudflare/tasks', headers: operator, payload: input })).statusCode, 404);
  } finally { await local.close(); }
});

test('remote routes use operator authentication and reject local runtimes, arbitrary commands and extra private fields', async t => {
  const cf = control(); const app = buildApp({ cloudflare: cf.value }); t.after(() => app.close());
  const post = (url: string, payload: Record<string, unknown>, headers: Record<string, string> = operator) => app.inject({ method: 'POST', url, payload, headers });
  for (const headers of [{}, worker]) {
    for (const url of ['/api/capabilities', '/api/state']) assert.equal((await app.inject({ url, headers })).statusCode, 401);
    assert.equal((await post('/api/cloudflare/tasks', input, headers)).statusCode, 401);
    assert.equal((await post('/api/cloudflare/tasks/cf-api-task/decision', { decision: 'approve', reason: 'run' }, headers)).statusCode, 401);
    assert.equal((await post('/api/cloudflare/tasks/cf-api-task/cancel', { reason: 'stop' }, headers)).statusCode, 401);
  }
  for (const payload of [{ ...input, runtime: 'local' }, { ...input, provider: 'mock' }, { ...input, controlToken: 'private' }, { ...input, testCommand: ['sh', '-c', 'anything'] }, { ...input, repositoryPath: '/arbitrary' }]) assert.equal((await post('/api/cloudflare/tasks', payload)).statusCode, 400);
  assert.equal((await post('/api/cloudflare/tasks', input)).statusCode, 201);
  assert.equal((await post('/api/cloudflare/tasks/cf-api-task/decision', { decision: 'approve', reason: 'run' })).statusCode, 200);
  assert.equal((await post('/api/cloudflare/tasks/cf-api-task/cancel', { reason: 'stop' })).statusCode, 200);
  assert.deepEqual(cf.calls, [['create', input], ['decision', 'cf-api-task', 'approve', 'run'], ['cancel', 'cf-api-task', 'stop']]);
});
