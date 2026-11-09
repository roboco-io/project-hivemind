import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRollout } from '../scripts/phase0/rollout-receipts.ts';

test('rollout receipts retain native lifecycle metadata without prompt contents', () => {
  const input = [
    { timestamp: '2026-11-09T14:00:00Z', type: 'session_meta', payload: { id: 'thread-A', source: 'exec', base_instructions: { text: 'fixture-private-prompt' } } },
    { timestamp: '2026-11-09T14:00:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-A' } },
    { timestamp: '2026-11-09T14:00:08Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'fixture-private-answer' } },
  ].map(row => JSON.stringify(row)).join('\n');
  const receipt = summarizeRollout(input);
  assert.equal(receipt.id, 'thread-A');
  assert.equal(receipt.lifecycle.length, 2);
  assert.equal(JSON.stringify(receipt).includes('fixture-private'), false);
});

test('native structured spawn output yields IDs without copying its text', () => {
  const agentId = '01a1c0b9-790f-71d3-8e86-efe0b16fe963';
  const input = [
    { timestamp: '2026-11-09T14:00:00Z', type: 'response_item', payload: { type: 'function_call', name: 'spawn_agent', call_id: 'spawn-A' } },
    { timestamp: '2026-11-09T14:00:01Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'spawn-A', output: [{ type: 'text', text: JSON.stringify({ agent_id: agentId, nickname: 'fixture-private-name' }) }] } },
  ].map(row => JSON.stringify(row)).join('\n');
  const receipt = summarizeRollout(input);
  assert.equal(receipt.spawnReturns[0]?.agentId, agentId);
  assert.equal(JSON.stringify(receipt).includes('fixture-private-name'), false);
});
