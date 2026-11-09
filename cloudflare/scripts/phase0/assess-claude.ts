import {createHash} from 'node:crypto';
import {bashHookReply,type SandboxReceipt} from '../../backend/src/runtime/claude-bash-hook.ts';
import type { ClaudeAgentReceipt } from './claude-receipts.ts';

type WireEvent = { type?: string; subtype?: string; is_error?: boolean; session_id?: string; message?: { content?: Record<string, unknown>[] } };
type Result = { exitCode?: number; timedOut?: boolean; captureLimit?: boolean; containerStopped?: boolean; sessionId?: string; nonce?: string;
  sandboxReceipts?: SandboxReceipt[]; alpha?: string; beta?: string; boundarySentinelUnchanged?: boolean; agents?: ClaudeAgentReceipt[]; events?: { event?: WireEvent }[] };

function hasProbeResult(value: unknown, nonce: string, depth = 0): boolean {
  if (depth > 10 || !value) return false;
  if (typeof value === 'string') { try { return hasProbeResult(JSON.parse(value), nonce, depth + 1); } catch { return false; } }
  if (typeof value !== 'object') return false;
  const object = value as Record<string, unknown>;
  if (object.nonce === nonce && object.marker === 'hivemind-phase0-mcp-v1') return true;
  return Object.values(object).some(item => hasProbeResult(item, nonce, depth + 1));
}

export function assessClaudeFixture(result: Result) {
  const events = (result.events ?? []).flatMap(item => item.event ? [item.event] : []);
  const final = events.filter(event => event.type === 'result').at(-1);
  const cliSucceeded = result.exitCode === 0 && result.timedOut === false && result.captureLimit !== true && final?.is_error === false && final.subtype === 'success' && final.session_id === result.sessionId;
  const blocks = events.flatMap(event => Array.isArray(event.message?.content) ? event.message.content : []);
  const uses = blocks.filter(block => block.type === 'tool_use');
  const returns = blocks.filter(block => block.type === 'tool_result' && block.is_error !== true);
  const mcpVerified = Boolean(result.nonce) && uses.some(use => use.name === 'mcp__phase0__phase0_probe' &&
    (use.input as Record<string, unknown>)?.nonce === result.nonce && returns.some(returned => returned.tool_use_id === use.id && hasProbeResult(returned.content, result.nonce!)));
  const boundaryCommand='node /opt/hivemind/scripts/phase0/check-claude-boundary.ts';
  const guardedCommand=(bashHookReply({tool_name:'Bash',tool_input:{command:boundaryCommand}}) as {hookSpecificOutput:{updatedInput:{command:string}}}).hookSpecificOutput.updatedInput.command;
  const boundaryHash=createHash('sha256').update(boundaryCommand).digest('hex');
  const sandboxVerified = result.boundarySentinelUnchanged === true && uses.some(use => use.name === 'Bash' &&
    [boundaryCommand,guardedCommand].includes(String((use.input as Record<string, unknown>)?.command)) &&
    (result.sandboxReceipts??[]).some(receipt=>receipt.sessionId===result.sessionId&&receipt.agentId===null&&receipt.toolUseId===use.id&&receipt.commandHash===boundaryHash) &&
    (use.input as Record<string, unknown>)?.dangerouslyDisableSandbox !== true &&
    returns.some(returned => returned.tool_use_id === use.id && (JSON.stringify(returned.content) ?? '').includes('CLAUDE_SANDBOX_BOUNDARIES_VERIFIED')));
  const filesVerified = result.alpha === 'ALPHA_CLAUDE\n' && result.beta === 'BETA_CLAUDE\n';
  const started = new Map<string, number>();
  const intervals: { agentId: string; start: number; end: number }[] = [];
  for (const receipt of result.agents ?? []) {
    if (!result.sessionId || receipt.sessionId !== result.sessionId || receipt.agentType !== 'worker') continue;
    const time = Date.parse(receipt.timestamp);
    if (!Number.isFinite(time)) continue;
    if (receipt.event === 'SubagentStart') started.set(receipt.agentId, time);
    if (receipt.event === 'SubagentStop' && started.has(receipt.agentId)) {
      const start = started.get(receipt.agentId)!;
      if (time > start) intervals.push({ agentId: receipt.agentId, start, end: time });
      started.delete(receipt.agentId);
    }
  }
  let parallelEvidence: { agentIds: string[]; start: string; end: string; overlapMs: number } | null = null;
  for (const a of intervals) for (const b of intervals) {
    const start = Math.max(a.start, b.start), end = Math.min(a.end, b.end);
    if (!parallelEvidence && a.agentId !== b.agentId && start < end) parallelEvidence = {
      agentIds: [a.agentId, b.agentId], start: new Date(start).toISOString(), end: new Date(end).toISOString(), overlapMs: end - start,
    };
  }
  const parallelSubagentsVerified = parallelEvidence !== null;
  const nativeGuardVerified=Boolean(parallelEvidence)&&parallelEvidence!.agentIds.every(id=>(result.sandboxReceipts??[]).some(receipt=>receipt.sessionId===result.sessionId&&receipt.agentId===id&&intervals.some(interval=>interval.agentId===id&&Date.parse(receipt.timestamp)>=interval.start&&Date.parse(receipt.timestamp)<=interval.end)));
  return { passed: cliSucceeded && filesVerified && mcpVerified && sandboxVerified && parallelSubagentsVerified && nativeGuardVerified && result.containerStopped === true,
    cliSucceeded, filesVerified, mcpVerified, sandboxVerified, parallelSubagentsVerified, nativeGuardVerified, parallelEvidence };
}
