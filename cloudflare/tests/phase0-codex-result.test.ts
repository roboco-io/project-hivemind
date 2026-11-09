import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessCodexFixture } from '../scripts/phase0/assess-codex.ts';

test('zero CLI exit with missing agent files must not pass the fixture', () => {
  assert.equal(assessCodexFixture({ exitCode: 0, alpha: '', beta: '', events: [] }).passed, false);
});

test('passing requires two linked native agent intervals that actually overlap', () => {
  const nonce = '0123456789abcdef0123456789abcdef';
  const receipt = (id: string, start: string, end: string) => ({
    id, source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } }, forkedFromId: null,
    malformedRows: 0, calls: [], spawnReturns: [],
    lifecycle: [
      { type: 'task_started', timestamp: start }, { type: 'task_complete', timestamp: end },
    ],
  });
  const result = {
    exitCode: 0, timedOut: false, captureLimit: false, containerStopped: true,
    alpha: 'ALPHA_HIVEMIND\n', beta: 'BETA_HIVEMIND\n', nonce,
    events: [
      { event: { type: 'thread.started', thread_id: 'parent' } },
      { event: { type: 'turn.completed' } },
      { event: { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'phase0', tool: 'phase0_probe', status: 'completed',
        result: { structured_content: { nonce, marker: 'hivemind-phase0-mcp-v1' } } } } },
    ],
    rolloutReceipts: [
      receipt('child-A', '2026-11-09T14:00:00Z', '2026-11-09T14:00:10Z'),
      receipt('child-B', '2026-11-09T14:00:05Z', '2026-11-09T14:00:12Z'),
    ],
  };
  assert.equal(assessCodexFixture(result).passed, true);
  const sequential = { ...result, rolloutReceipts: [result.rolloutReceipts[0], receipt('child-B', '2026-11-09T14:00:11Z', '2026-11-09T14:00:12Z')] };
  assert.equal(assessCodexFixture(sequential).passed, false);
  assert.equal(assessCodexFixture({ ...result, rolloutReceipts: [] }).passed, false);
  const clonedHeaders = result.rolloutReceipts.map(receipt => ({ ...receipt,
    storageThreadId: receipt.id, id: 'parent', source: 'exec',
  }));
  const root = { id: 'parent', storageThreadId: 'parent', source: 'exec', forkedFromId: null,
    malformedRows: 0, lifecycle: [], calls: [], spawnReturns: [
      { callId: 'spawn-A', agentId: 'child-A', timestamp: '2026-11-09T14:00:00Z' },
      { callId: 'spawn-B', agentId: 'child-B', timestamp: '2026-11-09T14:00:05Z' },
    ] };
  assert.equal(assessCodexFixture({ ...result, rolloutReceipts: [root, ...clonedHeaders] }).passed, true);
  assert.equal(assessCodexFixture({ ...result, rolloutReceipts: clonedHeaders }).passed, false);
});
