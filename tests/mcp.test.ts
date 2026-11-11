import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createHivemindMcpServer, loadMcpSettings } from '../apps/mcp-server/src/server.js';

const operatorToken = 'mcp-test-operator-private-sentinel';
const repo = { id: 'cloudflare', name: 'explicit-target-fixture', baseCommit: 'a'.repeat(40), testProfile: 'default', testCommand: ['node', '--test'] };
const connection = { status: 'ready', message: null, checkedAt: '2026-11-10T00:00:00Z' };
const processEvidence = { status: 'passed', exitCode: 0, durationMs: 1000, stdout: 'unit passed ' + operatorToken, stderr: '', truncated: false, privateKey: 'never-public' };
const sampleTask = { id: 'cf-mcp-task', title: 'MCP task', instructions: 'safely change fixture', provider: 'codex', runtime: 'cloudflare', budgetMicros: 0, status: 'awaiting_execution_approval', repositoryId: repo.id, baseCommit: repo.baseCommit, testProfile: 'default', createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T00:00:00Z', actualCostMicros: null, summary: 'summary ' + operatorToken, diff: '+ actual change\n', diffTruncated: false, execution: null, worktreePath: '/private/review-path', privateSubmission: 'never-public', remote: { phase: 'AWAITING_APPROVAL', jobId: null, inputSnapshotId: 'input', outputSnapshotId: null, containerStopped: false, authSynced: false, agent: processEvidence, checks: [{ id: 'unit', name: 'Unit', status: 'SUCCEEDED', command: ['node', '--test'], process: processEvidence, credentialsAbsent: true, sourceUnchanged: true, credentialId: 'never-public' }], errorCode: null } };
type Context = { after(fn: () => unknown): void };
function fakeApi() {
  const calls: { path: string; init: RequestInit; body: any }[] = [];
  let task: any = structuredClone(sampleTask);
  let capabilities: any = { providers: ['mock'], repository: null, cloudflare: { providers: ['codex', 'claude'], repository: repo, connection, controlToken: 'never-public' } };
  let failure: 'http' | 'network' | 'oversize' | null = null;
  const fetchImpl: typeof fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname; const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, init, body });
    if (failure === 'network') throw new Error('request ' + operatorToken + ' failed');
    if (failure === 'http') return new Response(JSON.stringify({ message: operatorToken }), { status: 403 });
    if (failure === 'oversize') return new Response('x'.repeat(2_000_001));
    if (path === '/api/capabilities') return Response.json(capabilities);
    if (path === '/api/state') return Response.json({ tasks: [{ ...sampleTask, id: 'local-task', runtime: 'local' }], events: [], workers: [], cloudflare: { tasks: [task], events: [], connection, submission: 'never-public' } });
    if (path === '/api/cloudflare/tasks') { task = { ...task, ...body, status: 'awaiting_execution_approval' }; return Response.json(task, { status: 201 }); }
    if (path.endsWith('/decision')) { task = { ...task, status: body.decision === 'approve' ? 'queued' : 'rejected' }; return Response.json(task); }
    if (path.endsWith('/cancel')) { task = { ...task, status: 'running', remote: { ...task.remote, phase: 'CANCELLING' } }; return Response.json(task); }
    return Response.json({}, { status: 404 });
  };
  return { fetchImpl, calls, setFailure: (value: typeof failure) => { failure = value; }, setCapabilities: (value: any) => { capabilities = value; }, setTask: (value: any) => { task = value; } };
}
async function session(t: Context, api = fakeApi()) {
  const server = createHivemindMcpServer({ apiUrl: 'http://127.0.0.1:4310', operatorToken, fetchImpl: api.fetchImpl });
  const client = new Client({ name: 'hivemind-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ type: string; text: string }>; structuredContent?: Record<string, any> };
    return { result, data: result.isError ? null : JSON.parse(result.content[0]!.text) as Record<string, any> };
  };
  return { server, client, call, api };
}

test('real SDK handshake lists ten tools with read-only and explicit mutation annotations', async t => {
  const { client } = await session(t); const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['hivemind_approve_workflow', 'hivemind_cancel_task', 'hivemind_create_task', 'hivemind_create_workflow', 'hivemind_decide_task', 'hivemind_get_result', 'hivemind_get_workflow', 'hivemind_list_tasks', 'hivemind_list_workflows', 'hivemind_status']);
  for (const name of ['hivemind_status', 'hivemind_list_tasks', 'hivemind_get_result']) assert.equal(tools.find(tool => tool.name === name)!.annotations!.readOnlyHint, true);
  for (const name of ['hivemind_create_task', 'hivemind_decide_task', 'hivemind_cancel_task']) assert.equal(tools.find(tool => tool.name === name)!.annotations!.readOnlyHint, false);
  assert.equal(tools.find(tool => tool.name === 'hivemind_cancel_task')!.annotations!.destructiveHint, true);
});

test('status names the pinned target and list exposes only bounded Cloudflare task summaries', async t => {
  const { call } = await session(t); const status = (await call('hivemind_status')).data!;
  assert.equal(status.repository.name, repo.name); assert.equal(status.repository.baseCommit, repo.baseCommit); assert.equal(status.connection.status, 'ready');
  assert.equal(status.counts.awaiting_execution_approval, 1);
  const listed = (await call('hivemind_list_tasks', { limit: 1 })).data!;
  assert.equal(listed.tasks.length, 1); assert.equal(listed.tasks[0].id, 'cf-mcp-task');
  assert.ok(!JSON.stringify({ status, listed }).includes('never-public'));
  assert.ok(!JSON.stringify(listed).includes('private/review-path'));
});

test('known-token redaction also covers identifier fields in otherwise valid public DTOs', async t => {
  const { call, api } = await session(t);
  api.setCapabilities({ cloudflare: { providers: ['codex'], repository: { ...repo, id: operatorToken }, connection } });
  const result = await call('hivemind_status');
  assert.equal(result.result.isError, undefined);
  assert.ok(!JSON.stringify(result.result).includes(operatorToken));
});

test('create fetches the current server policy and produces only an unapproved Cloudflare draft', async t => {
  const { call, api } = await session(t);
  const result = await call('hivemind_create_task', { title: 'goal', instructions: 'conditions', provider: 'claude', budgetMicros: 0 });
  assert.equal(result.result.isError, undefined); assert.equal(result.data!.task.status, 'awaiting_execution_approval');
  assert.deepEqual(api.calls.map(call => call.path), ['/api/capabilities', '/api/cloudflare/tasks']);
  assert.deepEqual(api.calls[1]!.body, { title: 'goal', instructions: 'conditions', provider: 'claude', budgetMicros: 0, runtime: 'cloudflare', repositoryId: repo.id, baseCommit: repo.baseCommit, testProfile: repo.testProfile });
  assert.equal(api.calls[1]!.init.redirect, 'error'); assert.ok(api.calls[1]!.init.signal);
  assert.equal(new Headers(api.calls[1]!.init.headers).get('authorization'), 'Bearer ' + operatorToken);
});

test('strict schemas reject path, URL, credentials, arbitrary commands, local IDs and invalid limits before HTTP', async t => {
  const { call, api } = await session(t);
  const draft = { title: 'goal', instructions: 'conditions', provider: 'codex', budgetMicros: 0 };
  for (const args of [{ ...draft, apiUrl: 'https://bad.invalid' }, { ...draft, repositoryPath: '/arbitrary' }, { ...draft, testCommand: ['sh'] }, { ...draft, operatorToken }, { ...draft, [operatorToken]: true }, { ...draft, provider: 'mock' }]) {
    const { result } = await call('hivemind_create_task', args); assert.equal(result.isError, true); assert.ok(!JSON.stringify(result).includes(operatorToken));
  }
  for (const [name, args] of [['hivemind_get_result', { taskId: '../api/state' }], ['hivemind_decide_task', { taskId: 'local-task', decision: 'approve', reason: 'run' }], ['hivemind_list_tasks', { limit: 21 }], ['hivemind_get_result', { taskId: 'cf-mcp-task', maxChars: 20001 }]] as const) assert.equal((await call(name, args)).result.isError, true);
  assert.deepEqual(api.calls, []);
});

test('decisions and pending cancellation remain separate explicit mutations with no automatic follow-up', async t => {
  const { call, api } = await session(t);
  await call('hivemind_decide_task', { taskId: 'cf-mcp-task', decision: 'approve', reason: 'user explicitly approved' });
  const cancelled = await call('hivemind_cancel_task', { taskId: 'cf-mcp-task', reason: 'user requested stop' });
  assert.equal(cancelled.data!.task.remote.phase, 'CANCELLING'); assert.equal(cancelled.data!.task.status, 'running');
  assert.deepEqual(api.calls.map(call => call.path), ['/api/cloudflare/tasks/cf-mcp-task/decision', '/api/cloudflare/tasks/cf-mcp-task/cancel']);
});

test('result opt-ins redact known tokens before the shared text limit and whitelist evidence', async t => {
  const { call, api } = await session(t);
  api.setTask({ ...sampleTask, status: 'awaiting_review', diff: operatorToken + 'x'.repeat(10000), summary: null, remote: { ...sampleTask.remote, phase: 'SUCCEEDED', authSynced: true, containerStopped: true } });
  const hidden = (await call('hivemind_get_result', { taskId: 'cf-mcp-task' })).data!;
  assert.equal(hidden.diff, undefined); assert.equal(hidden.task.remote.agent.stdout, undefined);
  const result = await call('hivemind_get_result', { taskId: 'cf-mcp-task', includeDiff: true, includeLogs: true, maxChars: 100 });
  const text = JSON.stringify(result.result);
  assert.ok(!text.includes(operatorToken)); assert.ok(!text.includes(operatorToken.slice(0, 10))); assert.ok(!text.includes('never-public')); assert.ok(!text.includes('private/review-path'));
  assert.equal(result.data!.task.remote.checks[0].credentialsAbsent, true); assert.equal(result.data!.task.remote.checks[0].process.exitCode, 0);
  assert.ok(result.data!.diff.length <= 100); assert.equal(result.data!.truncated, true);
  assert.match(result.data!.diff, /REDACTED/);
});

test('HTTP, transport and oversized-response errors are safe and never replay a POST', async t => {
  const { call, api } = await session(t);
  for (const failure of ['http', 'network', 'oversize'] as const) {
    api.setFailure(failure); const result = (await call('hivemind_decide_task', { taskId: 'cf-mcp-task', decision: 'approve', reason: 'explicit' })).result;
    assert.equal(result.isError, true); assert.ok(!JSON.stringify(result).includes(operatorToken));
  }
  assert.equal(api.calls.length, 3);
  api.setFailure(null); api.setCapabilities({ cloudflare: { providers: ['codex'], repository: repo, connection: { ...connection, status: 'unavailable' } } });
  assert.equal((await call('hivemind_create_task', { title: 'goal', instructions: 'conditions', provider: 'codex', budgetMicros: 0 })).result.isError, true);
  assert.equal(api.calls.filter(call => call.path === '/api/cloudflare/tasks').length, 0);
});

test('MCP settings use protected OPERATOR_TOKEN files and require HTTPS with explicit nondevelopment authentication off loopback', t => {
  assert.deepEqual(loadMcpSettings({}), { apiUrl: 'http://127.0.0.1:4310/', operatorToken: 'local-development-only' });
  const invalid = (env: NodeJS.ProcessEnv) => assert.throws(() => loadMcpSettings(env), { message: 'Invalid HIVEMIND MCP configuration.' });
  invalid({ HIVEMIND_API_URL: 'http://remote.example.invalid', HIVEMIND_OPERATOR_TOKEN: operatorToken });
  invalid({ HIVEMIND_API_URL: 'https://remote.example.invalid' });
  invalid({ HIVEMIND_API_URL: 'https://user:secret@remote.example.invalid', HIVEMIND_OPERATOR_TOKEN: operatorToken });
  invalid({ HIVEMIND_API_URL: 'http://127.0.0.1:4310/arbitrary', HIVEMIND_OPERATOR_TOKEN: operatorToken });
  assert.equal(loadMcpSettings({ HIVEMIND_API_URL: 'https://remote.example.invalid', HIVEMIND_OPERATOR_TOKEN: operatorToken }).operatorToken, operatorToken);
  const root = mkdtempSync(join(tmpdir(), 'hivemind-mcp-settings-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'operator.json'); writeFileSync(file, JSON.stringify({ OPERATOR_TOKEN: operatorToken, CONTROL_TOKEN: 'do-not-use' }), { mode: 0o600 });
  assert.equal(loadMcpSettings({ HIVEMIND_OPERATOR_TOKEN_FILE: file }).operatorToken, operatorToken);
  chmodSync(file, 0o644); invalid({ HIVEMIND_OPERATOR_TOKEN_FILE: file }); chmodSync(file, 0o600);
  const link = join(root, 'link'); symlinkSync(file, link); invalid({ HIVEMIND_OPERATOR_TOKEN_FILE: link });
  invalid({ HIVEMIND_OPERATOR_TOKEN_FILE: file, HIVEMIND_OPERATOR_TOKEN: operatorToken });
});

test('real SDK stdio handshake and calls keep stdout reserved for JSON-RPC', async t => {
  const api = fakeApi(); const http = createServer(async (request, response) => {
    const result = await api.fetchImpl('http://127.0.0.1' + request.url, { method: request.method, headers: request.headers as Record<string, string> });
    response.writeHead(result.status, { 'content-type': 'application/json' }); response.end(await result.text());
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening'); t.after(() => { http.close(); });
  const address = http.address(); assert.ok(address && typeof address !== 'string');
  const transport = new StdioClientTransport({ command: process.execPath, args: [new URL('../apps/mcp-server/src/main.js', import.meta.url).pathname], env: { HIVEMIND_API_URL: 'http://127.0.0.1:' + address.port, HIVEMIND_OPERATOR_TOKEN: operatorToken }, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' }); t.after(() => client.close());
  await client.connect(transport); assert.equal((await client.listTools()).tools.length, 10);
  const result = await client.callTool({ name: 'hivemind_status', arguments: {} });
  assert.ok(JSON.stringify(result).includes(repo.name)); assert.equal(stderr, '');
  assert.equal(api.calls.length, 2);
});

test('invalid stdio startup prints one fixed stderr error and nothing to stdout', () => {
  const result = spawnSync(process.execPath, [new URL('../apps/mcp-server/src/main.js', import.meta.url).pathname], { env: { PATH: process.env.PATH, HIVEMIND_API_URL: 'http://' + operatorToken }, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(result.stderr, 'Unable to start HIVEMIND MCP server.\n');
});
