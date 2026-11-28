import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildApp } from '../apps/control-plane/src/app.js';
import { createHivemindMcpServer, loadMcpSettings } from '../apps/mcp-server/src/server.js';
import type { CreateComputeJob } from '../packages/contracts/src/compute.js';

const OP = 'operator-token-0000000000000000000001';
const WK = 'worker-token-00000000000000000000002';
const AG = 'agent-token-000000000000000000000003';

function draft(): CreateComputeJob {
  return {
    title: 'Agent token draft',
    workloadId: 'smf-tiny-v1',
    repository: 'roboco-io/silicon-model-factory',
    baseCommit: 'a'.repeat(40),
    compute: {
      region: 'us-east-2',
      instanceType: 'g4dn.xlarge',
      amiId: 'ami-0123456789abcdef0',
      maxLifetimeMs: 3_600_000,
      maxHourlyPriceUsd: 0.4,
      maxTotalCostMicros: 400_000,
      s3ArtifactPrefix: 'models/smf-tiny-v1/runs/agent-token',
    },
    releasePolicy: { mode: 's3_artifact_only', visibility: 'private', releaseCheckCommand: ['node', 'check.mjs'] },
  };
}

test('the agent token reaches only the Model Factory agent routes', async (t) => {
  const app = buildApp({ operatorToken: OP, workerToken: WK, agentToken: AG, computeBudgetCapMicros: 1_000_000 });
  t.after(() => app.close());
  const call = (method: 'GET' | 'POST', url: string, token: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });

  // Allowed for the agent.
  assert.equal((await call('GET', '/api/compute/jobs', AG)).statusCode, 200);
  assert.equal((await call('GET', '/api/compute/ledger', AG)).statusCode, 200);
  const created = await call('POST', '/api/compute/jobs', AG, draft());
  assert.equal(created.statusCode, 201);
  const job = created.json() as { id: string; approvalFingerprint: string };
  assert.equal((await call('GET', `/api/compute/jobs/${job.id}`, AG)).statusCode, 200);
  const approved = await call('POST', `/api/compute/jobs/${job.id}/approve`, AG, { approvalFingerprint: job.approvalFingerprint, reason: 'agent approves within budget' });
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.json().status, 'queued');
  // Local mode has no EC2 orchestrator; the agent passes authentication and gets 503, not 401.
  assert.equal((await call('POST', `/api/compute/jobs/${job.id}/wake`, AG, {})).statusCode, 503);
  assert.equal((await call('POST', `/api/compute/jobs/${job.id}/dispatch-verifier`, AG, {})).statusCode, 503);

  // Operator-only routes refuse the agent token before doing anything.
  const operatorOnly: [method: 'GET' | 'POST', url: string, body?: unknown][] = [
    ['POST', `/api/compute/jobs/${job.id}/approve-release`, { decision: 'approve', openedRawArtifacts: false, durationMinutes: 1, reason: 'x' }],
    ['POST', `/api/compute/jobs/${job.id}/publish-release`, {}],
    ['POST', `/api/compute/jobs/${job.id}/verify-release`, {}],
    ['POST', `/api/compute/jobs/${job.id}/receipt`, {}],
    ['POST', '/api/compute/sweep-expired', {}],
    ['POST', '/api/delivery/tasks', {}],
    ['GET', '/api/collab/sessions'],
    ['GET', '/api/capabilities'],
  ];
  for (const [method, url, body] of operatorOnly) {
    assert.equal((await call(method, url, AG, body)).statusCode, 401, `${method} ${url}`);
  }
  // The worker-only attestation route refuses it too.
  assert.equal((await call('POST', `/api/compute/jobs/${job.id}/verifier-attestation`, AG, {})).statusCode, 401);

  // Cancel is allowed, and the job record shows nothing of the token.
  const cancelled = await call('POST', `/api/compute/jobs/${job.id}/cancel`, AG, { reason: 'agent stops its own draft' });
  assert.equal(cancelled.statusCode, 200);
  assert.doesNotMatch(cancelled.body, new RegExp(AG));
  // The operator token still works everywhere it did.
  assert.equal((await call('GET', '/api/delivery/tasks', OP)).statusCode, 200);
});

test('without an agent token configured, an arbitrary bearer is refused and the operator flow is unchanged', async (t) => {
  const app = buildApp({ operatorToken: OP, workerToken: WK });
  t.after(() => app.close());
  const res = await app.inject({ method: 'GET', url: '/api/compute/jobs', headers: { authorization: `Bearer ${AG}` } });
  assert.equal(res.statusCode, 401);
  const bare = await app.inject({ method: 'GET', url: '/api/compute/jobs', headers: { authorization: 'Bearer ' } });
  assert.equal(bare.statusCode, 401);
});

test('the agent token must be long and distinct from the operator and worker tokens', () => {
  assert.throws(() => buildApp({ operatorToken: OP, workerToken: WK, agentToken: OP }), /Agent token/);
  assert.throws(() => buildApp({ operatorToken: OP, workerToken: WK, agentToken: WK }), /Agent token/);
  assert.throws(() => buildApp({ operatorToken: OP, workerToken: WK, agentToken: 'short' }), /Agent token/);
});

function tokenFile(key: string, value: string, mode = 0o600): string {
  const file = join(mkdtempSync(join(tmpdir(), 'hm-agent-token-')), 'token.json');
  writeFileSync(file, JSON.stringify({ [key]: value }));
  chmodSync(file, mode);
  return file;
}

test('the MCP agent profile reads only the agent token file and refuses mixing it with an operator token', () => {
  const agentFile = tokenFile('AGENT_TOKEN', AG);
  const settings = loadMcpSettings({ HIVEMIND_MCP_PROFILE: 'agent', HIVEMIND_AGENT_TOKEN_FILE: agentFile });
  assert.equal(settings.profile, 'agent');
  assert.equal(settings.operatorToken, AG);
  assert.throws(() => loadMcpSettings({ HIVEMIND_AGENT_TOKEN_FILE: agentFile }));
  assert.throws(() => loadMcpSettings({ HIVEMIND_MCP_PROFILE: 'agent', HIVEMIND_AGENT_TOKEN_FILE: agentFile, HIVEMIND_OPERATOR_TOKEN: OP }));
  assert.throws(() => loadMcpSettings({ HIVEMIND_MCP_PROFILE: 'agent', HIVEMIND_OPERATOR_TOKEN: OP }));
  assert.throws(() => loadMcpSettings({ HIVEMIND_MCP_PROFILE: 'agent', HIVEMIND_AGENT_TOKEN_FILE: tokenFile('AGENT_TOKEN', AG, 0o644) }));
  assert.throws(() => loadMcpSettings({ HIVEMIND_MCP_PROFILE: 'agent', HIVEMIND_AGENT_TOKEN_FILE: tokenFile('OPERATOR_TOKEN', AG) }));
});

test('the MCP agent profile exposes no release, delivery write, collaboration or Control Plane power tool', async (t) => {
  const app = buildApp({ operatorToken: OP, workerToken: WK, agentToken: AG, computeBudgetCapMicros: 1_000_000 });
  t.after(() => app.close());
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const res = await app.inject({ method: (init?.method ?? 'GET') as 'GET', url: url.pathname, headers, ...(typeof init?.body === 'string' ? { payload: init.body } : {}) });
    return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'application/json' } });
  };
  const server = createHivemindMcpServer({ apiUrl: 'http://127.0.0.1:4310', operatorToken: AG, profile: 'agent', fetchImpl });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'agent', version: '0' });
  await client.connect(a);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'hivemind_agent_credentials',
    'hivemind_autonomy_triggers',
    'hivemind_compute_approve',
    'hivemind_compute_cancel',
    'hivemind_compute_create',
    'hivemind_compute_dispatch_verifier',
    'hivemind_compute_get',
    'hivemind_compute_ledger',
    'hivemind_compute_list',
    'hivemind_compute_wake',
    'hivemind_delivery_get',
    'hivemind_delivery_list',
    'hivemind_project_me',
    'hivemind_status',
  ]);
  const status = (await client.callTool({ name: 'hivemind_status', arguments: {} })) as { structuredContent: Record<string, unknown> };
  assert.equal(status.structuredContent.connected, true);
  assert.equal(status.structuredContent.principal, 'agent');
  assert.equal(status.structuredContent.delivery, undefined);
  assert.equal((status.structuredContent.compute as { storageBackend: string }).storageBackend, 'sqlite');
});
