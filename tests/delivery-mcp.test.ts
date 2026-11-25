import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildApp } from '../apps/control-plane/src/app.js';
import { createHivemindMcpServer, loadMcpSettings } from '../apps/mcp-server/src/server.js';
import { computeAcceptanceTestDigest } from '../packages/core/src/delivery.js';

const OP_TOKEN = 'operator-mcp-delivery-token-999999';
const WK_TOKEN = 'worker-mcp-delivery-token-111111';
const BASE_COMMIT = 'a'.repeat(40);
const TREE_HASH = 'b'.repeat(40);
const COMMIT_SHA = 'c'.repeat(40);
const FILE_SHA = 'd'.repeat(64);
const PATCH_SHA = 'e'.repeat(64);

test('delivery MCP profile exposes exactly 6 focused SW delivery tools and runs full draft -> approve -> human no-diff decision', async (t) => {
  const settings = loadMcpSettings({
    HIVEMIND_API_URL: 'http://127.0.0.1:4310',
    HIVEMIND_OPERATOR_TOKEN: OP_TOKEN,
    HIVEMIND_MCP_PROFILE: 'delivery',
  });
  assert.equal(settings.profile, 'delivery');
  assert.throws(() => loadMcpSettings({ HIVEMIND_MCP_PROFILE: 'unknown' }));

  const app = buildApp({ operatorToken: OP_TOKEN, workerToken: WK_TOKEN });
  t.after(async () => app.close());

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    if (init?.headers) {
      new Headers(init.headers).forEach((v, k) => {
        headers[k] = v;
      });
    }
    const res = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: url.pathname + url.search,
      headers,
      payload: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response(res.body, {
      status: res.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  };

  const server = createHivemindMcpServer({
    apiUrl: 'http://127.0.0.1:4310',
    operatorToken: OP_TOKEN,
    profile: 'delivery',
    fetchImpl,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-delivery-mcp', version: '0.1.0' });
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      'hivemind_delivery_approve',
      'hivemind_delivery_cancel',
      'hivemind_delivery_create',
      'hivemind_delivery_get',
      'hivemind_delivery_human_decision',
      'hivemind_delivery_list',
    ],
  );

  const files = [{ path: 'tests/acceptance.test.ts', sha256: FILE_SHA }];
  const testCommand = ['npm', 'run', 'check'];
  const digest = computeAcceptanceTestDigest({ baseCommit: BASE_COMMIT, files, testCommand });

  const createdResult = await client.callTool({
    name: 'hivemind_delivery_create',
    arguments: {
      title: 'Fix bug via AWS Fargate Spot',
      instructions: 'Implement fix without modifying acceptance tests.',
      provider: 'codex',
      maxIterations: 3,
      budgetMicros: 200_000,
      acceptance: { baseCommit: BASE_COMMIT, files, testCommand, digest },
      delivery: {
        mode: 'draft_pr',
        repository: 'roboco-io/project-hivemind',
        baseBranch: 'main',
        branchPrefix: 'hivemind/',
        autoMerge: false,
      },
    },
  });
  assert.notEqual(createdResult.isError, true);
  const created = createdResult.structuredContent as { task: { id: string; approvalFingerprint: string; status: string }; executionApproved: boolean };
  assert.equal(created.executionApproved, false);
  assert.equal(created.task.status, 'awaiting_approval');

  const approvedResult = await client.callTool({
    name: 'hivemind_delivery_approve',
    arguments: {
      taskId: created.task.id,
      approvalFingerprint: created.task.approvalFingerprint,
      reason: 'Approved by operator via MCP',
    },
  });
  assert.notEqual(approvedResult.isError, true);

  // Simulate worker execution + independent verification + Draft PR publish.
  await app.inject({
    method: 'POST',
    url: `/api/delivery/tasks/${created.task.id}/start`,
    headers: { authorization: `Bearer ${WK_TOKEN}` },
    payload: { workerId: 'fargate-spot-1', runId: 'run-1' },
  });
  await app.inject({
    method: 'POST',
    url: `/api/delivery/tasks/${created.task.id}/verify`,
    headers: { authorization: `Bearer ${WK_TOKEN}` },
    payload: {
      runId: 'run-1',
      iteration: 1,
      baseCommit: BASE_COMMIT,
      acceptanceTestDigest: digest,
      verifiedTreeHash: TREE_HASH,
      patchSha256: PATCH_SHA,
      checksPassed: true,
      acceptancePathsUnmodified: true,
      durationMs: 2500,
      exitCode: 0,
      summary: 'Passed cleanly',
      verifiedAt: '2026-11-25T12:00:00.000Z',
    },
  });
  await app.inject({
    method: 'POST',
    url: `/api/delivery/tasks/${created.task.id}/publish-draft-pr`,
    headers: { authorization: `Bearer ${OP_TOKEN}` },
    payload: {
      branchName: `hivemind/${created.task.id}-r1`,
      commitSha: COMMIT_SHA,
      prTreeHash: TREE_HASH,
      prNumber: 202,
      prUrl: 'https://github.com/roboco-io/project-hivemind/pull/202',
      verifiedTreeHash: TREE_HASH,
      acceptanceTestDigest: digest,
      patchSha256: PATCH_SHA,
      publishedAt: '2026-11-25T12:01:00.000Z',
    },
  });

  const decisionResult = await client.callTool({
    name: 'hivemind_delivery_human_decision',
    arguments: {
      taskId: created.task.id,
      decision: 'approve',
      openedDiff: false,
      durationMinutes: 2.0,
      reason: 'Approved solely from verified acceptance tests and matching tree hash',
    },
  });
  assert.notEqual(decisionResult.isError, true);
  const decided = decisionResult.structuredContent as { status: string; humanDecision: { openedDiff: boolean; durationMinutes: number } };
  assert.equal(decided.status, 'approved');
  assert.equal(decided.humanDecision.openedDiff, false);
  assert.equal(decided.humanDecision.durationMinutes, 2.0);
});
