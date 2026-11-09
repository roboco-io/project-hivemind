import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleProbe } from '../scripts/phase0/cloudflare/handler.ts';

test('Cloudflare probe rejects anonymous requests before starting a container', async () => {
  let starts = 0;
  const response = await handleProbe(new Request('https://example.test/phase0'), 'fixture-control-token', async () => {
    starts++;
    return {};
  });
  assert.equal(response.status, 401);
  assert.equal(starts, 0);
});

test('authenticated probe runs fixed diagnostics once', async () => {
  let starts = 0;
  const response = await handleProbe(new Request('https://example.test/phase0', {
    headers: { authorization: 'Bearer fixture-control-token' },
  }), 'fixture-control-token', async () => {
    starts++;
    return { exitCode: 0, scope: 'cloudflare-container-prerequisites-only' };
  });
  assert.equal(response.status, 200);
  assert.equal(starts, 1);
  assert.equal((await response.json()).scope, 'cloudflare-container-prerequisites-only');
});

test('missing control token prevents all probe execution', async () => {
  let starts = 0;
  const response = await handleProbe(new Request('https://example.test/phase0'), undefined, async () => { starts++; });
  assert.equal(response.status, 503);
  assert.equal(starts, 0);
});

test('probe rejects caller-selected command routes and request bodies', async () => {
  let starts = 0;
  const run = async () => { starts++; };
  const headers = { authorization: 'Bearer fixture-control-token' };
  assert.equal((await handleProbe(new Request('https://example.test/exec', { headers }), 'fixture-control-token', run)).status, 404);
  assert.equal((await handleProbe(new Request('https://example.test/phase0', {
    headers, method: 'POST', body: '{"command":"unexpected"}',
  }), 'fixture-control-token', run)).status, 405);
  assert.equal(starts, 0);
});

test('probe failure response does not publish internal error text', async () => {
  const response = await handleProbe(new Request('https://example.test/phase0', {
    headers: { authorization: 'Bearer fixture-control-token' },
  }), 'fixture-control-token', async () => { throw new Error('fixture-private-error'); });
  assert.equal(response.status, 502);
  assert.equal(await response.text(), 'Probe failed');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('sandbox probe selects a fixed diagnostic rather than caller commands', async () => {
  const response = await handleProbe(new Request('https://example.test/phase0/sandbox', {
    headers: { authorization: 'Bearer fixture-control-token' },
  }), 'fixture-control-token', async kind => ({ kind }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { kind: 'sandbox' });
});

test('model probe requires an authenticated explicit POST', async () => {
  const headers = { authorization: 'Bearer fixture-control-token' };
  let calls = 0;
  const run = async (kind: string) => { calls++; return { kind }; };
  const get = await handleProbe(new Request('https://example.test/phase0/codex', { headers }), 'fixture-control-token', run);
  assert.equal(get.status, 405);
  assert.equal(calls, 0);
  const post = await handleProbe(new Request('https://example.test/phase0/codex', { headers, method: 'POST' }), 'fixture-control-token', run);
  assert.equal(post.status, 200);
  assert.deepEqual(await post.json(), { kind: 'codex' });
});

test('Claude probe is a separate authenticated POST route', async () => {
  const headers = { authorization: 'Bearer fixture-control-token' };
  const response = await handleProbe(new Request('https://example.test/phase0/claude', { headers, method: 'POST' }), 'fixture-control-token', async kind => ({ kind }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { kind: 'claude' });
});
