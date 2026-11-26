import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildApp } from '../apps/control-plane/src/app.js';
import { CollabOrchestrator } from '../apps/control-plane/src/collab-orchestrator.js';
import { createHivemindMcpServer, loadMcpSettings } from '../apps/mcp-server/src/server.js';

const OP_TOKEN = 'operator-mcp-collab-token-999999';
const WK_TOKEN = 'worker-mcp-collab-token-111111';
const LOCAL_API_KEY = 'sk-ant-ephemeral-local-test-token-never-in-output';
const LOCAL_AUTH = JSON.stringify({ claude: { apiKey: LOCAL_API_KEY } });

type ToolResult = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, any> };

async function connect(t: test.TestContext, localAuthFile?: string) {
  const launched: { subtaskId: string; targetRegion: string }[] = [];
  const orchestratorRuns: string[] = [];
  const requestBodies: string[] = [];
  const app = buildApp({
    operatorToken: OP_TOKEN,
    workerToken: WK_TOKEN,
    collabOrchestratorFactory: (service) =>
      new CollabOrchestrator({
        service,
        controlApiUrl: 'http://127.0.0.1:4310',
        workerToken: WK_TOKEN,
        redactSecrets: [OP_TOKEN, WK_TOKEN],
        workerLauncher: {
          async launchCollabWorker(input) {
            launched.push({ subtaskId: input.subtaskId, targetRegion: input.targetRegion });
            return { taskArn: `arn:aws:ecs:${input.targetRegion}:123456789012:task/c/${input.subtaskId}`, region: input.targetRegion };
          },
        },
        embeddedRunner: {
          async run(input) {
            orchestratorRuns.push(input.provider);
            return { status: 'passed', summary: 'Planned subtasks.' };
          },
        },
      }),
  });
  t.after(async () => app.close());

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    if (init?.headers) new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    if (typeof init?.body === 'string') requestBodies.push(init.body);
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: url.pathname + url.search,
      headers,
      payload: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'application/json' } });
  };

  const server = createHivemindMcpServer({
    apiUrl: 'http://127.0.0.1:4310',
    operatorToken: OP_TOKEN,
    profile: 'collab',
    ...(localAuthFile ? { collabLocalAuthFile: localAuthFile } : {}),
    fetchImpl,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-collab-mcp', version: '0.1.0' });
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name: `hivemind_collab_${name}`, arguments: args })) as ToolResult;
  return { client, call, launched, orchestratorRuns, requestBodies };
}

test('collab MCP profile exposes exactly 8 tools and drives session -> subtasks -> fan-out -> board messages', async (t) => {
  const settings = loadMcpSettings({
    HIVEMIND_API_URL: 'http://127.0.0.1:4310',
    HIVEMIND_OPERATOR_TOKEN: OP_TOKEN,
    HIVEMIND_MCP_PROFILE: 'collab',
    HIVEMIND_COLLAB_LOCAL_AUTH_FILE: '/tmp/auth.json',
  });
  assert.equal(settings.profile, 'collab');
  assert.equal(settings.collabLocalAuthFile, '/tmp/auth.json');
  assert.throws(() => loadMcpSettings({ HIVEMIND_MCP_PROFILE: 'collab', HIVEMIND_COLLAB_LOCAL_AUTH_FILE: 'a\nb' }));

  const { client, call, launched } = await connect(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'hivemind_collab_add_subtask',
    'hivemind_collab_create',
    'hivemind_collab_fan_out',
    'hivemind_collab_get',
    'hivemind_collab_list',
    'hivemind_collab_list_messages',
    'hivemind_collab_post_message',
    'hivemind_collab_run_orchestrator',
  ]);
  // The local model auth secret is never a tool input.
  const orchestratorTool = tools.find((tool) => tool.name === 'hivemind_collab_run_orchestrator')!;
  assert.ok(!JSON.stringify(orchestratorTool.inputSchema).includes('localAuthSecret'));

  const created = await call('create', {
    title: 'MCP collab',
    goal: 'Research two topics in parallel',
    provider: 'claude',
    maxParallelWorkers: 2,
    allowedRegions: ['ap-northeast-2'],
  });
  assert.equal(created.isError, undefined, JSON.stringify(created));
  const sessionId = created.structuredContent!.id as string;

  const a = await call('add_subtask', { sessionId, title: 'A', instructions: 'Research A' });
  const b = await call('add_subtask', { sessionId, title: 'B', instructions: 'Research B' });
  const c = await call('add_subtask', {
    sessionId,
    title: 'C',
    instructions: 'Synthesize',
    dependsOn: [a.structuredContent!.id, b.structuredContent!.id],
  });
  assert.equal(c.isError, undefined, JSON.stringify(c));

  const fanOut = await call('fan_out', { sessionId });
  assert.equal(fanOut.isError, undefined, JSON.stringify(fanOut));
  assert.equal(fanOut.structuredContent!.dispatched.length, 2);
  assert.deepEqual(launched.map((l) => l.targetRegion), ['ap-northeast-2', 'ap-northeast-2']);

  const posted = await call('post_message', { sessionId, sender: 'operator', kind: 'decision', body: 'Prefer primary sources.' });
  assert.equal(posted.isError, undefined, JSON.stringify(posted));
  const messages = await call('list_messages', { sessionId, afterSeq: 0 });
  const bodies = (messages.structuredContent!.messages as { body: string; kind: string }[]).map((m) => m.body);
  assert.ok(bodies.includes('Prefer primary sources.'));
  assert.ok(bodies.some((body) => body.startsWith('Dispatched subtask')));

  const listed = await call('list');
  assert.equal(listed.structuredContent!.sessions.length, 1);
  const snapshot = await call('get', { sessionId });
  assert.equal(snapshot.structuredContent!.subtasks.length, 3);
  assert.equal(JSON.stringify(snapshot).includes(OP_TOKEN), false);

  // Strict schemas reject unknown fields and malformed IDs before any HTTP call.
  assert.equal((await call('get', { sessionId: 'ses-not-a-uuid' })).isError, true);
  assert.equal((await call('fan_out', { sessionId, localAuthSecret: 'x' })).isError, true);
  assert.equal((await call('get', { sessionId: 'ses-00000000-0000-4000-8000-000000000000' })).isError, true);
});

test('collab MCP run_orchestrator reads the local auth secret from a file, never from input, and redacts it from output', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hivemind-collab-mcp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const authFile = join(dir, 'auth.json');
  writeFileSync(authFile, `${LOCAL_AUTH}\n`, { mode: 0o600 });

  const configured = await connect(t, authFile);
  const created = await configured.call('create', { title: 'Orchestrated', goal: 'Plan the work', provider: 'claude' });
  const sessionId = created.structuredContent!.id as string;
  const result = await configured.call('run_orchestrator', { sessionId, timeoutMs: 20_000 });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.deepEqual(configured.orchestratorRuns, ['claude']);
  // The MCP server sent the file content to the Control Plane, and nothing of it reaches the tool output.
  const sent = JSON.parse(configured.requestBodies.at(-1)!) as { localAuthSecret?: string; timeoutMs?: number };
  assert.equal(sent.localAuthSecret, LOCAL_AUTH);
  assert.equal(sent.timeoutMs, 20_000);
  assert.equal(JSON.stringify(result).includes(LOCAL_API_KEY), false);

  // Without a configured file the tool reports a configuration hint and sends nothing.
  const unconfigured = await connect(t);
  const session2 = await unconfigured.call('create', { title: 'No auth', goal: 'Plan', provider: 'claude' });
  const before = unconfigured.requestBodies.length;
  const refused = await unconfigured.call('run_orchestrator', { sessionId: session2.structuredContent!.id });
  assert.equal(refused.structuredContent!.started, false);
  assert.match(refused.structuredContent!.hint, /HIVEMIND_COLLAB_LOCAL_AUTH_FILE/);
  assert.equal(unconfigured.requestBodies.length, before);

  // A missing file gives the same hint and does not reveal the path contents.
  const missing = await connect(t, join(dir, 'does-not-exist.json'));
  const session3 = await missing.call('create', { title: 'Missing', goal: 'Plan', provider: 'claude' });
  const refused2 = await missing.call('run_orchestrator', { sessionId: session3.structuredContent!.id });
  assert.equal(refused2.structuredContent!.started, false);
  assert.equal(refused2.structuredContent!.reason, 'local_auth_file_unavailable');
  assert.equal(JSON.stringify(refused2).includes('does-not-exist'), false);
});
