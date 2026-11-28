import assert from 'node:assert/strict';
import test from 'node:test';
import { createControlFetch, isConnectFailure } from '../apps/worker/src/control-fetch.js';

const connectError = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

test('a worker keeps calling the Control Plane while it is being replaced', async () => {
  let clock = 0;
  let calls = 0;
  const sleeps: number[] = [];
  const fetcher = (async () => {
    calls += 1;
    if (calls <= 3) throw connectError(calls === 1 ? 'ECONNREFUSED' : 'UND_ERR_CONNECT_TIMEOUT');
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const controlFetch = createControlFetch({ fetch: fetcher, sleep: async (ms) => { sleeps.push(ms); clock += ms; }, now: () => clock, log: () => undefined });
  const res = await controlFetch('http://control-plane.hivemind.internal:4310/api/x', { method: 'POST', body: '{}' });
  assert.equal(res.status, 200);
  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [2000, 4000, 8000]);
});

test('errors after the request reached the server, HTTP errors and aborts are not retried', async () => {
  const reset = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket'), { code: 'UND_ERR_SOCKET' }) });
  assert.equal(isConnectFailure(reset), false);
  let calls = 0;
  const failing = createControlFetch({ fetch: (async () => { calls += 1; throw reset; }) as typeof fetch, sleep: async () => undefined, log: () => undefined });
  await assert.rejects(failing('http://x.internal/api'), /fetch failed/);
  assert.equal(calls, 1);

  const http = createControlFetch({ fetch: (async () => new Response('no', { status: 503 })) as typeof fetch });
  assert.equal((await http('http://x.internal/api')).status, 503);

  const controller = new AbortController();
  controller.abort();
  calls = 0;
  const aborted = createControlFetch({ fetch: (async () => { calls += 1; throw connectError('ECONNREFUSED'); }) as typeof fetch, sleep: async () => undefined, log: () => undefined });
  await assert.rejects(aborted('http://x.internal/api', { signal: controller.signal }));
  assert.equal(calls, 1);
});

test('retries stop after the wait limit', async () => {
  let clock = 0;
  let calls = 0;
  const controlFetch = createControlFetch({
    fetch: (async () => { calls += 1; throw connectError('EHOSTUNREACH'); }) as typeof fetch,
    maxWaitMs: 30_000,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    log: () => undefined,
  });
  await assert.rejects(controlFetch('http://x.internal/api'));
  // Waits of 2, 4, 8 and 15 s end at 29 s; one more 15 s wait would pass 30 s, so the fifth failure is thrown.
  assert.equal(calls, 5);
});
