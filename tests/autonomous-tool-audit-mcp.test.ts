import test from 'node:test';
import assert from 'node:assert/strict';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {registerToolAuditTool} from '../apps/mcp-server/src/autonomous-tool-audit.ts';

const OP = 'OPERATOR_CANARY';
const item = (n: number, extra: Record<string, unknown> = {}) => ({sequence: n, tool: 'Bash', inputDigest: 'a'.repeat(64), inputSummary: 'ls', inputTruncated: false, outcome: 'allowed', startedAt: 5, durationMs: 1, runId: 'r1', iteration: 1, receivedAt: 9, source: 'worker_report', ...extra});
async function session(t: {after(fn: () => unknown): void}, reply: (url: URL) => Response) {
  const calls: {url: URL; headers: Headers}[] = [];
  const server = new McpServer({name: 't', version: '1'});
  registerToolAuditTool(server, {apiUrl: 'http://127.0.0.1:4310', operatorToken: OP, redact: s => s.replaceAll(OP, '[REDACTED]'), fetchImpl: async (u, o = {}) => { const url = new URL(String(u)); calls.push({url, headers: new Headers(o.headers)}); return reply(url); }});
  const client = new Client({name: 'c', version: '1'}), [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct); t.after(async () => { await client.close(); await server.close(); });
  return {calls, call: (args: Record<string, unknown>) => client.callTool({name: 'hivemind_autonomous_tool_calls', arguments: args}), client};
}
test('tool is listed and fetches a bounded page with operator auth', async t => {
  const h = await session(t, () => Response.json({source: 'worker_report', items: [item(1), item(2)], totals: {recorded: 2, denied: 0, errors: 0, droppedByWorker: 1, droppedByStore: 0}, nextCursor: 'abc.def'}));
  assert.ok((await h.client.listTools()).tools.some(x => x.name === 'hivemind_autonomous_tool_calls'));
  const r: any = await h.call({taskId: 'autonomous-1', limit: 2, cursor: 'x.y'});
  assert.equal(r.isError, undefined);
  assert.equal(h.calls[0]!.url.pathname + h.calls[0]!.url.search, '/api/cloudflare/autonomous-tasks/autonomous-1/tool-calls?limit=2&cursor=x.y');
  assert.equal(h.calls[0]!.headers.get('authorization'), 'Bearer ' + OP);
  const s = r.structuredContent;
  assert.equal(s.source, 'worker_report'); assert.equal(s.items.length, 2); assert.equal(s.nextCursor, 'abc.def'); assert.equal(s.totals.droppedByWorker, 1);
  assert.match(s.notice, /worker/i);
});
test('summaries are redacted again and unknown fields dropped', async t => {
  const h = await session(t, () => Response.json({source: 'worker_report', items: [item(1, {inputSummary: 'echo ' + OP + ' sk-ant-abcdefghijklmnop', leaked: 'NEVER'})], totals: {recorded: 1, denied: 0, errors: 0, droppedByWorker: 0, droppedByStore: 0}}));
  const r: any = await h.call({taskId: 'autonomous-1'}), text = JSON.stringify(r);
  assert.ok(!text.includes(OP) && !text.includes('sk-ant-abcdefghijklmnop') && !text.includes('NEVER'));
  assert.equal(r.structuredContent.items[0].source, 'worker_report');
});
test('strict input and server failures give a generic error without leaking', async t => {
  const h = await session(t, () => Response.json({error: OP}, {status: 503}));
  for (const bad of [{taskId: '../x'}, {taskId: 'a', limit: 101}, {taskId: 'a', extra: 1}]) assert.equal(((await h.call(bad)) as any).isError, true);
  assert.equal(h.calls.length, 0);
  const r: any = await h.call({taskId: 'a'}); assert.equal(r.isError, true); assert.ok(!JSON.stringify(r).includes(OP));
});
test('malformed server payload is rejected', async t => {
  const h = await session(t, () => Response.json({source: 'worker_report', items: [{sequence: 'x'}], totals: {}}));
  assert.equal(((await h.call({taskId: 'a'})) as any).isError, true);
});
