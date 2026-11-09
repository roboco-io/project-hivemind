import {createHash} from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeAgentReceipt } from '../scripts/phase0/claude-receipts.ts';
import { assessClaudeFixture } from '../scripts/phase0/assess-claude.ts';

test('Claude native lifecycle receipts exclude transcripts and messages', () => {
  const receipt = claudeAgentReceipt({
    hook_event_name: 'SubagentStart', session_id: 'parent-A', agent_id: 'worker-A', agent_type: 'worker',
    transcript_path: '/private/fixture-transcript', last_assistant_message: 'fixture-private-message',
  }, '2026-11-09T14:00:00Z');
  assert.deepEqual(receipt, { event: 'SubagentStart', sessionId: 'parent-A', agentId: 'worker-A', agentType: 'worker', timestamp: '2026-11-09T14:00:00Z' });
  assert.equal(JSON.stringify(receipt).includes('fixture-private'), false);
});

test('a successful Claude process cannot pass with missing files or lifecycle evidence', () => {
  assert.equal(assessClaudeFixture({ exitCode: 0, events: [], agents: [], alpha: '', beta: '' }).passed, false);
});

test('Claude fixture requires real tool results, boundaries and overlapping native hooks', () => {
  const nonce = '0123456789abcdef0123456789abcdef';
  const hook = (agentId: string, event: 'SubagentStart' | 'SubagentStop', timestamp: string) => ({ agentId, event, timestamp, sessionId: 'parent-A', agentType: 'worker' });
  const result = {
    exitCode: 0, timedOut: false, captureLimit: false, containerStopped: true, sessionId: 'parent-A', nonce,
    alpha: 'ALPHA_CLAUDE\n', beta: 'BETA_CLAUDE\n', boundarySentinelUnchanged: true,
    events: [
      { event: { type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'mcp-A', name: 'mcp__phase0__phase0_probe', input: { nonce } },
        { type: 'tool_use', id: 'bash-A', name: 'Bash', input: { command: 'node /opt/hivemind/scripts/phase0/check-claude-boundary.ts' } },
      ] } } },
      { event: { type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'mcp-A', content: [{ type: 'text', text: JSON.stringify({ nonce, marker: 'hivemind-phase0-mcp-v1' }) }] },
        { type: 'tool_result', tool_use_id: 'bash-A', content: 'CLAUDE_SANDBOX_BOUNDARIES_VERIFIED' },
      ] } } },
      { event: { type: 'result', subtype: 'success', is_error: false, session_id: 'parent-A' } },
    ],
    sandboxReceipts:[{sessionId:'parent-A',agentId:null,toolUseId:'bash-A',commandHash:createHash('sha256').update('node /opt/hivemind/scripts/phase0/check-claude-boundary.ts').digest('hex'),timestamp:'2026-11-10T00:00:13.000Z'},...['A','B'].map(agentId=>({sessionId:'parent-A',agentId,toolUseId:'child-'+agentId,commandHash:'a'.repeat(64),timestamp:'2026-11-10T00:00:06.000Z'}))],
    agents: [hook('A', 'SubagentStart', '2026-11-10T00:00:00Z'), hook('B', 'SubagentStart', '2026-11-10T00:00:05Z'), hook('A', 'SubagentStop', '2026-11-10T00:00:10Z'), hook('B', 'SubagentStop', '2026-11-10T00:00:12Z')],
  };
  assert.equal(assessClaudeFixture(result).passed, true);
  assert.equal(assessClaudeFixture({ ...result, agents: [] }).passed, false);
  assert.equal(assessClaudeFixture({ ...result, sandboxReceipts: [] }).passed, false);
  assert.equal(assessClaudeFixture({ ...result, sandboxReceipts: result.sandboxReceipts.filter(x=>x.agentId!=='B') }).passed, false);
  assert.equal(assessClaudeFixture({ ...result, boundarySentinelUnchanged: false }).passed, false);
  assert.equal(assessClaudeFixture({ ...result, nonce: 'other' }).passed, false);
});
