import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexOutbound, claudeOutbound } from '../scripts/phase0/cloudflare/outbound.ts';

test('subscription requests retain authentication only on approved HTTPS origins', async () => {
  let calls = 0;
  const response = await codexOutbound(new Request('https://chatgpt.com/backend-api/codex/responses', {
    headers: { authorization: 'Bearer fixture-subscription-token' },
  }), async request => {
    calls++;
    assert.equal(request.headers.get('authorization'), 'Bearer fixture-subscription-token');
    return new Response('forwarded');
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
});

test('egress rejects other origins, HTTP, alternate ports and deceptive hostnames', async () => {
  let calls = 0;
  for (const url of [
    'http://chatgpt.com/', 'https://example.test/', 'https://chatgpt.com.example.test/',
    'https://chatgpt.com:8443/', 'https://127.0.0.1/',
  ]) {
    const response = await codexOutbound(new Request(url), async () => { calls++; return new Response('unexpected'); });
    assert.equal(response.status, 403);
  }
  assert.equal(calls, 0);
});

test('Claude subscription egress retains the bearer token only on its official HTTPS API', async () => {
  let calls = 0;
  const response = await claudeOutbound(new Request('https://api.anthropic.com/v1/messages', {
    headers: { authorization: 'Bearer fixture-claude-subscription' },
  }), async request => { calls++; assert.equal(request.headers.get('authorization'), 'Bearer fixture-claude-subscription'); return new Response('ok'); });
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  const denied = await claudeOutbound(new Request('https://api.anthropic.com.example.test/'), async () => { throw new Error('Unexpected forward'); });
  assert.equal(denied.status, 403);
});
