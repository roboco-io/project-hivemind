import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildApp } from '../apps/control-plane/src/app.js';
import { createHivemindMcpServer, loadMcpSettings, type McpProfile } from '../apps/mcp-server/src/server.js';
import type { CreateModelFactoryJob } from '../packages/contracts/src/model-factory.js';

const OP_TOKEN = 'operator-mcp-default-token-999999';
const WK_TOKEN = 'worker-mcp-default-token-111111';

type ToolResult = { isError?: boolean; content: { text: string }[]; structuredContent?: Record<string, any> };

async function connect(t: test.TestContext, profile?: McpProfile, operatorToken = OP_TOKEN) {
  const app = buildApp({ operatorToken: OP_TOKEN, workerToken: WK_TOKEN, modelFactoryBudgetCapMicros: 2_000_000 });
  t.after(async () => app.close());
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    if (init?.headers) new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: url.pathname + url.search,
      headers,
      payload: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'application/json' } });
  };
  const server = createHivemindMcpServer({ apiUrl: 'http://127.0.0.1:4310', operatorToken, ...(profile ? { profile } : {}), fetchImpl });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-default-mcp', version: '0.1.0' });
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
  return { client, call, app };
}

test('default MCP profile exposes the AWS single path in one server and no retired Cloudflare tool', async (t) => {
  assert.equal(loadMcpSettings({ HIVEMIND_OPERATOR_TOKEN: OP_TOKEN }).profile, undefined);
  for (const name of ['default', 'aws', 'legacy', 'delivery', 'model-factory', 'collab']) {
    assert.equal(loadMcpSettings({ HIVEMIND_OPERATOR_TOKEN: OP_TOKEN, HIVEMIND_MCP_PROFILE: name }).profile, name);
  }
  assert.throws(() => loadMcpSettings({ HIVEMIND_OPERATOR_TOKEN: OP_TOKEN, HIVEMIND_MCP_PROFILE: 'cloudflare' }));

  const unset = await connect(t);
  const names = (await unset.client.listTools()).tools.map((tool) => tool.name).sort();
  assert.equal(names.length, 25, 'status 1 + delivery 7 + model factory 7 + collab 10');
  assert.ok(names.includes('hivemind_status'));
  assert.equal(names.filter((n) => n.startsWith('hivemind_delivery_')).length, 7);
  assert.equal(names.filter((n) => n.startsWith('hivemind_mf_')).length, 7);
  assert.equal(names.filter((n) => n.startsWith('hivemind_collab_')).length, 10);
  // Retired Cloudflare-path tools are gone from the default profile.
  for (const retired of ['hivemind_create_task', 'hivemind_decide_task', 'hivemind_create_workflow', 'hivemind_autonomous_create', 'hivemind_workflow_team_get']) {
    assert.ok(!names.includes(retired), retired);
  }

  // `aws` and `default` are the same tool set; `legacy` still holds the retired one until the archive is removed.
  for (const alias of ['aws', 'default'] as const) {
    assert.deepEqual((await (await connect(t, alias)).client.listTools()).tools.map((tool) => tool.name).sort(), names);
  }
  const legacyNames = (await (await connect(t, 'legacy')).client.listTools()).tools.map((tool) => tool.name);
  assert.ok(legacyNames.includes('hivemind_create_task'));
  assert.ok(!legacyNames.includes('hivemind_delivery_create'));
});

test('hivemind_status on the default profile reports AWS-path counts and budget, and fails closed on a wrong token', async (t) => {
  const { call } = await connect(t);
  const empty = await call('hivemind_status');
  assert.equal(empty.isError, undefined, JSON.stringify(empty));
  assert.deepEqual(empty.structuredContent, {
    runtime: 'aws',
    connected: true,
    delivery: { storageBackend: 'sqlite', total: 0, byStatus: {} },
    modelFactory: {
      storageBackend: 'sqlite',
      total: 0,
      byStatus: {},
      globalBudgetCapMicros: 2_000_000,
      reservedMicros: 0,
      settledMicros: 0,
      remainingBudgetMicros: 2_000_000,
    },
    collab: { storageBackend: 'sqlite', total: 0, byStatus: {} },
  });

  // Tools of all three areas work through the same server.
  const job: CreateModelFactoryJob = {
    title: 'Default profile job',
    modelId: 'smf-tiny-v1',
    repository: 'roboco-io/silicon-model-factory',
    baseCommit: 'a'.repeat(40),
    compute: {
      region: 'us-east-2',
      instanceType: 'g5.xlarge',
      amiId: 'ami-0123456789abcdef0',
      maxLifetimeMs: 3_600_000,
      maxHourlyPriceUsd: 0.45,
      maxTotalCostMicros: 500_000,
      s3ArtifactPrefix: 'models/smf-tiny-v1/run-default-profile',
    },
    releasePolicy: { mode: 's3_artifact_only', visibility: 'private', releaseCheckCommand: ['node', 'tools/release-check.mjs'] },
  };
  const created = await call('hivemind_mf_create', job as unknown as Record<string, unknown>);
  assert.equal(created.isError, undefined, JSON.stringify(created));
  const session = await call('hivemind_collab_create', { title: 'Default profile session', goal: 'Check the unified profile', provider: 'codex' });
  assert.equal(session.isError, undefined, JSON.stringify(session));
  assert.equal((await call('hivemind_delivery_list')).isError, undefined);

  const after = (await call('hivemind_status')).structuredContent!;
  assert.deepEqual(after.modelFactory.byStatus, { awaiting_training_approval: 1 });
  assert.deepEqual(after.collab.byStatus, { active: 1 });
  assert.equal(after.modelFactory.remainingBudgetMicros, 2_000_000, 'a draft reserves nothing');
  assert.equal(JSON.stringify(after).includes(OP_TOKEN), false);
  assert.equal(JSON.stringify(after).includes('Check the unified profile'), false, 'status returns counts, not task text');

  const wrong = await connect(t, undefined, 'wrong-operator-token-000000000');
  const refused = await wrong.call('hivemind_status');
  assert.equal(refused.isError, true);
  assert.equal(refused.structuredContent, undefined);
});
